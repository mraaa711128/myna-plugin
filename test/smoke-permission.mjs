#!/usr/bin/env node
// Autonomous e2e of permission forwarding: the REAL PermissionRequest hook (scripts/permission-request.mjs)
// → the REAL relay → a local Telegram API stub. No phone, no bot, no Claude Code: the hook gets the
// JSON Claude Code would send on stdin, and a fake transcript stands in for the session.
// Proves: phone ✅/❌/✍️/⏹ → the hook's decision; the terminal answering first (during the delay, or
// after the phone was asked) → no decision and the phone's buttons retracted; earlier identical calls
// don't count as answered; SIGTERM retracts; the relay's round end cancels a prompt whose hook died;
// relay down / flag off → the hook abstains at once; the prompt joins the session's topic unrenamed;
// a background subagent's prompt (agent_id) outlives the main thread's round end, is cancelled at the
// session end or by the orphan sweep, and only the subagent's own transcript counts as its answer.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
const hookPath = fileURLToPath(new URL("../scripts/permission-request.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 180s"); process.exit(1); }, 180000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myna-perm-test-"));

// --- Telegram API stub -------------------------------------------------------------------------
const sent = [], markupEdits = [], renamed = [], created = [], deletedTopics = [];
let updates = [], nextUpdateId = 1, mid = 100, nextTopic = 700, sendDelayMs = 0; // sendDelayMs: a slow Telegram
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    if (/\/getUpdates$/.test(u.pathname)) { const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); }; return updates.length ? deliver() : setTimeout(deliver, 150); }
    if (/\/sendMessage$/.test(u.pathname)) { b.message_id = ++mid; sent.push(b); return setTimeout(() => json({ ok: true, result: { message_id: b.message_id } }), b.reply_markup ? sendDelayMs : 0); }
    if (/\/createForumTopic$/.test(u.pathname)) { created.push(b); return json({ ok: true, result: { message_thread_id: ++nextTopic, name: b.name } }); }
    if (/\/editForumTopic$/.test(u.pathname)) { renamed.push(b); return json({ ok: true, result: true }); }
    if (/\/deleteForumTopic$/.test(u.pathname)) { deletedTopics.push(b.message_thread_id); return json({ ok: true, result: true }); }
    if (/\/editMessageReplyMarkup$/.test(u.pathname)) { markupEdits.push(b); return json({ ok: true, result: true }); }
    json({ ok: true, result: true });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));

// --- real relay ----------------------------------------------------------------------------------
const PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${PORT}`;
const relay = spawn(process.execPath, [relayPath], {
  env: {
    ...process.env, MYNA_ENV: path.join(tmp, "no-such-env"), MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
    RELAY_PORT: String(PORT), MYNA_ANSWER_HOLD_MS: "1000", TELEGRAM_TOPIC_ROUND_GRACE: "0",
    MYNA_TOPICS_FILE: path.join(tmp, "topics.json"), MYNA_PENDING_FILE: path.join(tmp, "pending.json"), MYNA_TELEGRAM_CHAT_FILE: path.join(tmp, "chat.json"),
  },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; ; i++) {
  try { await fetch(`${RELAY}/`, { signal: AbortSignal.timeout(500) }); break; }
  catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await sleep(100); }
}

// --- helpers -------------------------------------------------------------------------------------
const FLAG = path.join(tmp, "permission");
let tn = 0;
// a fake transcript: [{use: id, input}] / [{result: id}] entries, appended as Claude Code would
function transcript(entries = []) {
  const file = path.join(tmp, `t${++tn}.jsonl`);
  fs.writeFileSync(file, "");
  const add = (e) => fs.appendFileSync(file, JSON.stringify(e.use
    ? { type: "assistant", message: { content: [{ type: "tool_use", id: e.use, name: e.name || "Bash", input: e.input }] } }
    : { type: "user", message: { content: [{ type: "tool_result", tool_use_id: e.result, content: "" }] } }) + "\n");
  entries.forEach(add);
  return { file, add };
}
function runHook(input, { delay = 0, port = PORT, envFile } = {}) {
  const env = { ...process.env, MYNA_ENV: envFile || path.join(tmp, "no-such-env"), RELAY_PORT: String(port), MYNA_RELAY_URL: "", MYNA_PERMISSION_FILE: FLAG, MYNA_PERMISSION_DELAY: String(delay), MYNA_PERMISSION_WATCH_MS: "200" };
  if (delay === null) delete env.MYNA_PERMISSION_DELAY; // read it from the env file instead
  const c = spawn(process.execPath, [hookPath], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  delete c.env;
  let out = ""; c.stdout.on("data", (d) => (out += d));
  const t0 = Date.now();
  const done = new Promise((r) => c.on("exit", (code, sig) => r({ code, sig, out, ms: Date.now() - t0, decision: (() => { try { return JSON.parse(out).hookSpecificOutput.decision; } catch { return null; } })() })));
  c.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s-perm", cwd: "/work/myproj", permission_mode: "default", ...input }));
  return { c, done };
}
const cmdInput = (cmd) => ({ command: cmd, description: "test step" });
async function keyboardFor(text) {
  for (let i = 0; i < 60; i++) {
    const m = [...sent].reverse().find((s) => s.reply_markup?.inline_keyboard && (s.text || "").includes(text));
    if (m) return m;
    await sleep(100);
  }
  return null;
}
const push = (u) => updates.push({ update_id: nextUpdateId++, ...u });
const tap = (kb, row, idx) => push({ callback_query: { id: `cq${nextUpdateId}`, data: kb.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 }, ...(kb.message_thread_id ? { message_thread_id: kb.message_thread_id } : {}) } } });
const retracted = (kb) => markupEdits.some((e) => e.message_id && e.reply_markup?.inline_keyboard?.length === 0) && sent.some((s) => /已在終端機/.test(s.text || "") && s.message_thread_id === kb.message_thread_id);

// 1) relay down → abstain at once
{
  const t = transcript([{ use: "a1", input: cmdInput("echo 1") }]);
  const r = await runHook({ tool_name: "Bash", tool_input: cmdInput("echo 1"), transcript_path: t.file }, { port: 9 }).done;
  ok(r.code === 0 && r.out === "" && r.ms < 8000, `relay down → the hook abstains (exit 0, no output) in ${r.ms} ms — the terminal dialog works as usual`);
}

// 2) flag off → abstain, nothing sent
{
  fs.writeFileSync(FLAG, "off\n");
  const n = sent.length;
  const r = await runHook({ tool_name: "Bash", tool_input: cmdInput("echo 2") }).done;
  ok(r.code === 0 && r.out === "" && sent.length === n, "/myna:perm off → the hook abstains, nothing reaches the phone");
  fs.rmSync(FLAG);
}

// 3–6) phone answers: ✅ / ❌ / ✍️ / ⏹
for (const [label, act, check] of [
  ["✅ allow", (kb) => tap(kb, 0, 0), (d) => d?.behavior === "allow"],
  ["❌ deny", (kb) => tap(kb, 0, 1), (d) => d?.behavior === "deny" && /denied this on their phone/.test(d.message)],
  ["✍️ text", async (kb) => { tap(kb, 1, 0); for (let i = 0; i < 40 && !sent.some((s) => s.reply_markup?.force_reply); i++) await sleep(100); push({ message: { chat: { id: 42 }, ...(kb.message_thread_id ? { message_thread_id: kb.message_thread_id } : {}), text: "改用 pnpm" } }); },
    (d) => d?.behavior === "deny" && /改用 pnpm/.test(d.message)],
  ["⏹ stop", (kb) => tap(kb, 1, 1), (d) => d?.behavior === "deny" && d.interrupt === true],
]) {
  sent.length = 0;
  const cmd = `npm test -- ${label}`;
  const t = transcript([{ use: `u-${label}`, input: cmdInput(cmd) }]);
  const h = runHook({ tool_name: "Bash", tool_input: cmdInput(cmd), transcript_path: t.file });
  const kb = await keyboardFor(cmd);
  if (label === "✅ allow") ok(!!kb && /🔐 權限確認/.test(kb.text) && /Bash/.test(kb.text) && /myproj/.test(kb.text) && /test step/.test(kb.text),
    `the phone gets the tool, the command, its description and the project → ${JSON.stringify(kb?.text)}`);
  await act(kb);
  const r = await h.done;
  ok(check(r.decision), `phone ${label} → hook decision ${JSON.stringify(r.decision)}`);
}

// 7) the terminal answers during the delay → the phone never hears of it
{
  const n = sent.length;
  const t = transcript([{ use: "d7", input: cmdInput("echo seven") }]);
  const h = runHook({ tool_name: "Bash", tool_input: cmdInput("echo seven"), transcript_path: t.file }, { delay: 3 });
  await sleep(500); t.add({ result: "d7" });
  const r = await h.done;
  ok(r.code === 0 && r.out === "" && r.ms < 2500 && !sent.slice(n).some((s) => /echo seven/.test(s.text || "")),
    `terminal answered within the delay → hook exits (${r.ms} ms), nothing sent to the phone`);
}

// 8) an earlier identical call is not "answered"; the terminal answering after the phone was asked retracts it
{
  sent.length = 0; markupEdits.length = 0;
  const t = transcript([{ use: "old8", input: cmdInput("echo eight") }, { result: "old8" }, { use: "new8", input: cmdInput("echo eight") }]);
  const h = runHook({ tool_name: "Bash", tool_input: cmdInput("echo eight"), transcript_path: t.file }, { delay: 1 });
  const kb = await keyboardFor("echo eight");
  ok(!!kb, "the same command answered earlier in the session doesn't count — this one still goes to the phone");
  t.add({ result: "new8" });
  const r = await h.done;
  for (let i = 0; i < 30 && !retracted(kb); i++) await sleep(100);
  ok(r.out === "" && retracted(kb), "…the terminal then answers → no decision, the phone's buttons are retracted (\"已在終端機處理\")");
}

// 9) SIGTERM (a terminal \"No\" in the TUI, the hook timeout, the session ending) → retract
{
  sent.length = 0; markupEdits.length = 0;
  const h = runHook({ tool_name: "Bash", tool_input: cmdInput("echo nine") });
  const kb = await keyboardFor("echo nine");
  h.c.kill("SIGTERM");
  const r = await h.done;
  for (let i = 0; i < 30 && !retracted(kb); i++) await sleep(100);
  ok(r.out === "" && retracted(kb), "SIGTERM → the hook retracts the phone's question before it exits");
}

// 10) the hook died without a word (SIGKILL) → the round end cancels its prompt; it holds nothing open
{
  sent.length = 0; markupEdits.length = 0;
  const h = runHook({ tool_name: "Bash", tool_input: cmdInput("echo ten") });
  const kb = await keyboardFor("echo ten");
  h.c.kill("SIGKILL"); await h.done;
  const re = await fetch(`${RELAY}/session/round-end`, { method: "POST", body: JSON.stringify({ session_id: "s-perm" }) }).then((r) => r.json());
  for (let i = 0; i < 30 && !retracted(kb); i++) await sleep(100);
  ok(re.ended === true && retracted(kb), `relay round end cancels a permission prompt whose hook is gone, and the round still ends → ${JSON.stringify(re)}`);
}

// 11) topic: joins the session's current topic without renaming it; a session without one gets "<dir> <time>"
{
  sent.length = 0; renamed.length = 0; created.length = 0;
  const g = await fetch(`${RELAY}/ask`, { method: "POST", body: JSON.stringify({ question: "gate q", options: ["A"], session_id: "s-topic", session_name: "PROJ-1 · myproj 10/16 09:00", gate: "Design" }) }).then((r) => r.json());
  const gkb = await keyboardFor("gate q");
  const h = runHook({ session_id: "s-topic", tool_name: "Bash", tool_input: cmdInput("echo eleven") });
  const kb = await keyboardFor("echo eleven");
  ok(kb?.message_thread_id === gkb?.message_thread_id && created.length === 1 && renamed.length === 0,
    "a permission prompt joins the session's current gate topic and never renames it");
  tap(kb, 0, 0); await h.done; tap(gkb, 0, 0);
  for (;;) { const j = await (await fetch(`${RELAY}/answer/${g.request_id}`)).json(); if (j.kind !== "pending") break; }
  const h2 = runHook({ session_id: "s-fresh", tool_name: "Bash", tool_input: cmdInput("echo twelve") });
  const kb2 = await keyboardFor("echo twelve");
  ok(created.some((c) => /^myproj \d\d\/\d\d \d\d:\d\d$/.test(c.name)) && kb2?.message_thread_id,
    `…a session with no topic yet gets one named "<dir> <time>" → ${JSON.stringify(created.map((c) => c.name))}`);
  tap(kb2, 0, 1); await h2.done;
}

// 12) MYNA_PERMISSION_DELAY from ~/.myna/.env (no process env) → the phone is asked only after it
{
  sent.length = 0;
  const envFile = path.join(tmp, "myna.env");
  fs.writeFileSync(envFile, "MYNA_PERMISSION_DELAY=2\n");
  const t0 = Date.now();
  const h = runHook({ tool_name: "Bash", tool_input: cmdInput("echo thirteen") }, { delay: null, envFile });
  const kb = await keyboardFor("echo thirteen");
  const waited = Date.now() - t0;
  ok(!!kb && waited >= 1900, `MYNA_PERMISSION_DELAY=2 in ~/.myna/.env → the phone is asked after ${waited} ms`);
  tap(kb, 0, 1); await h.done;
}

// 13–17) a background subagent's prompt (the hook input carries agent_id): its dialog can outlive the
// main thread's turn, so the round end leaves it on the phone; the session end, the hook itself, or the
// orphan sweep retract it; the terminal's answer is looked for in the subagent's own transcript only
const AGENT = "a0f1e2d3c4b5a6978";
let mn = 0;
// a main transcript <tmp>/mainN.jsonl and the subagent's <tmp>/mainN/subagents/agent-<id>.jsonl (not created yet)
function sessionFiles() {
  const main = transcript();
  const subFile = path.join(main.file.replace(/\.jsonl$/, ""), "subagents", `agent-${AGENT}.jsonl`);
  const sub = (e) => { fs.mkdirSync(path.dirname(subFile), { recursive: true }); fs.appendFileSync(subFile, JSON.stringify(e.use
    ? { type: "assistant", message: { content: [{ type: "tool_use", id: e.use, name: "Bash", input: e.input }] } }
    : { type: "user", message: { content: [{ type: "tool_result", tool_use_id: e.result, content: "" }] } }) + "\n"); };
  return { main, sub, n: ++mn };
}
const workerHook = (cmd, transcript_path, extra = {}) => runHook({ session_id: "s-worker", agent_id: AGENT, tool_name: "Bash", tool_input: cmdInput(cmd), ...(transcript_path ? { transcript_path } : {}), ...extra });
const answerOf = (id) => fetch(`${RELAY}/requests?session_id=s-worker`).then((r) => r.json()).then((j) => j.requests.find((q) => q.request_id === id));
const lastAskId = async (cmd) => { for (let i = 0; i < 40; i++) { const j = await fetch(`${RELAY}/requests?session_id=s-worker`).then((r) => r.json()); const q = j.requests.find((x) => (x.question || "").includes(cmd)); if (q) return q.request_id; await sleep(100); } return null; };

// 13) round end → the worker's prompt stays (buttons, open, ended:false); the phone's ✅ still reaches the hook
{
  sent.length = 0; markupEdits.length = 0;
  const h = workerHook("echo worker13");
  const kb = await keyboardFor("echo worker13");
  const id = await lastAskId("echo worker13");
  const q = await answerOf(id);
  ok(q?.agent_id === AGENT, `the worker's prompt reaches the relay marked with its agent_id → ${JSON.stringify(q?.agent_id)}`);
  const re = await fetch(`${RELAY}/session/round-end`, { method: "POST", body: JSON.stringify({ session_id: "s-worker" }) }).then((r) => r.json());
  await sleep(400);
  ok(re.ended === false && markupEdits.length === 0 && (await answerOf(id))?.answered === false,
    `round end leaves a background subagent's prompt on the phone and the round open → ${JSON.stringify(re)}, retractions=${markupEdits.length}`);
  tap(kb, 0, 0);
  const r = await h.done;
  ok(r.decision?.behavior === "allow", `…the phone's ✅ after the round end still reaches the worker's hook → ${JSON.stringify(r.decision)}`);
}

// 14) the main thread's prompt in the same round end is still cancelled (its behavior is unchanged)
{
  sent.length = 0; markupEdits.length = 0;
  const w = workerHook("echo worker14");
  const kw = await keyboardFor("echo worker14");
  const m = runHook({ session_id: "s-worker", tool_name: "Bash", tool_input: cmdInput("echo main14") });
  const km = await keyboardFor("echo main14");
  m.c.kill("SIGKILL"); await m.done;
  const re = await fetch(`${RELAY}/session/round-end`, { method: "POST", body: JSON.stringify({ session_id: "s-worker" }) }).then((r) => r.json());
  for (let i = 0; i < 30 && !markupEdits.some((e) => e.message_id === km?.message_id); i++) await sleep(100);
  ok(re.ended === false && markupEdits.some((e) => e.message_id === km?.message_id) && !markupEdits.some((e) => e.message_id === kw?.message_id),
    `same round end: the main thread's prompt is cancelled, the worker's stays → ${JSON.stringify(re)}`);
  tap(kw, 0, 1); await w.done;
}

// 15) session end → the worker's prompt is cancelled (the hook abstains: the terminal decides)
{
  sent.length = 0; markupEdits.length = 0;
  const h = workerHook("echo worker15");
  const kb = await keyboardFor("echo worker15");
  await fetch(`${RELAY}/session/close`, { method: "POST", body: JSON.stringify({ session_id: "s-worker" }) });
  const r = await h.done;
  for (let i = 0; i < 30 && !markupEdits.some((e) => e.message_id === kb?.message_id); i++) await sleep(100);
  ok(r.out === "" && markupEdits.some((e) => e.message_id === kb?.message_id), "session end cancels a background subagent's prompt too (buttons retracted, the hook abstains)");
}

// 16) the terminal's answer: only the subagent's own transcript counts
{
  // a) the result shows up in <session>/subagents/agent-<id>.jsonl → retracted, no decision
  sent.length = 0; markupEdits.length = 0;
  const f = sessionFiles();
  f.sub({ use: "w16a", input: cmdInput("echo worker16a") });
  const h = workerHook("echo worker16a", f.main.file);
  const kb = await keyboardFor("echo worker16a");
  f.sub({ result: "w16a" });
  const r = await h.done;
  for (let i = 0; i < 30 && !retracted(kb); i++) await sleep(100);
  ok(r.out === "" && retracted(kb), "the terminal answers a worker's prompt (result in its own subagents/agent-<id>.jsonl) → no decision, the phone's buttons retracted");
}
{
  // b) the same call and result only in the main transcript → not taken as the worker's answer
  sent.length = 0; markupEdits.length = 0;
  const f = sessionFiles();
  f.main.add({ use: "m16b", input: cmdInput("echo worker16b") });
  const h = workerHook("echo worker16b", f.main.file);
  const kb = await keyboardFor("echo worker16b");
  f.main.add({ result: "m16b" });
  await sleep(1200);
  ok(!retracted(kb), "the same call answered in the MAIN transcript does not retract a worker's prompt");
  tap(kb, 0, 1);
  const r = await h.done;
  ok(r.decision?.behavior === "deny", `…it was still waiting on the phone (❌ → ${JSON.stringify(r.decision)})`);
}
{
  // c) no subagent transcript at all → still asks, no error, the phone decides
  sent.length = 0; markupEdits.length = 0;
  const f = sessionFiles();
  const h = workerHook("echo worker16c", f.main.file);
  const kb = await keyboardFor("echo worker16c");
  await sleep(800);
  ok(!!kb && !retracted(kb), "no subagent transcript yet → the worker's prompt still goes to the phone and stays");
  tap(kb, 0, 0);
  const r = await h.done;
  ok(r.decision?.behavior === "allow", `…and the phone's ✅ reaches it → ${JSON.stringify(r.decision)}`);
}

// 17) a worker's hook that died without a word (SIGKILL — how a stopped subagent's hook ends on Windows):
// the next round end cancels it once nobody polls for it; with no round end at all, the orphan sweep does
// (a second relay with a short MYNA_ATTENDED_GRACE_MS / MYNA_ORPHAN_TTL; same stub)
{
  sent.length = 0; markupEdits.length = 0;
  relay.kill(); // from here on only the second relay polls the stub (a tap must reach the relay that asked)
  const PORT2 = PORT + 1;
  const relay2 = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env, MYNA_ENV: path.join(tmp, "no-such-env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      RELAY_PORT: String(PORT2), MYNA_ANSWER_HOLD_MS: "1000", TELEGRAM_TOPIC_ROUND_GRACE: "0",
      MYNA_TOPICS_FILE: path.join(tmp, "topics2.json"), MYNA_PENDING_FILE: path.join(tmp, "pending2.json"), MYNA_TELEGRAM_CHAT_FILE: path.join(tmp, "chat2.json"),
      MYNA_ORPHAN_TTL: "4", MYNA_ATTENDED_GRACE_MS: "300", MYNA_SWEEP_MS: "200",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${PORT2}/`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (i > 40) { console.error("❌ second relay never came up"); process.exit(1); } await sleep(100); }
  }
  const roundEnd2 = (sid) => fetch(`http://127.0.0.1:${PORT2}/session/round-end`, { method: "POST", body: JSON.stringify({ session_id: sid }) }).then((r) => r.json());
  const g = runHook({ session_id: "s-worker3", agent_id: AGENT, tool_name: "Bash", tool_input: cmdInput("echo worker17a") }, { port: PORT2 });
  const kg = await keyboardFor("echo worker17a");
  g.c.kill("SIGKILL"); await g.done;
  await sleep(2000); // its last held poll (MYNA_ANSWER_HOLD_MS) has run out + MYNA_ATTENDED_GRACE_MS: nobody polls for it any more
  const re = await roundEnd2("s-worker3");
  for (let i = 0; i < 30 && !markupEdits.some((e) => e.message_id === kg?.message_id); i++) await sleep(100);
  ok(re.ended === true && markupEdits.some((e) => e.message_id === kg?.message_id), `a stopped worker's prompt (its hook killed, nobody polling) is cancelled at the next round end, and the round ends → ${JSON.stringify(re)}`);
  // the round end comes right after the stop, while its last poll still counts as attended → left open,
  // then the sweep finishes that round end once nobody polls: prompt retracted, the round's topic ended
  const k = runHook({ session_id: "s-worker4", agent_id: AGENT, tool_name: "Bash", tool_input: cmdInput("echo worker17c") }, { port: PORT2 });
  const kk = await keyboardFor("echo worker17c");
  k.c.kill("SIGKILL"); await k.done;
  const re2 = await roundEnd2("s-worker4");
  ok(re2.ended === false && !markupEdits.some((e) => e.message_id === kk?.message_id), `a round end right after the stop (its last poll still counts) leaves it open for now → ${JSON.stringify(re2)}`);
  for (let i = 0; i < 60 && !(markupEdits.some((e) => e.message_id === kk?.message_id) && deletedTopics.includes(kk?.message_thread_id)); i++) await sleep(100);
  ok(markupEdits.some((e) => e.message_id === kk?.message_id) && deletedTopics.includes(kk?.message_thread_id),
    `…once nobody polls, the sweep finishes that round end: prompt retracted, topic ${kk?.message_thread_id} ended (no second round end, no orphan TTL)`);
  // the same worker's next prompt after that round end does not drop the pending round end: once neither
  // is polled for, both are retracted and the round ends
  {
    const a = runHook({ session_id: "s-worker5", agent_id: AGENT, tool_name: "Bash", tool_input: cmdInput("echo worker17d") }, { port: PORT2 });
    const ka = await keyboardFor("echo worker17d");
    const r5 = await roundEnd2("s-worker5");
    const b = runHook({ session_id: "s-worker5", agent_id: AGENT, tool_name: "Bash", tool_input: cmdInput("echo worker17e") }, { port: PORT2 });
    const kb5 = await keyboardFor("echo worker17e");
    a.c.kill("SIGKILL"); b.c.kill("SIGKILL"); await a.done; await b.done;
    const gone = (k) => markupEdits.some((e) => e.message_id === k?.message_id);
    for (let i = 0; i < 60 && !(gone(ka) && gone(kb5) && deletedTopics.includes(ka?.message_thread_id)); i++) await sleep(100);
    ok(r5.ended === false && gone(ka) && gone(kb5) && deletedTopics.includes(ka?.message_thread_id),
      `a round end that left a worker's prompt open survives that worker's next prompt: both retracted once nobody polls, the round ends (${JSON.stringify(r5)})`);
  }
  // a worker's prompt still being sent (a slow Telegram, longer than MYNA_ATTENDED_GRACE_MS) at the round
  // end is not taken for a dead one: it stays, and the phone's ✅ reaches the hook once it is on the phone
  {
    sendDelayMs = 1500;
    const w = runHook({ session_id: "s-worker6", agent_id: AGENT, tool_name: "Bash", tool_input: cmdInput("echo worker17f") }, { port: PORT2 });
    const kw = await keyboardFor("echo worker17f");
    await sleep(700); // still sending; past the grace since it was created
    const r6 = await roundEnd2("s-worker6");
    await sleep(1200); sendDelayMs = 0;
    const early = markupEdits.some((e) => e.message_id === kw?.message_id);
    tap(kw, 0, 0);
    const d = await w.done;
    ok(r6.ended === false && !early && d.decision?.behavior === "allow", `a worker's prompt still being sent at the round end stays (${JSON.stringify(r6)}), and the phone's ✅ then reaches the hook → ${JSON.stringify(d.decision)}`);
  }
  const h = runHook({ session_id: "s-worker2", agent_id: AGENT, tool_name: "Bash", tool_input: cmdInput("echo worker17b") }, { port: PORT2 });
  const kb = await keyboardFor("echo worker17b");
  h.c.kill("SIGKILL"); await h.done;
  await sleep(500);
  ok(!markupEdits.some((e) => e.message_id === kb?.message_id), "a worker's hook killed without a word, no round end: right after, its prompt is still there");
  for (let i = 0; i < 60 && !markupEdits.some((e) => e.message_id === kb?.message_id); i++) await sleep(100);
  ok(markupEdits.some((e) => e.message_id === kb?.message_id), "…once older than MYNA_ORPHAN_TTL with nobody polling, the orphan sweep retracts it");
  relay2.kill();
}

relay.kill(); stub.close(); clearTimeout(watchdog);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ PERMISSION E2E PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
