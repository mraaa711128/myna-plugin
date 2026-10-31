#!/usr/bin/env node
// Write IM provider credentials into ~/.myna/.env
// (stable per-user location — survives plugin updates; not inside the versioned plugin cache).
//
// usage:
//   configure <telegram_bot_token> [chat_id]            (legacy shorthand → telegram)
//   configure telegram <bot_token> [chat_id]
//   configure discord  <bot_token> <channel_id>
//   configure slack    <bot_token> <app_token> <channel_id>
//   configure provider <telegram|discord|slack|auto>    (force the active provider; auto = first configured)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const envPath = process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env");
const argv = process.argv.slice(2);
const USAGE = [
  "usage: configure <telegram_bot_token> [chat_id]",
  "       configure telegram <bot_token> [chat_id]",
  "       configure discord <bot_token> <channel_id>",
  "       configure slack <bot_token> <app_token> <channel_id>",
  "       configure provider <telegram|discord|slack|auto>",
].join("\n");
if (!argv.length) { console.error(USAGE); process.exit(1); }

fs.mkdirSync(path.dirname(envPath), { recursive: true });
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const set = (k, v) => {
  const re = new RegExp(`^${k}=.*$`, "m");
  if (re.test(env)) env = env.replace(re, `${k}=${v}`);
  else env += (env && !env.endsWith("\n") ? "\n" : "") + `${k}=${v}\n`;
};
const unset = (k) => { env = env.replace(new RegExp(`^${k}=.*\\n?`, "m"), ""); };

const sub = argv[0].toLowerCase();
let done;
if (sub === "telegram" || !["discord", "slack", "provider"].includes(sub)) {
  // explicit `telegram …` or the legacy 1–2 arg form (first arg IS the token)
  const [token, chatId] = sub === "telegram" ? argv.slice(1) : argv;
  if (!token) { console.error(USAGE); process.exit(1); }
  set("TELEGRAM_BOT_TOKEN", token);
  if (chatId) {
    set("TELEGRAM_CHAT_ID", chatId);
    // an explicit chat id replaces a chat bound by /myna:pair (that one would otherwise win)
    try { fs.unlinkSync(path.join(path.dirname(envPath), "telegram-chat.json")); } catch {}
  }
  done = `telegram token${chatId ? " + chat_id" : ""}` + (chatId ? "" : " — next: start the relay, then /myna:pair to bind your chat");
} else if (sub === "discord") {
  const [token, channelId] = argv.slice(1);
  if (!token || !channelId) { console.error(USAGE); process.exit(1); }
  set("DISCORD_BOT_TOKEN", token);
  set("DISCORD_CHANNEL_ID", channelId);
  done = "discord bot token + channel_id";
} else if (sub === "slack") {
  const [bot, app, channelId] = argv.slice(1);
  if (!bot || !app || !channelId) { console.error(USAGE); process.exit(1); }
  set("SLACK_BOT_TOKEN", bot);
  set("SLACK_APP_TOKEN", app);
  set("SLACK_CHANNEL_ID", channelId);
  done = "slack bot token + app token + channel_id";
} else { // provider
  const p = (argv[1] || "").toLowerCase();
  if (!["telegram", "discord", "slack", "auto"].includes(p)) { console.error(USAGE); process.exit(1); }
  if (p === "auto") { unset("MYNA_PROVIDER"); done = "provider = auto (first configured of telegram → discord → slack)"; }
  else { set("MYNA_PROVIDER", p); done = `provider = ${p}`; }
}
fs.writeFileSync(envPath, env);
console.log(`wrote ${envPath} (${done}). Restart the relay to apply: /myna:relay stop then start.`);
