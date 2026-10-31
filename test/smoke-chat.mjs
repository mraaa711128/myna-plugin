#!/usr/bin/env node
// Autonomous e2e of the relay's chat core (src/chat.mjs + the telegram provider's chat part) against a
// local Telegram API stub. No phone, no bot, no Claude Code: the test plays the chat mod (register,
// take, progress, close) over HTTP and the human (getUpdates updates).
// Proves: the relay secret guards registration and per-session tokens scope the rest; a chat session
// gets its own topic, unique nick; the human's text in that topic / `@nick` / a reply in the main chat
// reaches the right inbox (👀 when taken), queued messages taken together (a "!command" alone); a
// "!command" outside any topic goes to the session last written to (or asks which), a "/cmd" (or
// "/cmd@bot") is not forwarded but answered with a hint to type "!cmd"; progress is one silent message edited in place, a new one
// once something lands below it or near the length limit, then the final answer (with a push) — or,
// with /myna:murmur off, only the 🖥 line + the newest tool, kept at the bottom; a
// chat session's questions go into its chat topic (🚦 gate line) and only a reply answers them; the
// ✍️ fallback no longer steals chat-topic text; a 429 cools down without losing the question; close
// keeps the topic as 🔒; a relay restart keeps topic, nick and inbox; a handed-off question stays put.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
const root = path.dirname(path.dirname(relayPath));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 120s"); process.exit(1); }, 120000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myna-chat-test-"));
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 50) { const v = fn(); if (v) return v; await sleep(50); } return fn(); };

// --- Telegram API stub -------------------------------------------------------------------------
const calls = []; // {method, b}
let updates = [], nextUpdateId = 1, mid = 100, nextTopic = 900;
let limitNext = null; // {method, after}: answer that method once with 429 retry_after
const goneTopics = new Set(); // sendMessage into these → "message thread not found" (the human deleted it)
let dropCreate = 0; // createForumTopic connections cut while > 0 (Telegram unreachable → fetch failed)
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    const method = u.pathname.split("/").pop();
    if (method === "getUpdates") { const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); }; return updates.length ? deliver() : setTimeout(deliver, 100); }
    if (limitNext && limitNext.method === method) { const after = limitNext.after; limitNext = null; calls.push({ method: `${method}:429`, b, at: Date.now() }); return json({ ok: false, error_code: 429, description: "Too Many Requests: retry after " + after, parameters: { retry_after: after } }); }
    if (method === "createForumTopic" && dropCreate > 0) { dropCreate--; calls.push({ method: "createForumTopic:dropped", b, at: Date.now() }); return req.socket.destroy(); }
    if (method === "sendMessage" && goneTopics.has(b.message_thread_id)) return json({ ok: false, error_code: 400, description: "Bad Request: message thread not found" });
    calls.push({ method, b, at: Date.now() });
    if (method === "sendMessage") { b._id = ++mid; return json({ ok: true, result: { message_id: b._id } }); }
    if (method === "getMe") return json({ ok: true, result: { id: 1, is_bot: true, username: "MynaTestBot", has_topics_enabled: true } });
    if (method === "createForumTopic") return json({ ok: true, result: { message_thread_id: ++nextTopic, name: b.name } });
    json({ ok: true, result: true });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const of = (method) => calls.filter((c) => c.method === method).map((c) => c.b);
const sentIn = (thread) => of("sendMessage").filter((b) => b.message_thread_id === thread);

// --- real relay ----------------------------------------------------------------------------------
const PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${PORT}`;
const SECRET_FILE = path.join(tmp, "relay-secret");
const PROGRESS_FILE = path.join(tmp, "chat-progress");
let relay;
async function startRelay(extra = {}) {
  relay = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env, MYNA_ENV: path.join(tmp, "no-such-env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      RELAY_PORT: String(PORT), MYNA_ANSWER_HOLD_MS: "1000", TELEGRAM_TOPIC_ROUND_GRACE: "0", MYNA_CHAT_PROGRESS_MS: "400", MYNA_CHAT_STALE_MS: "60000",
      MYNA_TOPICS_FILE: path.join(tmp, "topics.json"), MYNA_PENDING_FILE: path.join(tmp, "pending.json"), MYNA_TELEGRAM_CHAT_FILE: path.join(tmp, "chat.json"),
      MYNA_RELAY_SECRET_FILE: SECRET_FILE, MYNA_CHAT_FILE: path.join(tmp, "chat-sessions.json"), MYNA_CHAT_TOPICS_FILE: path.join(tmp, "chat-topics.json"),
      MYNA_PROGRESS_FILE: PROGRESS_FILE,
      ...extra,
    },
    stdio: ["ignore", "ignore", process.env.MYNA_TEST_VERBOSE ? "inherit" : "ignore"],
  });
  for (let i = 0; ; i++) {
    try { await fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (i > 50) { console.error("❌ relay never came up"); process.exit(1); } await sleep(100); }
  }
}
await startRelay();

// --- helpers -------------------------------------------------------------------------------------
const api = async (p, body, auth) => {
  const r = await fetch(`${RELAY}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const push = (u) => updates.push({ update_id: nextUpdateId++, ...u });
const say = (text, { thread, replyTo } = {}) => { const id = ++mid; push({ message: { message_id: id, chat: { id: 42, type: "private" }, from: { id: 7, first_name: "Alice" }, text, ...(thread ? { message_thread_id: thread } : {}), ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } }); return id; };
const tap = (kb, row, idx) => push({ callback_query: { id: `cq${nextUpdateId}`, data: kb.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 } } } });
const keyboardFor = (text) => until(() => [...of("sendMessage")].reverse().find((s) => s.reply_markup?.inline_keyboard && (s.text || "").includes(text)));
const answerOf = async (id) => { for (;;) { const j = await (await fetch(`${RELAY}/answer/${id}`)).json(); if (j.kind !== "pending") return j; } };
const ask = (body) => fetch(`${RELAY}/ask`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
const SECRET = () => fs.readFileSync(SECRET_FILE, "utf8").trim();

// 1) the relay secret: created 0600; registration needs it
{
  const mode = fs.statSync(SECRET_FILE).mode & 0o777;
  ok(mode === 0o600 && SECRET().length >= 64, `relay secret created at start, mode ${mode.toString(8)}`);
  const none = await api("/chat/register", { session_id: "s-a", nick: "egret" });
  const wrong = await api("/chat/register", { session_id: "s-a", nick: "egret" }, "nope");
  ok(none.status === 401 && wrong.status === 401, "register without / with a wrong relay secret → 401");
}

// 2) register: own topic, intro, unique nick
const A = await api("/chat/register", { session_id: "s-a", nick: "Egret", label: "example-app", cwd: "/work/example-app" }, SECRET());
const tA = A.topic;
ok(A.status === 200 && A.nick === "egret" && tA && of("createForumTopic").some((t) => t.name === "💬 egret · example-app"),
  `register → token, nick "egret", its own topic "💬 egret · example-app" (thread ${tA})`);
const intro = await until(() => sentIn(tA).find((s) => /已連線/.test(s.text)));
ok(intro?.disable_notification === true, "…and a silent hello in it");
const B = await api("/chat/register", { session_id: "s-b", nick: "egret", label: "other" }, SECRET());
ok(B.nick === "egret2", `a second live session asking for "egret" gets "${B.nick}"`);

// 3) tokens scope everything after registering
{
  const anon = await api("/chat/take", {});
  const other = await api("/chat/take", {}, "x".repeat(48));
  ok(anon.status === 401 && other.status === 401, "take without / with an unknown token → 401");
  const st = await (await fetch(`${RELAY}/chat/session?session_id=s-a`)).json();
  ok(st.chat === true && st.nick === "egret", `GET /chat/session → ${JSON.stringify(st)}`);
}

// 4) the human writes: in A's topic → A; `@egret2 …` in the main chat → B; a reply to A's message → A
{
  const m1 = say("幫我跑測試", { thread: tA });
  await sleep(400);
  const takeB = await api("/chat/take", {}, B.token);
  const takeA = await api("/chat/take", {}, A.token);
  ok(takeB.message === null && takeA.message?.text === "幫我跑測試" && takeA.message?.from === "Alice", `text in A's topic → only A's inbox → ${JSON.stringify(takeA.message)}`);
  const eyes = await until(() => of("setMessageReaction").find((r) => r.message_id === m1));
  ok(eyes?.reaction?.[0]?.emoji === "👀", "…taking it puts 👀 on the human's message");
  say("@egret2 看一下 log");
  await sleep(400);
  const tb = await api("/chat/take", {}, B.token);
  ok(tb.message?.text === "看一下 log", `"@egret2 看一下 log" in the main chat → egret2 gets "${tb.message?.text}"`);
  say("那個也順便", { replyTo: intro._id });
  await sleep(400);
  const tr = await api("/chat/take", {}, A.token);
  ok(tr.message?.text === "那個也順便", "a reply (in the main chat) to one of A's messages → A");
  say("@nobody 哈囉");
  await sleep(300);
  ok((await api("/chat/take", {}, A.token)).message === null && (await api("/chat/take", {}, B.token)).message === null, "an unknown @nick reaches no one");
}

// 4b) take {max}: what queued comes at once, a "!command" always alone; no max = one (older mods)
{
  for (const t of ["a1", "a2", "!cost now", "a3", "a4"]) say(t, { thread: tA });
  await sleep(400);
  const t1 = await api("/chat/take", { max: 20 }, A.token);
  const t2 = await api("/chat/take", { max: 20 }, A.token);
  const t3 = await api("/chat/take", {}, A.token);
  const t4 = await api("/chat/take", { max: 20 }, A.token);
  ok(t1.messages.map((m) => m.text).join("|") === "a1|a2" && t1.message.text === "a1" && t1.queued === 3, `max 20 → the text before the command: ${t1.messages.map((m) => m.text).join("|")} (queued ${t1.queued})`);
  ok(t2.messages.map((m) => m.text).join("|") === "!cost now", "…then the command alone");
  ok(t3.messages.length === 1 && t3.message.text === "a3" && t4.messages.map((m) => m.text).join("|") === "a4", "no max → one at a time, as before");
}

// 5) progress: one silent message edited in place; a new one once the human's message lands below it
{
  calls.length = 0;
  await api("/chat/progress", { event: "start", origin: "terminal", prompt: "跑全部測試\n然後回報" }, A.token);
  const first = await until(() => sentIn(tA).find((s) => /🖥/.test(s.text)));
  ok(first?.disable_notification === true && /🖥 跑全部測試 然後回報/.test(first.text), `terminal turn → silent progress message "${first?.text}"`);
  await api("/chat/progress", { event: "step", text: "先跑測試", tools: [{ name: "Bash", input: { command: "npm test" } }] }, A.token);
  await api("/chat/progress", { event: "step", tools: [{ name: "Read", input: { file_path: "/work/example-app/src/relay.mjs" } }] }, A.token);
  const edit = await until(() => of("editMessageText").find((e) => /src\/relay\.mjs/.test(e.text)), 3000);
  ok(edit && /💭 先跑測試/.test(edit.text) && /🔧 Bash: npm test/.test(edit.text) && /🔧 Read: src\/relay\.mjs/.test(edit.text) && sentIn(tA).length === 1,
    `steps → the same message edited (no new message): ${JSON.stringify(edit?.text)}`);
  say("順便看 lint", { thread: tA });
  await sleep(300);
  await api("/chat/progress", { event: "step", tools: [{ name: "Grep", input: { pattern: "TODO", path: "/work/example-app/src" } }] }, A.token);
  const second = await until(() => sentIn(tA).find((s) => /Grep/.test(s.text)));
  ok(second?.disable_notification === true && !/Bash/.test(second.text), `the human's message landed below → next step opens a NEW silent message with only the new line: "${second?.text}"`);
  await api("/chat/progress", { event: "done", text: "全部通過 ✅" }, A.token);
  const fin = await until(() => sentIn(tA).find((s) => s.text === "全部通過 ✅"));
  const doneEdit = await until(() => of("editMessageText").find((e) => /✅ 完成\(3 個工具\)/.test(e.text)));
  ok(!!doneEdit && fin && !fin.disable_notification, "done → progress closed with \"✅ 完成(3 個工具)\", final answer as a new message WITH a push");
  await api("/chat/take", {}, A.token);
}

// 6) a phone turn with no tools → just the answer; a long answer is split
{
  calls.length = 0;
  await api("/chat/progress", { event: "start", origin: "phone" }, A.token);
  await api("/chat/progress", { event: "done", text: "hi" }, A.token);
  await until(() => sentIn(tA).some((s) => s.text === "hi"));
  ok(sentIn(tA).length === 1 && of("editMessageText").length === 0, "a phone turn without tools → only the answer, no progress message");
  calls.length = 0;
  await api("/chat/progress", { event: "start", origin: "phone" }, A.token);
  await api("/chat/progress", { event: "done", text: "x".repeat(9000) }, A.token);
  await until(() => sentIn(tA).length >= 3);
  ok(sentIn(tA).map((s) => s.text.length).join(",") === "4000,4000,1000", `a 9000-char answer → ${sentIn(tA).map((s) => s.text.length).join(",")}`);
  calls.length = 0;
  const zh = "測試中文不會被切壞。".repeat(380);
  await api("/chat/progress", { event: "start", origin: "phone" }, A.token);
  // the body arrives in two chunks, split in the middle of a 3-byte character
  const buf = Buffer.from(JSON.stringify({ event: "done", text: zh }));
  let cut = 1001; while ((buf[cut] & 0xc0) !== 0x80) cut++;
  await new Promise((resolve) => {
    const r = http.request(`${RELAY}/chat/progress`, { method: "POST", headers: { authorization: `Bearer ${A.token}`, "content-type": "application/json", "content-length": buf.length } }, (res) => { res.resume(); res.on("end", resolve); });
    r.write(buf.subarray(0, cut)); setTimeout(() => r.end(buf.subarray(cut)), 100);
  });
  await until(() => sentIn(tA).length >= 1);
  ok(sentIn(tA)[0]?.text === zh, "a long Chinese answer arrives intact (no character split across request chunks)");
}

// 6b) the model's 💭 remarks and answer reach the phone as plain text; the 🖥 line (the human's
//     own words) and the 🔧 line (the command) stay exactly as written
{
  calls.length = 0;
  await api("/chat/progress", { event: "start", origin: "terminal", prompt: "看 **這個** 檔" }, A.token);
  await api("/chat/progress", { event: "step", text: "先看 `src/relay.mjs` 的 **ask** 路徑", tools: [{ name: "Bash", input: { command: "grep -n '**' src/*.mjs" } }] }, A.token);
  await api("/chat/progress", { event: "done", text: "## 結果\n\n**全部通過**,見 [PR](https://x.io/pr/1)。\n\n| 測試 | 結果 |\n|---|---|\n| chat | ✅ |" }, A.token);
  const fin = await until(() => sentIn(tA).find((s) => /結果/.test(s.text) && !/🖥/.test(s.text)));
  const views = [...sentIn(tA), ...of("editMessageText")].map((s) => s.text).filter((t) => /🖥/.test(t));
  const view = views[views.length - 1] || "";
  ok(/🖥 看 \*\*這個\*\* 檔/.test(view) && /💭 先看 src\/relay\.mjs 的 ask 路徑/.test(view) && view.includes("🔧 Bash: grep -n '**' src/*.mjs"),
    `🖥 and 🔧 as written, 💭 as plain text: ${JSON.stringify(view)}`);
  ok(fin?.text === "結果\n\n全部通過,見 PR https://x.io/pr/1 。\n\n測試：chat\n結果：✅", `the answer as plain text: ${JSON.stringify(fin?.text)}`);
  ok(calls.every((c) => !("parse_mode" in (c.b || {}))), "no parse_mode on any chat message");
}

// 7) near the length limit the progress rolls over into a new message
{
  calls.length = 0;
  await api("/chat/progress", { event: "start", origin: "phone" }, A.token);
  for (let i = 0; i < 40; i++) await api("/chat/progress", { event: "step", tools: [{ name: "Bash", input: { command: `echo ${i} ${"y".repeat(140)}` } }] }, A.token);
  await api("/chat/progress", { event: "done", text: "ok" }, A.token);
  await until(() => sentIn(tA).some((s) => s.text === "ok"));
  const prog = sentIn(tA).filter((s) => s.text !== "ok");
  const longest = Math.max(...of("editMessageText").map((e) => e.text.length), ...prog.map((s) => s.text.length));
  ok(prog.length >= 2 && longest <= 3800 && [...of("editMessageText"), ...prog].some((e) => /echo 39/.test(e.text)),
    `40 long steps → ${prog.length} progress messages, none over 3800 chars (longest ${longest})`);
}

// 7b) /myna:murmur off: the 🖥 line + every 💭 + only the newest tool with its count; moved to the bottom (old one deleted)
{
  calls.length = 0;
  const murmur = (a) => execFileSync(process.execPath, [path.join(root, "scripts", "murmur.mjs"), a], { env: { ...process.env, MYNA_PROGRESS_FILE: PROGRESS_FILE }, encoding: "utf8" });
  murmur("off");
  await api("/chat/progress", { event: "start", origin: "terminal", prompt: "列出檔案" }, A.token);
  await until(() => sentIn(tA).find((s) => /🖥 列出檔案/.test(s.text)));
  await api("/chat/progress", { event: "step", text: "先看目錄", tools: [{ name: "Bash", input: { command: "ls" } }] }, A.token);
  await api("/chat/progress", { event: "step", tools: [{ name: "Read", input: { file_path: "/work/example-app/src/chat.mjs" } }] }, A.token);
  const e1 = await until(() => of("editMessageText").find((e) => /chat\.mjs/.test(e.text)), 3000);
  ok(e1?.text === "🖥 列出檔案\n💭 先看目錄\n🔧 Read: src/chat.mjs(第 2 個工具)" && sentIn(tA).length === 1, `murmur off → edited to the 🖥 line + its 💭 + newest tool only: ${JSON.stringify(e1?.text)}`);
  const firstId = sentIn(tA)[0]._id;
  say("還有 lint", { thread: tA });
  await sleep(300);
  await api("/chat/progress", { event: "step", text: "再找找看", tools: [{ name: "Grep", input: { pattern: "x", path: "/work/example-app" } }] }, A.token);
  const moved = await until(() => sentIn(tA).find((s) => /Grep/.test(s.text)));
  const del = await until(() => of("deleteMessage").find((d) => d.message_id === firstId));
  ok(moved?.disable_notification === true && /^🖥 列出檔案\n💭 先看目錄\n💭 再找找看\n🔧 Grep: .*\(第 3 個工具\)$/.test(moved.text) && !!del,
    `something landed below → a new silent message at the bottom, the old one deleted: ${JSON.stringify(moved?.text)}`);
  await api("/chat/progress", { event: "done", text: "列好了" }, A.token);
  const fin = await until(() => sentIn(tA).find((s) => s.text === "列好了"));
  const doneEdit = await until(() => of("editMessageText").find((e) => e.text === "🖥 列出檔案\n💭 先看目錄\n💭 再找找看\n✅ 完成(3 個工具)"));
  ok(!!doneEdit && fin && !fin.disable_notification, "done → \"✅ 完成(3 個工具)\" under the 🖥 line and every 💭, answer pushed as a new message");
  await api("/chat/take", {}, A.token);
  // a long turn: every 💭 is kept until the message would pass the limit, then the oldest give way
  calls.length = 0;
  await api("/chat/progress", { event: "start", origin: "phone" }, A.token);
  for (let i = 0; i < 20; i++) await api("/chat/progress", { event: "step", text: `第 ${i} 句 ${"話".repeat(380)}`, tools: [{ name: "Bash", input: { command: `echo ${i}` } }] }, A.token);
  await api("/chat/progress", { event: "done", text: "長回合結束" }, A.token);
  await until(() => sentIn(tA).some((s) => s.text === "長回合結束"));
  const all = calls.filter((c) => c.method === "editMessageText" || (c.method === "sendMessage" && c.b.message_thread_id === tA && c.b.text !== "長回合結束")).map((c) => c.b); // in order
  const lastView = all.at(-1)?.text || "";
  ok(all.every((e) => e.text.length <= 3800) && sentIn(tA).filter((s) => s.text !== "長回合結束").length === 1 && /^…\(前面 \d+ 句省略\)\n💭 第 \d+ 句/.test(lastView) && /💭 第 19 句/.test(lastView) && /✅ 完成\(20 個工具\)$/.test(lastView),
    `20 long 💭 → still ONE message, none over 3800, the oldest dropped: ${JSON.stringify(lastView.slice(0, 40))}…`);
  ok(/OFF/.test(murmur("status")) && /ON/.test(murmur("on")) && !fs.existsSync(PROGRESS_FILE) && /ON/.test(murmur("status")),
    "murmur status / on → back to the default (flag file removed)");
  await api("/chat/take", {}, A.token);
}

// 8) a chat session's question goes into its chat topic with the gate line; only a Telegram reply to it
//    answers it — typing without a reply is a chat message, even with that one question waiting
const openOf = async (sid) => (await (await fetch(`${RELAY}/requests?session_id=${sid}`)).json()).requests.filter((q) => !q.answered).map((q) => q.request_id);
const takeSoon = async () => { for (let i = 0; i < 40; i++) { const t = (await api("/chat/take", {}, A.token)).message; if (t) return t; await sleep(50); } return null; };
{
  calls.length = 0;
  const q = await ask({ question: "要用哪個方案?", options: ["A", "B"], session_id: "s-a", session_name: "x", gate: "設計" });
  const kb = await keyboardFor("要用哪個方案");
  ok(kb?.message_thread_id === tA && kb.text.startsWith("🚦 設計\n") && of("createForumTopic").length === 0,
    `ask_human of a chat session → its chat topic, "🚦 設計" header, no gate topic → ${JSON.stringify(kb?.text)}`);
  say("先問一下,A 比較快嗎", { thread: tA });
  const took = await takeSoon();
  ok(took?.text === "先問一下,A 比較快嗎" && (await openOf("s-a")).includes(q.request_id), "typing (no reply) with the question waiting → a chat message for the session, the question still open");
  const m = say("B,但先寫測試", { thread: tA, replyTo: kb._id });
  const a = await answerOf(q.request_id);
  ok(a.kind === "message" && a.text === "B,但先寫測試", `a reply to the question answers it → ${JSON.stringify(a)}`);
  ok(!!(await until(() => of("setMessageReaction").find((r) => r.message_id === m && r.reaction[0].emoji === "👌"))) && (await api("/chat/take", {}, A.token)).message === null,
    "…marked 👌, and not queued in the inbox");
}

// 9) two questions open in the topic → typing is a chat message (no "which one?"); a reply to one answers that one
{
  const q1 = await ask({ question: "第一題", options: ["1"], session_id: "s-a" });
  const q2 = await ask({ question: "第二題", options: ["2"], session_id: "s-a" });
  const kb1 = await keyboardFor("第一題"); const kb2 = await keyboardFor("第二題");
  calls.length = 0;
  say("隨便", { thread: tA });
  const took = await takeSoon();
  ok(took?.text === "隨便" && !sentIn(tA).some((s) => /題在等/.test(s.text || "")), `two questions waiting + typing → a chat message, no "which one?" (${JSON.stringify(took?.text)})`);
  say("就第二個", { thread: tA, replyTo: kb2._id });
  const a2 = await answerOf(q2.request_id);
  say("那第一題這樣", { thread: tA, replyTo: kb1._id });
  const a1 = await answerOf(q1.request_id);
  ok(a2.kind === "message" && a2.text === "就第二個" && a1.kind === "message" && a1.text === "那第一題這樣",
    "a reply to the 2nd question answers it, a reply to the 1st answers the 1st");
}

// 10) the ✍️ fallback no longer takes chat-topic text; it still works from the main chat
{
  const g = await ask({ question: "閘門題", options: ["好"], session_id: "s-g", session_name: "plain", gate: "G" });
  const kb = await keyboardFor("閘門題");
  tap(kb, 1, 0); // ✍️
  await until(() => of("sendMessage").some((s) => s.reply_markup?.force_reply));
  say("這是給 egret 的", { thread: tA });
  await sleep(400);
  const took = await api("/chat/take", {}, A.token);
  ok(took.message?.text === "這是給 egret 的", "a ✍️ pending elsewhere does not steal text typed in a chat topic");
  say("改成 C");
  const a = await answerOf(g.request_id);
  ok(a.kind === "message" && a.text === "改成 C", "…the chat's only pending ✍️ still takes a reply typed in the main chat");
}

// 10b) a known failure case, reproduced: an orchestrator session is a chat session, two questions sit in its
//      💬 topic; the merge question is answered with a button, then the human's words about it must not be
//      taken as the answer to the other question still open (L0/L1)
{
  const qL = await ask({ question: "PROJ-101 L0/L1 分級?", options: ["L0", "L1"], session_id: "s-a", gate: "Orchestrator b-11111111" });
  const qP = await ask({ question: "GH-1 合併 PR #2?", options: ["合併(squash)", "先不要"], session_id: "s-a", gate: "Orchestrator b-22222222" });
  const kL = await keyboardFor("L0/L1"); const kP = await keyboardFor("PR #2");
  ok(kP?.message_thread_id === tA, `both questions in the 💬 topic (thread ${kP?.message_thread_id})`);
  tap(kP, 0, 0);
  const aP = await answerOf(qP.request_id);
  // a reply to the answered merge question → "already answered", not L0/L1's answer, not the inbox
  calls.length = 0;
  say("先不要", { thread: tA, replyTo: kP._id });
  const told = await until(() => sentIn(tA).find((s) => /已經答過/.test(s.text || "")));
  await sleep(300);
  ok(aP.kind === "selection" && !!told && (await openOf("s-a")).includes(qL.request_id) && (await api("/chat/take", {}, A.token)).message === null,
    `a reply to the answered question → "${told?.text}"; L0/L1 still open, nothing queued for the session`);
  // the failing path: "先不要" typed WITHOUT a reply, L0/L1 the only question left →
  // a chat message for the session, not L0/L1's answer
  say("先不要", { thread: tA });
  const took = await takeSoon();
  ok(took?.text === "先不要" && (await openOf("s-a")).includes(qL.request_id), `typed "先不要" after the button answer → a chat message (${JSON.stringify(took?.text)}), L0/L1 still open`);
  // the other failing path: a chat message landing a few seconds after a new question went out → still a chat message
  const qN = await ask({ question: "GH-3 下一步?", options: ["繼續", "停"], session_id: "s-a", gate: "Orchestrator b-new" });
  await keyboardFor("GH-3");
  say("你剛剛那個 build 跑完了嗎", { thread: tA });
  const took2 = await takeSoon();
  ok(took2?.text === "你剛剛那個 build 跑完了嗎" && (await openOf("s-a")).includes(qN.request_id), "a chat message arriving right after a new question → a chat message, the new question still open");
  // ✍️ tapped but typed without replying to its prompt → still a chat message; a reply to the prompt answers
  tap(kL, 1, 0);
  const prompt = await until(() => sentIn(tA).find((s) => s.reply_markup?.force_reply));
  say("L0 跟 L1 差在哪", { thread: tA });
  const took3 = await takeSoon();
  ok(!!prompt && took3?.text === "L0 跟 L1 差在哪" && (await openOf("s-a")).includes(qL.request_id), "✍️ tapped, typed without a reply → a chat message, L0/L1 still open");
  say("請先說明 L0", { thread: tA, replyTo: prompt._id });
  const aL = await answerOf(qL.request_id);
  ok(aL.kind === "message" && aL.text === "請先說明 L0", `a reply to the ✍️ prompt answers L0/L1 → ${JSON.stringify(aL)}`);
  await fetch(`${RELAY}/cancel/${qN.request_id}`, { method: "POST" });
  await answerOf(qN.request_id);
}

// 11) 429: the question waits the cooldown out and still arrives; progress holds back
{
  calls.length = 0;
  limitNext = { method: "sendMessage", after: 1 };
  const t0 = Date.now();
  const q = await ask({ question: "限流題", options: ["好"], session_id: "s-g2", session_name: "plain2" });
  const kb = await keyboardFor("限流題");
  ok(!!kb && calls.some((c) => c.method === "sendMessage:429") && Date.now() - t0 >= 900, `429 retry_after 1 → the question still goes out, after ${Date.now() - t0} ms`);
  tap(kb, 0, 0); await answerOf(q.request_id);
  calls.length = 0;
  await api("/chat/progress", { event: "start", origin: "phone" }, A.token);
  await api("/chat/progress", { event: "step", tools: [{ name: "Bash", input: { command: "first" } }] }, A.token);
  await until(() => sentIn(tA).some((s) => /first/.test(s.text)));
  limitNext = { method: "editMessageText", after: 1 };
  await api("/chat/progress", { event: "step", tools: [{ name: "Bash", input: { command: "second" } }] }, A.token);
  const later = await until(() => of("editMessageText").find((e) => /second/.test(e.text)), 5000);
  ok(calls.some((c) => c.method === "editMessageText:429") && !!later, "a rate-limited progress edit is redone after the cooldown");
  await api("/chat/progress", { event: "done", text: "ok2" }, A.token);
  await until(() => sentIn(tA).some((s) => s.text === "ok2"));
}

// 12) handoff: A hands its question off, another session takes it over — the question stays in A's topic
{
  calls.length = 0;
  const q = await ask({ question: "交接題", options: ["是"], session_id: "s-a", gate: "交接" });
  const kq = await keyboardFor("交接題");
  const d = await api(`/detach/${q.request_id}`, { session_id: "s-a" });
  const r = await api(`/reattach/${q.request_id}`, { session_id: "s-c", session_name: "taker" });
  say("交給你了", { thread: tA, replyTo: kq._id });
  const a = await answerOf(q.request_id);
  ok(d.detached && r.reattached && a.kind === "message" && a.text === "交給你了" && of("createForumTopic").length === 0,
    "a question handed off to another session stays in the chat topic; a reply there still answers it");
}

// 13) close: topic kept as 🔒, token dead, text there is answered with a notice
{
  calls.length = 0;
  const c = await api("/chat/close", {}, A.token);
  const renamed = await until(() => of("editForumTopic").find((e) => e.message_thread_id === tA));
  ok(c.closed && renamed?.name === "🔒 egret · example-app" && of("deleteForumTopic").length === 0, `close → topic kept, renamed "${renamed?.name}"`);
  ok((await api("/chat/take", {}, A.token)).status === 401 && (await (await fetch(`${RELAY}/chat/session?session_id=s-a`)).json()).chat === false, "…its token is dead, /chat/session says chat:false");
  say("還在嗎", { thread: tA });
  ok(!!(await until(() => sentIn(tA).find((s) => /已經結束/.test(s.text)))), "…text in its topic → \"已經結束,訊息沒有送出\"");
}

// 14) relay restart: topic, nick and the unread inbox survive; old tokens don't
{
  say("@egret2 重啟前的訊息");
  await sleep(400);
  relay.kill(); await new Promise((r) => relay.on("exit", r));
  calls.length = 0;
  await startRelay();
  ok((await api("/chat/take", {}, B.token)).status === 401, "after a relay restart the old token → 401");
  const B2 = await api("/chat/register", { session_id: "s-b", nick: "egret2" }, SECRET());
  const t = await api("/chat/take", {}, B2.token);
  ok(B2.nick === "egret2" && B2.topic === B.topic && of("createForumTopic").length === 0 && t.message?.text === "重啟前的訊息",
    `register again → same nick, same topic, the unread message is still there → ${JSON.stringify(t.message?.text)}`);
  const A2 = await api("/chat/register", { session_id: "s-a", nick: "egret", label: "example-app" }, SECRET());
  const back = await until(() => of("editForumTopic").find((e) => e.message_thread_id === tA));
  ok(A2.topic === tA && back?.name === "💬 egret · example-app", "a resumed session reopens its topic (renamed back from 🔒)");
}

// 14c) a "!command" outside any chat topic; a "/command" anywhere is not forwarded
{
  calls.length = 0;
  let A3 = await api("/chat/register", { session_id: "s-a", nick: "egret", label: "example-app" }, SECRET());
  let B3x = await api("/chat/register", { session_id: "s-b", nick: "egret2" }, SECRET());
  // egret2 was written to just before the restart (14) — the relay still knows: the command goes there,
  // with a pointer where it was typed (thread 777, some other topic) to where the answer lands
  say("!cost", { thread: 777 });
  await sleep(400);
  const toB = await api("/chat/take", {}, B3x.token);
  const pointer = await until(() => sentIn(777).find((s) => /已交給 @egret2/.test(s.text)));
  ok(toB.message?.text === "!cost" && !!pointer, `after a relay restart "!cost" in another topic → egret2 (written to before the restart), pointer there: ${JSON.stringify(pointer?.text)}`);
  // in a session's own topic, "@<its nick> !cmd" is the command (the mention is just addressing)
  say("@egret2 !usage", { thread: B3x.topic });
  await sleep(400);
  const own = await api("/chat/take", {}, B3x.token);
  ok(own.message?.text === "!usage", `"@egret2 !usage" in egret2's topic → "${own.message?.text}"`);
  // "/cmd", "@nick /cmd", "/cmd@thebot" (Telegram's command menu): never forwarded — a hint to type "!cmd"
  calls.length = 0;
  say("@egret2 /usage", { thread: B3x.topic });
  say("/context@MynaTestBot full", { thread: tA });
  say("/cost", { thread: 778 });
  const hints = await until(() => { const h = of("sendMessage").filter((m) => /沒有轉給 session/.test(m.text)); return h.length === 3 && h; });
  await sleep(300);
  ok(hints && /改打「!usage」/.test(hints.find((m) => m.message_thread_id === B3x.topic)?.text) && /改打「!context full」/.test(hints.find((m) => m.message_thread_id === tA)?.text)
    && hints.some((m) => m.message_thread_id === 778) && (await api("/chat/take", {}, B3x.token)).message === null && (await api("/chat/take", {}, A3.token)).message === null,
    `"/…" commands → not forwarded, hint in the topic they were typed in: ${JSON.stringify(hints && hints[0].text)}`);
  // a short memory (MYNA_CHAT_TALK_MS) that has run out, two sessions live → ask which, change nothing
  relay.kill(); await new Promise((r) => relay.on("exit", r));
  await startRelay({ MYNA_CHAT_TALK_MS: "1500" });
  calls.length = 0;
  A3 = await api("/chat/register", { session_id: "s-a", nick: "egret", label: "example-app" }, SECRET());
  B3x = await api("/chat/register", { session_id: "s-b", nick: "egret2" }, SECRET());
  await sleep(1600);
  say("!cost");
  const asked = await until(() => of("sendMessage").find((m) => /要給哪個 session/.test(m.text)));
  ok(asked && /@egret/.test(asked.text) && /@egret2/.test(asked.text) && /「@egret !cost」/.test(asked.text) && (await api("/chat/take", {}, A3.token)).message === null && (await api("/chat/take", {}, B3x.token)).message === null,
    `"!cost" outside a topic, no one written to lately, two sessions → asked: ${JSON.stringify(asked?.text)}`);
  // after writing in A's topic, a topic-less command goes to A (full-width "！" too)
  say("嗨", { thread: tA }); await sleep(300); await api("/chat/take", {}, A3.token);
  say("！cost");
  await sleep(400);
  const toA = await api("/chat/take", {}, A3.token);
  ok(toA.message?.text === "！cost", `…after writing in egret's topic, "！cost" outside a topic → egret: ${JSON.stringify(toA.message?.text)}`);
  // a "/…@someone else" is not a command for us: forwarded as plain text
  say("/usage@someone", { thread: tA });
  await sleep(400);
  const other = await api("/chat/take", {}, A3.token);
  ok(other.message?.text === "/usage@someone", `"/usage@someone" kept as text: "${other.message?.text}"`);
  A.token = A3.token; B.token = B3x.token;
}

// 14b) the human deleted the chat topic → the next message recreates it
{
  calls.length = 0;
  const B3 = await api("/chat/register", { session_id: "s-b", nick: "egret2" }, SECRET());
  goneTopics.add(B3.topic);
  await api("/chat/progress", { event: "start", origin: "phone" }, B3.token);
  await api("/chat/progress", { event: "done", text: "topic 被刪後的回答" }, B3.token);
  const fresh = await until(() => of("createForumTopic").find((t) => t.name === "💬 egret2 · other"));
  const landed = await until(() => of("sendMessage").find((s) => s.text === "topic 被刪後的回答"));
  ok(!!fresh && landed && landed.message_thread_id !== B3.topic && landed.message_thread_id > 0, `deleted topic → recreated (thread ${landed?.message_thread_id}) and the answer lands there`);
}

// 15) Stop hook: a chat session ending on a question is not bounced
{
  const hook = fileURLToPath(new URL("../scripts/stop-catch-question.mjs", import.meta.url));
  const run = (sid) => new Promise((resolve) => {
    const c = spawn(process.execPath, [hook], { env: { ...process.env, MYNA_RELAY_URL: RELAY, MYNA_STOPCATCH_FILE: path.join(tmp, "stopcatch") } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", () => resolve(out));
    c.stdin.end(JSON.stringify({ session_id: sid, last_assistant_message: "改好了。要我現在就開 PR 嗎?" }));
  });
  const chatOut = await run("s-a"), plainOut = await run("s-plain");
  ok(chatOut === "" && /"block"/.test(plainOut), "stop-catch: chat session → no bounce; a plain session → still bounced");
}

// 16) no topics (TELEGRAM_TOPICS=off / no Threaded Mode): the session talks in the main chat as [nick]
{
  relay.kill(); await new Promise((r) => relay.on("exit", r));
  await startRelay({ TELEGRAM_TOPICS: "off", MYNA_CHAT_TOPICS_FILE: path.join(tmp, "chat-topics-flat.json") });
  calls.length = 0;
  const F = await api("/chat/register", { session_id: "s-f", nick: "finch", label: "flat" }, SECRET());
  const hello = await until(() => of("sendMessage").find((s) => /finch/.test(s.text)));
  ok(F.topic === null && of("createForumTopic").length === 0 && /^\[finch\] 💬 finch\(flat\) 已連線/.test(hello?.text) && !hello.message_thread_id,
    `no topics → hello in the main chat: "${hello?.text}"`);
  await api("/chat/progress", { event: "start", origin: "phone" }, F.token);
  await api("/chat/progress", { event: "step", tools: [{ name: "Bash", input: { command: "ls" } }] }, F.token);
  await api("/chat/progress", { event: "done", text: "列好了" }, F.token);
  const ans = await until(() => of("sendMessage").find((s) => /列好了/.test(s.text)));
  ok(ans?.text === "[finch] 列好了" && of("sendMessage").some((s) => s.text.startsWith("[finch] 🔧 Bash: ls")), "progress and answer are prefixed [finch]");
  const q = await ask({ question: "平面題", options: ["好"], session_id: "s-f", gate: "G" });
  const kb = await keyboardFor("平面題");
  ok(kb?.text.startsWith("[finch]\n🚦 G\n"), `its question says whose it is → ${JSON.stringify(kb?.text)}`);
  say("用回覆回答", { replyTo: kb._id });
  const a = await answerOf(q.request_id);
  ok(a.kind === "message" && a.text === "用回覆回答", "a reply to its question answers it");
  say("@finch 下一步");
  say("沒加 nick 的閒聊");
  await sleep(400);
  const t1 = await api("/chat/take", {}, F.token), t2 = await api("/chat/take", {}, F.token);
  ok(t1.message?.text === "下一步" && t2.message === null, "@finch reaches it; unaddressed chatter does not");
}

// 17) a chat place without a topic (its create failed — Telegram unreachable — or topics were off)
// is not final: every registration tries again while topics are on; a failed retry stays in the main
// chat without repeating "已連線" there (a reconnect still says "重新連線了"), and the record stays retryable
{
  const FLAT = path.join(tmp, "chat-topics-flat.json");
  const rec = () => JSON.parse(fs.readFileSync(FLAT, "utf8"))["s-f"];
  ok(rec()?.thread === null, "finch's record (topics were off) has no topic");
  relay.kill(); await new Promise((r) => relay.on("exit", r));
  await startRelay({ MYNA_CHAT_TOPICS_FILE: FLAT });
  calls.length = 0;
  const finchMsgs = () => of("sendMessage").filter((s) => /finch/.test(s.text));
  dropCreate = 99;
  const R1 = await api("/chat/register", { session_id: "s-f", nick: "finch", label: "flat" }, SECRET());
  await sleep(300);
  ok(R1.status === 200 && R1.topic === null && of("createForumTopic:dropped").length >= 1 && finchMsgs().length === 0 && rec()?.thread === null,
    `Telegram unreachable: registration retried the topic (${of("createForumTopic:dropped").length} attempt(s)), stays in the main chat, says nothing again, record still retryable`);
  await api("/chat/close", {}, R1.token);
  calls.length = 0;
  const R2 = await api("/chat/register", { session_id: "s-f", nick: "finch", label: "flat" }, SECRET());
  await sleep(300);
  ok(R2.topic === null && of("createForumTopic:dropped").length >= 1 && finchMsgs().length === 1 && finchMsgs()[0].text === "[finch] 💬 finch 重新連線了。" && !finchMsgs()[0].message_thread_id,
    `a reconnect that still gets no topic says "重新連線了" once, in the main chat → ${JSON.stringify(finchMsgs().map((s) => s.text))}`);
  dropCreate = 0;
  calls.length = 0;
  const R3 = await api("/chat/register", { session_id: "s-f", nick: "finch", label: "flat" }, SECRET());
  const intro = await until(() => finchMsgs()[0]);
  ok(R3.topic && of("createForumTopic").length === 1 && of("createForumTopic")[0].name === "💬 finch · flat" && intro?.message_thread_id === R3.topic
    && intro.text.startsWith("💬 finch 已連線。在這個 topic 打字") && rec()?.thread === R3.topic,
    `Telegram back: the next registration gets its topic (${R3.topic}), says hello there, and the record keeps it`);
  calls.length = 0;
  say("topic 裡的訊息", { thread: R3.topic });
  await sleep(400);
  const t = await api("/chat/take", {}, R3.token);
  const R4 = await api("/chat/register", { session_id: "s-f", nick: "finch", label: "flat" }, SECRET());
  ok(t.message?.text === "topic 裡的訊息" && R4.topic === R3.topic && of("createForumTopic").length === 0,
    "text in the new topic reaches finch; a later registration keeps that topic (no new create)");
}

relay.kill(); stub.close(); clearTimeout(watchdog);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ CHAT E2E PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
