#!/usr/bin/env node
// Autonomous FULL-CHAIN e2e: real bundled MCP tool (dist/ask-human.mjs, driven over MCP like
// Claude Code does) → real relay → real telegram provider → local Telegram API stub → "human"
// taps a button / types a reply → discriminated result returns from the TOOL CALL itself.
// Covers the whole pipeline a live gate walks through, including the multi-round loop
// (✍️ message → orchestrator re-asks with preamble + same thread_id → selection) and the
// decision log side-effect.
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
const serverPath = fileURLToPath(new URL("../dist/ask-human.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("until: timeout"); await new Promise((r) => setTimeout(r, 50)); } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 40s"); process.exit(1); }, 40000);

// --- Telegram API stub (the "human") -------------------------------------------
const sent = [], topicsCreated = [], topicsClosed = [], topicsRenamed = [], topicsDeleted = [];
let updates = [], nextUpdateId = 1, mid = 100;
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (/\/getUpdates$/.test(u.pathname)) {
      const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); };
      updates.length ? deliver() : setTimeout(deliver, 150);
      return;
    }
    if (/\/sendMessage$/.test(u.pathname)) { sent.push(JSON.parse(body || "{}")); json({ ok: true, result: { message_id: ++mid } }); return; }
    if (/\/createForumTopic$/.test(u.pathname)) { topicsCreated.push(JSON.parse(body || "{}")); json({ ok: true, result: { message_thread_id: 777 } }); return; }
    if (/\/editForumTopic$/.test(u.pathname)) { topicsRenamed.push(JSON.parse(body || "{}")); json({ ok: true, result: true }); return; }
    if (/\/deleteForumTopic$/.test(u.pathname)) { topicsDeleted.push(JSON.parse(body || "{}")); json({ ok: true, result: true }); return; }
    if (/\/closeForumTopic$/.test(u.pathname)) { topicsClosed.push(JSON.parse(body || "{}")); json({ ok: true, result: true }); return; }
    json({ ok: true, result: {} });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const push = (u) => updates.push({ update_id: nextUpdateId++, ...u });
const lastKeyboard = () => until(() => [...sent].reverse().find((s) => s.reply_markup?.inline_keyboard));
const tap = (kb, row, idx) => push({ callback_query: { id: `cq${nextUpdateId}`, data: kb.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 } } } });

// --- real relay ----------------------------------------------------------------
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const relay = spawn(process.execPath, [relayPath], {
  env: {
    ...process.env,
    MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"), MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
    RELAY_PORT: String(RELAY_PORT), MYNA_ANSWER_HOLD_MS: "1500",
    MYNA_TOPICS_FILE: path.join(os.tmpdir(), `myna-topics-fullchain-${process.pid}.json`),
    // own journal: the default (next to MYNA_ENV, i.e. $TMPDIR/relay-pending.json) is shared by every
    // run and would adopt open gates a previous run left behind
    MYNA_PENDING_FILE: path.join(os.tmpdir(), `myna-pending-fullchain-${process.pid}.json`),
    TELEGRAM_TOPIC_ROUND_GRACE: "0", // round-end ends the topic right away here (the grace itself is covered by smoke-telegram-provider)
  },
  stdio: ["ignore", "inherit", "inherit"],
});
for (let i = 0; ; i++) {
  try { await fetch(`${RELAY}/`, { signal: AbortSignal.timeout(500) }); break; }
  catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
}

// --- real MCP tool (bundled dist), like Claude Code drives it -------------------
const scratch = path.join(os.tmpdir(), "myna-full-chain-" + process.pid);
fs.mkdirSync(scratch, { recursive: true });
const transport = new StdioClientTransport({
  command: process.env.MYNA_NODE || process.execPath, args: [serverPath],
  env: { ...process.env, MYNA_RELAY_URL: RELAY, MYNA_LOG_DIR: scratch, MYNA_AUTOPILOT_FILE: path.join(scratch, "no-autopilot"), MYNA_HEARTBEAT_MS: "5000", MYNA_ANSWER_POLL_MS: "5000", MYNA_SESSION_NAME: "full-chain session", MYNA_TICKET: "", MYNA_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "cc-session-e2e" },
  stderr: "ignore",
});
const c = new Client({ name: "full-chain", version: "0" }, { capabilities: {} });
await c.connect(transport);
const call = (args) => c.callTool({ name: "ask_human", arguments: args }, undefined, { timeout: 30000, resetTimeoutOnProgress: true }).then((r) => JSON.parse(r.content[0].text));

// round 1: tool blocks → human taps ✍️ and types a clarifying question → {kind:"message"}
const round1 = call({ header: "AC scope", question: "要包含 X 嗎?", options: ["要 (Recommended)", "不要"], thread_id: "gate-e2e-1", logDir: scratch });
let kb = await lastKeyboard();
// the MCP server tagged the ask with its session → the relay opened ONE topic for it and the question lives there
ok(topicsCreated.length === 1 && topicsCreated[0].name === "full-chain session" && kb.message_thread_id === 777,
  `session topic created (name from MYNA_SESSION_NAME) and question routed into it → thread ${kb.message_thread_id}`);
tap(kb, 1, 0); // ✍️
await until(() => sent.some((s) => s.reply_markup?.force_reply));
push({ message: { chat: { id: 42 }, text: "X 是指哪個 X?" } });
let r = await round1;
ok(r.kind === "message" && r.text === "X 是指哪個 X?", `round 1: tool call returned the human's clarifying question → ${JSON.stringify(r)}`);

// round 2: orchestrator loop — re-ask with preamble + SAME thread_id → human taps 1 → selection
sent.length = 0;
const round2 = call({ header: "AC scope", question: "要包含 X 嗎?", options: ["要 (Recommended)", "不要"], thread_id: "gate-e2e-1", preamble: "X 指的是 API 層的 X。", logDir: scratch, ticket: "PROJ-2499" });
kb = await lastKeyboard();
ok(topicsRenamed.length === 1 && topicsRenamed[0].message_thread_id === 777 && topicsRenamed[0].name === "PROJ-2499 · full-chain session",
  `round 2 passes ticket → topic relabelled "${topicsRenamed[0]?.name}"`);
ok(sent.some((s) => s.text === "X 指的是 API 層的 X。"), "round 2: preamble delivered as its own message");
ok(!!kb.reply_parameters?.message_id, "round 2: same thread_id threads onto the round-1 message (reply_to)");
ok(topicsCreated.length === 1 && kb.message_thread_id === 777 && sent.every((s) => s.message_thread_id === 777), "round 2: still the same session topic, every message in it");
tap(kb, 0, 0);
r = await round2;
ok(r.kind === "selection" && r.value === "要 (Recommended)", `round 2: tool call returned the tapped selection → ${JSON.stringify(r)}`);

// round 3: the session moves on to ANOTHER ticket (explicit `ticket` again — the header is never
// sniffed for a key) → the same topic is re-labelled again (no new topic)
sent.length = 0;
const round3 = call({ header: "PROJ-1247 review", question: "merge?", options: ["yes"], logDir: scratch, ticket: "PROJ-1247" });
kb = await lastKeyboard();
tap(kb, 0, 0);
r = await round3;
ok(r.kind === "selection" && topicsCreated.length === 1 && topicsRenamed.length === 2 && topicsRenamed[1].name === "PROJ-1247 · full-chain session" && kb.message_thread_id === 777,
  `round 3: next ticket (explicit arg) → same topic relabelled "${topicsRenamed[1]?.name}", still one topic`);

// round 4: the AI tags a decision with `gate` → that gate gets its own topic named after it and the
// previous (gate-less) topic ends. Then Claude finishes its reply → the Stop hook POSTs
// /session/round-end with Claude's session id — the MCP server used CLAUDE_CODE_SESSION_ID, so the
// ids match and the gate's topic ends too.
sent.length = 0;
const round4 = call({ header: "deploy", question: "上線?", options: ["yes"], gate: "gate④ deploy", logDir: scratch });
kb = await lastKeyboard();
tap(kb, 0, 0);
r = await round4;
await until(() => topicsDeleted.length === 1, 5000).catch(() => {});
ok(r.kind === "selection" && topicsCreated.length === 2 && topicsCreated[1].name === "gate④ deploy · PROJ-1247 · full-chain session" && topicsDeleted.length === 1,
  `round 4: gate → own topic "${topicsCreated[1]?.name}", previous topic ended`);
const re = await fetch(`${RELAY}/session/round-end`, { method: "POST", body: JSON.stringify({ session_id: "cc-session-e2e" }) }).then((x) => x.json());
await until(() => topicsDeleted.length === 2, 5000).catch(() => {});
ok(re.ended === true && topicsDeleted.length === 2, "reply ended: /session/round-end keyed by CLAUDE_CODE_SESSION_ID (what the Stop hook sends) → gate topic deleted");

// side-effect: the human decisions were logged (the gate travels with its decision)
const jsonl = fs.readFileSync(path.join(scratch, "MYNA-DECISIONS.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(jsonl.length === 3 && jsonl[0].mode === "human" && jsonl[0].chosen === "要 (Recommended)", `decision logged (mode=human) → ${JSON.stringify(jsonl[0]?.chosen)}`);
ok(jsonl[2].gate === "gate④ deploy" && jsonl[0].gate === undefined, "decision log records the gate when one was given");

// the human answers in the TERMINAL instead (Esc → Claude Code cancels the tool call) → the MCP
// server cancels the request at the relay → the phone's buttons are retracted, nothing stays open
sent.length = 0;
const ctl = new AbortController();
const cancelled = c.callTool({ name: "ask_human", arguments: { question: "終端機回答?", options: ["a", "b"], gate: "gate-x terminal", logDir: scratch } },
  undefined, { timeout: 30000, signal: ctl.signal }).then(() => "resolved", () => "rejected");
kb = await lastKeyboard();
ctl.abort();
await until(() => sent.some((s) => /已在終端機/.test(s.text || "")), 5000).catch(() => {});
let hc = await fetch(`${RELAY}/health`).then((x) => x.json());
ok((await cancelled) === "rejected" && sent.some((s) => /已在終端機/.test(s.text || "")) && hc.pending === 0,
  `tool call cancelled (answered in the terminal) → request cancelled at the relay, phone told, pending=${hc.pending}`);

// session end with a question still unanswered: closing the MCP client (stdin EOF, like Claude Code
// exiting) → the server cancels its own open request, then POST /session/close → the gate topic is
// deleted right away (a dead process's question must not keep the close deferred)
sent.length = 0;
const round5 = call({ question: "收尾?", options: ["ok"], gate: "gate⑤ wrap-up", logDir: scratch }).catch(() => "closed");
kb = await lastKeyboard();
await until(() => topicsDeleted.length === 3, 5000).catch(() => {}); // gate switch ended the cancelled gate-x topic
await c.close();
await round5;
await until(() => topicsDeleted.length === 4, 5000).catch(() => {});
hc = await fetch(`${RELAY}/health`).then((x) => x.json());
ok(topicsDeleted.length === 4 && topicsClosed.length === 0 && hc.pending === 0,
  `MCP server exit with an unanswered question → it is cancelled, then /session/close deletes the gate topic (deleted=${topicsDeleted.length}, pending=${hc.pending})`);
relay.kill(); stub.close(); clearTimeout(watchdog);
try { fs.unlinkSync(path.join(os.tmpdir(), `myna-topics-fullchain-${process.pid}.json`)); } catch {}
try { fs.unlinkSync(path.join(os.tmpdir(), `myna-pending-fullchain-${process.pid}.json`)); } catch {}
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ FULL-CHAIN E2E PASS (MCP tool → relay → IM → human → tool return)" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
