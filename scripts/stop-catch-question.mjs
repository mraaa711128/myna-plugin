#!/usr/bin/env node
// Myna — Stop hook: catch human-directed questions that ended a turn as PLAIN TEXT.
//
// The PreToolUse intercept only sees AskUserQuestion; a turn that simply ENDS with prose like
// 「要我現在就開 PR 嗎?」 uses no tool at all, so nothing reaches the phone and the
// question silently waits in a terminal the user may not look at for hours (observed: several
// such endings in a single session).
//
// On Stop: if the turn's final assistant message ends with a question addressed to the user AND
// the relay is reachable, block ONCE and instruct the model to either route the question through
// ask_human (phone) or, if it was rhetorical, end the turn without a question. stop_hook_active
// guarantees the second Stop always passes — no loops.
//
// Default ON; disable with ~/.myna/stopcatch first line "off" (/myna:stopcatch off).
// Safety mirrors intercept-ask.mjs: any parse error / missing transcript / relay down → allow.
//
// Round end (independent of the stopcatch flag): every path that lets the reply END also tells the
// relay POST /session/round-end {session_id} — the session's current gate is over, so its IM topic
// can go (Telegram). The block path does not: the reply goes on (the question is about to be
// routed to the phone), so the gate is still live. Neither does a stop while background work the
// AI started AFTER its last ask_human is still running: Claude ends its reply to wait for that work
// and is woken by its <task-notification> — the same gate may well continue (live-observed: a
// backgrounded sleep between two questions of one gate split it into two topics). The next stop,
// once that work is done, reports the round end. Work started before the last question (a dev
// server, a long monitor) doesn't count — it says nothing about the gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLAG = process.env.MYNA_STOPCATCH_FILE || path.join(os.homedir(), ".myna", "stopcatch");
const PORT = Number(process.env.RELAY_PORT || 7800);
const RELAY = process.env.MYNA_RELAY_URL || `http://127.0.0.1:${PORT}`;

const chunks = [];
try { for await (const c of process.stdin) chunks.push(c); } catch { /* no stdin */ }
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}

// background work launched after the transcript's last ask_human call that has not finished yet
// (no terminal <task-notification> for its tool_use id). A launch needs real evidence tied to the
// call itself: a successful (non-error) result of a call made with run_in_background:true, or an
// Agent/Task / Monitor call whose result STARTS with its launch line — text that merely appears in
// some output (reading this very file, a log) is not a launch, and a rejected launch never ran.
// Tail-read (8MB) — a question further back than that is old enough that its gate is over anyway.
// Any read/parse trouble → none pending.
const resultText = (c) => (typeof c.content === "string" ? c.content
  : Array.isArray(c.content) ? c.content.map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n") : "").trimStart();
const isLaunch = (use, text) => use.input?.run_in_background === true
  || (/^(Agent|Task)$/.test(use.name || "") && /^Async agent launched/i.test(text))
  || (use.name === "Monitor" && /^Monitor started/i.test(text));
function backgroundPending(file) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 8 * 1024 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const entries = [];
    for (const line of buf.toString("utf8").split("\n")) { try { entries.push(JSON.parse(line)); } catch {} }
    let last = -1; // index of the last assistant entry that calls ask_human
    entries.forEach((j, i) => {
      if (j.type === "assistant" && Array.isArray(j.message?.content)
        && j.message.content.some((c) => c?.type === "tool_use" && /__(ask|await)_human$/.test(c.name || ""))) last = i;
    });
    if (last < 0) return false;
    const uses = new Map(), launched = new Set(), done = new Set();
    for (const j of entries.slice(last + 1)) {
      const content = j.message?.content;
      if (Array.isArray(content)) for (const c of content) {
        if (c?.type === "tool_use") uses.set(c.id, c);
        if (c?.type === "tool_result" && !c.is_error && uses.has(c.tool_use_id) && isLaunch(uses.get(c.tool_use_id), resultText(c))) launched.add(c.tool_use_id);
      }
      const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
      for (const m of raw.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>(\w+)<\/status>/g)) {
        if (/^(completed|failed|killed|cancelled|error)$/i.test(m[2])) done.add(m[1]);
      }
    }
    return [...launched].some((id) => id && !done.has(id));
  } catch { return false; }
}

// the reply ends → round end to the relay (best-effort, short timeout, never blocks the stop)
const allow = async () => {
  if (input.session_id && !(input.transcript_path && backgroundPending(input.transcript_path))) {
    try {
      await fetch(`${RELAY}/session/round-end`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: input.session_id }), signal: AbortSignal.timeout(1500),
      });
    } catch {}
  }
  process.exit(0);
};
const flagDisabled = (file) => {
  try { return fs.existsSync(file) && fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim() === "off"; }
  catch { return false; }
};
if (flagDisabled(FLAG)) await allow();
if (input.stop_hook_active) await allow();  // we already blocked once this stop — never loop

// final assistant text of the turn. Claude Code hands it over as last_assistant_message — read it
// from there first: under `claude -p` the turn's last message is not in the transcript yet when
// Stop fires, so the file alone shows nothing to catch (live-observed: every headless
// question ending passed). Without the field (older Claude Code) fall back to the transcript —
// tail-read keeps this O(128KB) no matter the session length.
let text = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
if (!text) {
  if (!input.transcript_path) await allow();
  try {
    const size = fs.statSync(input.transcript_path).size;
    const start = Math.max(0, size - 131072);
    const fd = fs.openSync(input.transcript_path, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      let j; try { j = JSON.parse(lines[i]); } catch { continue; }
      if (j.type !== "assistant" || j.isSidechain) continue;
      const content = j.message?.content;
      if (!Array.isArray(content)) continue;
      if (content.some((c) => c?.type === "tool_use")) await allow(); // turn didn't end on prose
      text = content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n").trim();
      break;
    }
  } catch { await allow(); }
}
if (!text) await allow();

// conservative question heuristic: the turn ends on a question AND that question is put to the
// user. Rhetorical/self-directed questions rarely satisfy both; when in doubt the blocked model
// re-judges and may simply end the turn (second Stop always passes).
// \uFF1F / \uFF01 = the full-width ?/! — spelled as escapes so they survive an editor or a model
// that normalizes punctuation to half-width (the original class here read [??] and never matched
// a full-width question mark).
const tail = text.slice(-600);
const qm = Math.max(tail.lastIndexOf("?"), tail.lastIndexOf("\uFF1F"));
if (qm < 0) await allow();
// a "?" glued to what follows is a URL query or a code token, not the end of a sentence
if (tail[qm] === "?" && /^[A-Za-z0-9=&%_\-/#.]/.test(tail.slice(qm + 1))) await allow();
// ends on the question — or on nothing more than a short "I'll wait for your answer" remark after it
const after = tail.slice(qm + 1).replace(/^[\s)\]」』»"'*_`~]+/, "");
const waiting = /(等你|等您|等待你|等待您|你回答|您回答|你回覆|您回覆|你的(回答|回覆|選擇|決定)|告訴我|讓我知道|I'll wait|I will wait|wait(ing)? for your|let me know|once you|after you|your (answer|reply|choice|decision))/i;
const endsQ = after === "" || (after.length <= 200 && waiting.test(after));
// put to the user: a direct-address cue near the question, or the question itself offers a choice
// ("A 還是 B?", "X or Y?", "Which … ?")
const upToQ = tail.slice(0, qm + 1);
const cue = /(要我|要不要|需不需要|是否要|你想|你要|你希望|你決定|你覺得|請問|請選|請確認|哪一個|哪個|哪張|哪種|嗎[?\uFF1F]|呢[?\uFF1F]|好嗎|可以嗎|怎麼走|Do you want|Do you prefer|Should I|Would you like|Would you prefer|which (one|option)|Shall I|Let me know (which|if))/i.test(upToQ.slice(-300));
const sentence = upToQ.slice(0, -1).split(/[。!?\uFF01\uFF1F\n]|\.\s/).pop();
const choice = /(還是|或是|\bor\b|\bwhich\b)/i.test(sentence);
if (!endsQ || !(cue || choice)) await allow();

// only bounce when the phone link is actually up — relay down means the terminal IS the channel.
// A chat session (registered with the relay as a chatbot) is exempt: its reply already goes to the
// phone, and the human answers by simply writing back in its chat topic. (A relay too old to know
// /chat/session answers 404 — still up, not a chat.)
const probe = () => fetch(`${RELAY}/chat/session?session_id=${encodeURIComponent(input.session_id || "")}`, { signal: AbortSignal.timeout(2000) })
  .then(async (r) => { try { return (await r.json())?.chat === true ? "chat" : "up"; } catch { return "up"; } }).catch(() => null);
const link = (await probe()) || (await probe());
if (!link || link === "chat") await allow();

process.stdout.write(JSON.stringify({
  decision: "block",
  reason: [
    "Myna stop-catch:這回合以『問使用者的問題』收尾,但沒有經過任何提問工具——這個問題不會送到手機,使用者可能幾小時後才看到。二選一:",
    "1. 這確實需要使用者回答才能繼續 → 立刻把同一個問題改用 mcp__myna__ask_human 送出(question 放問題文字、options 放結構化 JSON 字串陣列、可附 recommendedIndex;或改用 AskUserQuestion,Myna 會自動轉送手機),等答案回來再繼續。",
    "2. 它只是禮貌性/修辭性的收尾、不需要答案 → 直接再結束一次回合即可(這個 gate 不會攔第二次)。",
    "絕不要為了通過這個 gate 而刪掉真正需要人回答的問題。",
  ].join("\n"),
}));
process.exit(0);
