import express from "express";
import cors from "cors";
import morgan from "morgan";

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("tiny"));

const API_KEY = process.env.API_KEY || "";

// Bearer auth
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!API_KEY || token !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// Health (no auth)
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "Sonny Core", ts: Date.now() });
});

// Alexa speech ingest → returns SSML
app.post("/voice/ingest", auth, (req, res) => {
  const { text = "", sessionId = "", userId = "" } = req.body || {};
  const lower = String(text).toLowerCase().trim();

  let ssml = "<speak>Hello, I am Sonny. How can I help?</speak>";
  if (lower) {
    ssml = `<speak>
      <p>You said: <emphasis level="moderate">${escapeForSSML(lower)}</emphasis>.</p>
      <p>I'm here—what would you like to do next?</p>
    </speak>`;
  }

  return res.json({ ok: true, ssml, session: { sessionId, userId } });
});

// Actions stub
app.post("/actions/create", auth, (req, res) => {
  const { type = "note", payload = {} } = req.body || {};
  // ✅ FIXED template literal
  return res.json({ ok: true, id: `act_${Date.now()}`, type, status: "queued" });
});

function escapeForSSML(s) {
  return s.replace(/&/g, "and").replace(/[<>\"']/g, "");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sonny Core listening on ${PORT}`));
