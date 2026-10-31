#!/usr/bin/env node
// Autonomous check of the relay's network settings. No phone, no bot.
// Proves: MYNA_NET_ATTEMPT_MS (default 2000) becomes Node's process-wide Happy Eyeballs attempt
// timeout — the one fetch()/WebSocket connect with — and 0 / negative / non-numeric values fall back to
// the default instead of reaching Node (which throws on them); a Node without the setting is skipped
// safely; a real relay reports the value in /health and its start line; a provider call that cannot
// connect logs the reason under "fetch failed" (err.cause), not just "fetch failed".
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { netAttemptMs, applyNetAttemptTimeout, NET_ATTEMPT_DEFAULT_MS } from "../src/net.mjs";
import { errText } from "../src/providers/util.mjs";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 60s"); process.exit(1); }, 60000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myna-net-test-"));

// 1) parsing MYNA_NET_ATTEMPT_MS
ok(NET_ATTEMPT_DEFAULT_MS === 2000 && netAttemptMs(undefined).ms === 2000 && !netAttemptMs(undefined).bad && netAttemptMs("").ms === 2000, "unset / empty → 2000, no warning");
ok(netAttemptMs("3500").ms === 3500 && !netAttemptMs("3500").bad && netAttemptMs(" 800 ").ms === 800, "a positive number of ms is used as is");
ok(netAttemptMs("1500.7").ms === 1501, "a fraction is rounded (Node takes integers only)");
for (const bad of ["0", "-5", "abc", "Infinity", "0.2", "99999999999"]) {
  const r = netAttemptMs(bad);
  ok(r.ms === 2000 && /MYNA_NET_ATTEMPT_MS=/.test(r.bad || ""), `"${bad}" → default 2000 with a warning`);
}

// 2) applying it (fake net module: what is handed to Node, and what happens without the API)
{
  const logs = [], log = (...a) => logs.push(a.join(" "));
  const set = [];
  const fake = { setDefaultAutoSelectFamilyAttemptTimeout: (v) => { if (!Number.isInteger(v) || v < 1) throw new RangeError("ERR_OUT_OF_RANGE"); set.push(v); }, getDefaultAutoSelectFamilyAttemptTimeout: () => set.at(-1) };
  ok(applyNetAttemptTimeout({}, log, fake) === 2000 && set.join() === "2000", "default: Node gets 2000");
  ok(applyNetAttemptTimeout({ MYNA_NET_ATTEMPT_MS: "0" }, log, fake) === 2000 && set.at(-1) === 2000 && logs.some((l) => /"0"/.test(l)), "0 never reaches Node (it would throw) → 2000, logged");
  ok(applyNetAttemptTimeout({ MYNA_NET_ATTEMPT_MS: "-1" }, log, fake) === 2000 && applyNetAttemptTimeout({ MYNA_NET_ATTEMPT_MS: "x" }, log, fake) === 2000 && set.every((v) => v >= 1), "negative / non-numeric → 2000");
  ok(applyNetAttemptTimeout({ MYNA_NET_ATTEMPT_MS: "4000" }, log, fake) === 4000 && set.at(-1) === 4000, "4000 → Node gets 4000");
  logs.length = 0;
  ok(applyNetAttemptTimeout({}, log, {}) === null && logs.some((l) => /no setDefaultAutoSelectFamilyAttemptTimeout/.test(l)), "a Node without the API: skipped, logged, no throw");
  ok(applyNetAttemptTimeout({}, log, { setDefaultAutoSelectFamilyAttemptTimeout: () => { throw new Error("nope"); } }) === null, "a throwing API: skipped, no throw");
}

// 3) err.cause in the log line
{
  const agg = Object.assign(new AggregateError([new Error("connect ETIMEDOUT 2001:db8::1:443"), new Error("connect ETIMEDOUT 149.154.167.220:443")], ""), { code: "ETIMEDOUT" });
  ok(errText(new TypeError("fetch failed", { cause: agg })) === "fetch failed (cause: ETIMEDOUT; connect ETIMEDOUT 2001:db8::1:443; connect ETIMEDOUT 149.154.167.220:443)",
    "Happy Eyeballs failure: the code and every address tried");
  const one = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  ok(errText(new TypeError("fetch failed", { cause: one })) === "fetch failed (cause: connect ECONNREFUSED 127.0.0.1:1)", "a single cause: its message (code not repeated)");
  ok(errText(Object.assign(new Error("timeout"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })) === "timeout (cause: UND_ERR_CONNECT_TIMEOUT)", "a cause with only a code");
  ok(errText(new Error("plain")) === "plain" && errText("str") === "str" && errText(undefined) === "undefined", "no cause → the message alone");
}

// 4) a real relay (own port, own .env in a temp dir, Telegram pointed at a closed local port)
const closedPort = await new Promise((r) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function runRelay(extra = {}) {
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const env = path.join(tmp, `myna-${PORT}.env`);
  fs.writeFileSync(env, `TELEGRAM_BOT_TOKEN=fake\nTELEGRAM_CHAT_ID=1\nTELEGRAM_API_BASE=http://127.0.0.1:${closedPort}\n`);
  let err = "";
  const relay = spawn(process.execPath, [relayPath], {
    env: { ...process.env, MYNA_ENV: env, RELAY_PORT: String(PORT), MYNA_PROVIDER: "telegram", MYNA_NET_ATTEMPT_MS: "", NODE_OPTIONS: "",
      MYNA_PENDING_FILE: path.join(tmp, `pending-${PORT}.json`), MYNA_TOPICS_FILE: path.join(tmp, `topics-${PORT}.json`),
      MYNA_TELEGRAM_CHAT_FILE: path.join(tmp, `chat-${PORT}.json`), MYNA_CHAT_FILE: path.join(tmp, `chat-sessions-${PORT}.json`),
      MYNA_CHAT_TOPICS_FILE: path.join(tmp, `chat-topics-${PORT}.json`), MYNA_RELAY_SECRET_FILE: path.join(tmp, `secret-${PORT}`), ...extra },
    stdio: ["ignore", "ignore", "pipe"],
  });
  relay.stderr.on("data", (d) => (err += d));
  let health = null;
  for (let i = 0; i < 60 && !health; i++) {
    try { health = await (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) })).json(); }
    catch { await sleep(100); }
  }
  for (let i = 0; i < 40 && !/poll err/.test(err); i++) await sleep(100);
  relay.kill(); await new Promise((r) => relay.on("exit", r));
  return { health, err };
}
{
  const a = await runRelay();
  ok(a.health?.net_attempt_ms === 2000 && /relay v\S+ http on .* net_attempt_ms=2000/.test(a.err), `relay: /health net_attempt_ms=${a.health?.net_attempt_ms}, start line says so`);
  ok(/poll err fetch failed \(cause: .*ECONNREFUSED.*\)/.test(a.err), `relay: a failed getUpdates logs its cause → ${(a.err.match(/poll err .*/) || ["(none)"])[0]}`);
  const b = await runRelay({ MYNA_NET_ATTEMPT_MS: "3500" });
  ok(b.health?.net_attempt_ms === 3500 && /net_attempt_ms=3500/.test(b.err), "relay: MYNA_NET_ATTEMPT_MS=3500 → 3500");
  const c = await runRelay({ MYNA_NET_ATTEMPT_MS: "0" });
  ok(c.health?.net_attempt_ms === 2000 && /MYNA_NET_ATTEMPT_MS="0" is not a positive number of ms — using 2000/.test(c.err), "relay: MYNA_NET_ATTEMPT_MS=0 → 2000 with a warning, relay still up");
}

clearTimeout(watchdog);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ NET PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
