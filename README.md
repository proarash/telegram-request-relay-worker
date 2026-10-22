# Telegram request relay on Cloudflare Workers

A small, stateless Cloudflare Worker that accepts any `POST` body and forwards it to one Telegram chat. JSON, text, and URL-encoded forms are sent as messages. Multipart files, images, and raw binary payloads are uploaded to Telegram as actual documents.

## Setup

Requirements: a free Cloudflare account, Node.js 20 or newer, a Telegram bot token from BotFather, and the destination chat ID.

```bash
npm install
npx wrangler login
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ADMIN_UID, WEBHOOK_URL in .env
npm run secrets:push
npm run deploy
npm run webhook:set
```

Wrangler prints the public `workers.dev` URL after deployment; put that URL in `.env` as `WEBHOOK_URL` before running `webhook:set`. Keep all four values out of `wrangler.jsonc` and out of Git — `.env` is already gitignored, and `secrets:push` uploads it to Cloudflare in one shot via `wrangler secret bulk`.

- `TELEGRAM_ADMIN_UID` — a Telegram user ID that receives an alert if a relay fails.
- `WEBHOOK_URL` — the deployed Worker URL, used only by `npm run webhook:set` to call Telegram's `setWebhook`.

## Use

Send any `POST` request to the deployed URL:

```bash
curl -X POST "https://tg-intermediate-bot.<your-subdomain>.workers.dev/order-created?source=shop" \
  -H "Content-Type: application/json" \
  -d '{"order_id": 42, "status": "paid"}'
```

A successful relay returns HTTP `202`:

```json
{"ok":true,"files_sent":0}
```

Check whether the Worker is running with `GET /health`. Other non-POST requests return `405`. The Worker does not impose its own message or request-body size limit, and no request data is stored. Cloudflare and Telegram platform limits still apply.

Upload one or more files with multipart form data:

```bash
curl -X POST "https://tg-intermediate-bot.<your-subdomain>.workers.dev/upload" \
  -F "description=Example upload" \
  -F "image=@photo.jpg" \
  -F "metadata=@event.json;type=application/json"
```

You can also send a raw binary body. Its URL filename or `Content-Disposition` filename is preserved when possible:

```bash
curl -X POST "https://tg-intermediate-bot.<your-subdomain>.workers.dev/archive.zip" \
  -H "Content-Type: application/zip" \
  --data-binary "@archive.zip"
```

## Local development

Copy `.env.example` to `.env`, fill in the values, then run:

```bash
npm install
npm run dev
```

`.env` is ignored by Git. Test the local Worker at `http://localhost:8787`.

## Security note

The deployed URL is a public relay endpoint. Anyone who knows it can send messages to the configured chat. If it will receive untrusted traffic, protect it with Cloudflare Access, a WAF rule, or add an inbound shared-secret check.
