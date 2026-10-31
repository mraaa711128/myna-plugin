#!/usr/bin/env node
// Autonomous e2e of the REAL relay + telegram provider against a local Telegram API stub
// (TELEGRAM_API_BASE). No phone, no real bot. Proves the provider refactor kept the wire
// behavior: sendMessage body/keyboard shape, callback → selection, ✍️ → force_reply → free
// text → {kind:"message"}, ⏹ → {kind:"aborted"}, and the /ask → /answer HTTP contract.
// Plus per-session TOPICS (Bot API 9.3+ private-chat topics): one createForumTopic per session,
// every message of that session carries message_thread_id, a deleted topic is recreated, a bot
// without Threaded Mode falls back to the flat chat, and /session/close closes the topic.
// Plus per-GATE topics (step 15): gate switch / round-end (Stop hook) / session end each end a topic.
// Plus several gates of one session at once (step 18): each in its own topic, every answer on its own question.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 100s"); process.exit(1); }, 100000);

// --- Telegram API stub ---------------------------------------------------------
const sent = [];        // captured sendMessage bodies
let updates = [];       // queued getUpdates payloads (delivered once)
let nextUpdateId = 1;
let mid = 100;
const topicsCreated = [];  // captured createForumTopic bodies
const topicsClosed = [];   // captured closeForumTopic bodies
const topicsRenamed = [];  // captured editForumTopic bodies
const topicsDeleted = [];  // captured deleteForumTopic bodies
let privateChat = false;   // simulate a private chat: closeForumTopic is rejected there
let nextTopic = 500;
let forbidTopics = false;  // simulate a bot WITHOUT Threaded Mode
const goneTopics = new Set(); // sendMessage into these → "message thread not found"
const slowTexts = new Map();  // sendMessage text → delay (ms) before the stub answers (race reproductions)
let deleteDelay = 0;          // deleteForumTopic answered (and applied) after this many ms
let deleteWipes = false;      // a processed deleteForumTopic makes the thread gone, like real Telegram
const markupEdits = [];       // captured editMessageReplyMarkup bodies (buttons retracted on cancel)
const cbAnswers = [];         // captured answerCallbackQuery bodies (the toast a tapper sees)
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (/\/getUpdates$/.test(u.pathname)) {
      const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); };
      if (updates.length) deliver();
      else setTimeout(deliver, 150); // short empty long-poll cycle
      return;
    }
    if (/\/sendMessage$/.test(u.pathname)) {
      const b = JSON.parse(body || "{}");
      setTimeout(() => {
        if (b.message_thread_id && goneTopics.has(b.message_thread_id)) { json({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }); return; }
        const id = ++mid; Object.defineProperty(b, "_id", { value: id }); // the message id (non-enumerable: bodies stay as sent)
        sent.push(b); json({ ok: true, result: { message_id: id } });
      }, slowTexts.get(b.text) || 0);
      return;
    }
    if (/\/createForumTopic$/.test(u.pathname)) {
      const b = JSON.parse(body || "{}"); topicsCreated.push(b);
      if (forbidTopics) { json({ ok: false, error_code: 400, description: "Bad Request: BOT_FORUM_CREATE_FORBIDDEN" }); return; }
      json({ ok: true, result: { message_thread_id: ++nextTopic, name: b.name } }); return;
    }
    if (/\/editForumTopic$/.test(u.pathname)) { topicsRenamed.push(JSON.parse(body || "{}")); json({ ok: true, result: true }); return; }
    if (/\/deleteForumTopic$/.test(u.pathname)) {
      const b = JSON.parse(body || "{}");
      setTimeout(() => { topicsDeleted.push(b); if (deleteWipes) goneTopics.add(b.message_thread_id); json({ ok: true, result: true }); }, deleteDelay);
      return;
    }
    if (/\/closeForumTopic$/.test(u.pathname)) {
      topicsClosed.push(JSON.parse(body || "{}"));
      if (privateChat) { json({ ok: false, error_code: 400, description: "Bad Request: the chat is not a supergroup forum" }); return; }
      json({ ok: true, result: true }); return;
    }
    if (/\/answerCallbackQuery$/.test(u.pathname)) { cbAnswers.push(JSON.parse(body || "{}")); json({ ok: true }); return; }
    if (/\/editMessageReplyMarkup$/.test(u.pathname)) { markupEdits.push(JSON.parse(body || "{}")); json({ ok: true, result: true }); return; }
    json({ ok: true, result: {} });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

// --- real relay, pointed at the stub -------------------------------------------
const topicsFile = path.join(os.tmpdir(), `myna-topics-test-${process.pid}.json`);
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const child = spawn(process.execPath, [relayPath], {
  env: {
    ...process.env,
    MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"), // never read the machine's real config
    MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: stubBase,
    RELAY_PORT: String(RELAY_PORT), MYNA_ANSWER_HOLD_MS: "1500",
    MYNA_TOPICS_FILE: topicsFile, TELEGRAM_TOPIC_ON_END: "close", // steps 12/12b exercise close; 13 covers delete (default) + keep
    TELEGRAM_TOPIC_ROUND_GRACE: "0", // 12/12b check the end right after /session/close; the grace itself is step 15h
    MYNA_PENDING_FILE: path.join(os.tmpdir(), `myna-pending-test-${process.pid}-main.json`),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
for (let i = 0; ; i++) { // wait for relay http
  try { await fetch(`${RELAY}/`, { signal: AbortSignal.timeout(500) }); break; }
  catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
}

const ask = (args) => fetch(`${RELAY}/ask`, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());
async function answer(id) { // loop over bounded-poll {kind:"pending"}
  for (;;) {
    const j = await (await fetch(`${RELAY}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json();
    if (j.kind !== "pending") return j;
  }
}
async function lastKeyboard() { // wait for the stub to capture a keyboard message
  for (let i = 0; i < 50; i++) {
    const msg = [...sent].reverse().find((s) => s.reply_markup?.inline_keyboard);
    if (msg) return msg;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no keyboard message captured");
}
const push = (u) => updates.push({ update_id: nextUpdateId++, ...u });
const cbFor = (kb, row, idx) => kb.reply_markup.inline_keyboard[row][idx].callback_data;

// 1) selection: tap button "2" → {kind:"selection", value:"乙"}
let { request_id } = await ask({ header: "t", question: "選一個?", options: ["甲", "乙"] });
let kb = await lastKeyboard();
ok(kb.chat_id === "42" && /\[t\]\n選一個\?\n1\. 甲\n2\. 乙/.test(kb.text), `question body renders header + numbered options → ${JSON.stringify(kb.text)}`);
push({ callback_query: { id: "cq1", data: cbFor(kb, 0, 1), message: { chat: { id: 42 } } } });
let r = await answer(request_id);
ok(r.kind === "selection" && r.value === "乙", `button 2 → ${JSON.stringify(r)}`);

// 2) ✍️ free text: ask button → force_reply prompt → user text → {kind:"message"}
sent.length = 0;
({ request_id } = await ask({ question: "q2", options: ["A", "B"] }));
kb = await lastKeyboard();
push({ callback_query: { id: "cq2", data: cbFor(kb, 1, 0), message: { chat: { id: 42 } } } }); // ✍️
for (let i = 0; i < 50 && !sent.some((s) => s.reply_markup?.force_reply); i++) await new Promise((r2) => setTimeout(r2, 100));
ok(sent.some((s) => s.reply_markup?.force_reply), "✍️ triggers a force_reply prompt");
push({ message: { chat: { id: 42 }, text: "先解釋差異" } });
r = await answer(request_id);
ok(r.kind === "message" && r.text === "先解釋差異", `free text → ${JSON.stringify(r)}`);

// 3) ⏹ abort
sent.length = 0;
({ request_id } = await ask({ question: "q3", options: ["A"] }));
kb = await lastKeyboard();
push({ callback_query: { id: "cq3", data: cbFor(kb, 1, 1), message: { chat: { id: 42 } } } }); // ⏹
r = await answer(request_id);
ok(r.kind === "aborted", `⏹ → ${JSON.stringify(r)}`);

// 4) stray text (no pending ✍️) is ignored — decision 8a
push({ message: { chat: { id: 42 }, text: "hi" } });
({ request_id } = await ask({ question: "q4", options: ["A", "B"] }));
kb = await lastKeyboard();
push({ callback_query: { id: "cq4", data: cbFor(kb, 0, 0), message: { chat: { id: 42 } } } });
r = await answer(request_id);
ok(r.kind === "selection" && r.value === "A", `stray text ignored, next selection clean → ${JSON.stringify(r)}`);

// 4b) only TELEGRAM_CHAT_ID may answer: a tap or a ✍️ reply from any other chat is dropped (anyone
//     can DM the bot or add it to a group; the callback token alone must not be enough)
const settled = async (id) => (await (await fetch(`${RELAY}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json()).kind !== "pending";
sent.length = 0;
({ request_id } = await ask({ question: "q4b", options: ["A", "B"] }));
kb = await lastKeyboard();
push({ callback_query: { id: "cq4b", data: cbFor(kb, 0, 1), from: { id: 666 }, message: { chat: { id: 666 } } } });
await new Promise((r2) => setTimeout(r2, 400));
ok(!(await settled(request_id)) && cbAnswers.some((a) => a.callback_query_id === "cq4b" && /沒有權限/.test(a.text || "")),
  "a button tap from another chat does not answer (the tapper is told they may not)");
push({ callback_query: { id: "cq4b2", data: cbFor(kb, 1, 0), message: { chat: { id: 42 } } } }); // ✍️ from the owner
for (let i = 0; i < 50 && !sent.some((s) => s.reply_markup?.force_reply); i++) await new Promise((r2) => setTimeout(r2, 100));
push({ message: { chat: { id: 666 }, from: { id: 666 }, text: "陌生人的回覆" } });
await new Promise((r2) => setTimeout(r2, 400));
ok(!(await settled(request_id)), "…nor does text from another chat while a ✍️ reply is awaited");
push({ message: { chat: { id: 42 }, text: "本人的回覆" } });
r = await answer(request_id);
ok(r.kind === "message" && r.text === "本人的回覆", `…the owner's reply still answers → ${JSON.stringify(r)}`);

// 4c) markdown in preamble / question / options reaches the phone as plain text (no parse_mode,
//     so Telegram can never reject it); the button still answers with the option's own text
sent.length = 0;
({ request_id } = await ask({
  header: "**範圍**",
  preamble: "## 結論\n**建議選 A**,見 [PR #28](https://github.com/x/y/pull/28)。\n\n| 選項 | 說明 |\n|---|---|\n| A | 快 |",
  question: "改 `src/relay.mjs`,路徑 C:\\Users\\me\\.myna\\.env 不動?",
  options: ["**A** 只改 `telegram`", "B"],
}));
kb = await lastKeyboard();
const pre = sent.find((s) => !s.reply_markup);
ok(pre?.text === "結論\n建議選 A,見 PR #28 https://github.com/x/y/pull/28 。\n\n選項：A\n說明：快", `preamble → plain text: ${JSON.stringify(pre?.text)}`);
ok(kb.text === "[範圍]\n改 src/relay.mjs,路徑 C:\\Users\\me\\.myna\\.env 不動?\n1. A 只改 telegram\n2. B", `question + options → plain text, backslashes kept: ${JSON.stringify(kb.text)}`);
ok(sent.every((s) => !("parse_mode" in s)), "no parse_mode on any message");
push({ callback_query: { id: "cq4c", data: cbFor(kb, 0, 0), message: { chat: { id: 42 } } } });
r = await answer(request_id);
ok(r.kind === "selection" && r.value === "**A** 只改 `telegram`", `the button answers with the option exactly as given → ${JSON.stringify(r)}`);
for (let i = 0; i < 50 && !sent.some((s) => /你選了/.test(s.text)); i++) await new Promise((r2) => setTimeout(r2, 100));
ok(sent.some((s) => s.text === "✅ 你選了:A 只改 telegram"), `…the ✅ shown on the phone is plain text: ${JSON.stringify(sent.find((s) => /你選了/.test(s.text))?.text)}`);

// --- topics: one per session ------------------------------------------------------
// 5) first ask of session s1 creates a topic named after the session; question lands in it
sent.length = 0;
({ request_id } = await ask({ question: "t1", options: ["A", "B"], session_id: "s1", session_name: "example-app 09/18 11:27" }));
kb = await lastKeyboard();
ok(topicsCreated.length === 1 && topicsCreated[0].chat_id === "42" && topicsCreated[0].name === "example-app 09/18 11:27",
  `session s1 → createForumTopic(name=session_name) → ${JSON.stringify(topicsCreated[0])}`);
const t1 = kb.message_thread_id;
ok(t1 === 501, `question carries message_thread_id of the new topic → ${t1}`);
push({ callback_query: { id: "cq5", data: cbFor(kb, 0, 0), message: { chat: { id: 42 }, message_thread_id: t1 } } });
r = await answer(request_id);
// (a ✅ from the previous test may still trickle in — wait for THIS session's, i.e. the one in topic t1)
const confirmedIn = (t) => sent.some((s) => /✅/.test(s.text) && s.message_thread_id === t);
for (let i = 0; i < 50 && !confirmedIn(t1); i++) await new Promise((r2) => setTimeout(r2, 100));
ok(r.kind === "selection" && confirmedIn(t1), "✅ confirmation stays in the session topic");

// 6) second ask of s1 (with preamble + thread_id) reuses the topic — no second createForumTopic
sent.length = 0;
({ request_id } = await ask({ question: "t1b", options: ["A"], session_id: "s1", session_name: "example-app 09/18 11:27", thread_id: "th-1", preamble: "先說明" }));
kb = await lastKeyboard();
ok(topicsCreated.length === 1 && kb.message_thread_id === t1 && sent.find((s) => s.text === "先說明")?.message_thread_id === t1,
  "same session → same topic for preamble + question, no new createForumTopic");
// ✍️ inside the topic: force_reply prompt is in the topic; the reply arrives with message_thread_id
push({ callback_query: { id: "cq6", data: cbFor(kb, 1, 0), message: { chat: { id: 42 }, message_thread_id: t1 } } });
for (let i = 0; i < 50 && !sent.some((s) => s.reply_markup?.force_reply); i++) await new Promise((r2) => setTimeout(r2, 100));
ok(sent.find((s) => s.reply_markup?.force_reply)?.message_thread_id === t1, "✍️ force_reply prompt is sent into the session topic");
push({ message: { chat: { id: 42 }, message_thread_id: t1, text: "topic 內的反問" } });
r = await answer(request_id);
ok(r.kind === "message" && r.text === "topic 內的反問", `free text from inside the topic resolves → ${JSON.stringify(r)}`);

// 6b) the session learned its ticket → session_name changes → topic renamed in place (no new topic)
sent.length = 0;
({ request_id } = await ask({ question: "t1t", options: ["A"], session_id: "s1", session_name: "PROJ-2499 · example-app 09/18 11:27" }));
kb = await lastKeyboard();
ok(topicsCreated.length === 1 && kb.message_thread_id === t1 && topicsRenamed.length === 1
  && topicsRenamed[0].message_thread_id === t1 && topicsRenamed[0].name === "PROJ-2499 · example-app 09/18 11:27",
  `ticket learned mid-session → editForumTopic renames the topic → ${JSON.stringify(topicsRenamed[0])}`);
push({ callback_query: { id: "cq6b", data: cbFor(kb, 0, 0), message: { chat: { id: 42 }, message_thread_id: t1 } } });
await answer(request_id);
sent.length = 0;
({ request_id } = await ask({ question: "t1u", options: ["A"], session_id: "s1", session_name: "PROJ-2499 · example-app 09/18 11:27" }));
kb = await lastKeyboard();
ok(topicsRenamed.length === 1, "same name again → no rename call");
push({ callback_query: { id: "cq6c", data: cbFor(kb, 0, 0), message: { chat: { id: 42 }, message_thread_id: t1 } } });
await answer(request_id);

// 7) a different session gets its own topic
sent.length = 0;
({ request_id } = await ask({ question: "t2", options: ["A"], session_id: "s2", session_name: "other-project 09/18 11:30" }));
kb = await lastKeyboard();
const t2 = kb.message_thread_id;
ok(topicsCreated.length === 2 && t2 === 502 && t2 !== t1, `session s2 → its own topic → ${t2}`);
push({ callback_query: { id: "cq7", data: cbFor(kb, 0, 0), message: { chat: { id: 42 }, message_thread_id: t2 } } });
await answer(request_id);
const persisted = JSON.parse(fs.readFileSync(topicsFile, "utf8"));
ok(persisted.s1?.thread === t1 && persisted.s2?.thread === t2, "session→topic map persisted to MYNA_TOPICS_FILE (survives relay restarts)");

// 8) two sessions both awaiting ✍️ text: replies route by topic, never guessed
sent.length = 0;
const a1 = await ask({ question: "w1", options: ["A"], session_id: "s1", session_name: "x" });
const a2 = await ask({ question: "w2", options: ["A"], session_id: "s2", session_name: "y" });
for (let i = 0; i < 50 && sent.filter((s) => s.reply_markup?.inline_keyboard).length < 2; i++) await new Promise((r2) => setTimeout(r2, 100));
const kb1 = sent.find((s) => s.reply_markup?.inline_keyboard && s.message_thread_id === t1);
const kb2 = sent.find((s) => s.reply_markup?.inline_keyboard && s.message_thread_id === t2);
push({ callback_query: { id: "cq8a", data: cbFor(kb1, 1, 0), message: { chat: { id: 42 }, message_thread_id: t1 } } });
push({ callback_query: { id: "cq8b", data: cbFor(kb2, 1, 0), message: { chat: { id: 42 }, message_thread_id: t2 } } });
for (let i = 0; i < 50 && sent.filter((s) => s.reply_markup?.force_reply).length < 2; i++) await new Promise((r2) => setTimeout(r2, 100));
push({ message: { chat: { id: 42 }, message_thread_id: t2, text: "給 s2" } });
push({ message: { chat: { id: 42 }, message_thread_id: t1, text: "給 s1" } });
const [r1, r2] = await Promise.all([answer(a1.request_id), answer(a2.request_id)]);
ok(r1.text === "給 s1" && r2.text === "給 s2", `parallel ✍️ replies route by topic → s1=${JSON.stringify(r1.text)} s2=${JSON.stringify(r2.text)}`);

// 9) the human deleted the topic → "message thread not found" → recreated once, question delivered
sent.length = 0; goneTopics.add(t1);
({ request_id } = await ask({ question: "t1c", options: ["A"], session_id: "s1", session_name: "PROJ-2499 · example-app 09/18 11:27" }));
kb = await lastKeyboard();
ok(topicsCreated.length === 3 && kb.message_thread_id === 503, `deleted topic → recreated (thread ${kb.message_thread_id}), question delivered`);
push({ callback_query: { id: "cq9", data: cbFor(kb, 0, 0), message: { chat: { id: 42 }, message_thread_id: 503 } } });
await answer(request_id);

// 10) bot without Threaded Mode: createForumTopic rejected → flat chat, not retried for that session
sent.length = 0; forbidTopics = true;
({ request_id } = await ask({ question: "flat", options: ["A"], session_id: "s3", session_name: "no-topics" }));
kb = await lastKeyboard();
ok(topicsCreated.length === 4 && kb.message_thread_id === undefined, "no Threaded Mode → question goes to the flat chat");
push({ callback_query: { id: "cq10", data: cbFor(kb, 0, 0), message: { chat: { id: 42 } } } });
await answer(request_id);
sent.length = 0;
({ request_id } = await ask({ question: "flat2", options: ["A"], session_id: "s3", session_name: "no-topics" }));
kb = await lastKeyboard();
ok(topicsCreated.length === 4 && kb.message_thread_id === undefined, "…and the failed create is remembered (no retry per ask)");
push({ callback_query: { id: "cq10b", data: cbFor(kb, 0, 0), message: { chat: { id: 42 } } } });
await answer(request_id);
forbidTopics = false;

// 11) no session_id (old clients / direct curl) → flat chat, no topic call
sent.length = 0;
({ request_id } = await ask({ question: "legacy", options: ["A"] }));
kb = await lastKeyboard();
ok(topicsCreated.length === 4 && kb.message_thread_id === undefined, "ask without session_id → flat chat (backward compatible)");
push({ callback_query: { id: "cq11", data: cbFor(kb, 0, 0), message: { chat: { id: 42 } } } });
await answer(request_id);

// 12) session end → closeForumTopic on its topic, map entry dropped
await fetch(`${RELAY}/session/close`, { method: "POST", body: JSON.stringify({ session_id: "s2" }) });
ok(topicsClosed.length === 1 && topicsClosed[0].message_thread_id === t2, `POST /session/close s2 → closeForumTopic(${t2})`);
ok(JSON.parse(fs.readFileSync(topicsFile, "utf8")).s2 === undefined, "closed session removed from the persisted map");
await fetch(`${RELAY}/session/close`, { method: "POST", body: JSON.stringify({ session_id: "never-asked" }) });
ok(topicsClosed.length === 1, "closing an unknown session is a no-op");

// 12b) private chat (the normal Myna case): closeForumTopic rejected → topic renamed with 🔒 prefix instead
privateChat = true;
const renamedBefore = topicsRenamed.length;
await fetch(`${RELAY}/session/close`, { method: "POST", body: JSON.stringify({ session_id: "s1" }) });
ok(topicsClosed.length === 2 && topicsRenamed.length === renamedBefore + 1 && topicsRenamed.at(-1).message_thread_id === 503
  && topicsRenamed.at(-1).name === "🔒 PROJ-2499 · example-app 09/18 11:27",
  `private chat: close rejected → editForumTopic "${topicsRenamed.at(-1)?.name}"`);
privateChat = false;

child.kill();
// let the dead relay's in-flight getUpdates poll drain at the stub (it would otherwise absorb the
// next pushed update 150ms later) before a fresh relay starts polling the same queue.
await new Promise((r) => setTimeout(r, 500));

// 13) TELEGRAM_TOPIC_ON_END=delete / keep — same relay, different setting (fresh relay per mode)
for (const [mode, expectDeleted, expectClosed] of [["delete", 1, 2], ["keep", 1, 2]]) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const c2 = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env, MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: stubBase,
      RELAY_PORT: String(port), MYNA_ANSWER_HOLD_MS: "1500", MYNA_TOPICS_FILE: topicsFile,
      MYNA_PENDING_FILE: path.join(os.tmpdir(), `myna-pending-test-${process.pid}-${mode}.json`),
      TELEGRAM_TOPIC_ROUND_GRACE: "0", // the end is checked right after /session/close
      ...(mode === "delete" ? {} : { TELEGRAM_TOPIC_ON_END: mode }), // delete is the default → leave it unset
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
  }
  sent.length = 0;
  const { request_id: rid } = await fetch(`http://127.0.0.1:${port}/ask`, { method: "POST", body: JSON.stringify({ question: mode, options: ["A"], session_id: `s-${mode}`, session_name: mode }) }).then((r) => r.json());
  const k = await lastKeyboard();
  push({ callback_query: { id: `cq-${mode}`, data: cbFor(k, 0, 0), message: { chat: { id: 42 }, message_thread_id: k.message_thread_id } } });
  for (;;) { const j = await (await fetch(`http://127.0.0.1:${port}/answer/${rid}`, { signal: AbortSignal.timeout(5000) })).json(); if (j.kind !== "pending") break; }
  await fetch(`http://127.0.0.1:${port}/session/close`, { method: "POST", body: JSON.stringify({ session_id: `s-${mode}` }) });
  ok(topicsDeleted.length === expectDeleted && topicsClosed.length === expectClosed,
    `TELEGRAM_TOPIC_ON_END=${mode === "delete" ? "(unset → delete, the default)" : mode} → session end ${mode === "delete" ? "deletes the topic" : "leaves the topic untouched"} (deleted=${topicsDeleted.length}, closed=${topicsClosed.length})`);
  ok(JSON.parse(fs.readFileSync(topicsFile, "utf8"))[`s-${mode}`] === undefined, `…and the session is dropped from the map either way`);
  c2.kill();
  await new Promise((r) => setTimeout(r, 500)); // same drain as above
}

// 14) HANDOFF — open gates survive a relay restart/upgrade via the journal (MYNA_PENDING_FILE):
//     relay A sends two questions (one waiting on a button, one already at the ✍️ prompt), dies;
//     relay B starts on the same port with the same journal → /health shows them, the OLD buttons
//     on the phone still resolve, the ✍️ reply still lands, and the client's /answer poll just resumes.
{
  const port = 20000 + Math.floor(Math.random() * 20000);
  const journal = path.join(os.tmpdir(), `myna-pending-test-${process.pid}-handoff.json`);
  const env = {
    ...process.env, MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"), MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: stubBase,
    RELAY_PORT: String(port), MYNA_ANSWER_HOLD_MS: "1500", MYNA_TOPICS_FILE: topicsFile, MYNA_PENDING_FILE: journal,
  };
  // the relay may be rewriting the journal right now (Windows can refuse its atomic rename while we read
  // and falls back to a plain write) — a half-written read is retried, not a failure
  const readJournal = () => {
    for (let i = 0; ; i++) {
      try { return JSON.parse(fs.readFileSync(journal, "utf8")); }
      catch (e) { if (i > 50) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
    }
  };
  const boot = async () => {
    const c = spawn(process.execPath, [relayPath], { env, stdio: ["ignore", "inherit", "inherit"] });
    for (let i = 0; ; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; }
      catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
    }
    return c;
  };
  const askAt = (args) => fetch(`http://127.0.0.1:${port}/ask`, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());
  const answerAt = async (id) => { for (;;) { const j = await (await fetch(`http://127.0.0.1:${port}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json(); if (j.kind !== "pending") return j; } };
  const healthAt = () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());

  const a = await boot();
  sent.length = 0;
  const { request_id: r1 } = await askAt({ header: "h", question: "handoff-1", options: ["甲", "乙", "丙"], session_id: "s-h", session_name: "handoff" });
  const kb1 = await lastKeyboard();
  const { request_id: r2 } = await askAt({ question: "handoff-2", options: ["A"], session_id: "s-h", session_name: "handoff" });
  const kb2 = await lastKeyboard();
  push({ callback_query: { id: "cq-h-ask", data: cbFor(kb2, 1, 0), message: { chat: { id: 42 }, message_thread_id: kb2.message_thread_id } } }); // ✍️ on #2
  for (let i = 0; i < 50 && !sent.some((s) => s.reply_markup?.force_reply); i++) await new Promise((r) => setTimeout(r, 100));
  let h = await healthAt();
  ok(h.handoff === true && h.pending === 2 && h.journal === journal, `relay A: /health {handoff:true, pending:2, journal} → ${JSON.stringify({ handoff: h.handoff, pending: h.pending })}`);
  const j = readJournal();
  ok(Object.keys(j.requests).sort().join() === [r1, r2].sort().join() && j.provider.tokens.length >= 6 && j.provider.awaiting.length === 1,
    `journal written through: 2 requests, ${j.provider.tokens.length} button tokens, 1 ✍️ waiter`);

  a.kill(); await new Promise((r) => setTimeout(r, 500)); // relay A gone (upgrade / crash); drain its poll at the stub
  const b = await boot();
  h = await healthAt();
  ok(h.pending === 2, `relay B adopted the journal: /health pending=${h.pending}`);
  // the OLD button (token minted by relay A, already on the phone) resolves on relay B
  push({ callback_query: { id: "cq-h-sel", data: cbFor(kb1, 0, 2), message: { chat: { id: 42 }, message_thread_id: kb1.message_thread_id } } });
  let r = await answerAt(r1);
  ok(r.kind === "selection" && r.value === "丙", `old button from relay A → relay B resolves ${JSON.stringify(r)}`);
  // the ✍️ prompt sent by relay A: the free-text reply lands on relay B
  push({ message: { chat: { id: 42 }, text: "交接後的回覆", message_thread_id: kb2.message_thread_id } });
  r = await answerAt(r2);
  ok(r.kind === "message" && r.text === "交接後的回覆", `✍️ reply after the handoff → ${JSON.stringify(r)}`);
  const after = readJournal();
  ok(Object.keys(after.requests).length === 0 && after.provider.tokens.length === 0 && after.provider.awaiting.length === 0, "journal emptied once both answers were collected");
  // an answered-but-uncollected gate also survives: answer on A, restart, collect on B
  const { request_id: r3 } = await askAt({ question: "handoff-3", options: ["X", "Y"], session_id: "s-h", session_name: "handoff" });
  const kb3 = await lastKeyboard();
  push({ callback_query: { id: "cq-h-3", data: cbFor(kb3, 0, 1), message: { chat: { id: 42 }, message_thread_id: kb3.message_thread_id } } });
  for (let i = 0; i < 50 && readJournal().requests[r3]?.result === undefined; i++) await new Promise((r) => setTimeout(r, 100));
  b.kill(); await new Promise((r) => setTimeout(r, 500));
  const c = await boot();
  r = await answerAt(r3);
  ok(r.kind === "selection" && r.value === "Y", `answer given before the restart is delivered by the next relay → ${JSON.stringify(r)}`);
  c.kill(); await new Promise((r) => setTimeout(r, 500));
  try { fs.unlinkSync(journal); } catch {}
}

// 15) PER-GATE topics (TELEGRAM_TOPIC_SCOPE=gate, the default): a gate = 1..n questions asked one
//     call at a time under the same `gate`; its topic is named "<gate> · <session_name>" and ends when
//     the session moves to another gate, when Claude finishes its reply (/session/round-end, sent by
//     the Stop hook) with nothing of the session open and no new ask within the grace, or when the
//     session ends.
{
  const port = 20000 + Math.floor(Math.random() * 20000);
  const journal = path.join(os.tmpdir(), `myna-pending-test-${process.pid}-gate.json`);
  const env = {
    ...process.env, MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"), MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: stubBase,
    RELAY_PORT: String(port), MYNA_ANSWER_HOLD_MS: "1500", MYNA_TOPICS_FILE: topicsFile, MYNA_PENDING_FILE: journal,
    TELEGRAM_TOPIC_ROUND_GRACE: "0.8",
  };
  const boot = async (extra = {}) => {
    const c = spawn(process.execPath, [relayPath], { env: { ...env, ...extra }, stdio: ["ignore", "inherit", "inherit"] });
    for (let i = 0; ; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; }
      catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
    }
    return c;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const askAt = (args) => fetch(`http://127.0.0.1:${port}/ask`, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());
  const answerAt = async (id) => { for (;;) { const j = await (await fetch(`http://127.0.0.1:${port}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json(); if (j.kind !== "pending") return j; } };
  const roundEnd = (sid) => fetch(`http://127.0.0.1:${port}/session/round-end`, { method: "POST", body: JSON.stringify({ session_id: sid }) }).then((r) => r.json());
  const S = { session_id: "s-gate", session_name: "PROJ-7 · proj 09/23 10:00" };
  const deleted = (t) => topicsDeleted.some((d) => d.message_thread_id === t);
  const waitDeleted = async (t) => { for (let i = 0; i < 30 && !deleted(t); i++) await sleep(100); return deleted(t); };
  const kbFor = async (question) => { // the keyboard message of THIS question
    for (let i = 0; i < 50; i++) { const m = sent.find((s) => s.reply_markup?.inline_keyboard && s.text.includes(question)); if (m) return m; await sleep(100); }
    throw new Error(`no keyboard for ${question}`);
  };
  const tap = (k, row, idx) => push({ callback_query: { id: `cq-${Math.random()}`, data: cbFor(k, row, idx), message: { chat: { id: 42 }, message_thread_id: k.message_thread_id } } });
  const created0 = topicsCreated.length;

  let c = await boot();
  sent.length = 0;
  // a) gate G1, question 1 → topic named after the gate; ✍️ follow-up re-asked WITHOUT gate stays in it
  let { request_id: rid } = await askAt({ question: "g1-q1", options: ["A", "B"], gate: "gate② space-time", ...S });
  let k = await kbFor("g1-q1");
  const tA = k.message_thread_id;
  ok(topicsCreated.at(-1)?.name === "gate② space-time · PROJ-7 · proj 09/23 10:00", `gate → topic named "${topicsCreated.at(-1)?.name}"`);
  tap(k, 1, 0);
  for (let i = 0; i < 50 && !sent.some((s) => s.reply_markup?.force_reply && s.message_thread_id === tA); i++) await sleep(100);
  push({ message: { chat: { id: 42 }, message_thread_id: tA, text: "先解釋" } });
  await answerAt(rid);
  ({ request_id: rid } = await askAt({ question: "g1-q1b", options: ["A", "B"], preamble: "差異是…", ...S }));
  k = await kbFor("g1-q1b");
  ok(k.message_thread_id === tA && !deleted(tA), "✍️ re-ask without `gate` joins the current gate's topic");
  tap(k, 0, 0); await answerAt(rid);
  // b) question 2 of the same gate, asked after the answer (the AI worked in between) → same topic
  await sleep(300);
  ({ request_id: rid } = await askAt({ question: "g1-q2", options: ["A"], gate: "gate② space-time", ...S }));
  k = await kbFor("g1-q2");
  ok(k.message_thread_id === tA && topicsCreated.length === created0 + 1 && !deleted(tA), "next question of the SAME gate → same topic, nothing deleted");
  tap(k, 0, 0); await answerAt(rid);
  // c) a new gate → the previous gate's topic ends, a new one named after the new gate opens
  sent.length = 0;
  ({ request_id: rid } = await askAt({ question: "g2-q1", options: ["A"], gate: "gate③ AC scope", ...S }));
  k = await kbFor("g2-q1");
  const tB = k.message_thread_id;
  ok(tB !== tA && await waitDeleted(tA) && topicsCreated.at(-1)?.name === "gate③ AC scope · PROJ-7 · proj 09/23 10:00",
    `new gate → topic ${tA} deleted, fresh topic ${tB} "${topicsCreated.at(-1)?.name}"`);
  // d) round-end while that gate's question is still open → not over
  let re = await roundEnd("s-gate");
  await sleep(300);
  ok(re.ended === false && !deleted(tB), "round-end with a question still open → topic kept");
  tap(k, 0, 0); await answerAt(rid);
  // e) Claude finished its reply → round-end → after the grace the gate is over → topic deleted
  re = await roundEnd("s-gate");
  await sleep(300);
  ok(re.ended === true && !deleted(tB), "round-end → not deleted during the grace");
  ok(await waitDeleted(tB) && JSON.parse(fs.readFileSync(topicsFile, "utf8"))["s-gate"] === undefined,
    `…deleted once the grace passes (topic ${tB}), session dropped from the map`);
  // e2) the AI asks again within the grace (it was waiting on something the Stop hook couldn't see)
  //     → same gate, same topic; the round-end is cancelled
  sent.length = 0;
  ({ request_id: rid } = await askAt({ question: "e2-q1", options: ["A"], gate: "G-e2", ...S }));
  k = await kbFor("e2-q1");
  const tE = k.message_thread_id;
  tap(k, 0, 0); await answerAt(rid);
  await roundEnd("s-gate");
  await sleep(300);
  ({ request_id: rid } = await askAt({ question: "e2-q2", options: ["A"], gate: "G-e2", ...S }));
  k = await kbFor("e2-q2");
  await sleep(1200);
  ok(k.message_thread_id === tE && !deleted(tE), `ask within the grace → topic ${tE} kept, round-end cancelled`);
  tap(k, 0, 0); await answerAt(rid);
  // e3) relay restarted inside the grace → the next relay still ends the topic (endsAt persisted)
  await roundEnd("s-gate");
  c.kill(); await sleep(500);
  ok(!deleted(tE) && JSON.parse(fs.readFileSync(topicsFile, "utf8"))["s-gate"]?.endsAt, "relay stopped inside the grace (endsAt persisted)");
  c = await boot();
  ok(await waitDeleted(tE), `restarted relay ends the overdue topic ${tE}`);
  // f) next reply, question without gate → a fresh topic, NOT carrying the old gate's name
  sent.length = 0;
  ({ request_id: rid } = await askAt({ question: "n-q1", options: ["A"], ...S }));
  k = await kbFor("n-q1");
  const tC = k.message_thread_id;
  ok(tC !== tB && topicsCreated.at(-1)?.name === "PROJ-7 · proj 09/23 10:00", `next round without gate → fresh topic "${topicsCreated.at(-1)?.name}"`);
  tap(k, 0, 0); await answerAt(rid);
  // g) gate switch while a question of the old gate is still open (parallel calls) → the old topic
  //    is NOT ended under it; it goes once nothing is open (round-end)
  sent.length = 0;
  const p1 = await askAt({ question: "p-q1", options: ["A"], gate: "G-x", ...S });
  const kx = await kbFor("p-q1");
  const tX = kx.message_thread_id;
  const p2 = await askAt({ question: "p-q2", options: ["A"], gate: "G-y", ...S });
  const ky = await kbFor("p-q2");
  await sleep(300);
  ok(await waitDeleted(tC) && ky.message_thread_id !== tX && !deleted(tX), `gate switch with an open question → old topic ${tX} kept (stale), previous idle topic ${tC} ended`);
  tap(kx, 0, 0); await answerAt(p1.request_id);
  tap(ky, 0, 0); await answerAt(p2.request_id);
  await roundEnd("s-gate");
  ok(await waitDeleted(tX) && await waitDeleted(ky.message_thread_id), "round-end (after the grace) ends the stale topic too");
  // h) session end with a live gate → its topic goes after the grace, not at once (a `claude -p`
  //    run ends the moment it has its answer — the ✅ line must stay readable for a while);
  //    unknown session round-end is a no-op
  const closeAt = (sid) => fetch(`http://127.0.0.1:${port}/session/close`, { method: "POST", body: JSON.stringify({ session_id: sid }) });
  const mapped = (sid) => JSON.parse(fs.readFileSync(topicsFile, "utf8"))[sid];
  ({ request_id: rid } = await askAt({ question: "h-q", options: ["A"], gate: "G-h", ...S }));
  k = await kbFor("h-q");
  tap(k, 0, 0); await answerAt(rid);
  await closeAt("s-gate");
  ok(!deleted(k.message_thread_id) && mapped("s-gate")?.closed === true && mapped("s-gate")?.endsAt > Date.now(), "session end → topic not deleted during the grace (deadline persisted)");
  ok(await waitDeleted(k.message_thread_id) && mapped("s-gate") === undefined, "…and deleted once the grace is over");
  // h2) session end inside a grace the round end already started → that deadline stands (not pushed back)
  ({ request_id: rid } = await askAt({ question: "h2-q", options: ["A"], gate: "G-h2", ...S }));
  k = await kbFor("h2-q");
  tap(k, 0, 0); await answerAt(rid);
  await roundEnd("s-gate");
  const deadline = mapped("s-gate")?.endsAt;
  await sleep(200);
  await closeAt("s-gate");
  ok(deadline > 0 && mapped("s-gate")?.endsAt === deadline && mapped("s-gate")?.closed === true, "round end then session end → the round end's deadline is kept");
  ok(await waitDeleted(k.message_thread_id), "…and the topic goes at that deadline");
  // h3) a resumed session (same id) asks again inside that grace → same gate, same topic, end called off
  ({ request_id: rid } = await askAt({ question: "h3-q1", options: ["A"], gate: "G-h3", ...S }));
  k = await kbFor("h3-q1");
  const tH = k.message_thread_id;
  tap(k, 0, 0); await answerAt(rid);
  await closeAt("s-gate");
  ({ request_id: rid } = await askAt({ question: "h3-q2", options: ["A"], gate: "G-h3", ...S }));
  k = await kbFor("h3-q2");
  await sleep(1100); // past the grace
  ok(k.message_thread_id === tH && !deleted(tH) && mapped("s-gate")?.closed === undefined, `ask after the session end, within the grace → topic ${tH} kept`);
  tap(k, 0, 0); await answerAt(rid);
  await closeAt("s-gate");
  ok(await waitDeleted(tH), "…and it goes after the session ends again");
  const before = topicsDeleted.length;
  re = await roundEnd("never-asked");
  await sleep(200);
  ok(topicsDeleted.length === before, "round-end for a session without topics → no-op");
  c.kill(); await sleep(500);

  // i) TELEGRAM_TOPIC_SCOPE=session → pre-0.8 layout: gates ignored, one topic per session, round-end no-op
  c = await boot({ TELEGRAM_TOPIC_SCOPE: "session" });
  sent.length = 0;
  const T = { session_id: "s-scope", session_name: "scope" };
  ({ request_id: rid } = await askAt({ question: "s-q1", options: ["A"], gate: "G1", ...T }));
  k = await kbFor("s-q1");
  const tS = k.message_thread_id;
  tap(k, 0, 0); await answerAt(rid);
  ({ request_id: rid } = await askAt({ question: "s-q2", options: ["A"], gate: "G2", ...T }));
  const k2 = await kbFor("s-q2");
  tap(k2, 0, 0); await answerAt(rid);
  await roundEnd("s-scope"); await sleep(300);
  ok(k2.message_thread_id === tS && topicsCreated.find((t) => t.name === "scope") && !deleted(tS), "scope=session → one topic for both gates, named after the session, kept at round-end");
  await fetch(`http://127.0.0.1:${port}/session/close`, { method: "POST", body: JSON.stringify({ session_id: "s-scope" }) });
  ok(await waitDeleted(tS), "…and deleted at session end");
  c.kill(); await sleep(500);
  try { fs.unlinkSync(journal); } catch {}
}

// 16) never strand a gate (found in code review): a topic with a question on its way to the phone
//     must not be ended under it — neither by a racing gate switch (f1) nor by /session/close while a
//     question of the session is still open (f2, e.g. two MCP processes sharing a Claude session id);
//     and recreating a vanished topic must not drop the stale topics it still has to clean up (f3).
{
  const port = 20000 + Math.floor(Math.random() * 20000);
  const journal = path.join(os.tmpdir(), `myna-pending-test-${process.pid}-strand.json`);
  const env = {
    ...process.env, MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"), MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: stubBase,
    RELAY_PORT: String(port), MYNA_ANSWER_HOLD_MS: "1500", MYNA_TOPICS_FILE: topicsFile, MYNA_PENDING_FILE: journal,
    TELEGRAM_TOPIC_ROUND_GRACE: "0.3",
  };
  const c = spawn(process.execPath, [relayPath], { env, stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const askAt = (args) => fetch(`http://127.0.0.1:${port}/ask`, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json());
  const answerAt = async (id) => { for (;;) { const j = await (await fetch(`http://127.0.0.1:${port}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json(); if (j.kind !== "pending") return j; } };
  const post = (p, sid) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify({ session_id: sid }) }).then((r) => r.json());
  const deleted = (t) => topicsDeleted.some((d) => d.message_thread_id === t);
  const kbFor = async (question) => {
    for (let i = 0; i < 50; i++) { const m = sent.find((x) => x.reply_markup?.inline_keyboard && x.text.includes(question)); if (m) return m; await sleep(100); }
    throw new Error(`no keyboard for ${question}`);
  };
  const tap = (k, row, idx) => push({ callback_query: { id: `cq-${Math.random()}`, data: cbFor(k, row, idx), message: { chat: { id: 42 }, message_thread_id: k.message_thread_id } } });
  sent.length = 0;

  // f1) gate A's next question is mid-send (slow preamble, no buttons registered yet) when a gate-B
  //     question of the same session arrives; Telegram applies the delete only after A's question
  //     landed. A's topic must be kept (stale) — otherwise its question is wiped while still pending.
  const R = { session_id: "s-race", session_name: "race" };
  let { request_id: rid } = await askAt({ question: "f1-a1", options: ["A"], gate: "GA", ...R });
  let k = await kbFor("f1-a1");
  const tA = k.message_thread_id;
  tap(k, 0, 0); await answerAt(rid);
  slowTexts.set("SLOW-PREAMBLE", 300); deleteDelay = 1000; deleteWipes = true;
  const pA2 = askAt({ question: "f1-a2", options: ["A"], gate: "GA", preamble: "SLOW-PREAMBLE", ...R });
  await sleep(100);
  const pB = askAt({ question: "f1-b1", options: ["B"], gate: "GB", ...R });
  const [a2] = await Promise.all([pA2, pB]);
  const kA2 = await kbFor("f1-a2");
  await sleep(1300); // let any delete of A land
  const stranded = deleted(kA2.message_thread_id) && !sent.some((x) => x.text?.includes("f1-a2") && x.message_thread_id !== kA2.message_thread_id);
  ok(!stranded, `gate switch while gate A's question is mid-send → A's topic ${kA2.message_thread_id} not deleted under it (deleted=${deleted(kA2.message_thread_id)})`);
  slowTexts.clear(); deleteDelay = 0;
  const kB = await kbFor("f1-b1");
  tap(kB, 0, 0); tap(kA2, 0, 0);
  const [rA2] = await Promise.all([answerAt(a2.request_id)]);
  ok(rA2.kind === "selection", `…and A's question is still answerable → ${JSON.stringify(rA2)}`);
  await post("/session/round-end", "s-race");
  for (let i = 0; i < 30 && !(deleted(tA) && deleted(kB.message_thread_id)); i++) await sleep(100);
  ok(deleted(tA) && deleted(kB.message_thread_id), "…and both topics are cleaned up once the round ends");

  // f2) /session/close while a question of that session is still open (another MCP process with the
  //     same Claude session id exits) → its topic stays until the question is answered, then goes
  sent.length = 0;
  const C = { session_id: "s-close", session_name: "close" };
  ({ request_id: rid } = await askAt({ question: "f2-q", options: ["A"], gate: "GC", ...C }));
  k = await kbFor("f2-q");
  await post("/session/close", "s-close");
  await sleep(400);
  ok(!deleted(k.message_thread_id), `/session/close with an open question → topic ${k.message_thread_id} kept`);
  tap(k, 0, 0);
  const rC = await answerAt(rid);
  for (let i = 0; i < 30 && !deleted(k.message_thread_id); i++) await sleep(100);
  ok(rC.kind === "selection" && deleted(k.message_thread_id), "…the question is answered, then the deferred close ends the topic");

  // f3) gate A still open when gate B starts (A → stale); B's topic vanishes and is recreated →
  //     the stale A must survive the recreate and be cleaned up at round end
  sent.length = 0;
  const T = { session_id: "s-stale", session_name: "stale" };
  const g1 = await askAt({ question: "f3-a", options: ["A"], gate: "GA", ...T });
  const kS = await kbFor("f3-a");
  const g2 = await askAt({ question: "f3-b1", options: ["B"], gate: "GB", ...T });
  const kB1 = await kbFor("f3-b1");
  tap(kB1, 0, 0); await answerAt(g2.request_id);
  goneTopics.add(kB1.message_thread_id); // the human deleted B's topic
  const g3 = await askAt({ question: "f3-b2", options: ["B"], gate: "GB", ...T });
  const kB2 = await kbFor("f3-b2");
  const entry = JSON.parse(fs.readFileSync(topicsFile, "utf8"))["s-stale"];
  ok(kB2.message_thread_id !== kB1.message_thread_id && (entry?.stale || []).some(([t]) => t === kS.message_thread_id),
    `B's topic recreated (${kB1.message_thread_id} → ${kB2.message_thread_id}) and stale A ${kS.message_thread_id} still tracked → ${JSON.stringify(entry?.stale)}`);
  tap(kS, 0, 0); tap(kB2, 0, 0);
  await Promise.all([answerAt(g1.request_id), answerAt(g3.request_id)]);
  await post("/session/round-end", "s-stale");
  for (let i = 0; i < 30 && !deleted(kS.message_thread_id); i++) await sleep(100);
  ok(deleted(kS.message_thread_id), "…and the stale A topic is cleaned up at round end");
  deleteWipes = false;

  // f5) the asking side gives up (human answered in the terminal / Esc, or the MCP process exits) →
  //     POST /cancel/<id>: buttons retracted, a note in the topic, the request resolves "cancelled",
  //     and the gate no longer counts as open — round-end can end its topic
  sent.length = 0;
  const X = { session_id: "s-cancel", session_name: "cancel" };
  ({ request_id: rid } = await askAt({ question: "f5-q", options: ["A", "B"], gate: "GX", ...X }));
  k = await kbFor("f5-q");
  const cx = await post(`/cancel/${rid}`);
  const rX = await answerAt(rid);
  for (let i = 0; i < 30 && !sent.some((x) => /已在終端機/.test(x.text || "")); i++) await sleep(100);
  ok(cx.cancelled === true && rX.kind === "cancelled", `POST /cancel → request resolves ${JSON.stringify(rX)}`);
  ok(markupEdits.some((e) => e.reply_markup?.inline_keyboard?.length === 0) && sent.some((x) => /已在終端機/.test(x.text || "") && x.message_thread_id === k.message_thread_id),
    "…the phone's buttons are retracted and the topic says it was handled in the terminal");
  tap(k, 0, 0); await sleep(300);
  ok(!sent.some((x) => /✅ 你選了/.test(x.text || "") && x.message_thread_id === k.message_thread_id), "…an old button of the cancelled question no longer answers anything");
  ok((await post(`/cancel/${rid}`)).cancelled === false, "…cancelling again (or an answered request) is a no-op");
  const re = await post("/session/round-end", "s-cancel");
  for (let i = 0; i < 30 && !deleted(k.message_thread_id); i++) await sleep(100);
  ok(re.ended === true && deleted(k.message_thread_id), "…and the cancelled gate doesn't hold the round end: topic cleaned up");
  c.kill(); await sleep(500);
  try { fs.unlinkSync(journal); } catch {}
}

// 18) SEVERAL GATES AT ONCE: one session asks two gates in parallel (an orchestrator asking for two
//     workers). Each keeps its own topic; every answer — a button, ✍️ text, a reply to the question —
//     lands on its own question, never on whichever ✍️ happens to be waiting (the failure this guards against: a
//     "先不要" typed in one gate's topic was taken by the other gate's ✍️); a re-ask without `gate`
//     goes back to its thread's gate; "第 x/y 題" when the caller gives both; it all survives a restart.
{
  const port = 20000 + Math.floor(Math.random() * 20000);
  const journal = path.join(os.tmpdir(), `myna-pending-test-${process.pid}-multi.json`);
  const env = {
    ...process.env, MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"), MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: stubBase,
    RELAY_PORT: String(port), MYNA_ANSWER_HOLD_MS: "500", MYNA_TOPICS_FILE: topicsFile, MYNA_PENDING_FILE: journal,
    TELEGRAM_TOPIC_ROUND_GRACE: "0.3",
  };
  const boot = async () => {
    const c = spawn(process.execPath, [relayPath], { env, stdio: ["ignore", "inherit", "inherit"] });
    for (let i = 0; ; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); break; }
      catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 100)); }
    }
    return c;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const askAt = (args) => fetch(`http://127.0.0.1:${port}/ask`, { method: "POST", body: JSON.stringify(args) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  // the answer, or null if none came within ms (a wrongly routed answer must not hang the test)
  const answerWithin = async (id, ms = 2500) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      const j = await (await fetch(`http://127.0.0.1:${port}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json();
      if (j.kind !== "pending") return j;
    }
    return null;
  };
  const openIds = async () => (await (await fetch(`http://127.0.0.1:${port}/requests?session_id=s-multi`)).json()).requests.filter((q) => !q.answered).map((q) => q.request_id);
  const deleted = (t) => topicsDeleted.some((d) => d.message_thread_id === t);
  const until = async (f, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = f(); if (v) return v; } return f(); };
  const kbFor = async (question) => (await until(() => sent.find((x) => x.reply_markup?.inline_keyboard && x.text.includes(question)))) || (() => { throw new Error(`no keyboard for ${question}`); })();
  const tap = (k, row, idx) => push({ callback_query: { id: `cq-${Math.random()}`, data: cbFor(k, row, idx), message: { chat: { id: 42 }, message_thread_id: k.message_thread_id } } });
  const prompts = (t) => sent.filter((x) => x.reply_markup?.force_reply && x.message_thread_id === t);
  let human = 9000;
  const type = (t, text, replyTo) => { const id = ++human; push({ message: { chat: { id: 42 }, message_id: id, message_thread_id: t, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } }); return id; };
  const S = { session_id: "s-multi", session_name: "multi" };
  let c = await boot();
  sent.length = 0;

  // a) two gates at once → two topics; the first gate's topic stays
  const qa = await askAt({ question: "m-a1 L0/L1?", options: ["L0", "L1"], gate: "GA", thread_id: "th-A", ...S });
  const ka = await kbFor("m-a1");
  const qb = await askAt({ question: "m-b1 合併 PR?", options: ["合併", "先不要"], gate: "GB", thread_id: "th-B", ...S });
  const kb = await kbFor("m-b1");
  const tA = ka.message_thread_id, tB = kb.message_thread_id;
  await sleep(300);
  ok(tA && tB && tA !== tB && !deleted(tA), `two gates at once → two topics (${tA}, ${tB}), the first one kept`);

  // b) the failure case: ✍️ tapped on A, then "先不要" typed (not a reply) in B's topic → it is NOT A's answer
  tap(ka, 1, 0);
  const pA = await until(() => prompts(tA)[0]);
  type(tB, "先不要");
  await sleep(500);
  const open1 = await openIds();
  ok(!!pA && open1.includes(qa.request_id) && open1.includes(qb.request_id), `text typed in gate B's topic is not taken by gate A's waiting ✍️ (both still open: ${open1.length})`);

  // c) a reply to B's question message answers B (Telegram's own way of answering one message)
  type(tB, "先不要", kb._id);
  const rB = await answerWithin(qb.request_id);
  ok(rB?.kind === "message" && rB.text === "先不要", `a reply to gate B's question → B's answer ${JSON.stringify(rB)}`);
  // …and a reply to A's ✍️ prompt answers A
  type(tA, "先解釋 L0", pA._id);
  const rA = await answerWithin(qa.request_id);
  ok(rA?.kind === "message" && rA.text === "先解釋 L0", `a reply to gate A's ✍️ prompt → A's answer ${JSON.stringify(rA)}`);

  // d) A's follow-up WITHOUT `gate` (same thread_id) → back into A's topic, although B was asked last
  const qa2 = await askAt({ question: "m-a1b 那 L0/L1?", options: ["L0", "L1"], thread_id: "th-A", preamble: "差別是…", ...S });
  const ka2 = await kbFor("m-a1b");
  ok(ka2.message_thread_id === tA, `re-ask without gate, same thread_id → gate A's topic ${tA} (got ${ka2.message_thread_id})`);
  tap(ka2, 0, 1);
  const rA2 = await answerWithin(qa2.request_id);
  ok(rA2?.kind === "selection" && rA2.value === "L1", `…its button answers it ${JSON.stringify(rA2)}`);
  // e) gate B's next question → back into B's topic, no new topic
  const created0 = topicsCreated.length;
  const qb2 = await askAt({ question: "m-b2 現在合併?", options: ["合併", "先不要"], gate: "GB", ...S });
  const kb2 = await kbFor("m-b2");
  ok(kb2.message_thread_id === tB && topicsCreated.length === created0, `gate B's next question → B's topic ${tB}, no new topic (got ${kb2.message_thread_id})`);

  // f) a third gate asks two related questions at once with x/y → one new topic; idle gate A ends,
  //    gate B (its question still open) stays
  const qc1 = await askAt({ question: "m-c1 排序?", options: ["新→舊", "舊→新"], gate: "GC", questionNumber: 1, questionTotal: 2, ...S });
  const qc2 = await askAt({ question: "m-c2 門檻?", options: ["3", "5"], gate: "GC", questionNumber: 2, questionTotal: 2, ...S });
  const kc1 = await kbFor("m-c1"), kc2 = await kbFor("m-c2");
  const tC = kc1.message_thread_id;
  ok(tC && kc2.message_thread_id === tC && ![tA, tB].includes(tC), `two questions of one gate → one new topic ${tC}`);
  ok(/^第 1\/2 題\n/.test(kc1.text) && /^第 2\/2 題\n/.test(kc2.text), `"第 x/y 題" shown → ${JSON.stringify(kc1.text.split("\n")[0])}, ${JSON.stringify(kc2.text.split("\n")[0])}`);
  ok(await until(() => deleted(tA)) && !deleted(tB), `new gate → idle gate A's topic ${tA} ended, gate B's ${tB} (question open) kept`);
  const qd = await askAt({ question: "m-d 只給 y", options: ["好"], gate: "GC", questionTotal: 2, ...S });
  const kd = await kbFor("m-d");
  ok(!/第 /.test(kd.text), "only questionTotal given → no x/y line");
  tap(kd, 0, 0); await answerWithin(qd.request_id);
  const bad = await askAt({ question: "m-bad", options: ["好"], questionNumber: 3, questionTotal: 2, ...S });
  ok(bad.status === 400 && /questionNumber/.test(bad.error || ""), `questionNumber > questionTotal → 400 (${bad.error})`);

  // g) both questions of gate C await ✍️ in one topic: plain typing is not guessed; a reply to the
  //    FIRST prompt answers the first (it used to land on whichever ✍️ was tapped last)
  tap(kc1, 1, 0);
  const p1 = await until(() => prompts(tC)[0]);
  tap(kc2, 1, 0);
  const p2 = await until(() => prompts(tC)[1]);
  const before = sent.length;
  type(tC, "隨便");
  const hint = await until(() => sent.slice(before).find((x) => x.message_thread_id === tC && /2 題在等/.test(x.text || "")));
  const open2 = await openIds();
  ok(!!p1 && !!p2 && !!hint && open2.includes(qc1.request_id) && open2.includes(qc2.request_id), `two ✍️ waiting in one topic + plain text → not guessed, asked to reply ("${hint?.text}")`);
  type(tC, "新的在上面", p1._id);
  const rc1 = await answerWithin(qc1.request_id);
  ok(rc1?.kind === "message" && rc1.text === "新的在上面", `a reply to the FIRST ✍️ prompt → the first question ${JSON.stringify(rc1)}`);
  // a reply to the question that is already answered (its message, or its ✍️ prompt) answers nothing —
  // not the question still open next to it — and the human is told so
  for (const [what, id] of [["question message", kc1._id], ["✍️ prompt", p1._id]]) {
    const n = sent.length;
    type(tC, "其實要舊的在上面", id);
    const told = await until(() => sent.slice(n).find((x) => x.message_thread_id === tC && /已經答過/.test(x.text || "")));
    ok(!!told && (await openIds()).includes(qc2.request_id), `a reply to the answered question's ${what} → "${told?.text}", the open question untouched`);
  }
  type(tC, "門檻用 4");
  const rc2 = await answerWithin(qc2.request_id);
  ok(rc2?.kind === "message" && rc2.text === "門檻用 4", `…with one left, plain typing answers it ${JSON.stringify(rc2)}`);

  // h) relay restart with gate B still open: its old button works, its next question goes back to its topic
  c.kill(); await sleep(500);
  c = await boot();
  tap(kb2, 0, 1);
  const rb2 = await answerWithin(qb2.request_id);
  ok(rb2?.kind === "selection" && rb2.value === "先不要", `after a restart → gate B's old button still answers B ${JSON.stringify(rb2)}`);
  const qb3 = await askAt({ question: "m-b3 再確認?", options: ["好"], gate: "GB", ...S });
  const kb3 = await kbFor("m-b3");
  ok(kb3.message_thread_id === tB, `after a restart → gate B's next question still goes to B's topic ${tB} (got ${kb3.message_thread_id})`);
  tap(kb3, 0, 0); await answerWithin(qb3.request_id);

  // i) round end with nothing open → every gate topic of the session ends
  await fetch(`http://127.0.0.1:${port}/session/round-end`, { method: "POST", body: JSON.stringify({ session_id: "s-multi" }) });
  ok(await until(() => deleted(tB) && deleted(tC)), `round end → gate topics ${tB} and ${tC} ended`);
  c.kill(); await sleep(500);

  // j) a journal from before 0.17.0 (one ✍️ per place: awaitingText `${chat}:${topic}` -> id) is adopted:
  //    the ✍️ answer it was waiting for still lands
  fs.writeFileSync(journal, JSON.stringify({ version: "0.16.2", requests: { abcdef0123: { created: Date.now(), session_id: "s-multi" } }, closing: [],
    provider: { tokens: [], awaitingText: [["42:777", "abcdef0123"]], threadLastMsg: [], questionMsg: [["abcdef0123", { message_id: 4242, topic: 777, chat: "42" }]], askPrompts: [] } }));
  c = await boot();
  type(777, "舊 journal 的回覆");
  const rOld = await answerWithin("abcdef0123");
  ok(rOld?.kind === "message" && rOld.text === "舊 journal 的回覆", `pre-0.17 journal adopted → its ✍️ answer still lands ${JSON.stringify(rOld)}`);
  c.kill(); await sleep(500);
  try { fs.unlinkSync(journal); } catch {}
}

// 17) PAIRING (/myna:pair): a relay with only a token runs unpaired; POST /pair/start issues a one-time
//     code; `!pair <code>` from a chat binds it (an old `/pair <code>` only gets a hint) (written to the chat file); re-pairing moves new questions
//     to the new chat while the old chat's open question stays answerable there; wrong codes are refused
//     and 5 of them void the code; the binding survives a restart.
{
  const chatFile = path.join(os.tmpdir(), `myna-chat-test-${process.pid}.json`);
  const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
  try { fs.unlinkSync(chatFile); } catch {}
  const port = 20000 + Math.floor(Math.random() * 20000);
  const at = (p) => `http://127.0.0.1:${port}${p}`;
  const env = {
    ...process.env, MYNA_ENV: path.join(os.tmpdir(), "myna-no-such-env"), MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_API_BASE: stubBase, TELEGRAM_TOPICS: "off", // no TELEGRAM_CHAT_ID
    MYNA_TELEGRAM_CHAT_FILE: chatFile, RELAY_PORT: String(port), MYNA_ANSWER_HOLD_MS: "1500",
    MYNA_TOPICS_FILE: topicsFile, MYNA_PENDING_FILE: path.join(os.tmpdir(), `myna-pending-test-${process.pid}-pair.json`),
  };
  delete env.TELEGRAM_CHAT_ID;
  const startRelay = async () => {
    const c = spawn(process.execPath, [relayPath], { env, stdio: ["ignore", "inherit", "inherit"] });
    for (let i = 0; ; i++) {
      try { await fetch(at("/"), { signal: AbortSignal.timeout(500) }); return c; }
      catch { if (i > 40) { console.error("❌ relay never came up"); process.exit(1); } await sleep(100); }
    }
  };
  const askP = (args) => fetch(at("/ask"), { method: "POST", body: JSON.stringify(args) }).then((r2) => r2.json());
  const answerP = async (id) => { for (;;) { const j = await (await fetch(at(`/answer/${id}`), { signal: AbortSignal.timeout(5000) })).json(); if (j.kind !== "pending") return j; } };
  const openP = async (id) => (await (await fetch(at(`/answer/${id}`), { signal: AbortSignal.timeout(5000) })).json()).kind === "pending";
  const status = () => fetch(at("/pair/status")).then((r2) => r2.json());
  const startCode = () => fetch(at("/pair/start"), { method: "POST" }).then((r2) => r2.json());
  const sentTo = (chat, re) => sent.some((m) => String(m.chat_id) === String(chat) && re.test(m.text || ""));
  const waitSent = async (chat, re) => { for (let i = 0; i < 40 && !sentTo(chat, re); i++) await sleep(100); return sentTo(chat, re); };
  const say = (chat, text, extra = {}) => push({ message: { chat, from: { id: chat.id > 0 ? chat.id : 5 }, text, ...extra } });
  const me = { id: 77, type: "private", first_name: "Alice" };
  const stranger = { id: 666, type: "private", first_name: "Eve" };
  const team = { id: -100555, type: "supergroup", title: "Team" };

  let c = await startRelay();
  sent.length = 0;
  const unpaired = await answerP((await askP({ question: "before-pair", options: ["A"] })).request_id);
  ok(unpaired.kind === "unreachable" && (await status()).chat === null,
    `pairing: a relay with only a token runs; unpaired, a question resolves unreachable (the terminal answers) → ${JSON.stringify(unpaired.kind)}`);

  say(me, "!pair 123456");
  ok(await waitSent(77, /配對碼不正確或已過期/) && (await status()).chat === null, "…!pair with no live code is refused, nothing bound");

  let { code } = await startCode();
  ok(/^\d{6}$/.test(code), `…POST /pair/start issues a 6-digit one-time code`);
  sent.length = 0;
  say(stranger, `!pair ${code === "000000" ? "000001" : "000000"}`);
  ok(await waitSent(666, /配對碼不正確/) && (await status()).chat === null, "…a wrong code is refused");
  say(me, `/pair ${code}`);
  ok(await waitSent(77, /配對請改打「!pair \d{6}」/) && (await status()).chat === null, "…the old \"/pair <code>\" binds nothing, a hint to type \"!pair\" instead");
  say(me, `！pair ${code}`);
  ok(await waitSent(77, /已綁定這個聊天室/), "…the right code (full-width ！pair) binds the chat it was sent from (✅ reply there)");
  const saved = JSON.parse(fs.readFileSync(chatFile, "utf8"));
  ok(saved.chat_id === "77" && saved.type === "private" && (fs.statSync(chatFile).mode & 0o777) === 0o600 && (await status()).chat?.id === "77",
    `…and records it in the chat file (0600) → ${JSON.stringify(saved)}`);
  sent.length = 0;
  say(stranger, `!pair ${code}`);
  ok(await waitSent(666, /配對碼不正確/) && (await status()).chat?.id === "77", "…the code is one-use: replaying it from another chat is refused");

  sent.length = 0;
  const q1 = (await askP({ question: "q-pair-1", options: ["A", "B"] })).request_id;
  const k1 = await lastKeyboard();
  ok(String(k1.chat_id) === "77", "…questions now go to the paired chat");
  push({ callback_query: { id: "cq17a", data: cbFor(k1, 0, 0), from: { id: 42 }, message: { chat: { id: 42 } } } });
  await sleep(400);
  ok(await openP(q1), "…and a tap from any other chat does not answer");

  ({ code } = await startCode());
  sent.length = 0;
  say(team, `!pair ${code}`, { message_thread_id: 3 });
  ok(await waitSent(-100555, /已綁定這個聊天室/) && sent.some((m) => m.message_thread_id === 3 && /已綁定/.test(m.text || "")) && await waitSent(77, /已改綁到另一個聊天室/),
    "re-pair: `!pair <code>` in a group binds it (reply in the same thread), the old chat is told");
  push({ callback_query: { id: "cq17b", data: cbFor(k1, 0, 1), from: { id: 77 }, message: { chat: { id: 77 } } } });
  const r1 = await answerP(q1);
  ok(r1.kind === "selection" && r1.value === "B", `…a question already waiting in the old chat is still answered there → ${JSON.stringify(r1)}`);
  sent.length = 0;
  const q2 = (await askP({ question: "q-pair-2", options: ["A", "B"] })).request_id;
  const k2 = await lastKeyboard();
  push({ callback_query: { id: "cq17c", data: cbFor(k2, 0, 0), from: { id: 77 }, message: { chat: { id: 77 } } } });
  await sleep(400);
  ok(String(k2.chat_id) === "-100555" && await openP(q2), "…new questions go to the new chat, and the old chat can't answer them");
  push({ callback_query: { id: "cq17d", data: cbFor(k2, 0, 1), from: { id: 9 }, message: { chat: { id: -100555 } } } });
  const r2 = await answerP(q2);
  ok(r2.kind === "selection" && r2.value === "B", `…any member of the bound group can → ${JSON.stringify(r2)}`);

  ({ code } = await startCode());
  const wrong = code === "999999" ? "999998" : "999999";
  for (let i = 0; i < 5; i++) say(stranger, `!pair ${wrong}`);
  await sleep(600);
  say(me, `!pair ${code}`);
  await sleep(600);
  ok((await status()).chat?.id === "-100555" && (await status()).pairing === false, "…5 wrong codes void the live code (the right one no longer works)");

  c.kill(); await sleep(500);
  c = await startRelay();
  ok((await status()).chat?.id === "-100555", "…and the binding survives a relay restart");
  c.kill(); await sleep(500);
  try { fs.unlinkSync(chatFile); } catch {}
}

stub.close(); clearTimeout(watchdog);
try { fs.unlinkSync(topicsFile); } catch {}
for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`myna-pending-test-${process.pid}-`)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {} }
console.log(failed === 0 ? "\n✅ TELEGRAM-PROVIDER E2E PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
