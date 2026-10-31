#!/usr/bin/env node
// Autonomous e2e of the SESSION HANDOFF (detach / reattach): real bundled MCP servers
// (dist/ask-human.mjs — one per "Claude session") → real relay → real telegram provider → local
// Telegram API stub. Session A asks, hands the question off (detach_human) and ends; session B
// takes it over (await_human) and gets the human's answer — the phone's message, buttons and topic
// never change. Also: an answer given while nobody holds the question waits for the new session;
// a hand-off nobody takes over expires like a normal end; only the owner may hand off, and only a
// handed-off question (or the same session's orphan) may be taken over; a session that reconnects
// with the same id picks up what its dead process left; a detached question survives a relay restart.
// Isolated: random port, fake MYNA_ENV, own journal + topics file, stubbed Telegram on 127.0.0.1.
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
const serverPath = fileURLToPath(new URL(process.env.MYNA_SERVER ? `../${process.env.MYNA_SERVER}` : "../dist/ask-human.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return undefined; await sleep(50); } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 90s"); process.exit(1); }, 90000);

// --- Telegram API stub (the "human") -------------------------------------------
const sent = [], topicsCreated = [], topicsDeleted = [], markupEdits = [];
let updates = [], nextUpdateId = 1, mid = 100, nextTopic = 500;
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    if (/\/getUpdates$/.test(u.pathname)) {
      const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); };
      updates.length ? deliver() : setTimeout(deliver, 150);
      return;
    }
    if (/\/sendMessage$/.test(u.pathname)) { const m = ++mid; sent.push({ ...b, _mid: m }); json({ ok: true, result: { message_id: m } }); return; }
    if (/\/createForumTopic$/.test(u.pathname)) { topicsCreated.push(b); json({ ok: true, result: { message_thread_id: nextTopic++ } }); return; }
    if (/\/deleteForumTopic$/.test(u.pathname)) { topicsDeleted.push(b); json({ ok: true, result: true }); return; }
    if (/\/editMessageReplyMarkup$/.test(u.pathname)) { markupEdits.push(b); json({ ok: true, result: true }); return; }
    json({ ok: true, result: true });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const push = (u) => updates.push({ update_id: nextUpdateId++, ...u });
const keyboardFor = (question) => until(() => [...sent].reverse().find((s) => s.reply_markup?.inline_keyboard && s.text.includes(question)));
const tap = (kb, row, idx) => push({ callback_query: { id: `cq${nextUpdateId}`, data: kb.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 } } } });

// --- real relay (restartable: same journal + topics file) ------------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "myna-handoff-"));
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const TTL_S = 4;
let relay;
async function startRelay() {
  relay = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env,
      MYNA_ENV: path.join(scratch, "no-such.env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42",
      TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      RELAY_PORT: String(RELAY_PORT), MYNA_ANSWER_HOLD_MS: "1000",
      MYNA_TOPICS_FILE: path.join(scratch, "topics.json"), MYNA_PENDING_FILE: path.join(scratch, "pending.json"),
      TELEGRAM_TOPIC_ROUND_GRACE: "0", MYNA_DETACH_TTL: String(TTL_S), MYNA_ATTENDED_GRACE_MS: "800",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const up = await until(() => fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false), 8000);
  if (!up) { console.error("❌ relay never came up"); process.exit(1); }
}
async function stopRelay() {
  const gone = new Promise((r) => relay.once("exit", r));
  relay.kill(); await gone;
}
const health = () => fetch(`${RELAY}/health`).then((r) => r.json());
const requestsOf = (sid) => fetch(`${RELAY}/requests?session_id=${sid}`).then((r) => r.json()).then((j) => j.requests);
await startRelay();

// --- a "Claude session" = one MCP server process (bundled dist) with its own session id ----------
async function session(sid, name) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath],
    env: { ...process.env, MYNA_RELAY_URL: RELAY, MYNA_LOG_DIR: scratch, MYNA_AUTOPILOT_FILE: path.join(scratch, "no-autopilot"), MYNA_HEARTBEAT_MS: "5000", MYNA_ANSWER_POLL_MS: "5000", MYNA_SESSION_NAME: name, MYNA_TICKET: "", MYNA_SESSION_ID: sid },
    stderr: "ignore",
  });
  const c = new Client({ name: `handoff-${sid}`, version: "0" }, { capabilities: {} });
  await c.connect(transport);
  const tool = (name, args) => c.callTool({ name, arguments: args }, undefined, { timeout: 30000, resetTimeoutOnProgress: true })
    .then((r) => ({ isError: !!r.isError, ...(r.isError ? { text: r.content[0].text } : JSON.parse(r.content[0].text)) }));
  return {
    c, transport,
    ask: (args) => tool("ask_human", { logDir: scratch, ...args }),
    detach: (args = {}) => tool("detach_human", args),
    await: (args = {}) => tool("await_human", { logDir: scratch, ...args }),
  };
}

// the relay answers /ask with the request id only after the question is on the phone, so the keyboard
// can show up before the MCP server knows what it is waiting on — a detach right then finds nothing.
// Retry until it hands the question off (CI flake: "detach_human hands off … → undefined").
const detachWaiting = async (s) => (await until(async () => { const r = await s.detach(); return r.detached?.length ? r : undefined; }, 5000)) ?? { detached: [], failed: [] };

// tool list: ask_human first, plus the two handoff tools
{
  const s = await session("list-only", "list");
  const names = (await s.c.listTools()).tools.map((t) => t.name);
  ok(names.join(",") === "ask_human,detach_human,await_human", `tools listed: ${names.join(", ")}`);
  await s.c.close();
}

// 1) session A asks, hands the question off, ends → nothing on the phone changes
const A = await session("sess-A", "session A");
const askA = A.ask({ header: "scope", question: "Q1 要做 X 嗎?", options: ["要", "不要"], gate: "gate① scope", thread_id: "t-1" });
let kb = await keyboardFor("Q1");
const topic1 = kb.message_thread_id;
const dA = await detachWaiting(A);
const rid1 = dA.detached?.[0]?.request_id;
ok(dA.detached?.length === 1 && dA.detached[0].gate === "gate① scope" && dA.detached[0].thread_id === "t-1" && dA.detached[0].question === "Q1 要做 X 嗎?" && !!dA.detached[0].until && dA.failed.length === 0,
  `detach_human hands off A's waiting question with what B needs → ${JSON.stringify(dA.detached?.[0])}`);
const rA = await askA;
ok(rA.kind === "detached" && rA.request_id === rid1, `A's pending ask_human returns at once → ${JSON.stringify(rA)}`);
await A.c.close(); // A ends: stdin EOF → endSession (cancel inflight + /session/close)
await sleep(600);
let h = await health();
ok(markupEdits.length === 0 && !sent.some((s) => /已在終端機|已取消/.test(s.text || "")) && topicsDeleted.length === 0 && h.pending === 1 && h.detached === 1,
  `A ended: question NOT cancelled, buttons kept, topic kept (deleted=${topicsDeleted.length}, pending=${h.pending}, detached=${h.detached})`);

// 2) permission: only the owner may hand off; a question that was not handed off cannot be taken
const B = await session("sess-B", "session B");
const forged = await fetch(`${RELAY}/detach/${rid1}`, { method: "POST", body: JSON.stringify({ session_id: "sess-B" }) });
ok(forged.status === 403, `POST /detach by another session → ${forged.status}`);
const C = await session("sess-C", "session C");
const askC = C.ask({ question: "QC 不交出的題目?", options: ["a"], gate: "gate-c" });
const kbC = await keyboardFor("QC");
const ridC = (await requestsOf("sess-C"))[0]?.request_id;
const steal = await B.await({ request_id: ridC });
ok(steal.isError && /not detached/.test(steal.text), `await_human on a question that was not handed off → error (${steal.text})`);

// 3) session B takes A's question over → the human answers on the SAME message → B gets it
const awaitB = B.await({ request_id: rid1 });
await sleep(300);
tap(kb, 0, 1); // "不要"
const rB = await awaitB;
ok(rB.kind === "selection" && rB.value === "不要" && rB.request_id === rid1, `B's await_human returns the human's answer to A's question → ${JSON.stringify(rB)}`);
const topicsMap = JSON.parse(fs.readFileSync(path.join(scratch, "topics.json"), "utf8"));
ok(topicsMap["sess-B"]?.thread === topic1 && !topicsMap["sess-A"] && topicsDeleted.length === 0,
  `topic ${topic1} moved to B with the question; A's deferred close ran without deleting it`);
const log1 = fs.readFileSync(path.join(scratch, "MYNA-DECISIONS.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(log1.at(-1)?.chosen === "不要" && log1.at(-1)?.gate === "gate① scope" && log1.at(-1)?.reattached === rid1, "B logged the decision with the original gate/question");
// B's follow-up in the same gate stays in the same topic
const askB2 = B.ask({ question: "Q1b 追問?", options: ["ok"], thread_id: "t-1" });
kb = await keyboardFor("Q1b");
ok(kb.message_thread_id === topic1 && topicsCreated.length === 2, `B's follow-up lands in the same topic ${kb.message_thread_id} (no new topic)`);
tap(kb, 0, 0); await askB2;
await fetch(`${RELAY}/session/round-end`, { method: "POST", body: JSON.stringify({ session_id: "sess-B" }) });
await until(() => topicsDeleted.some((d) => d.message_thread_id === topic1), 3000);
ok(topicsDeleted.some((d) => d.message_thread_id === topic1), "B's round end ends the topic it took over");
tap(kbC, 0, 0); await askC; await C.c.close();

// 4) an answer given while nobody holds the question waits for the new session
const A2 = await session("sess-A2", "session A2");
const askA2 = A2.ask({ question: "Q2 先答後接?", options: ["好"], gate: "gate②" });
kb = await keyboardFor("Q2");
const rid2 = (await detachWaiting(A2)).detached?.[0]?.request_id;
await askA2; await A2.c.close();
tap(kb, 0, 0);
await until(() => sent.some((s) => s.text === "✅ 你選了:好"), 3000);
await sleep(300);
const early = await B.await({ request_id: rid2 });
ok(early.kind === "selection" && early.value === "好", `answered before anyone reattached → B still gets it → ${JSON.stringify(early)}`);

// 5) a detached question survives a relay restart (journal), then is taken over
const A3 = await session("sess-A3", "session A3");
const askA3 = A3.ask({ question: "Q3 重啟後接?", options: ["是"], gate: "gate③" });
kb = await keyboardFor("Q3");
const rid3 = (await detachWaiting(A3)).detached?.[0]?.request_id;
await askA3; await A3.c.close();
await stopRelay(); await startRelay();
h = await health();
ok(h.detached === 1 && (await requestsOf("sess-A3"))[0]?.detached === true, "relay restarted: the detached question was adopted from the journal");
const awaitB3 = B.await({ request_id: rid3 });
await sleep(300);
tap(kb, 0, 0);
const rB3 = await awaitB3;
ok(rB3.kind === "selection" && rB3.value === "是", `taken over after the restart, old button still answers → ${JSON.stringify(rB3)}`);

// 6) a hand-off nobody takes over expires like a normal end: buttons retracted, topic ended
const A4 = await session("sess-A4", "session A4");
const askA4 = A4.ask({ question: "Q4 沒人接?", options: ["x"], gate: "gate④" });
kb = await keyboardFor("Q4");
const rid4 = (await detachWaiting(A4)).detached?.[0]?.request_id;
await askA4; await A4.c.close();
const delBefore = topicsDeleted.length;
await until(() => sent.some((s) => /沒有 session 接手/.test(s.text || "")), (TTL_S + 3) * 1000);
await until(() => topicsDeleted.length > delBefore, 3000);
h = await health();
ok(markupEdits.some((m) => m.message_id === kb._mid) && sent.some((s) => /沒有 session 接手/.test(s.text || "")) && topicsDeleted.length > delBefore && h.detached === 0,
  `not reattached within MYNA_DETACH_TTL=${TTL_S}s → cancelled, buttons retracted, A4's deferred close ended the topic`);
const late = await B.await({ request_id: rid4 });
ok(late.isError && /expired/.test(late.text), `await_human after expiry → ${late.text || JSON.stringify(late)}`);

// 7) same session reconnects (process died without cancelling) → it picks up its own orphan
const R1 = await session("sess-R", "session R");
const askR = R1.ask({ question: "Q5 程序掛了?", options: ["繼續"], gate: "gate⑤" }).catch(() => "dead");
kb = await keyboardFor("Q5");
const R2 = await session("sess-R", "session R (reconnected)");
const busyR = await R2.await({});
ok(busyR.kind === "none", `while the first process still polls, it is not an orphan → ${JSON.stringify(busyR)}`);
const ridR = (await requestsOf("sess-R"))[0]?.request_id;
const busyR2 = await R2.await({ request_id: ridR });
ok(busyR2.isError && /still waiting/.test(busyR2.text), `explicit reattach while another process of the session polls → ${busyR2.text}`);
process.kill(R1.transport.pid, "SIGKILL"); // crash: no cancel, no /session/close
await askR;
await until(async () => (await requestsOf("sess-R"))[0]?.attended === false, 5000);
const awaitR = R2.await({});
await sleep(300);
tap(kb, 0, 0);
const rR = await awaitR;
ok(rR.kind === "selection" && rR.value === "繼續" && rR.request_id === ridR, `reconnected session (same id) reattached its orphan without an id → ${JSON.stringify(rR)}`);
await R2.c.close(); await B.c.close();

h = await health();
ok(h.pending === 0 && h.detached === 0, `nothing left open at the relay (pending=${h.pending}, detached=${h.detached})`);
await stopRelay(); stub.close(); clearTimeout(watchdog);
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ HANDOFF E2E PASS (detach → reattach, expiry, permissions, reconnect, restart)" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
