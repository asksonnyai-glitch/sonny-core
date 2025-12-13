// server.js — Sonny Core (Express + ChatGPT via fetch)
import express from "express";
import cors from "cors";
import morgan from "morgan";

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("tiny"));

const API_KEY = process.env.API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// --- Auth middleware (Bearer) ---
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!API_KEY || token !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// --- Health (no auth) ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "Sonny Core", ts: Date.now() });
});

// --- Voice ingest: route text to Sonny's brain (OpenAI), return SSML ---
app.post("/voice/ingest", auth, async (req, res) => {
  try {
    const { text = "", sessionId = "", userId = "" } = req.body || {};
    const input = String(text || "").trim();

    // If no OpenAI key configured, return a friendly fallback
    if (!OPENAI_API_KEY) {
      const ssml = input
        ? `<speak><p>You said: ${escapeForSSML(input)}.</p><p>I'm here—what would you like to do next?</p></speak>`
        : `<speak>Hello, I am Sonny. How can I help?</speak>`;
      return res.json({ ok: true, ssml, session: { sessionId, userId }, model: "fallback" });
    }

    // Build the prompt for Sonny's persona
    const systemPrompt =
      "You are Sonny, a warm mentor and spiritual guide rooted in Christian faith. " +
      "Answer concisely in a kind, encouraging tone. Avoid preaching; be practical and gentle. " +
      "Return answers suitable to be spoken out loud. Keep responses short (2–5 sentences).";

    // Ask OpenAI (Chat Completions; Node 18+ has fetch)
    const apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input || "Greet the user briefly and ask how you can help." }
        ]
      })
    });

    if (!apiRes.ok) {
      const textBody = await apiRes.text().catch(() => "");
      console.error("OpenAI non-200:", apiRes.status, textBody);
      const ssml = `<speak>Sorry, I couldn't reach my mind service.</speak>`;
      return res.json({ ok: false, ssml, error: `openai_${apiRes.status}` });
    }

    const data = await apiRes.json();
    const reply = data?.choices?.[0]?.message?.content || "I'm here. What would you like to do next?";
    const ssml = wrapToSSML(reply);

    return res.json({ ok: true, ssml, session: { sessionId, userId }, model: "gpt-4o-mini" });
  } catch (e) {
    console.error("ingest error:", e);
    return res.json({ ok: false, ssml: "<speak>Sorry, something went wrong.</speak>" });
  }
});

// --- Actions stub (kept simple) ---
app.post("/actions/create", auth, (req, res) => {
  const { type = "note", payload = {} } = req.body || {};
  return res.json({ ok: true, id: `act_${Date.now()}`, type, status: "queued" });
});

// --- Helpers ---
function escapeForSSML(s) {
  return String(s).replace(/&/g, "and").replace(/[<>\"']/g, "");
}

function wrapToSSML(text) {
  // Very simple SSML wrapper; we scrub any risky characters
  const safe = escapeForSSML(text);
  return `<speak><p>${safe}</p></speak>`;
}

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sonny Core listening on ${PORT}`));


