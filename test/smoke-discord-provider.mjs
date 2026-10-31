#!/usr/bin/env node
// Autonomous e2e of the REAL relay + discord provider against local stubs: a fake Gateway
// (WebSocket, test/helpers/ws-stub.mjs) + fake REST v10 (HTTP). No real Discord. Drives the
// full wire path: gateway hello → identify(intents=0) → heartbeat → READY; /ask → channel
// message with button components; INTERACTION_CREATE button → selection/abort; ✍️ → modal
// callback → modal submit → {kind:"message"}; foreign-channel clicks ignored.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createWsStub } from "./helpers/ws-stub.mjs";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const until = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("until: timeout"); await new Promise((r) => setTimeout(r, 50)); } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 30s"); process.exit(1); }, 30000);

// --- fake Gateway (WS) ---------------------------------------------------------
let gw = null, identify = null, heartbeats = 0, seq = 0;
const wsSrv = createWsStub((conn) => {
  gw = conn;
  conn.onJson = (m) => {
    if (m.op === 2) { identify = m.d; conn.send({ op: 0, t: "READY", s: ++seq, d: { user: { username: "stub-bot" } } }); }
    else if (m.op === 1) heartbeats++;
  };
  conn.send({ op: 10, d: { heartbeat_interval: 200 } });
});
await new Promise((r) => wsSrv.listen(0, "127.0.0.1", r));

// --- fake REST v10 -------------------------------------------------------------
const messages = [];   // captured POST /channels/:id/messages bodies
const callbacks = [];  // captured POST /interactions/:id/:token/callback bodies
let msgId = 500;
const rest = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/gateway/bot") {
      ok(req.headers.authorization === "Bot DTOK", "REST calls carry Bot auth header");
      json({ url: `ws://127.0.0.1:${wsSrv.address().port}` });
      return;
    }
    if (/^\/channels\/42\/messages$/.test(req.url)) { messages.push(JSON.parse(body || "{}")); json({ id: String(++msgId) }); return; }
    if (/^\/interactions\//.test(req.url)) { callbacks.push({ url: req.url, ...JSON.parse(body || "{}") }); json({}); return; }
    json({});
  });
});
await new Promise((r) => rest.listen(0, "127.0.0.1", r));

// --- real relay, pointed at the stubs ------------------------------------------
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const child = spawn(process.execPath, [relayPath], {
  env: {
    ...process.env,
    MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"),
    MYNA_PROVIDER: "discord",
    DISCORD_BOT_TOKEN: "DTOK", DISCORD_CHANNEL_ID: "42",
    DISCORD_API_BASE: `http://127.0.0.1:${rest.address().port}`,
    RELAY_PORT: String(RELAY_PORT), MYNA_ANSWER_HOLD_MS: "800",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
for (let i = 0; ; i++) {
  try { await fetch(`${RELAY}/`, { signal: AbortSignal.timeout(500) }); break; }
  catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
}

// gateway handshake happened
await until(() => identify);
ok(identify.token === "DTOK" && identify.intents === 0, `identify sent with bot token + intents=0 → ${JSON.stringify({ intents: identify.intents })}`);
await until(() => heartbeats >= 1, 3000);
ok(heartbeats >= 1, `heartbeat loop running (${heartbeats} beats)`);

const ask = (args) => fetch(`${RELAY}/ask`, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());
async function answer(id) {
  for (;;) {
    const j = await (await fetch(`${RELAY}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json();
    if (j.kind !== "pending") return j;
  }
}
const answerOnce = (id) => fetch(`${RELAY}/answer/${id}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
const interact = (d) => gw.send({ op: 0, t: "INTERACTION_CREATE", s: ++seq, d: { id: `i${seq}`, token: `itok${seq}`, ...d } });
const btn = (msg, row, idx) => msg.components[row].components[idx].custom_id;

// 1) selection: numbered button → {kind:"selection"}
let { request_id } = await ask({ header: "t", question: "選一個?", options: ["甲", "乙"] });
let q = await until(() => messages.find((m) => m.components));
ok(/\[t\]\n選一個\?\n1\. 甲\n2\. 乙/.test(q.content), `question body renders header + numbered options`);
interact({ type: 3, channel_id: "42", data: { custom_id: btn(q, 0, 1) } });
let r = await answer(request_id);
ok(r.kind === "selection" && r.value === "乙", `button 2 → ${JSON.stringify(r)}`);
// the provider resolves FIRST, then acks — the ack may land after the answer was collected (CI flake)
let cb = await until(() => callbacks.find((c) => c.type === 4 && /你選了/.test(c.data?.content || ""))).catch(() => callbacks.at(-1));
ok(cb?.type === 4 && /你選了/.test(cb?.data?.content || ""), "selection acked with a visible confirmation callback");

// 2) foreign-channel click is ignored (allowlist)
messages.length = 0;
({ request_id } = await ask({ question: "q2", options: ["A", "B"] }));
q = await until(() => messages.find((m) => m.components));
interact({ type: 3, channel_id: "999", data: { custom_id: btn(q, 0, 0) } });
r = await answerOnce(request_id);
ok(r.kind === "pending", `foreign-channel click did NOT resolve (answer still pending)`);

// 3) ✍️ modal round-trip on the same request → {kind:"message"}
callbacks.length = 0;
interact({ type: 3, channel_id: "42", data: { custom_id: btn(q, 1, 0) } }); // ✍️
const modalCb = await until(() => callbacks.find((c) => c.type === 9));
ok(!!modalCb.data?.custom_id && modalCb.data?.components?.[0]?.components?.[0]?.type === 4, "✍️ opens a modal with a text input");
interact({ type: 5, channel_id: "42", data: { custom_id: modalCb.data.custom_id, components: [{ type: 1, components: [{ type: 4, custom_id: "text", value: "先解釋差異" }] }] } });
r = await answer(request_id);
ok(r.kind === "message" && r.text === "先解釋差異", `modal submit → ${JSON.stringify(r)}`);

// 4) ⏹ abort
messages.length = 0;
({ request_id } = await ask({ question: "q3", options: ["A"] }));
q = await until(() => messages.find((m) => m.components));
interact({ type: 3, channel_id: "42", data: { custom_id: btn(q, 1, 1) } }); // ⏹
r = await answer(request_id);
ok(r.kind === "aborted", `⏹ → ${JSON.stringify(r)}`);

child.kill(); wsSrv.close(); rest.close(); clearTimeout(watchdog);
console.log(failed === 0 ? "\n✅ DISCORD-PROVIDER E2E PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
