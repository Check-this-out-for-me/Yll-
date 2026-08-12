# Parko Kosova WhatsApp QR bot

Ky Ã«shtÃ« njÃ« shÃ«rbim i veÃ§antÃ« Node pÃ«r lidhje me QR, i ndarÃ« nga faqja statike nÃ« Vercel.

## Ã‡farÃ« bÃ«n

- Shfaq njÃ« panel privat ku del QR-ja e lidhjes.
- Punon me njÃ« sesion tÃ« ri QR pÃ«r nisje tÃ« qÃ«ndrueshme; `WA_PERSIST_SESSION=true` mund tÃ« aktivizohet mÃ« vonÃ« pÃ«r ruajtje tÃ« sesionit.
- Jep `/health` pÃ«r kontroll publik dhe `/status`, `/qr` e `/send` vetÃ«m me token.
- Kufizon dÃ«rgimet te i njÃ«jti numÃ«r me cooldown dhe nuk lejon mesazhe bosh ose shumÃ« tÃ« gjata.
- Kontrollon radhÃ«n private `parko_whatsapp_outbox` nÃ« Supabase dhe dÃ«rgon kodet e login-it nga WhatsApp Web.

## Kujdes

Ky pÃ«rdor WhatsApp Web automation, jo WhatsApp Cloud API zyrtare. Ã‹shtÃ« mÃ« i brishtÃ« dhe mund tÃ« shkaktojÃ« dalje nga sesioni ose kufizim tÃ« numrit nga WhatsApp. PÃ«rdore vetÃ«m pÃ«r mesazhe tÃ« kÃ«rkuara nga pÃ«rdoruesit dhe mbaj volum tÃ« ulÃ«t.

## Konfigurimi

1. Kopjo `.env.example` nÃ« `.env`.
2. Vendos dy token-a tÃ« gjatÃ«, tÃ« ndryshÃ«m: `BOT_PANEL_TOKEN` dhe `BOT_API_TOKEN`.
3. Instalo varÃ«sitÃ« me `npm install` dhe nise me `npm start`.
4. Hape panelin nÃ« `http://localhost:8787/?token=BOT_PANEL_TOKEN`.
5. NÃ« WhatsApp Business: **Settings > Linked devices > Link a device**, pastaj skano QR-nÃ«.
6. Mos e vendos dosjen `.wwebjs_auth` nÃ« GitHub dhe mos e ndaj QR-nÃ« me askÃ«nd. Me `WA_PERSIST_SESSION=false`, duhet tÃ« skanosh QR-nÃ« pÃ«rsÃ«ri vetÃ«m pas rinisjes sÃ« procesit.

## Kodet e login-it tÃ« faqes

NÃ« `.env` tÃ« botit vendos `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` dhe `WHATSAPP_OUTBOX_ENABLED=true`. NÃ« Vercel vendos tÃ« njÃ«jtin `SUPABASE_SERVICE_ROLE_KEY` dhe `WHATSAPP_BOT_QUEUE_ENABLED=true`. Faqja do ta ruajÃ« kodin nÃ« outbox; laptopi do ta dÃ«rgojÃ« sapo statusi i WhatsApp-it tÃ« jetÃ« `ready`.

## Online

GitHub nuk Ã«shtÃ« host 24/7 dhe Vercel nuk Ã«shtÃ« vendi i duhur pÃ«r procesin Chromium qÃ« mban WhatsApp Web. PÃ«r 24/7 duhet njÃ« server me proces tÃ« pÃ«rhershÃ«m dhe storage persistent. Dockerfile-i kÃ«tu e bÃ«n shÃ«rbimin tÃ« gatshÃ«m pÃ«r njÃ« VPS ose host tjetÃ«r always-on.

