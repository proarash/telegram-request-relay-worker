import { loadEnvFile } from "./load-env.mjs";

const vars = { ...loadEnvFile(), ...process.env };

const botToken = vars.TELEGRAM_BOT_TOKEN;
const webhookUrl = vars.WEBHOOK_URL;

if (!botToken) {
  console.error("Missing TELEGRAM_BOT_TOKEN (set it in .env or the environment).");
  process.exit(1);
}

if (!webhookUrl) {
  console.error("Missing WEBHOOK_URL (set it in .env or the environment).");
  process.exit(1);
}

const response = await fetch(
  `https://api.telegram.org/bot${botToken}/setWebhook`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  },
);

const result = await response.json();

if (!response.ok || !result.ok) {
  console.error("Failed to set webhook:", result.description ?? response.status);
  process.exit(1);
}

console.log(`Webhook set to ${webhookUrl}`);
