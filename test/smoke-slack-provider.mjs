#!/usr/bin/env node
// Autonomous e2e of the REAL relay + slack provider against local stubs: a fake Socket Mode
// endpoint (WebSocket, test/helpers/ws-stub.mjs) + fake Web API (HTTP). No real Slack. Drives
// the full wire path: apps.connections.open (xapp token) → WS hello → /ask → chat.postMessage
// with Block Kit buttons; block_actions → selection/abort (+ envelope acks); ✍️ → views.open
// modal → view_submission → {kind:"message"}; foreign-channel clicks ignored; thread_ts reuse.
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

// --- fake Socket Mode (WS) -----------------------------------------------------
let sock = null; const acks = [];
const wsSrv = createWsStub((conn) => {
  sock = conn;
  conn.onJson = (m) => { if (m.envelope_id) acks.push(m.envelope_id); };
  conn.send({ type: "hello" });
});
await new Promise((r) => wsSrv.listen(0, "127.0.0.1", r));

// --- fake Web API --------------------------------------------------------------
const posts = [];  // captured chat.postMessage bodies
const views = [];  // captured views.open bodies
let ts = 100;
const api = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/apps.connections.open") {
      ok(req.headers.authorization === "Bearer XAPP", "connections.open uses the xapp app token");
      json({ ok: true, url: `ws://127.0.0.1:${wsSrv.address().port}` });
      return;
    }
    if (req.url === "/chat.postMessage") {
      ok(req.headers.authorization === "Bearer XOXB", "chat.postMessage uses the xoxb bot token");
      posts.push(JSON.parse(body || "{}")); json({ ok: true, ts: `${++ts}.000` });
      return;
    }
    if (req.url === "/views.open") { views.push(JSON.parse(body || "{}")); json({ ok: true }); return; }
    json({ ok: true });
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));

// --- real relay, pointed at the stubs ------------------------------------------
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const child = spawn(process.execPath, [relayPath], {
  env: {
    ...process.env,
    MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"),
    MYNA_PROVIDER: "slack",
    SLACK_BOT_TOKEN: "XOXB", SLACK_APP_TOKEN: "XAPP", SLACK_CHANNEL_ID: "C0AA",
    SLACK_API_BASE: `http://127.0.0.1:${api.address().port}`,
    RELAY_PORT: String(RELAY_PORT), MYNA_ANSWER_HOLD_MS: "800",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
for (let i = 0; ; i++) {
  try { await fetch(`${RELAY}/`, { signal: AbortSignal.timeout(500) }); break; }
  catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
}
await until(() => sock);

const ask = (args) => fetch(`${RELAY}/ask`, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());
async function answer(id) {
  for (;;) {
    const j = await (await fetch(`${RELAY}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json();
    if (j.kind !== "pending") return j;
  }
}
const answerOnce = (id) => fetch(`${RELAY}/answer/${id}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
let env = 0;
const send = (payload) => sock.send({ envelope_id: `env${++env}`, type: "interactive", payload });
const optBtn = (msg, i) => msg.blocks.find((b) => b.block_id === "myna_opts").elements[i];
const ctlBtn = (msg, action) => msg.blocks.find((b) => b.block_id === "myna_ctl").elements.find((e) => e.action_id === action);
const click = (msg, el, extra = {}) => send({ type: "block_actions", channel: { id: "C0AA" }, trigger_id: "tr1", actions: [{ action_id: el.action_id, value: el.value }], message: { ts: msg._ts }, ...extra });

// 1) selection: numbered button → {kind:"selection"} (+ envelope acked)
let { request_id } = await ask({ header: "t", question: "選一個?", options: ["甲", "乙"] });
let q = await until(() => posts.find((m) => m.blocks)); q._ts = "101.000";
ok(/\[t\]\n選一個\?\n1\. 甲\n2\. 乙/.test(q.blocks[0].text.text), "question section renders header + numbered options");
click(q, optBtn(q, 1));
let r = await answer(request_id);
ok(r.kind === "selection" && r.value === "乙", `button 2 → ${JSON.stringify(r)}`);
await until(() => acks.length >= 1);
ok(acks.length >= 1, `socket envelopes acked (${acks.length})`);
let confirm = await until(() => posts.find((m) => /你選了/.test(m.text || "")));
ok(confirm.thread_ts === "101.000", "confirmation threads onto the question message");

// 2) foreign-channel click is ignored (allowlist)
posts.length = 0;
({ request_id } = await ask({ question: "q2", options: ["A", "B"] }));
q = await until(() => posts.find((m) => m.blocks)); q._ts = "102.000";
click(q, optBtn(q, 0), { channel: { id: "C_EVIL" } });
r = await answerOnce(request_id);
ok(r.kind === "pending", "foreign-channel click did NOT resolve (answer still pending)");

// 3) ✍️ modal round-trip on the same request → {kind:"message"}
click(q, ctlBtn(q, "ask"));
const view = (await until(() => views.at(-1)))?.view;
ok(view?.private_metadata && view?.blocks?.[0]?.element?.type === "plain_text_input", "✍️ opens a modal (views.open with trigger_id)");
send({ type: "view_submission", view: { private_metadata: view.private_metadata, state: { values: { myna_q: { text: { value: "先解釋差異" } } } } } });
r = await answer(request_id);
ok(r.kind === "message" && r.text === "先解釋差異", `view_submission → ${JSON.stringify(r)}`);

// 4) ⏹ abort + thread_id reuse threads the second question
posts.length = 0;
({ request_id } = await ask({ question: "q3", options: ["A"], thread_id: "th1" }));
q = await until(() => posts.find((m) => m.blocks)); q._ts = "103.000";
const first = await ask({ question: "q3-again", options: ["A"], thread_id: "th1" });
const q2 = await until(() => posts.filter((m) => m.blocks).length >= 2 && posts.filter((m) => m.blocks).at(-1));
ok(!!q2.thread_ts, `same thread_id reuses thread_ts (${q2.thread_ts})`);
click(q, ctlBtn(q, "abort"));
r = await answer(request_id);
ok(r.kind === "aborted", `⏹ → ${JSON.stringify(r)}`);
await answerOnce(first.request_id).catch(() => {}); // drain

child.kill(); wsSrv.close(); api.close(); clearTimeout(watchdog);
console.log(failed === 0 ? "\n✅ SLACK-PROVIDER E2E PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
