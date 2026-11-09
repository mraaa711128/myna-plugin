#!/usr/bin/env node
// Bind the Telegram chat Myna sends to (and takes answers from) — /myna:pair.
//   pair.mjs          ask the running relay for a one-time code (10 min); the human sends
//                     `!pair <code>` from the chat to bind (private chat or group)
//   pair.mjs status   which chat is bound now
// The relay takes the pairing itself (it owns the bot's getUpdates), so it must be running.
import { localHeaders } from "../src/local-auth.mjs"; // the relay secret (MYNA_LOCAL_AUTH)
const PORT = Number(process.env.RELAY_PORT || 7800);
const RELAY = process.env.MYNA_RELAY_URL || `http://127.0.0.1:${PORT}`;
const status = (process.argv[2] || "").toLowerCase() === "status";

const describe = (c) => !c ? "no chat bound yet"
  : c.source === "TELEGRAM_CHAT_ID" ? `chat ${c.id} (from TELEGRAM_CHAT_ID in ~/.myna/.env)`
  : `chat ${c.id} — ${c.type === "private" ? "private chat" : c.type || "chat"}${c.title ? ` "${c.title}"` : ""}, paired ${c.paired_at}`;

let res;
try { res = await fetch(`${RELAY}${status ? "/pair/status" : "/pair/start"}`, { method: status ? "GET" : "POST", headers: localHeaders(), signal: AbortSignal.timeout(3000) }); }
catch { console.error(`relay not reachable at ${RELAY} — start it first (/myna:relay start), then run /myna:pair again`); process.exit(1); }
const j = await res.json().catch(() => ({}));
if (!res.ok) { console.error(j.error || `relay answered HTTP ${res.status}`); process.exit(1); }

if (status) {
  console.log(`bound: ${describe(j.chat)}${j.pairing ? "\na pairing code is live (waiting for !pair <code>)" : ""}`);
} else {
  console.log(`pairing code: ${j.code}  (valid ${Math.round(j.expires_in / 60)} min, one use, void after 5 wrong tries)`);
  console.log(`send this in the Telegram chat to bind:  !pair ${j.code}`);
  console.log("  in a group, the bot must have privacy mode off (BotFather: Bot Settings, Group Privacy, Turn off) or be an admin to see it");
  console.log(`currently bound: ${describe(j.chat)}${j.chat ? " — pairing another chat replaces it" : ""}`);
  console.log("the bot replies ✅ in that chat once bound; check with /myna:pair status");
}
