require("dotenv").config();

const express = require("express");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
const { Client, LocalAuth, NoAuth } = require("whatsapp-web.js");

const app = express();
const port = Number(process.env.PORT || 8787);
const panelToken = process.env.BOT_PANEL_TOKEN || "";
const apiToken = process.env.BOT_API_TOKEN || "";
const cooldownMs = Math.max(
  0,
  Number(process.env.MESSAGE_COOLDOWN_SECONDS || 20) * 1000,
);
const autoReplyEnabled =
  String(process.env.AUTO_REPLY_ENABLED || "true").toLowerCase() !== "false";
const autoReplyCooldownMs = Math.max(
  0,
  Number(process.env.AUTO_REPLY_COOLDOWN_SECONDS || 120) * 1000,
);
const sendHistory = new Map();
const autoReplyHistory = new Map();
const outboxEnabled =
  String(process.env.WHATSAPP_OUTBOX_ENABLED || "false").toLowerCase() ===
  "true";
const outboxPollMs = Math.max(1000, Number(process.env.OUTBOX_POLL_MS || 3000));
const persistSession =
  String(process.env.WA_PERSIST_SESSION || "false").toLowerCase() === "true";
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { autoRefreshToken: false, persistSession: false } },
      )
    : null;
let outboxBusy = false;

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
  // A fresh QR session avoids a WhatsApp Web profile redirect loop on this laptop.
  // Set WA_PERSIST_SESSION=true only after a clean linked session is available.
  authStrategy: persistSession
    ? new LocalAuth({
        clientId: process.env.WA_CLIENT_ID || "parko-kosova",
        dataPath: process.env.WA_SESSION_PATH || "./.wwebjs_auth",
      })
    : new NoAuth(),
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

client.on("message", async (message) => {
  if (!autoReplyEnabled || message.fromMe || message.from.endsWith("@g.us"))
    return;
  const incoming = String(message.body || "").trim();
  if (!incoming) return;

  const lastReply = autoReplyHistory.get(message.from) || 0;
  if (Date.now() - lastReply < autoReplyCooldownMs) return;

  const text = incoming.toLowerCase();
  const publicUrl =
    process.env.PARKO_PUBLIC_URL || "https://parkokosova.vercel.app";
  let reply = `PÃ«rshÃ«ndetje! Ky Ã«shtÃ« asistenti i Parko Kosova. Shiko parkingjet kÃ«tu: ${publicUrl}`;
  if (/parking|parkim|vend/.test(text)) {
    reply = `PÃ«r parkingje dhe distancÃ«n nga lokacioni yt, hap: ${publicUrl}. PÃ«r ndihmÃ«, shkruaj SUPPORT.`;
  } else if (/support|ndihm|problem|moderator/.test(text)) {
    reply =
      "Mesazhi yt u pranua. NjÃ« moderator do tÃ« tÃ« pÃ«rgjigjet sÃ« shpejti.";
  } else if (/maps|harta|lokacion|adresa/.test(text)) {
    reply = `Hape Parko Kosova dhe pÃ«rdor butonin â€œAfÃ«r mejeâ€ pÃ«r distancÃ«n dhe rrugÃ«n nÃ« Maps: ${publicUrl}`;
  } else if (/Ã§mim|cmim|Ã§mime|cmime|price/.test(text)) {
    reply = `Ã‡mimet shfaqen te kartat e parkingjeve nÃ« ${publicUrl}.`;
  }

  try {
    await message.reply(reply);
    autoReplyHistory.set(message.from, Date.now());
  } catch (error) {
    lastError = error.message;
  }
});

async function processOutbox() {
  if (!outboxEnabled || !supabase || state !== "ready" || outboxBusy) return;
  outboxBusy = true;
  try {
    const { data: jobs, error } = await supabase
      .from("parko_whatsapp_outbox")
      .select("id,phone,message,attempts")
      .eq("status", "pending")
      .lte("available_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(5);
    if (error) throw error;

    for (const job of jobs || []) {
      const { data: claimed } = await supabase
        .from("parko_whatsapp_outbox")
        .update({
          status: "processing",
          attempts: Number(job.attempts || 0) + 1,
          processing_started_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (!claimed) continue;

      try {
        const recipient = normaliseNumber(job.phone);
        if (!recipient) throw new Error("Invalid recipient phone");
        await client.sendMessage(recipient, job.message);
        await supabase
          .from("parko_whatsapp_outbox")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            last_error: null,
          })
          .eq("id", job.id);
      } catch (sendError) {
        await supabase
          .from("parko_whatsapp_outbox")
          .update({
            status: Number(job.attempts || 0) + 1 >= 3 ? "failed" : "pending",
            available_at: new Date(Date.now() + 15000).toISOString(),
            last_error: String(sendError.message || sendError),
          })
          .eq("id", job.id);
      }
    }
  } catch (error) {
    lastError = error.message;
  } finally {
    outboxBusy = false;
  }
}

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
  setInterval(processOutbox, outboxPollMs);
});

