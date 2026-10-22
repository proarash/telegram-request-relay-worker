import { spawnSync } from "node:child_process";
import { loadEnvFile } from "./load-env.mjs";

const REQUIRED_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_ADMIN_UID",
  "WEBHOOK_URL",
];

const vars = loadEnvFile();
const secrets = {};

for (const key of REQUIRED_KEYS) {
  if (vars[key]) {
    secrets[key] = vars[key];
  }
}

const missing = REQUIRED_KEYS.filter((key) => !secrets[key]);
if (missing.length > 0) {
  console.error(`Missing from .env: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Pushing ${Object.keys(secrets).length} secrets via wrangler secret bulk...`);

const result = spawnSync("npx", ["wrangler", "secret", "bulk"], {
  input: JSON.stringify(secrets),
  stdio: ["pipe", "inherit", "inherit"],
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
