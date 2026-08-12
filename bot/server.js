require("dotenv").config();

const express = require("express");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
const port = Number(process.env.PORT || 8787);
const panelToken = process.env.BOT_PANEL_TOKEN || "";
const apiToken = process.env.BOT_API_TOKEN || "";
const cooldownMs = Math.max(
  0,
  Number(process.env.MESSAGE_COOLDOWN_SECONDS || 20) * 1000,
);
const sendHistory = new Map();

let state = "starting";
let qrDataUrl = null;
let lastError = null;
let clientInfo = null;

function configured() {
  return Boolean(panelToken && apiToken);
}

function tokenFrom(req) {
  const header = req.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return String(req.query.token || req.get("x-bot-token") || "");
}

function requireToken(expected) {
  return (req, res, next) => {
    if (!configured())
      return res.status(503).json({ ok: false, error: "BOT_NOT_CONFIGURED" });
    if (!tokenFrom(req) || tokenFrom(req) !== expected) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }
    next();
  };
}

function normaliseNumber(input) {
  const digits = String(input || "").replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `${digits}@c.us`;
}

function publicStatus() {
  return {
    ok: true,
    state,
    authenticated: state === "ready",
    linkedNumber: clientInfo?.wid?.user || null,
    lastError,
    qrAvailable: Boolean(qrDataUrl),
    updatedAt: new Date().toISOString(),
  };
}

app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  const allowed = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const origin = req.get("origin");
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Bot-Token",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => res.json(publicStatus()));

app.get("/", requireToken(panelToken), async (_req, res) => {
  const image = qrDataUrl
    ? `<img src="${qrDataUrl}" alt="WhatsApp QR" width="320" height="320">`
    : `<div class="state">${state === "ready" ? "WhatsApp Ã«shtÃ« lidhur." : "Duke pritur QR-nÃ«..."}</div>`;
  res
    .type("html")
    .send(
      `<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parko Kosova Bot</title><style>body{font-family:system-ui;background:#f4f7f5;color:#14251c;display:grid;place-items:center;min-height:100vh;margin:0}.panel{width:min(92vw,520px);background:white;border:1px solid #d8e3dc;border-radius:18px;padding:28px;text-align:center;box-shadow:0 15px 50px #19352414}img{display:block;margin:22px auto;border-radius:12px}.state{padding:72px 16px;font-weight:700}small{color:#62736a}</style></head><body><main class="panel"><h1>Parko Kosova</h1><p>WhatsApp bot i lidhur me QR</p>${image}<small>Statusi: ${state}</small></main></body></html>`,
    );
});

app.get("/status", requireToken(panelToken), (_req, res) =>
  res.json(publicStatus()),
);
app.get("/qr", requireToken(panelToken), (_req, res) => {
  if (!qrDataUrl)
    return res
      .status(404)
      .json({ ok: false, error: "QR_NOT_AVAILABLE", state });
  res.json({ ok: true, state, qrDataUrl });
});

app.post("/send", requireToken(apiToken), async (req, res) => {
  const to = normaliseNumber(req.body?.to);
  const body = String(req.body?.message || "").trim();
  if (!to || !body || body.length > 2000) {
    return res.status(400).json({ ok: false, error: "INVALID_MESSAGE" });
  }
  if (state !== "ready")
    return res
      .status(503)
      .json({ ok: false, error: "WHATSAPP_NOT_READY", state });
  const previous = sendHistory.get(to) || 0;
  if (Date.now() - previous < cooldownMs) {
    return res.status(429).json({ ok: false, error: "RECIPIENT_COOLDOWN" });
  }
  try {
    await client.sendMessage(to, body);
    sendHistory.set(to, Date.now());
    return res.json({ ok: true, to: to.replace("@c.us", "") });
  } catch (error) {
    lastError = error.message;
    return res.status(502).json({ ok: false, error: "SEND_FAILED" });
  }
});

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: process.env.WA_CLIENT_ID || "parko-kosova",
    dataPath: process.env.WA_SESSION_PATH || "./.wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

client.on("qr", async (qr) => {
  state = "awaiting_qr";
  qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
  console.log("WhatsApp QR is ready at the protected bot panel.");
});

client.on("authenticated", () => {
  state = "authenticated";
  qrDataUrl = null;
  lastError = null;
});

client.on("ready", () => {
  state = "ready";
  qrDataUrl = null;
  clientInfo = client.info || null;
  lastError = null;
  console.log(
    `WhatsApp bot ready${clientInfo?.wid?.user ? ` for ${clientInfo.wid.user}` : ""}.`,
  );
});

client.on("auth_failure", (message) => {
  state = "auth_failure";
  lastError = String(message);
});

client.on("disconnected", (reason) => {
  state = "disconnected";
  lastError = String(reason);
  qrDataUrl = null;
});

process.on("SIGTERM", async () => {
  await client.destroy().catch(() => {});
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Parko Kosova WhatsApp bot listening on port ${port}`);
  if (!configured())
    console.warn(
      "Set BOT_PANEL_TOKEN and BOT_API_TOKEN before exposing this service.",
    );
  client.initialize().catch((error) => {
    state = "error";
    lastError = error.message;
    console.error(error);
  });
});