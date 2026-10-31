#!/usr/bin/env node
// Regression for the IM-send-failure bug: when the question/keyboard send to the IM FAILS, the relay used
// to log-and-absorb it, still hand the client a request_id, and the client would poll forever for
// an answer to a message the human never received (the 3-layer fallback never fired). The fix:
// sendQuestion throws on a failed question delivery → relay resolves {kind:"unreachable"} → client
// falls back to the local picker. This drives the REAL relay + telegram provider against a stub whose
// sendMessage FAILS, and asserts /answer returns {kind:"unreachable"} (not a hang).
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 30s"); process.exit(1); }, 30000);

// --- Telegram API stub whose sendMessage always FAILS (Telegram-level {ok:false}) --------------
let sendAttempts = 0;
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (/\/getUpdates$/.test(u.pathname)) { setTimeout(() => json({ ok: true, result: [] }), 120); return; }
    if (/\/sendMessage$/.test(u.pathname)) { sendAttempts++; json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }); return; }
    if (/\/answerCallbackQuery$/.test(u.pathname)) { json({ ok: true }); return; }
    json({ ok: true, result: {} });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

// --- real relay, pointed at the failing stub ---------------------------------------------------
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const child = spawn(process.execPath, [relayPath], {
  env: {
    ...process.env,
    MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"),
    MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: stubBase,
    RELAY_PORT: String(RELAY_PORT), MYNA_ANSWER_HOLD_MS: "1500",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
for (let i = 0; ; i++) {
  try { await fetch(`${RELAY}/`, { signal: AbortSignal.timeout(500) }); break; }
  catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
}

const ask = (args) => fetch(`${RELAY}/ask`, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());
async function answer(id) {
  for (;;) {
    const j = await (await fetch(`${RELAY}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json();
    if (j.kind !== "pending") return j;
  }
}

// ask a question the stub can't deliver → the client must get {kind:"unreachable"}, NOT hang.
const { request_id } = await ask({ header: "t", question: "選一個?", options: ["甲", "乙"] });
ok(!!request_id, `/ask returns a request_id even on delivery failure → ${request_id}`);
const r = await answer(request_id);
ok(r.kind === "unreachable", `undeliverable question → {kind:"unreachable"} (was: hang) → ${JSON.stringify(r)}`);
ok(/delivery failed/i.test(r.error || ""), `unreachable carries a delivery-failed reason → ${JSON.stringify(r.error)}`);

child.kill(); stub.close(); clearTimeout(watchdog);
console.log(failed === 0 ? "\n✅ RELAY-UNREACHABLE (delivery-failure fallback) PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
