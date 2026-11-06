#!/usr/bin/env node
// /myna:hold (scripts/hold.mjs) — the flag file it writes and what it says. Temp HOME, MYNA_ENV and
// MYNA_UPSTREAM_HOLD_FILE; a fake relay /health on a random port (never :7800). The holding itself (an
// edge relay with the hub away) is test/smoke-edge-chat.mjs item 10.
//   - on / off / max <t> / max default: the file's contents (on|off, max=<seconds>, a time stamp)
//   - max: 30m 6h 1d or seconds, 10 minutes – 7 days; anything else refused, the file untouched
//   - no argument / status: writes nothing; source default / file / env; an unreadable file is the default
//   - MYNA_UPSTREAM_HOLD / MYNA_UPSTREAM_HOLD_MAX set: still written, and it says the variable wins
//   - not an edge: still written, and it says it only matters on one; an old relay (no upstream.hold): says so
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const HOLD = path.join(ROOT, "scripts", "hold.mjs");
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-hold-"));
const FILE = path.join(TMP, "upstream-hold"), ENV = path.join(TMP, ".env");
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$)/.test(k)) delete e[k];
  e.HOME = e.USERPROFILE = path.join(TMP, "home"); fs.mkdirSync(e.HOME, { recursive: true });
  return e;
})();
// a fake relay: what /health says is set per check
let healthDoc = null;
const srv = http.createServer((q, res) => { res.writeHead(healthDoc ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(healthDoc || {})); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;
// async (not spawnSync): the fake relay above answers from this process's event loop
const run = (args = [], extra = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [HOLD, ...args], { env: { ...baseEnv, MYNA_ENV: ENV, MYNA_UPSTREAM_HOLD_FILE: FILE, RELAY_PORT: String(PORT), ...extra } });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.on("close", (rc) => resolve({ rc, out }));
});
const lines = () => fs.readFileSync(FILE, "utf8").split(/\r?\n/).filter(Boolean);
fs.writeFileSync(ENV, "MYNA_ROLE=edge\nMYNA_UPSTREAM=https://hub.example.com\n");

// status with nothing set: writes nothing
let r = await run([]);
ok(r.rc === 0 && !fs.existsSync(FILE) && /斷線排隊：開，上限 1 天（設定來自預設）/.test(r.out), `no argument → status, default (on, 1 day), nothing written: ${r.out.split("\n")[0]}`);
ok(/這台是子節點/.test(r.out), "…and it knows this machine is an edge");
// off / on keep max
r = await run(["off"]);
ok(r.rc === 0 && lines()[0] === "off" && lines().length === 2 && !Number.isNaN(Date.parse(lines()[1])), `off → file "off" + a time stamp (${JSON.stringify(lines())})`);
r = await run(["max", "6h"]);
ok(r.rc === 0 && lines()[0] === "off" && lines()[1] === "max=21600", `max 6h → "max=21600", the off kept (${JSON.stringify(lines())})`);
r = await run(["on"]);
ok(r.rc === 0 && lines()[0] === "on" && lines()[1] === "max=21600", `on → "on", the max kept (${JSON.stringify(lines())})`);
r = await run(["status"]);
ok(/斷線排隊：開，上限 6 小時（設定來自\/myna:hold/.test(r.out), `status: on, 6 hours, from /myna:hold (${r.out.split("\n")[0]})`);
for (const [arg, want] of [["30m", 1800], ["1d", 86400], ["7d", 604800], ["600", 600]]) {
  r = await run(["max", arg]);
  ok(r.rc === 0 && lines()[1] === `max=${want}`, `max ${arg} → max=${want}`);
}
const before = fs.readFileSync(FILE, "utf8");
for (const bad of ["5m", "8d", "abc", "", "-1h"]) {
  r = await run(["max", bad]);
  ok(r.rc === 1 && fs.readFileSync(FILE, "utf8") === before, `max "${bad}" refused (rc ${r.rc}), the file untouched`);
}
r = await run(["max", "default"]);
ok(r.rc === 0 && lines().length === 2 && lines()[0] === "on" && !lines().some((l) => l.startsWith("max=")), `max default → the max line gone (${JSON.stringify(lines())})`);
// an unreadable file → the default, and status says so
fs.writeFileSync(FILE, "perhaps\n");
r = await run([]);
ok(/上限 1 天（設定來自預設）/.test(r.out) && /讀不懂/.test(r.out), "an unreadable file → the default, and status says it could not read it");
// environment variables win: still written, and said
r = await run(["off"], { MYNA_UPSTREAM_HOLD: "on" });
ok(r.rc === 0 && lines()[0] === "off" && /環境變數 MYNA_UPSTREAM_HOLD=on 有設/.test(r.out), "off with MYNA_UPSTREAM_HOLD=on set → written, and it says the variable is what counts");
fs.appendFileSync(ENV, "MYNA_UPSTREAM_HOLD_MAX=3600\n");
r = await run([]);
ok(/上限 1 小時（設定來自環境變數）/.test(r.out) && /MYNA_UPSTREAM_HOLD_MAX=3600/.test(r.out), "MYNA_UPSTREAM_HOLD_MAX in ~/.myna/.env → status: the cap from the environment");
fs.writeFileSync(ENV, "MYNA_ROLE=edge\nMYNA_UPSTREAM=https://hub.example.com\n");
// what the relay says
healthDoc = { role: "edge", version: "0.20.4", upstream: { reachable: false } };
r = await run([]);
ok(/0\.20\.4，不支援斷線排隊（要 0\.21\.0 以上）/.test(r.out), "an edge relay older than 0.21.0 (no upstream.hold) → says it does not hold yet");
const t = new Date(); t.setHours(14, 32, 0, 0);
healthDoc = { role: "edge", version: "0.21.0", upstream: { reachable: false, reason: "hub answered HTTP 530", since: t.toISOString(), hold: { on: true, max_s: 86400, source: "default", queued: 2, oldest_at: t.toISOString(), waiting: 1 } } };
r = await run([]);
ok(/排著 2 題，最早 14:32 問的；另有 1 題已送出、在等你回答/.test(r.out) && /連不上/.test(r.out), `status from the relay: ${r.out.split("\n").filter((l) => /排著|主節點/.test(l)).join(" ")}`);
srv.closeAllConnections?.(); await new Promise((res) => srv.close(res)); // the relay is not running
r = await run([]);
ok(/relay 沒在跑/.test(r.out), "relay not answering → status says it cannot see the held questions");
// not an edge: written anyway, and said
fs.writeFileSync(ENV, "TELEGRAM_BOT_TOKEN=1:x\n");
r = await run(["on"]);
ok(r.rc === 0 && lines()[0] === "on" && /這台不是子節點/.test(r.out), "on a machine that is not an edge → written, and it says it only matters on one");

if (failed) { console.log(`\n❌ ${failed} check(s) FAILED`); process.exit(1); }
console.log("\n✅ all /myna:hold checks passed");
