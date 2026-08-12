const SUPABASE_URL = "https://coswvjmodkcpdrntwmyz.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_B7OvsXnx7Rol8a8KmChX5Q_GQb9nC8o";

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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function supabaseFetch(path, accessToken) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, { ok: false, message: "Only POST is supported." });
  }

  const accessToken = String(req.headers.authorization || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!accessToken) {
    return send(res, 401, { ok: false, message: "KyÃ§u para dÃ«rgimit." });
  }

  const { response: userResponse, data: authUser } = await supabaseFetch(
    "/auth/v1/user",
    accessToken,
  );
  if (!userResponse.ok || !authUser?.id) {
    return send(res, 401, { ok: false, message: "Sesioni nuk Ã«shtÃ« valid." });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { ok: false, message: "KÃ«rkesa nuk Ã«shtÃ« valide." });
  }

  const phone = normalizePhone(body.to);
  if (!phone || phone.length < 8 || phone.length > 15) {
    return send(res, 400, {
      ok: false,
      message: "Numri WhatsApp duhet tÃ« jetÃ« me prefiks shteti.",
    });
  }

  const reservationId = encodeURIComponent(String(body.reservationId || ""));
  if (!reservationId) {
    return send(res, 400, { ok: false, message: "Mungon rezervimi." });
  }

  const { response: reservationResponse, data: reservations } =
    await supabaseFetch(
      `/rest/v1/parko_reservations?id=eq.${reservationId}&select=id,user_id,parking_name,city,reservation_date,start_time,qr_token`,
      accessToken,
    );
  if (
    !reservationResponse.ok ||
    !Array.isArray(reservations) ||
    !reservations[0]
  ) {
    return send(res, 404, {
      ok: false,
      message: "Rezervimi nuk u gjet ose nuk tÃ« pÃ«rket ty.",
    });
  }

  const booking = reservations[0];
  const fallbackBooking = {
    code: booking.qr_token,
    parking: booking.parking_name,
    date: `${booking.reservation_date || ""} ${String(booking.start_time || "").slice(0, 5)}`.trim(),
  };

  const access = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName =
    process.env.WHATSAPP_TEMPLATE_NAME || "parko_reservation_code";
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || "en_US";

  if (!access || !phoneNumberId) {
    return send(res, 501, {
      ok: false,
      code: "WHATSAPP_NOT_CONFIGURED",
      message:
        "WhatsApp API nuk Ã«shtÃ« lidhur ende nÃ« Vercel. Vendos WHATSAPP_ACCESS_TOKEN dhe WHATSAPP_PHONE_NUMBER_ID.",
      booking: fallbackBooking,
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: booking.parking_name || "Parko Kosova" },
            { type: "text", text: String(booking.qr_token || booking.id) },
            { type: "text", text: fallbackBooking.date || "rezervimi" },
          ],
        },
      ],
    },
  };

  const metaResponse = await fetch(
    `https://graph.facebook.com/v24.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const metaBody = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok) {
    return send(res, 502, {
      ok: false,
      message:
        metaBody?.error?.message ||
        "WhatsApp API nuk e pranoi mesazhin. Kontrollo token/template.",
      booking: fallbackBooking,
      meta: metaBody,
    });
  }

  return send(res, 200, { ok: true, meta: metaBody });
};
