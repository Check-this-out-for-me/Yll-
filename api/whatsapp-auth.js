const SUPABASE_URL = "https://coswvjmodkcpdrntwmyz.supabase.co";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function normalizePhone(phone) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
}

function config() {
  return {
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    botUrl: String(process.env.WHATSAPP_BOT_URL || "").replace(/\/$/, ""),
    botApiToken: process.env.WHATSAPP_BOT_API_TOKEN,
    templateName:
      process.env.WHATSAPP_AUTH_TEMPLATE_NAME || "parko_login_code",
    templateLang: process.env.WHATSAPP_AUTH_TEMPLATE_LANG || "en_US",
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function supabaseFetch(path, options = {}) {
  const key = config().serviceKey;
  return fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function hashCode(phone, code) {
  const data = new TextEncoder().encode(
    `${phone}:${code}:${process.env.WHATSAPP_OTP_PEPPER || "parko-otp"}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function randomPassword() {
  return `${require("crypto").randomBytes(32).toString("hex")}P!9`;
}

async function sendWhatsAppCode(phone, code, settings) {
  if (settings.botUrl && settings.botApiToken) {
    const response = await fetch(`${settings.botUrl}/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.botApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: phone,
        message: `Parko Kosova: kodi yt i hyrjes eshte ${code}. Ky kod skadon pas 10 minutash.`,
      }),
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  const response = await fetch(
    `https://graph.facebook.com/v24.0/${settings.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "template",
        template: {
          name: settings.templateName,
          language: { code: settings.templateLang },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: code }],
            },
          ],
        },
      }),
    },
  );
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function sendCode(req, res, phone, settings) {
  const recentUrl = `/rest/v1/parko_phone_otps?phone=eq.${encodeURIComponent(phone)}&purpose=eq.login&created_at=gte.${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}&select=id&limit=1`;
  const recent = await supabaseFetch(recentUrl);
  if (recent.ok && (await recent.json()).length) {
    return send(res, 429, {
      ok: false,
      code: "OTP_RATE_LIMITED",
      message: "Prit 60 sekonda para se te kerkosh kod te ri.",
    });
  }

  const code = randomCode();
  const codeHash = await hashCode(phone, code);
  const insert = await supabaseFetch("/rest/v1/parko_phone_otps", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      phone,
      purpose: "login",
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  if (!insert.ok) {
    return send(res, 500, {
      ok: false,
      code: "OTP_STORAGE_ERROR",
      message: "Kodi nuk mund te pergatitet tani.",
    });
  }

  const delivered = await sendWhatsAppCode(phone, code, settings);
  if (!delivered.response.ok) {
    await supabaseFetch(
      `/rest/v1/parko_phone_otps?phone=eq.${encodeURIComponent(phone)}&used_at=is.null`,
      { method: "DELETE" },
    );
    return send(res, 502, {
      ok: false,
      code: "WHATSAPP_SEND_FAILED",
      message:
        delivered.body?.error?.message ||
        "WhatsApp nuk e pranoi mesazhin. Kontrollo template-in dhe kredencialet Meta.",
    });
  }

  return send(res, 200, { ok: true, message: "Kodi u dergua ne WhatsApp." });
}

async function verifyCode(res, phone, code) {
  const response = await supabaseFetch(
    `/rest/v1/parko_phone_otps?phone=eq.${encodeURIComponent(phone)}&purpose=eq.login&used_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id,code_hash,attempts&order=created_at.desc&limit=1`,
  );
  const rows = response.ok ? await response.json() : [];
  const otp = rows[0];
  if (!otp || Number(otp.attempts) >= 5) {
    return send(res, 400, { ok: false, code: "OTP_INVALID", message: "Kodi nuk eshte valid." });
  }

  const valid = (await hashCode(phone, code)) === otp.code_hash;
  if (!valid) {
    await supabaseFetch(`/rest/v1/parko_phone_otps?id=eq.${otp.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ attempts: Number(otp.attempts) + 1 }),
    });
    return send(res, 400, { ok: false, code: "OTP_INVALID", message: "Kodi nuk eshte valid." });
  }

  await supabaseFetch(`/rest/v1/parko_phone_otps?id=eq.${otp.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  });

  const profileResponse = await supabaseFetch(
    `/rest/v1/parko_profiles?phone=eq.${encodeURIComponent(phone)}&select=id,full_name&limit=1`,
  );
  const profileRows = profileResponse.ok ? await profileResponse.json() : [];
  const password = randomPassword();
  let userId = profileRows[0]?.id;

  if (userId) {
    const updateUser = await supabaseFetch(`/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ password, phone_confirm: true }),
    });
    if (!updateUser.ok)
      return send(res, 500, { ok: false, message: "Llogaria nuk mund te aktivizohet tani." });
  } else {
    const createUser = await supabaseFetch("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({
        phone,
        password,
        phone_confirm: true,
        user_metadata: { full_name: phone },
      }),
    });
    const created = await createUser.json().catch(() => ({}));
    if (!createUser.ok || !created?.id)
      return send(res, 500, { ok: false, message: "Llogaria nuk mund te krijohet tani." });
    userId = created.id;
    await supabaseFetch("/rest/v1/parko_profiles", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: userId, phone, full_name: phone }),
    });
  }

  return send(res, 200, { ok: true, phone, password });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, message: "Only POST is supported." });
  const settings = config();
  const hasBot = Boolean(settings.botUrl && settings.botApiToken);
  const hasMeta = Boolean(settings.accessToken && settings.phoneNumberId);
  if (!settings.serviceKey || (!hasBot && !hasMeta)) {
    return send(res, 501, {
      ok: false,
      code: "WHATSAPP_NOT_CONFIGURED",
      message: "WhatsApp nuk eshte konfiguruar ne Vercel.",
    });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { ok: false, message: "Kerkesa nuk eshte valide." });
  }
  const phone = normalizePhone(body.phone);
  if (phone.length < 8 || phone.length > 15)
    return send(res, 400, { ok: false, message: "Numri nuk eshte valid." });

  if (body.action === "send") return sendCode(req, res, phone, settings);
  if (body.action === "verify") {
    const code = String(body.code || "").replace(/\D/g, "");
    if (code.length !== 6)
      return send(res, 400, { ok: false, message: "Kodi duhet te kete 6 shifra." });
    return verifyCode(res, phone, code);
  }
  return send(res, 400, { ok: false, message: "Veprimi nuk eshte valid." });
};