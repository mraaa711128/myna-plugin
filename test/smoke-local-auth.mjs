#!/usr/bin/env node
// Autonomous smoke: the local listener's auth (MYNA_LOCAL_AUTH, src/local-auth.mjs). With it on, every local request
// but GET /health and /chat/* needs the relay secret in X-Myna-Local-Secret — /ask, /answer, /cancel, /requests,
// /attest, /pair/*, /detach, /session/*, /shutdown answer 401 without it, and nothing changes behind them; the bundled
// MCP tool and the scripts read the secret themselves, so a gate still goes round (MCP → relay → stubbed Telegram →
// tap → tool result) and /myna:relay stop still stops the relay. With it off (the default) nothing changes.
// Never :7800, never a real bot: a local Telegram API stub, a temp secret.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
const serverPath = fileURLToPath(new URL(`../${process.env.MYNA_SERVER || "dist/ask-human.mjs"}`, import.meta.url));
const stopRelay = fileURLToPath(new URL("../scripts/stop-relay.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("until: timeout"); await new Promise((r) => setTimeout(r, 50)); } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 60s"); process.exit(1); }, 60000);

// --- Telegram API stub (the "human") -------------------------------------------
const sent = [];
let updates = [], nextUpdateId = 1, mid = 100;
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (/\/getUpdates$/.test(u.pathname)) { const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); }; updates.length ? deliver() : setTimeout(deliver, 150); return; }
    if (/\/sendMessage$/.test(u.pathname)) { sent.push(JSON.parse(body || "{}")); json({ ok: true, result: { message_id: ++mid } }); return; }
    if (/\/createForumTopic$/.test(u.pathname)) { json({ ok: true, result: { message_thread_id: 777 } }); return; }
    json({ ok: true, result: {} });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const push = (u) => updates.push({ update_id: nextUpdateId++, ...u });

// --- the secret, where the relay and its clients look (MYNA_RELAY_SECRET_FILE) ---------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "myna-local-auth-"));
const secretFile = path.join(scratch, "relay-secret");
const SECRET = "a".repeat(16) + Math.random().toString(16).slice(2).padEnd(48, "0");
fs.writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });

function startRelay(extra) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env,
      MYNA_ENV: path.join(scratch, "no-such-env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      RELAY_PORT: String(port), MYNA_ANSWER_HOLD_MS: "800", MYNA_RELAY_SECRET_FILE: secretFile,
      MYNA_TOPICS_FILE: path.join(scratch, `topics-${port}.json`), MYNA_PENDING_FILE: path.join(scratch, `pending-${port}.json`),
      MYNA_CHAT_FILE: path.join(scratch, `chat-${port}.json`),
      ...extra,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return { port, url: `http://127.0.0.1:${port}`, child };
}
const up = (url) => until(() => fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.json()).catch(() => null), 8000);
const req = (url, p, { method = "GET", secret = null, body, auth } = {}) => fetch(`${url}${p}`, {
  method, headers: { ...(secret ? { "x-myna-local-secret": secret } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const ASK = { question: "上線?", options: ["yes", "no"], session_id: "s-local-auth" };

// --- on --------------------------------------------------------------------------------------
const on = startRelay({ MYNA_LOCAL_AUTH: "1" });
const h = await up(on.url);
ok(h?.local_auth === true, `/health answers without the secret and says local_auth: ${h?.local_auth}`);

const refused = [
  ["POST", "/ask", ASK], ["GET", "/answer/0123456789"], ["POST", "/cancel/0123456789", {}], ["GET", "/requests?session_id=s-local-auth"],
  ["POST", "/attest", { command: "rm -rf /", session_id: "s" }], ["POST", "/pair/start", {}], ["GET", "/pair/status"],
  ["POST", "/detach/0123456789", { session_id: "s" }], ["POST", "/session/close", { session_id: "s" }], ["POST", "/session/round-end", { session_id: "s" }],
  ["POST", "/shutdown", {}],
];
for (const secret of [null, "wrong", SECRET.slice(0, -1)]) {
  const got = [];
  for (const [method, p, body] of refused) got.push((await req(on.url, p, { method, body, secret })).status);
  ok(got.every((s) => s === 401), `without the right secret (${secret === null ? "none" : secret === "wrong" ? "a wrong one" : "one short"}) every state-changing entry is 401 → ${got.join(",")}`);
}
ok(sent.length === 0, "nothing reached the phone meanwhile");
ok((await req(on.url, "/requests?session_id=s-local-auth", { secret: SECRET })).status === 200, "with the secret: /requests answers");
ok(!!(await fetch(`${on.url}/health`).then((r) => r.ok)), "the relay is still up (the 401 /shutdown did nothing)");
// /chat/* keeps its own: the relay secret as Bearer registers, the local header is not asked for
const reg = await req(on.url, "/chat/register", { method: "POST", auth: SECRET, body: { session_id: "chat-s", nick: "egret", label: "t", cwd: scratch } });
ok(reg.status !== 401, `/chat/register is not behind the local check (its own Bearer secret) → ${reg.status}`);

// the bundled MCP tool reads the secret itself: a gate goes round
const transport = new StdioClientTransport({
  command: process.execPath, args: [serverPath],
  env: { ...process.env, MYNA_RELAY_URL: on.url, MYNA_RELAY_SECRET_FILE: secretFile, MYNA_LOG_DIR: scratch, MYNA_AUTOPILOT_FILE: path.join(scratch, "no-autopilot"), MYNA_HEARTBEAT_MS: "5000", MYNA_ANSWER_POLL_MS: "5000", MYNA_SESSION_NAME: "local-auth", MYNA_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "cc-local-auth" },
  stderr: "ignore",
});
const c = new Client({ name: "local-auth", version: "0" }, { capabilities: {} });
await c.connect(transport);
const call = c.callTool({ name: "ask_human", arguments: { header: "deploy", question: "上線?", options: ["yes", "no"], logDir: scratch } }, undefined, { timeout: 30000, resetTimeoutOnProgress: true }).then((r) => JSON.parse(r.content[0].text));
const kb = await until(() => [...sent].reverse().find((s) => s.reply_markup?.inline_keyboard));
push({ callback_query: { id: "cq1", data: kb.reply_markup.inline_keyboard[0][0].callback_data, message: { chat: { id: 42 } } } });
const r = await call;
ok(r.kind === "selection" && r.value === "yes", `MCP ask_human → relay (with the secret it read) → tap → ${JSON.stringify(r)}`);
await c.close();

// /myna:relay stop (scripts/stop-relay.mjs) reads it too
const stop = spawnSync(process.execPath, [stopRelay], { env: { ...process.env, RELAY_PORT: String(on.port), MYNA_RELAY_SECRET_FILE: secretFile }, encoding: "utf8", timeout: 15000 });
ok(/stopped/.test(stop.stdout), `stop-relay.mjs stops it with the secret → ${stop.stdout.trim()}`);

// --- off (the default): nothing asked ---------------------------------------------------------
const off = startRelay({});
const h2 = await up(off.url);
ok(h2?.local_auth === false, "MYNA_LOCAL_AUTH unset → local_auth: false");
const asked = await req(off.url, "/ask", { method: "POST", body: { ...ASK, session_id: "s-off" } });
ok(asked.status === 200 && !!asked.json?.request_id, `off: POST /ask without any secret is taken as before → ${asked.status}`);
await req(off.url, `/cancel/${asked.json?.request_id}`, { method: "POST", body: {} });
await req(off.url, "/shutdown", { method: "POST", body: {} });

clearTimeout(watchdog);
for (const x of [on, off]) try { x.child.kill(); } catch {}
stub.close();
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
console.log(failed ? `\n${failed} check(s) failed` : "\nall local-auth checks passed");
process.exit(failed ? 1 : 0);
