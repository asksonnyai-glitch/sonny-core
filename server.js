// server.js — Sonny Core (Express + ChatGPT + Google OAuth/Gmail)
import express from "express";
import cors from "cors";
import morgan from "morgan";

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("tiny"));

const API_KEY = process.env.API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Google OAuth env
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";

// Very simple in-memory token store (demo only)
const TOKENS = new Map(); // key: userId, value: { access_token, refresh_token, expiry_date, scope, token_type }

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

    if (!OPENAI_API_KEY) {
      const ssml = input
        ? `<speak><p>You said: ${escapeForSSML(input)}.</p><p>I'm here—what would you like to do next?</p></speak>`
        : `<speak>Hello, I am Sonny. How can I help?</speak>`;
      return res.json({ ok: true, ssml, session: { sessionId, userId }, model: "fallback" });
    }

    const systemPrompt =
      "You are Sonny, a warm mentor and spiritual guide rooted in Christian faith. " +
      "Answer concisely in a kind, encouraging tone. Avoid preaching; be practical and gentle. " +
      "Return answers suitable to be spoken out loud. Keep responses short (2–5 sentences).";

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

// --- GOOGLE OAUTH: start (no auth; browser friendly) ---
app.get("/oauth/google/start", (req, res) => {
  try {
    const userId = String(req.query.userId || "anon");
    if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
      return res.status(500).send("Google OAuth not configured.");
    }
    const scope = [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "openid",
      "email",
      "profile"
    ].join(" ");

    const state = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString("base64url");
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      scope,
      state
    });
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return res.redirect(url);
  } catch (e) {
    console.error("oauth start error:", e);
    return res.status(500).send("OAuth start failed.");
  }
});

// --- GOOGLE OAUTH: callback (no auth; Google redirects here) ---
app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const stateRaw = String(req.query.state || "");
    const state = JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf8"));
    const userId = String(state?.userId || "anon");

    if (!code) return res.status(400).send("Missing code");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("token exchange failed:", tokens);
      return res.status(500).send("Token exchange failed.");
    }

    TOKENS.set(userId, tokens);
    console.log("Stored tokens for", userId);
    return res.send(
      `<html><body><h2>Sonny: Google connected ✅</h2>
       <p>You can close this tab.</p></body></html>`
    );
  } catch (e) {
    console.error("oauth callback error:", e);
    return res.status(500).send("OAuth callback error.");
  }
});

// --- Verify Gmail profile (auth; requires API_KEY) ---
app.get("/gmail/profile", auth, async (req, res) => {
  try {
    const userId = String(req.query.userId || "anon");
    const tokens = TOKENS.get(userId);
    if (!tokens?.access_token) return res.status(401).json({ ok: false, error: "not_linked" });

    const gRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const data = await gRes.json();
    if (!gRes.ok) {
      console.error("gmail profile error:", data);
      return res.status(500).json({ ok: false, error: "gmail_profile_failed", detail: data });
    }
    return res.json({ ok: true, profile: data });
  } catch (e) {
    console.error("gmail profile exception:", e);
    return res.status(500).json({ ok: false, error: "gmail_profile_exception" });
  }
});

// --- Actions: create (email supported) ---
app.post("/actions/create", auth, async (req, res) => {
  try {
    const { userId = "anon", type = "note", topic = "", details = "", to = "", subject = "", body = "" } = req.body || {};
    if (type !== "email") {
      return res.json({ ok: true, id: `act_${Date.now()}`, type, status: "queued" });
    }

    const tokens = TOKENS.get(userId);
    if (!tokens?.access_token) {
      return res.status(401).json({ ok: false, error: "not_linked", message: "Please link Gmail at /oauth/google/start?userId=YOU" });
    }

    const raw = buildRfc822({ to, subject, text: body || details || `Topic: ${topic}` });
    const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ raw })
    });
    const data = await sendRes.json();
    if (!sendRes.ok) {
      console.error("gmail send error:", data);
      return res.status(500).json({ ok: false, error: "gmail_send_failed", detail: data });
    }
    return res.json({ ok: true, id: data?.id || `msg_${Date.now()}`, status: "sent" });
  } catch (e) {
    console.error("actions.create error:", e);
    return res.status(500).json({ ok: false, error: "actions_create_exception" });
  }
});

// --- Helpers ---
function escapeForSSML(s) {
  return String(s).replace(/&/g, "and").replace(/[<>\"']/g, "");
}
function wrapToSSML(text) {
  const safe = escapeForSSML(text);
  return `<speak><p>${safe}</p></speak>`;
}
function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function buildRfc822({ to, subject, text }) {
  const lines = [
    `To: ${to}`,
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "MIME-Version: 1.0",
    `Subject: ${subject}`,
    "",
    text
  ].join("\r\n");
  return base64url(lines);
}

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sonny Core listening on ${PORT}`));




