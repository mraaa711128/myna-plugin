#!/usr/bin/env node
// Autonomous e2e of the chat mod (hooks/chat-mod.mjs) against the real relay and a local Telegram API
// stub. No phone, no bot, no Claude Code: the test is the engine — a stub `$` (http, fs, store, env,
// clock, prompt, ui) and the events (session.start/end, turn.start/step/complete, command.run) — and
// the human (getUpdates updates).
// Proves: who chats by default (terminal yes; -p / SDK no; MYNA_CHAT overrides), the
// bird nickname (egret for example-app, MYNA_CHAT_NICK wins); a phone message becomes a prompt only
// while the session is idle, one at a time; a phone turn and a terminal turn are reported with the
// right origin, tool calls slimmed, subagent steps left out; a turn nobody typed (a background
// notification, a Monitor event, another session's message, another plugin's prompt) shows a short
// label instead of 🖥 + its text, by prompt.submit's origin or else the engine's framing; messages that piled up during a turn go in
// as ONE prompt; "!command" from the phone runs the slash command (its text back as the answer; a prompt
// command's turn counted as the phone's; an unknown one is plain text; /myna:nick from the phone;
// !usage / ！cost answered from $.session.usage(); another built-in run bare refused; no text and no turn → said so);
// /myna:nick and /myna:chat off|on; a
// relay restart (tokens gone) re-registers by itself; a resume keeps the renamed nick; a /clear
// registers the new session; no relay / no secret just shows in the status line.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { register, birdFor, slimInput, turnSource } from "../hooks/chat-mod.mjs";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 120s"); process.exit(1); }, 120000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myna-chatmod-test-"));
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 50) { const v = await fn(); if (v) return v; await sleep(50); } return fn(); };

// --- Telegram API stub -------------------------------------------------------------------------
const calls = [];
let updates = [], nextUpdateId = 1, mid = 100, nextTopic = 900;
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    const method = u.pathname.split("/").pop();
    if (method === "getUpdates") { const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); }; return updates.length ? deliver() : setTimeout(deliver, 100); }
    calls.push({ method, b, at: Date.now() });
    if (method === "sendMessage") { b._id = ++mid; return json({ ok: true, result: { message_id: b._id } }); }
    if (method === "createForumTopic") return json({ ok: true, result: { message_thread_id: ++nextTopic, name: b.name } });
    json({ ok: true, result: true });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const of = (method) => calls.filter((c) => c.method === method).map((c) => c.b);
const sentIn = (thread) => of("sendMessage").filter((b) => b.message_thread_id === thread);
const say = (text, thread) => { const id = ++mid; updates.push({ update_id: nextUpdateId++, message: { message_id: id, chat: { id: 42, type: "private" }, from: { id: 7, first_name: "Alice" }, text, ...(thread ? { message_thread_id: thread } : {}) } }); return id; };

// --- real relay ----------------------------------------------------------------------------------
const PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${PORT}`;
const SECRET_FILE = path.join(tmp, "relay-secret");
let relay;
async function startRelay() {
  relay = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env, MYNA_ENV: path.join(tmp, "no-such-env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      RELAY_PORT: String(PORT), TELEGRAM_TOPIC_ROUND_GRACE: "0", MYNA_CHAT_PROGRESS_MS: "200",
      MYNA_TOPICS_FILE: path.join(tmp, "topics.json"), MYNA_PENDING_FILE: path.join(tmp, "pending.json"), MYNA_TELEGRAM_CHAT_FILE: path.join(tmp, "chat.json"),
      MYNA_RELAY_SECRET_FILE: SECRET_FILE, MYNA_CHAT_FILE: path.join(tmp, "chat-sessions.json"), MYNA_CHAT_TOPICS_FILE: path.join(tmp, "chat-topics.json"),
      MYNA_PROGRESS_FILE: path.join(tmp, "chat-progress"), // never the human's own /myna:murmur setting
    },
    stdio: ["ignore", "ignore", process.env.MYNA_TEST_VERBOSE ? "inherit" : "ignore"],
  });
  for (let i = 0; ; i++) {
    try { await fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (i > 50) { console.error("❌ relay never came up"); process.exit(1); } await sleep(100); }
  }
}
async function stopRelay() { relay.kill(); await new Promise((r) => relay.once("exit", r)); }
await startRelay();
const chatOf = async (sid) => (await fetch(`${RELAY}/chat/session?session_id=${sid}`)).json();

// --- the engine: a stub `$` and the events --------------------------------------------------------
const ROOT = "/work/example-app";
function engine({ sid, env = {}, interactive = true, store = new Map(), root = ROOT }) {
  const hooks = [];
  register((event, a, b) => { const [match, hook] = b ? [a, b] : [null, a]; hooks.push({ event, match, hook }); return { catch() { return this; } }; });
  const S = { sid, status: undefined, submits: [], runs: [], timers: new Set(), store };
  const $ = {
    plugin: { name: "myna", root: "/x" },
    http: { fetch: async (url, init = {}) => { const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body }); return { status: r.status, ok: r.ok, headers: {}, text: await r.text() }; } },
    fs: { read: async (p) => fs.readFileSync(p, "utf8") },
    session: {
      id: async () => S.sid, root: async () => root, cwd: async () => root,
      usage: async () => ({ startedAt: 0, context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [{ kind: "five_hour", percentUsed: 23.5, resetsAt: "2026-10-17T07:00:00Z" }, { kind: "seven_day", percentUsed: 7 }], cost: { usd: 1.234 } }),
    },
    ui: { status: (t) => { S.status = t; } },
    prompt: { submit: async ({ text }) => { S.submits.push(text); return { text }; } },
    // like the engine: a local command prints text, a prompt command (skill / markdown) resolves bare and starts a turn,
    // a panel command resolves bare and starts nothing
    command: {
      list: async () => [
        { name: "compact", source: "builtin" }, { name: "model", source: "builtin" }, { name: "usage", source: "builtin" },
        { name: "probe:hello", source: "plugin" }, { name: "probe:panel", source: "plugin" },
      ],
      run: async ({ command, args = "" }) => {
        S.runs.push(`${command} ${args}`.trim());
        if (command === "compact") return { text: "Compacted." };
        if (command === "model") return { text: `Set model to ${args}` };
        if (command === "probe:hello" || command === "probe:panel") return {};
        throw new Error(`myna: $.command.run: no command named /${command} in this session`);
      },
    },
    clock: { every: (ms, fn) => { const h = setInterval(fn, 100); S.timers.add(h); return { cancel: () => { clearInterval(h); S.timers.delete(h); } }; } },
    store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }, delete: async (k) => { store.delete(k); }, keys: async () => [...store.keys()] },
    env: { get: async (n) => ({ HOME: tmp, MYNA_ENV: path.join(tmp, "no-such-env"), RELAY_PORT: String(PORT), MYNA_RELAY_SECRET_FILE: SECRET_FILE, ...env })[n] },
  };
  const fire = async (event, e, result = e) => {
    for (const h of hooks.filter((x) => x.event === event && (!x.match || Object.entries(x.match).every(([k, v]) => e[k] === v)))) {
      if (event === "turn.step") {
        const gen = h.hook($, e, async function* () { return result; });
        let r; do r = await gen.next(); while (!r.done); return r.value;
      }
      return h.hook($, e, async () => result);
    }
    return result;
  };
  return {
    S, fire,
    start: () => fire("session.start", { cwd: root, surface: interactive ? "terminal" : null, isInteractive: interactive }),
    end: (reason = "prompt_input_exit") => fire("session.end", { reason, sessionId: S.sid }),
    cmd: (command, args = "") => fire("command.run", { command, args, origin: { kind: "composer" } }),
    // a prompt entering the session, as the engine stamps it (turnId: delivered into a running turn)
    submit: (text, origin, extra = {}) => fire("prompt.submit", { text, origin, wait: false, ...extra }),
    // what the engine does with a submitted prompt: a turn whose text is the framed prompt
    turn: async (text, { steps = [], answer = "done", agentSteps = [] } = {}) => {
      const turnId = `t${Math.random()}`;
      await fire("turn.start", { text, turnId });
      for (const s of agentSteps) await fire("turn.step", { turnId, index: 0, agentId: "sub1" }, { answer: s.text || "", toolUses: s.tools, stopReason: "tool_use" });
      for (const [i, s] of steps.entries()) await fire("turn.step", { turnId, index: i }, { answer: s.text || "", toolUses: s.tools, stopReason: "tool_use" });
      await fire("turn.complete", { answer, durationMs: 1, isAborted: false, turnId, reason: "answer" });
    },
    framed: (t) => `The myna plugin sent a message: ${t}\n\nThis is how Claude Code surfaces a prompt a plugin starts this turn in the user's place.`,
    stop: () => { for (const h of S.timers) clearInterval(h); S.timers.clear(); },
  };
}

// 0) pure helpers
ok(birdFor("example-app") === "egret" && birdFor("Myna") === "magpie" && birdFor("scout") === "swift", "bird nickname alliterates with the repo dir (example → egret, myna → magpie, never myna)");
ok(typeof birdFor("123", () => 0) === "string" && birdFor("123", () => 0).length > 0, "no letter → some bird");
{
  const s = slimInput({ file_path: "/a/b.txt", content: "x".repeat(10000), todos: Array(500).fill({ content: "y".repeat(50) }) });
  ok(s.file_path === "/a/b.txt" && s.content.length <= 301 && s.todos.length === 500 && JSON.stringify(s).length < 3500, "tool input slimmed (long strings cut, big arrays keep only their length)");
}
ok(turnSource("hi", [{ kind: "composer" }]) === null && turnSource("hi", [{ kind: "bridge" }]) === null && turnSource("x", [{ kind: "sdk" }]) === null && turnSource("plain") === null,
  "turnSource: typed (composer / bridge / sdk) or nothing to go by → a person's prompt");
ok(turnSource("<task-notification>", [{ kind: "composer" }, { kind: "task-notification" }]) === null, "turnSource: a turn carrying a typed prompt counts as typed");
ok(turnSource("x", [{ kind: "scheduled-trigger" }]) === "⏰ 排程" && turnSource("x", [{ kind: "channel", server: "slack" }]) === "📡 slack 頻道訊息"
  && turnSource("x", [{ kind: "peer-send-message" }]) === "🔗 其他 session 的訊息" && turnSource("x", [{ kind: "channel" }]) === "📡 頻道訊息",
  "turnSource: schedule / channel / SendMessage → their labels");
ok(turnSource("  <\\task-notification> x") === "⚙ 背景通知" && turnSource("<teammate-message>") === "🔗 其他 session 的訊息" && turnSource("x", [{ kind: "some-new-kind" }]) === null,
  "turnSource: framing marks (also the rewritten \"<\\tag\"); an unknown kind with plain text stays typed");

// 1) who chats by default
{
  const p = engine({ sid: "s-p", interactive: false }); await p.start(); await sleep(400);
  const off = engine({ sid: "s-off", env: { MYNA_CHAT: "off" } }); await off.start(); await sleep(400);
  ok(!(await chatOf("s-p")).chat && !(await chatOf("s-off")).chat,
    "-p / SDK and MYNA_CHAT=off → not registered");
  const pOn = engine({ sid: "s-pon", interactive: false, env: { MYNA_CHAT: "on", MYNA_CHAT_NICK: "Scout" } }); await pOn.start();
  const j = await until(async () => { const c = await chatOf("s-pon"); return c.chat && c; });
  ok(j?.nick === "scout", `MYNA_CHAT=on registers a -p session; MYNA_CHAT_NICK wins over the bird (nick "${j?.nick}")`);
  await pOn.end(); for (const x of [p, off, pOn]) x.stop();
}

// 2) a terminal session registers as egret, its own topic
const store = new Map();
let A = engine({ sid: "s-a", store });
await A.start();
const reg = await until(async () => { const c = await chatOf("s-a"); return c.chat && c; });
const topicA = (await until(() => of("createForumTopic").find((t) => t.name === "💬 egret · example-app")) && nextTopic);
ok(reg?.nick === "egret" && of("createForumTopic").some((t) => t.name === "💬 egret · example-app"), `terminal session registers by itself as "egret", topic "💬 egret · example-app"`);
ok(await until(() => A.S.status === "💬 egret"), `status line: "${A.S.status}"`);

// 3) a phone message → a prompt, only while idle, one at a time
const m1 = say("list the files", topicA);
await until(() => A.S.submits.length === 1);
ok(A.S.submits[0] === "[Telegram · Alice] list the files", `phone message submitted as a prompt: "${A.S.submits[0]}"`);
ok(await until(() => of("setMessageReaction").some((r) => r.message_id === m1)), "…and marked 👀 when taken");
say("and then?", topicA);
await sleep(600);
ok(A.S.submits.length === 1, "a second message waits while the first has not started its turn");
await A.fire("turn.start", { text: A.framed(A.S.submits[0]), turnId: "tp" });
await sleep(400);
ok(A.S.submits.length === 1, "…and while that turn runs");
await A.fire("turn.step", { turnId: "tp", index: 0, agentId: "sub1" }, { answer: "", toolUses: [{ name: "Grep", input: { pattern: "SUBAGENT" } }], stopReason: "tool_use" });
await A.fire("turn.step", { turnId: "tp", index: 1 }, { answer: "Let me look.", toolUses: [{ name: "Bash", input: { command: "ls -la" } }, { name: "Write", input: { file_path: `${ROOT}/notes.md`, content: "z".repeat(400000) } }], stopReason: "tool_use" });
const prog = await until(() => sentIn(topicA).find((s) => /🔧 Bash: ls -la/.test(s.text)));
ok(prog?.disable_notification === true && /💭 Let me look\./.test(prog.text) && /🔧 Write: notes\.md/.test(prog.text),
  "phone turn: one silent progress message with the interim text and both tool calls (a 400 KB Write slimmed)");
ok(!/🖥/.test(prog?.text || "") && !sentIn(topicA).some((s) => /SUBAGENT/.test(s.text)), "…no 🖥 echo of the phone's own prompt, and the subagent's step left out");
await A.fire("turn.complete", { answer: "Here are the files.", durationMs: 1, isAborted: false, turnId: "tp", reason: "answer" });
const ans = await until(() => sentIn(topicA).find((s) => s.text === "Here are the files."));
ok(ans && !ans.disable_notification, "final answer sent as its own message, with a push");
await until(() => A.S.submits.length === 2);
ok(A.S.submits[1] === "[Telegram · Alice] and then?", "the waiting message is taken once the turn is over");
await A.turn(A.framed(A.S.submits[1]), { answer: "ok" });

// 4) a terminal turn is reported too, with its prompt
await A.turn("run the tests", { steps: [{ tools: [{ name: "Bash", input: { command: "npm test" } }] }], answer: "all green" });
// a progress message as it reads now: its first text, or the latest edit of it
const latest = (m) => m && ([...of("editMessageText")].reverse().find((e) => e.message_id === m._id)?.text ?? m.text);
const tprog = await until(() => sentIn(topicA).find((s) => /🖥 run the tests/.test(s.text)));
ok(await until(() => /🔧 Bash: npm test/.test(latest(tprog) || "")) && await until(() => sentIn(topicA).some((s) => s.text === "all green")), "terminal turn: 🖥 prompt + tool line in progress, then the answer");

// 4a) a turn nobody typed: a background notification, a Monitor event, another session's message,
// another plugin's prompt → one short label, never its text and never 🖥; typed at the terminal → 🖥 as before
{
  // the progress message of the turn whose tool ran `marker`, as it reads now
  const progressOf = async (marker) => (await until(() => sentIn(topicA).map(latest).find((t) => t.includes(`echo ${marker}`)))) || "";
  const run = async (text, marker, origin, extra) => {
    if (origin) await A.submit(text, origin, extra);
    await A.turn(text, { steps: [{ tools: [{ name: "Bash", input: { command: `echo ${marker}` } }] }], answer: `answer ${marker}` });
    await until(() => sentIn(topicA).some((s) => s.text === `answer ${marker}`));
    return progressOf(marker);
  };
  const ECHO = "那你覺得準則應該跟專案repo還是跟著PM Lead";
  const notif = `<task-notification> <task-id>k4t6klice</task-id> <status>completed</status> <summary>MCP task k4t6klice (plugin:myna:myna/ask_human) completed.</summary> <result> {"kind":"message","text":"${ECHO}"} </result> </task-notification>`;
  let p = await run(notif, "BG1", { kind: "task-notification" });
  ok(/^⚙ 背景通知$/m.test(p) && !p.includes("🖥") && !p.includes(ECHO) && /🔧 Bash: echo BG1/.test(p),
    `a background task's <task-notification> → "⚙ 背景通知", not 🖥 with the human's own words: ${JSON.stringify(p)}`);
  ok(!sentIn(topicA).some((s) => s.text.includes(ECHO)), "…its text is nowhere on the phone");
  p = await run("<task-notification> <task-id>bmon1</task-id> <event>Monitor: build finished</event> </task-notification>", "MON", { kind: "task-notification" });
  ok(/^⚙ 背景通知$/m.test(p) && !/Monitor: build/.test(p) && !p.includes("🖥"), `a Monitor event → "⚙ 背景通知": ${JSON.stringify(p)}`);
  const gate = `<cross-session-message from="uds:x" from-name="worker"> WORKER-GATE v1 g-1 {"source":"ask_human","questions":[{"question":"LONG"}]} </cross-session-message>`;
  p = await run(gate, "PEER", { kind: "peer" });
  ok(/^🔗 其他 session 的訊息$/m.test(p) && !/WORKER-GATE/.test(p) && !p.includes("🖥"), `another session's message (a WORKER-GATE) → "🔗 其他 session 的訊息": ${JSON.stringify(p)}`);
  p = await run("The engram plugin sent a message: remember this\n\nThis is how Claude Code surfaces a prompt a plugin starts", "PLUG", { kind: "plugin", name: "engram" });
  ok(/^🧩 engram plugin$/m.test(p) && !/remember this/.test(p) && !p.includes("🖥"), `another plugin's prompt → "🧩 engram plugin": ${JSON.stringify(p)}`);
  p = await run("check the build", "TERM", { kind: "composer" });
  ok(/^🖥 check the build$/m.test(p), `typed at the terminal (origin composer) → 🖥 as before: ${JSON.stringify(p)}`);
  // no origin to go by (an older CLI, or unclassified): the engine's framing decides; plain text stays 🖥
  p = await run(notif.replace("k4t6klice", "old1"), "OLD1");
  ok(/^⚙ 背景通知$/m.test(p) && !p.includes(ECHO), `no prompt.submit (older CLI) + <task-notification> → "⚙ 背景通知": ${JSON.stringify(p)}`);
  p = await run(`<\\cross-session-message from="uds:y"> hello </\\cross-session-message>`, "OLD2", { kind: "unclassified" });
  ok(/^🔗 其他 session 的訊息$/m.test(p) && !p.includes("🖥"), `unclassified + a rewritten "<\\cross-session-message" → "🔗": ${JSON.stringify(p)}`);
  p = await run("why is it red", "UNC", { kind: "unclassified" });
  ok(/^🖥 why is it red$/m.test(p), `unclassified, no framing → 🖥 (better an extra line than a person's prompt left out): ${JSON.stringify(p)}`);
  // a notification delivered into a running turn (turnId) is not this turn's origin; a typed prompt
  // delivered that way is not kept to mislabel a later turn either
  await A.submit("run lint", { kind: "composer" }, { turnId: "busy" });
  p = await run("<task-notification> run lint done </task-notification>", "LATE");
  ok(/^⚙ 背景通知$/m.test(p) && !p.includes("🖥"), `a typed prompt delivered into a running turn is not matched to a later notification: ${JSON.stringify(p)}`);
  // a subagent's run (agentId) is no turn of its own on the phone
  calls.length = 0;
  await A.fire("turn.start", { text: "SUBAGENT PROMPT", turnId: "sa", agentId: "sub9" });
  await sleep(500);
  ok(!sentIn(topicA).some((s) => /SUBAGENT PROMPT/.test(s.text)), "a subagent's turn.start → no 🖥 line with its prompt");
  await A.fire("turn.complete", { answer: "", durationMs: 1, isAborted: false, turnId: "sa", agentId: "sub9", reason: "answer" });
}

// 4b) what piled up during a turn goes in as ONE prompt; a "/command" comes alone and runs as a command
{
  const runTurn = async (text, answer = "ok") => { await A.fire("turn.start", { text, turnId: `t${text.length}` }); return { done: () => A.fire("turn.complete", { answer, durationMs: 1, isAborted: false, turnId: `t${text.length}`, reason: "answer" }) }; };
  // a phone turn is running…
  say("first", topicA);
  await until(() => A.S.submits.at(-1) === "[Telegram · Alice] first");
  const t1 = await runTurn(A.framed(A.S.submits.at(-1)));
  const n = A.S.submits.length;
  const ids = [say("one", topicA), say("two", topicA), say("three", topicA)];
  await sleep(600);
  ok(A.S.submits.length === n, "three messages while a turn runs → all wait");
  await t1.done();
  await until(() => A.S.submits.length === n + 1);
  await sleep(500);
  ok(A.S.submits.length === n + 1 && A.S.submits.at(-1) === "[Telegram · Alice] one\n\n[Telegram · Alice] two\n\n[Telegram · Alice] three",
    `turn over → ONE prompt with all three: ${JSON.stringify(A.S.submits.at(-1))}`);
  ok(await until(() => ids.every((id) => of("setMessageReaction").some((r) => r.message_id === id))), "…each marked 👀");
  await (await runTurn(A.framed(A.S.submits.at(-1)))).done();

  // a local command: runs, its output is the answer (pushed), no prompt
  calls.length = 0;
  say("!compact", topicA);
  const costAns = await until(() => sentIn(topicA).find((s) => s.text === "Compacted."));
  ok(A.S.runs.at(-1) === "compact" && costAns && !costAns.disable_notification && A.S.submits.length === n + 1, `"!compact" from the phone → ran /compact, its output back as the answer`);

  // !usage (and full-width ！cost): answered by the mod from $.session.usage(), the built-in never run
  const runsAt = A.S.runs.length;
  say("!usage", topicA);
  const use = await until(() => sentIn(topicA).find((s) => /^📊 egret 的用量/.test(s.text)));
  ok(use && /context:42%\(84k \/ 200k tokens\)/.test(use.text) && /5 小時額度:已用 23\.5%,\d+\/\d+ \d\d:00 重置/.test(use.text) && /7 天額度:已用 7%$/m.test(use.text) && /US\$1\.23/.test(use.text),
    `"!usage" → ${JSON.stringify(use?.text)}`);
  calls.length = 0;
  say("！Cost", topicA);
  ok(!!(await until(() => sentIn(topicA).find((s) => /^📊 egret 的用量/.test(s.text)))) && A.S.runs.length === runsAt, "\"！Cost\" (full-width, any case) → the same summary; no built-in run");
  // another built-in run bare (a terminal panel) → refused, not run; with arguments it runs
  say("!model", topicA);
  const refused = await until(() => sentIn(topicA).find((s) => /!model 不帶參數會在終端機開面板/.test(s.text)));
  ok(refused && A.S.runs.length === runsAt, `"!model" → refused: ${JSON.stringify(refused?.text)}`);
  say("!model opus", topicA);
  ok(!!(await until(() => sentIn(topicA).find((s) => s.text === "Set model to opus"))) && A.S.runs.at(-1) === "model opus", "\"!model opus\" → runs, its text back");
  // no text and no turn (a panel after all) → the phone is told after a while
  say("!probe:panel", topicA);
  const quiet = await until(() => sentIn(topicA).find((s) => s.text === "✅ !probe:panel 已在終端機執行,但它沒有文字結果可以傳回來。"), 9000);
  ok(quiet && A.S.runs.at(-1) === "probe:panel", "a command with no text and no turn → \"已在終端機執行,沒有文字結果\"");

  // a prompt command: its turn is the phone's (no 🖥 echo), and the next message flows after it
  say("!probe:hello world", topicA);
  await until(() => A.S.runs.at(-1) === "probe:hello world");
  ok(A.S.runs.at(-1) === "probe:hello world", "\"!probe:hello world\" → $.command.run({command: \"probe:hello\", args: \"world\"})");
  say("after it", topicA);
  await sleep(500);
  ok(!A.S.submits.includes("[Telegram · Alice] after it"), "…the next message waits for the command's turn");
  await A.turn("<command-message>probe:hello</command-message>\n<command-name>/probe:hello</command-name>\n<command-args>world</command-args>",
    { steps: [{ tools: [{ name: "Bash", input: { command: "echo hi" } }] }], answer: "HELLO-CMD world" });
  const cprog = await until(() => sentIn(topicA).find((s) => /echo hi/.test(s.text)));
  ok(cprog && !/🖥/.test(cprog.text), "…its turn reported as the phone's (no 🖥 echo)");
  await until(() => A.S.submits.includes("[Telegram · Alice] after it"));
  ok(A.S.submits.at(-1) === "[Telegram · Alice] after it", "…then the next message goes in");
  await A.turn(A.framed(A.S.submits.at(-1)));

  // text, a command, text — while busy: the text before the command, then the command, then the rest
  say("first", topicA);
  await until(() => A.S.submits.at(-1) === "[Telegram · Alice] first");
  const t2 = await runTurn(A.framed("[Telegram · Alice] first") + " ");
  say("alpha", topicA); say("!compact", topicA); say("beta", topicA);
  await sleep(500);
  const runsBefore = A.S.runs.length;
  await t2.done();
  await until(() => A.S.submits.at(-1) === "[Telegram · Alice] alpha");
  ok(A.S.submits.at(-1) === "[Telegram · Alice] alpha", "text / command / text → \"alpha\" alone first (a command never rides along)");
  await A.turn(A.framed("[Telegram · Alice] alpha"));
  await until(() => A.S.runs.length > runsBefore);
  ok(A.S.runs.at(-1) === "compact", "…then !compact runs");
  await until(() => A.S.submits.at(-1) === "[Telegram · Alice] beta");
  ok(A.S.submits.at(-1) === "[Telegram · Alice] beta", "…then \"beta\"");
  await A.turn(A.framed("[Telegram · Alice] beta"));

  // not a command after all → plain text; our own /myna:nick is answered by the mod itself
  say("!123 是什麼", topicA);
  await until(() => A.S.submits.at(-1) === "[Telegram · Alice] !123 是什麼");
  ok(A.S.submits.at(-1) === "[Telegram · Alice] !123 是什麼", "an unknown \"!123 …\" → submitted as plain text");
  await A.turn(A.framed(A.S.submits.at(-1)));
  // a "/command" is not forwarded at all: the relay tells the human to type "!" instead
  calls.length = 0;
  const runsNow = A.S.runs.length, subsNow = A.S.submits.length;
  say("/cost", topicA);
  const hint = await until(() => sentIn(topicA).find((s) => /請在 session 的 topic 裡改打「!cost」/.test(s.text)));
  await sleep(400);
  ok(hint && A.S.runs.length === runsNow && A.S.submits.length === subsNow, `"/cost" → not run, hint: ${JSON.stringify(hint?.text)}`);
  say("!myna:nick plover", topicA);
  const nickAns = await until(() => sentIn(topicA).find((s) => s.text === "💬 暱稱改為 plover。"));
  ok(nickAns && (await chatOf("s-a")).nick === "plover" && !A.S.runs.some((r) => r.startsWith("myna:")), "\"!myna:nick plover\" from the phone → renamed by the mod itself, answered in the topic");
  say("!myna:nick egret", topicA);
  await until(async () => (await chatOf("s-a")).nick === "egret");
}

// 5) /myna:nick
{
  const r = await A.cmd("myna:nick", "Heron");
  ok(/heron/.test(r.text) && (await chatOf("s-a")).nick === "heron" && of("editForumTopic").some((t) => t.name === "💬 heron · example-app"), `/myna:nick Heron → "${r.text}", topic renamed`);
  ok(A.S.status === "💬 heron", "status line follows");
  ok(/heron/.test((await A.cmd("myna:nick")).text), "/myna:nick without a name shows it");
}

// 6) the relay restarts (tokens gone) → the mod registers again by itself
{
  await stopRelay(); await startRelay();
  const m = say("still there?", topicA);
  await until(() => A.S.submits.includes("[Telegram · Alice] still there?"), 8000);
  ok(A.S.submits.includes("[Telegram · Alice] still there?") && (await chatOf("s-a")).nick === "heron", "after a relay restart: re-registered (same nick), messages flow again");
  ok(await until(() => of("setMessageReaction").some((r) => r.message_id === m)), "…👀 on it");
  await A.turn(A.framed("[Telegram · Alice] still there?"), { answer: "yes" });
}

// 7) /myna:chat off | on
{
  const r = await A.cmd("myna:chat", "off");
  ok(/關閉/.test(r.text) && !(await chatOf("s-a")).chat && A.S.status === undefined, `/myna:chat off → "${r.text}", unregistered, status cleared`);
  ok(await until(() => of("editForumTopic").some((t) => t.name === "🔒 heron · example-app")), "…topic kept as 🔒");
  ok(store.get("chat:s-a")?.on === false, "…remembered for this session");
  const r2 = await A.cmd("myna:chat", "on");
  ok(/開啟/.test(r2.text) && (await chatOf("s-a")).chat && /heron/.test(r2.text), `/myna:chat on → "${r2.text}"`);
  ok(/heron/.test((await A.cmd("myna:chat")).text), "/myna:chat without an argument reports the state");
}

// 8) the session ends; a resume (same id, same store) comes back as heron in the same topic
{
  await A.end(); A.stop();
  ok(!(await chatOf("s-a")).chat, "session.end → closed at the relay");
  const before = of("createForumTopic").length;
  A = engine({ sid: "s-a", store });
  await A.start();
  const c = await until(async () => { const x = await chatOf("s-a"); return x.chat && x; });
  ok(c?.nick === "heron" && of("createForumTopic").length === before && of("editForumTopic").at(-1)?.name === "💬 heron · example-app",
    "resume → same nick (heron), same topic reopened as 💬");
}

// 9) /clear (or an in-app /resume): the process goes on under another session id → the old one closes, that one registers
{
  await A.end("clear");
  A.S.sid = "s-a2";
  const c = await until(async () => { const x = await chatOf("s-a2"); return x.chat && x; });
  ok(!(await chatOf("s-a")).chat && c?.nick === "egret", `/clear → old session closed, new one registered as "${c?.nick}"`);
  await A.end("resume");
  A.S.sid = "s-a";
  const back = await until(async () => { const x = await chatOf("s-a"); return x.chat && x; });
  ok(!(await chatOf("s-a2")).chat && back?.nick === "heron", `in-app /resume back to the first session → it chats again as "${back?.nick}"`);
  await A.end(); A.stop();
}

// 10) no relay / no secret: nothing breaks, the status line says why
{
  const D = engine({ sid: "s-d", env: { RELAY_PORT: "1" } }); await D.start();
  ok(await until(() => /relay 沒有回應/.test(D.S.status || "")), `relay down → status "${D.S.status}"`);
  D.stop();
  const E = engine({ sid: "s-e", env: { MYNA_RELAY_SECRET_FILE: path.join(tmp, "nope") } }); await E.start();
  ok(await until(() => /密鑰/.test(E.S.status || "")), `no relay secret → status "${E.S.status}"`);
  E.stop();
}

await stopRelay(); stub.close(); clearTimeout(watchdog);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ all chat-mod checks passed");
process.exit(failed ? 1 : 0);
