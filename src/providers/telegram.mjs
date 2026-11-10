// Telegram provider — the original Myna transport, extracted verbatim from relay.mjs.
// Owns the single bot connection (getUpdates long-poll). Sends a question to the chat with
// numbered options in the body + [1][2..] [✍️] [⏹] buttons:
//   button number   -> {kind:"selection", value}
//   ✍️ (force_reply) -> {kind:"message", text}
//   ⏹               -> {kind:"aborted"}
// Free text counts only as the answer to ONE known question (decision 8a) — stray chat is ignored:
//   - a reply to a question's ✍️ prompt, or to the question message itself, answers that question;
//   - text typed (not a reply) after ✍️ answers it only when it is the one question open in that
//     topic (outside any topic: in the whole chat); with several open, the human is asked to reply to
//     the one meant — never guessed (a ✍️ tapped on one question once took text meant for another).
//   - a reply to a question that is already over answers nothing (the human is told it was answered).
// Exception: a session registered as a chatbot (relay /chat/*, see "chat" below) — text in its chat
// topic, or `@nick …` / a reply to its message in the main chat, is for that session. There only a
// reply (to the question or its ✍️ prompt) answers one of its questions; typed text is always a chat
// message, ✍️ tapped or not.
// Only the PAIRED chat counts — taps and texts from any other chat are dropped before anything else;
// every member of that chat may answer. Pairing (`/myna:pair`): the relay issues a one-time code
// (POST /pair/start, shown in Claude Code only), the human sends `!pair <code>` from the chat to bind
// (private or group), and the relay records that chat in telegram-chat.json next to .env. A legacy
// TELEGRAM_CHAT_ID in .env still works; a paired chat wins over it. Unpaired, the relay runs only to
// take the pairing — questions resolve unreachable (the terminal answers them).
//
// Topics (Bot API 9.3+/9.4+, "Threaded Mode" in @BotFather): every GATE gets its OWN topic in the
// private chat, so parallel sessions — and successive gates of one session — never interleave.
// The MCP server tags each /ask with {session_id, session_name, gate?}; a session's first ask
// createForumTopic("<gate> · <session_name>") and routes every message of that gate (question,
// preamble, ✍️ prompt, ✅/⏹ confirmations) with message_thread_id. A gate is one decision the AI
// asks as 1..n questions (one call at a time, or in parallel). A session may have several gates open
// at once, each in its own topic: a question goes into its gate's topic (a re-ask without `gate`: the
// gate of its thread_id, else the one asked last). A gate ends when
//   - the session starts a NEW gate (the AI moved on) and nothing of this gate is waiting — one with
//     a question open stays, answerable, and takes its gate's later questions; or
//   - Claude finishes its reply (Stop hook → relay /session/round-end → endRound) and the session
//     asks nothing more within TELEGRAM_TOPIC_ROUND_GRACE (default 10 min — a safety net for waits
//     the Stop hook cannot see; an ask inside it keeps the topic), or
//   - the session ends (/session/close) — its topic goes after the same grace, so the answer stays
//     readable for a while (a `claude -p` run ends the moment it has it).
// An ask without `gate` joins the session's current topic (✍️ re-asks needn't repeat it); with no
// current topic the whole reply is one gate. Ended topics follow TELEGRAM_TOPIC_ON_END. The
// session→topic map is persisted next to .env so a relay restart keeps gates in their topics. If
// the bot has no Threaded Mode (createForumTopic rejects) that round falls back to the flat chat.
// TELEGRAM_TOPIC_SCOPE=session restores the pre-0.8 layout (one topic per session, gates ignored).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { questionLines, newToken, oneLine, toolLine, errText } from "./util.mjs";
import { mdToPlain } from "./plain.mjs";
import { isCommand, isSlashCommand } from "../chat.mjs";
import * as inbox from "../inbox.mjs";

export const name = "telegram";
// the chat bound by /myna:pair, kept next to .env like the topics map (MYNA_TELEGRAM_CHAT_FILE: tests)
const chatFile = (cfg) => cfg.MYNA_TELEGRAM_CHAT_FILE
  || path.join(path.dirname(cfg.MYNA_ENV || path.join(os.homedir(), ".myna", ".env")), "telegram-chat.json");
const readBound = (cfg) => { try { const j = JSON.parse(fs.readFileSync(chatFile(cfg), "utf8")); return j?.chat_id != null ? j : null; } catch { return null; } };
export const configured = (cfg) => !!(cfg.TELEGRAM_BOT_TOKEN && (readBound(cfg) || cfg.TELEGRAM_CHAT_ID));
// a token alone is enough to run the relay: it has to be up to take the pairing
export const pairable = (cfg) => !!cfg.TELEGRAM_BOT_TOKEN;

// topic name = "<session_name>" trimmed to Telegram's 1–128 char limit (fallback keeps it non-empty)
export const topicName = (s) => (String(s || "").trim() || "claude session").slice(0, 128);

export function create(cfg, ctx) {
  const TOKEN = cfg.TELEGRAM_BOT_TOKEN;
  const CHAT_FILE = chatFile(cfg);
  let bound = readBound(cfg);
  let CHAT_ID = bound ? String(bound.chat_id) : cfg.TELEGRAM_CHAT_ID ? String(cfg.TELEGRAM_CHAT_ID) : null;
  // Who may answer: only the paired chat (anyone can DM the bot or add it to another group). Every
  // member of that chat is trusted to answer — in a private chat, only its owner.
  const fromOurChat = (chat) => CHAT_ID !== null && String(chat?.id) === CHAT_ID;
  // pairing: one live code at a time, 10 minutes, voided after PAIR_TRIES wrong guesses
  const PAIR_TTL_MS = 10 * 60 * 1000, PAIR_TRIES = 5;
  let pairing = null; // {code, expires, tries}
  const who = (chat, from) => `chat ${chat?.id ?? "?"} user ${from?.id ?? "?"}`;
  // TELEGRAM_API_BASE override exists for the stubbed smoke test (test/smoke-telegram-provider.mjs)
  const API_ROOT = cfg.TELEGRAM_API_BASE || "https://api.telegram.org";
  const API = `${API_ROOT}/bot${TOKEN}`;
  // the bot token sits in every API and file URL: never in a log line, a reply, or what a session gets
  const redact = (s) => (TOKEN ? String(s).split(TOKEN).join("***") : String(s));
  // TELEGRAM_TOPICS=auto (default): one topic per session when the bot has Threaded Mode; off = flat chat.
  const TOPICS = String(cfg.TELEGRAM_TOPICS || "auto").trim().toLowerCase() !== "off";
  // TELEGRAM_TOPIC_SCOPE: gate (default) = one topic per gate, ended per gate/round; session = one per session.
  const SCOPE = String(cfg.TELEGRAM_TOPIC_SCOPE || "gate").trim().toLowerCase() === "session" ? "session" : "gate";
  // TELEGRAM_TOPIC_ON_END: what happens to a topic when it ends (gate over / session ends) —
  //   delete (default) = deleteForumTopic — topic and its messages gone, the list never piles up
  //     (the gate decisions themselves live in MYNA-DECISIONS.jsonl, not in the chat);
  //   close = mark it ended but keep it listed: closeForumTopic where supported (forum supergroups);
  //     private chats reject that ("the chat is not a supergroup forum" — live-verified;
  //     private-chat topics only support create/edit/delete), so there it is renamed with a 🔒 prefix;
  //   keep = leave it untouched.
  const ON_END = (() => {
    const v = String(cfg.TELEGRAM_TOPIC_ON_END || "delete").trim().toLowerCase();
    if (!["close", "delete", "keep"].includes(v)) { ctx.log(`TELEGRAM_TOPIC_ON_END="${v}" is not delete|close|keep — using delete`); return "delete"; }
    return v;
  })();
  // TELEGRAM_TOPIC_ROUND_GRACE: seconds between a round end — or the session's end — and ending the
  // gate's topic (0 = right away).
  const ROUND_GRACE_MS = (() => {
    const v = String(cfg.TELEGRAM_TOPIC_ROUND_GRACE ?? "600").trim();
    const n = Number(v);
    if (v === "" || !Number.isFinite(n) || n < 0) { ctx.log(`TELEGRAM_TOPIC_ROUND_GRACE="${v}" is not seconds — using 600`); return 600000; }
    return n * 1000;
  })();
  const TOPICS_FILE = cfg.MYNA_TOPICS_FILE
    || path.join(path.dirname(cfg.MYNA_ENV || path.join(os.homedir(), ".myna", ".env")), "telegram-topics.json");
  const log = ctx.log;

  const tokens = new Map();        // callback token -> {request_id, kind, value?, topic?}
  const awaiting = new Map();      // request_id -> {chat, topic} of a question whose ✍️ was tapped (its typed answer is awaited)
  const threadLastMsg = new Map(); // thread_id -> last message_id (reply_to threading)
  const questionMsg = new Map();   // request_id -> {message_id, topic, chat, thread_id?} of its keyboard message (to retract on cancel)
  const threadGates = new Map();   // `${session_id}\n${thread_id}` -> gate label: a re-ask without `gate` goes back to its own gate
  const closedMsgs = new Map();    // `${chat}:${message_id}` -> {request_id, kind} of an answered / ended question's messages
                                   // (keyboard, ✍️ prompt, ✅/⏹ line): a reply to one must not answer another question
  const closeMsg = (k, v) => remember(closedMsgs, k, v, 500); // journaled on every write — keep it small

  // session_id -> {thread: number|null, name, gate, created, stale?, endsAt?, closed?}  (thread null =
  // topics unavailable this round; thread/name/gate = the gate the session asked under last;
  // stale = [thread, name, gate] of the session's other gate topics still around — kept because a
  // question was open in them when a new gate started; a question of such a gate goes back into its
  // topic; endsAt = round or session ended, topic goes at this time unless the session asks again;
  // closed = it was the session that ended)
  const topics = loadTopics();
  const graceTimers = new Map();   // session_id -> timeout (round or session ended, grace running)
  function loadTopics() {
    try { const j = JSON.parse(fs.readFileSync(TOPICS_FILE, "utf8")); return new Map(Object.entries(j)); }
    catch { return new Map(); }
  }
  function saveTopics() {
    try { fs.mkdirSync(path.dirname(TOPICS_FILE), { recursive: true }); fs.writeFileSync(TOPICS_FILE, JSON.stringify(Object.fromEntries(topics), null, 2)); }
    catch (e) { log("topics: could not persist", TOPICS_FILE, e.message); }
  }

  // Rate limits (429 + retry_after: Telegram allows ~1 message/s per chat, 20/min in a group): every
  // call waits the cooldown out and retries — except `low` ones (chat progress edits), which give up
  // at once and are redone later by their own scheduler, so a question or an answer never queues
  // behind progress. highWaiting > 0 = a call is sitting out a cooldown → progress holds back too.
  let cooldownUntil = 0, highWaiting = 0;
  async function tg(method, body, tries = 2, { low = false } = {}) {
    for (let attempt = 1, limited = 0; ; attempt++) {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) {
        if (low) return { ok: false, error_code: 429, cooldown: true, description: "cooling down after a rate limit" };
        highWaiting++;
        try { await new Promise((r) => setTimeout(r, wait)); } finally { highWaiting--; }
      }
      try {
        const r = await fetch(`${API}/${method}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        const j = await r.json();
        if (!j.ok && j.error_code === 429) {
          const after = Math.max(1, Number(j.parameters?.retry_after) || 1);
          cooldownUntil = Math.max(cooldownUntil, Date.now() + after * 1000);
          log(`tg ${method} rate-limited — cooling down ${after}s${low ? "" : " and retrying"}`);
          if (!low && ++limited <= 5) { attempt--; continue; }
          return j;
        }
        if (!j.ok && !(low && /not modified/i.test(j.description || ""))) log(`tg ${method} error:`, JSON.stringify(j));
        if (j.ok && method === "sendMessage" && j.result?.message_id) noteTail(body.chat_id, body.message_thread_id, j.result.message_id);
        return j;
      } catch (e) {
        // transport-level failure (stale keep-alive socket reset, timeout, DNS blip). Retry on a
        // FRESH socket before giving up — a single blip on the load-bearing question send otherwise
        // strands the request forever (a flaky link can blip many times a day).
        if (attempt < tries) {
          log(`tg ${method} transport err (retry ${attempt}/${tries - 1}):`, errText(e));
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        // Exhausted: NEVER throw here — a cosmetic send (e.g. "✅ 你選了") must not abort handleUpdate
        // before resolve runs. The CALLER decides whether an unsent message is fatal: sendQuestion
        // throws on the question/keyboard (→ relay resolves unreachable → client falls back); the
        // ✅/⏹ confirmations ignore ok (best-effort).
        log(`tg ${method} transport err:`, errText(e));
        return { ok: false, error: errText(e) };
      }
    }
  }

  // --- topics ------------------------------------------------------------------
  const gateLabel = (g) => (SCOPE === "gate" && typeof g === "string" ? g.trim().replace(/\s+/g, " ").slice(0, 60) : "");
  // a question on its way into a topic holds it from the moment topicFor picks the thread until its
  // buttons are registered — before that, tokens alone can't show the topic is in use, and a racing
  // gate switch would end it under the question (found in code review)
  const reserved = new Map();      // thread -> number of questions currently being sent into it
  const hold = (s, thread) => { if (!s || !thread) return; reserved.set(thread, (reserved.get(thread) || 0) + 1); s.holds.push(thread); };
  const release = (s) => { for (const t of s.holds.splice(0)) { const n = (reserved.get(t) || 1) - 1; if (n > 0) reserved.set(t, n); else reserved.delete(t); } };
  // a topic with a question still on screen (buttons live, a ✍️ reply awaited) or on its way there must never be ended
  const busy = (thread) => reserved.has(thread) || [...tokens.values()].some((v) => v.topic === thread) || [...awaiting.values()].some((w) => w.topic === thread);

  // wrap up an ended topic per TELEGRAM_TOPIC_ON_END (delete = keeps the list short; close = the list
  // shows what is still live; keep = untouched). Best-effort — a topic that no longer exists just logs.
  async function endTopic(thread, name, why) {
    if (!thread || ON_END === "keep") return;
    if (ON_END === "delete") {
      const res = await tg("deleteForumTopic", { chat_id: CHAT_ID, message_thread_id: thread });
      log(`${why} — topic ${thread} ${res.ok ? "deleted" : "not deleted"}`);
      return;
    }
    let res = await tg("closeForumTopic", { chat_id: CHAT_ID, message_thread_id: thread });
    let how = "closed";
    if (!res.ok && /not a supergroup forum/i.test(res.description || "")) {
      // private chat: no close — mark it ended in the name instead (🔒 prefix), stays listed
      res = await tg("editForumTopic", { chat_id: CHAT_ID, message_thread_id: thread, name: topicName(`🔒 ${name}`) });
      how = "marked 🔒 (private chats can't close topics)";
    }
    log(`${why} — topic ${thread} ${res.ok ? how : "not closed"}`);
  }
  // drop the session's map entry (synchronously — a question racing this opens a fresh topic instead
  // of routing into the dying one) and end its topic(s). `keepBusy`: a topic still showing an open
  // question is carried over as stale instead of ended (→ carry, for the caller's new entry).
  // `ending` settles once the IM calls are done — callers that need not wait (a new gate's question) don't.
  function retire(session_id, why, keepBusy = false) {
    const t = topics.get(session_id);
    topics.delete(session_id); saveTopics();
    const carry = [], ends = [];
    for (const [thread, name, gate] of t ? [...(t.stale || []), [t.thread, t.name, t.gate]] : []) {
      if (!thread) continue;
      if (keepBusy && busy(thread)) { carry.push([thread, name, gate]); continue; }
      ends.push(endTopic(thread, name, `session ${session_id} ${why}`).catch((e) => log("endTopic err", e.message)));
    }
    return { carry, ending: Promise.all(ends) };
  }

  // create (or reuse) the topic for a session's current gate. Returns message_thread_id, or undefined for flat.
  // One at a time per session: two questions racing through create would each open a topic and the
  // map would keep only one (the other never cleaned up). `s` (a question being sent) gets the thread
  // held; `carry` = stale topics handed over from an entry being replaced (recreate path).
  const topicLocks = new Map();    // session_id -> tail of its topicFor chain
  function topicFor(session_id, session_name, gate, s, carry) {
    if (!TOPICS || !session_id) return Promise.resolve(undefined);
    const run = (topicLocks.get(session_id) || Promise.resolve()).then(() => topicForLocked(session_id, session_name, gate, s, carry));
    const tail = run.catch(() => {});
    topicLocks.set(session_id, tail);
    tail.then(() => { if (topicLocks.get(session_id) === tail) topicLocks.delete(session_id); });
    return run;
  }
  async function topicForLocked(session_id, session_name, gate, s, carry = []) {
    let known = topics.get(session_id);
    // asked again within the grace (after a round end, or a resumed session after its end) → the
    // gate goes on; keep the topic (sync, before any await)
    if (graceTimers.has(session_id) || known?.endsAt) {
      clearTimeout(graceTimers.get(session_id)); graceTimers.delete(session_id);
      if (known?.endsAt) { delete known.endsAt; delete known.closed; saveTopics(); log(`session ${session_id} asked again within the grace — topic ${known.thread} kept`); }
    }
    // an ask without `gate` that re-asks a thread (✍️ follow-up) belongs to that thread's gate
    const g = gateLabel(gate) || (s?.thread_id ? threadGates.get(`${session_id}\n${s.thread_id}`) || "" : "");
    let stale = [...carry];
    if (known && g && g !== known.gate) {
      const back = (known.stale || []).find(([t, , sg]) => t && sg === g);
      if (back) {
        // a gate whose topic is still around (a question of it was open when another gate started)
        // → back into its topic; no new gate started, so nothing ends
        known.stale = [...known.stale.filter((e) => e !== back), ...(known.thread ? [[known.thread, known.name, known.gate]] : [])];
        Object.assign(known, { thread: back[0], name: back[1], gate: g });
        if (!known.stale.length) delete known.stale;
        saveTopics();
        log(`session ${session_id} back to gate "${g}" — topic ${back[0]}`);
      } else {
        // a new gate starts → the idle gates are over; one with a question still open stays (stale),
        // and a later question of that gate goes back into its topic
        stale.push(...retire(session_id, `gate "${known.gate || "(none)"}" → "${g}"`, true).carry);
        known = undefined;
      }
    }
    const cur = known ? known.gate : g;   // an ask without `gate` joins the current one
    if (s) s.gateOf = cur;
    if (s?.thread_id && cur) remember(threadGates, `${session_id}\n${s.thread_id}`, cur);
    // s.machine: the asking machine's name, set by the relay once several machines share it (0.20)
    const nm = topicName([s?.machine, cur, session_name || s?.label].filter(Boolean).join(" · "));
    if (known) {
      hold(s, known.thread); // before any await — the rename below must not open a window
      if (stale.length) { known.stale = [...(known.stale || []), ...stale]; saveTopics(); }
      // the session's label changed (typically a ticket key learned mid-session) → rename in place
      if (known.thread && session_name && nm !== known.name) {
        const res = await tg("editForumTopic", { chat_id: CHAT_ID, message_thread_id: known.thread, name: nm });
        if (res.ok) { known.name = nm; saveTopics(); log(`topic ${known.thread} renamed → "${nm}"`); }
      }
      return known.thread ?? undefined;
    }
    const res = await tg("createForumTopic", { chat_id: CHAT_ID, name: nm });
    const thread = res.ok ? res.result?.message_thread_id : undefined;
    if (thread) log(`topic created for session ${session_id}: "${nm}" (thread ${thread})`);
    else log(`topics unavailable for session ${session_id} (${res.description || res.error || "createForumTopic failed"}) — falling back to the flat chat. Enable "Threaded Mode" for the bot in @BotFather → Bot Settings to get one topic per gate.`);
    // remember either way: a failed create is not retried until this gate/round ends (one call, not one per ask)
    topics.set(session_id, { thread: thread ?? null, name: nm, gate: cur, created: new Date().toISOString(), ...(stale.length ? { stale } : {}) });
    saveTopics();
    hold(s, thread);
    return thread ?? undefined;
  }
  const isThreadGone = (res) => !res.ok && /thread not found|TOPIC_(DELETED|CLOSED|ID_INVALID)|topic.*(not found|deleted|closed)/i.test(res.description || "");
  const inTopic = (topic, payload) => (topic ? { ...payload, message_thread_id: topic } : payload);

  // --- chat: a session registered as a chatbot (relay src/chat.mjs) -------------------------------
  // Each chat session gets a topic of its own, "💬 <nick> · <label>", kept for the session's life and
  // after it (renamed "🔒 …" — the conversation stays readable); it is never a gate topic, so gate
  // switches / round ends / retire() never touch it. Without topics (TELEGRAM_TOPICS=off, no Threaded
  // Mode) the session talks in the main chat, every message prefixed [nick]. A place without a topic is
  // never final: while topics are on, every registration tries to create one again.
  // The session's ask_human questions and permission prompts go into its chat topic too, with the
  // gate as a header line (🚦), so the whole conversation is in one place.
  // Progress: one message per turn, edited in place (no push) as the session works — a line per tool
  // call. Once anything else lands below it in the topic (a question, the human's message) the next
  // update starts a new one at the bottom; likewise near Telegram's 4096-char limit. Edits are
  // throttled (MYNA_CHAT_PROGRESS_MS, default 3000) and give way to rate limits. The final answer
  // goes out as a new message — one push per turn.
  // `/myna:murmur off` (flag file ~/.myna/chat-progress, read at every update) shows only the
  // tool calls instead: the 🖥 prompt line and every 💭 remark stay, below them only the latest tool with its count; when
  // anything lands below, the message moves to the bottom and the old one is deleted.
  const CHAT_TOPICS_FILE = cfg.MYNA_CHAT_TOPICS_FILE
    || path.join(path.dirname(cfg.MYNA_ENV || path.join(os.homedir(), ".myna", ".env")), "telegram-chat-topics.json");
  const PROGRESS_FILE = cfg.MYNA_PROGRESS_FILE || path.join(os.homedir(), ".myna", "chat-progress");
  const lastOnly = () => { try { return fs.readFileSync(PROGRESS_FILE, "utf8").split(/\r?\n/)[0].trim() === "off"; } catch { return false; } };
  const PROGRESS_MS = (() => { const n = Number(cfg.MYNA_CHAT_PROGRESS_MS ?? 3000); return Number.isFinite(n) && n >= 0 ? n : 3000; })();
  const PROGRESS_LIMIT = 3800, ANSWER_CHUNK = 4000;
  const chatTopics = (() => { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(CHAT_TOPICS_FILE, "utf8")))); } catch { return new Map(); } })();
  const saveChatTopics = () => {
    try { fs.mkdirSync(path.dirname(CHAT_TOPICS_FILE), { recursive: true }); fs.writeFileSync(CHAT_TOPICS_FILE, JSON.stringify(Object.fromEntries(chatTopics), null, 2)); }
    catch (e) { log("chat topics: could not persist", CHAT_TOPICS_FILE, e.message); }
  };
  const tails = new Map();      // `${chat}:${thread||0}` -> newest message_id seen there (is the progress message still at the bottom?)
  const owners = new Map();     // `${chat}:${message_id}` -> sid of the chat session that sent it (a reply routes to it)
  const askPrompts = new Map(); // `${chat}:${message_id}` of a ✍️ prompt -> request_id (a reply to it answers that question)
  const progress = new Map();   // sid -> this turn's progress state
  // the chat session the human last wrote to gets a stray "/command" — stamped on its chatTopics entry
  // (`talked`), so a relay restart (a plugin upgrade) doesn't forget it
  const TALK_MS = (() => { const n = Number(cfg.MYNA_CHAT_TALK_MS ?? 30 * 60000); return Number.isFinite(n) && n > 0 ? n : 30 * 60000; })();
  let botUser = "";             // the bot's @username (getMe): "/cmd@<bot>" is the same command
  const tailKey = (chat, thread) => `${chat}:${thread || 0}`;
  function noteTail(chat, thread, id) {
    const k = tailKey(chat, thread);
    if (!(tails.get(k) >= id)) tails.set(k, id);
  }
  const remember = (map, k, v, cap = 2000) => { map.set(k, v); if (map.size > cap) map.delete(map.keys().next().value); };
  // "<machine> · 💬 <nick> · <label>": the machine prefix once several machines share this bot (relay MYNA_TOPIC_MACHINE)
  const chatName = (c, mark = "💬") => topicName(`${c.machine ? `${c.machine} · ` : ""}${mark} ${[c.nick, c.label].filter(Boolean).join(" · ")}`);
  // the session's chat place in the CURRENT chat (a re-pair leaves the old one behind)
  const chatOf = (sid) => { const c = chatTopics.get(sid); return c && c.chat === CHAT_ID && ctx.chat?.isLive(sid) ? c : null; };
  const said = (c, text) => (c.thread ? text : `[${c.nick}] ${text}`);

  // a topic for the session's chat place → its thread, or null (no Threaded Mode, Telegram unreachable…)
  async function newChatTopic(c) {
    const res = await tg("createForumTopic", { chat_id: CHAT_ID, name: c.name });
    const thread = res.ok ? res.result?.message_thread_id ?? null : null;
    if (!thread) log(`chat: no topic for ${c.nick} (${res.description || res.error || "createForumTopic failed"}) — it talks in the main chat until a later registration gets one`);
    return thread;
  }
  const hello = (c) => (c.thread
    ? `💬 ${c.nick} 已連線。在這個 topic 打字,訊息就會交給這個 session。`
    : `💬 ${c.nick}${c.label ? `(${c.label})` : ""} 已連線。訊息用 @${c.nick} 開頭,或直接回覆它的訊息,就會交給這個 session。`);

  async function chatOpen(sid, { nick, label, machine, reopened } = {}) {
    if (!CHAT_ID) return null;
    let c = chatTopics.get(sid);
    if (c && c.chat === CHAT_ID) {
      const wasClosed = c.closed;
      Object.assign(c, { nick, label }); delete c.closed;
      if (machine) c.machine = machine; else delete c.machine;
      const name = chatName(c);
      if (c.thread && c.name !== name) {
        const res = await tg("editForumTopic", { chat_id: CHAT_ID, message_thread_id: c.thread, name });
        if (res.ok) c.name = name;
        else if (isThreadGone(res)) c = null; // the human deleted it → a new one below
      }
      if (c && !c.thread && TOPICS) {
        // no topic on record — its create failed (Telegram unreachable at the time) or topics
        // were off back then: try again, a failed create is never final
        c.name = name;
        const thread = await newChatTopic(c);
        if (thread) {
          c.thread = thread; saveChatTopics();
          log(`chat: ${nick} → topic ${thread} "${c.name}" (it had none)`);
          await chatSend(sid, hello(c), { silent: true, recreate: false });
          return c.thread;
        }
      }
      if (c) {
        saveChatTopics();
        // still in the main chat: its "已連線" was said once — a registration repeats nothing, a reconnect says so
        if (!c.thread && (wasClosed || reopened)) await chatSend(sid, `💬 ${nick} 重新連線了。`, { silent: true, recreate: false });
        return c.thread;
      }
    }
    c = { chat: CHAT_ID, thread: null, nick, label, ...(machine ? { machine } : {}), created: new Date().toISOString() };
    c.name = chatName(c);
    if (TOPICS) c.thread = await newChatTopic(c);
    chatTopics.set(sid, c); saveChatTopics();
    log(`chat: ${nick} → ${c.thread ? `topic ${c.thread} "${c.name}"` : "main chat"}`);
    await chatSend(sid, hello(c), { silent: true, recreate: false });
    return c.thread;
  }
  // a message from the session into its place (topic recreated once if the human deleted it)
  async function chatSend(sid, text, { silent = false, low = false, recreate = true } = {}) {
    let c = chatTopics.get(sid);
    if (!c || c.chat !== CHAT_ID) return { ok: false };
    const payload = () => inTopic(c.thread, { chat_id: c.chat, text: said(c, text), ...(silent ? { disable_notification: true } : {}) });
    let res = await tg("sendMessage", payload(), 2, { low });
    if (c.thread && isThreadGone(res) && recreate) {
      log(`chat: topic ${c.thread} of ${c.nick} is gone — recreating`);
      chatTopics.delete(sid);
      await chatOpen(sid, { nick: c.nick, label: c.label, machine: c.machine });
      c = chatTopics.get(sid);
      res = await tg("sendMessage", payload(), 2, { low });
    }
    if (res.ok && res.result?.message_id) remember(owners, `${c.chat}:${res.result.message_id}`, sid);
    return res;
  }

  // progress: {pend: lines not shown yet, seg: lines in the current message, msgId, tools, done?, timer, chain,
  //            head/remarks/last: the 🖥 (or background) line, every 💭 and the newest tool line, for the last-only view}
  function chatProgress(sid, ev = {}, { cwd } = {}) {
    if (!chatOf(sid)) return;
    let p = progress.get(sid);
    if (ev.event === "start" || !p || p.finished) {
      p = { pend: [], seg: [], msgId: null, tools: 0, lastFlush: 0, timer: null, chain: p?.chain || Promise.resolve(), head: null, remarks: [], last: null };
      progress.set(sid, p);
      if (ev.event === "start" && ev.origin === "terminal" && ev.prompt) p.pend.push(p.head = `🖥 ${oneLine(ev.prompt, 300)}`);
      // a turn nobody typed (a background notification, another session, a plugin): the mod's one-line label, never its text
      else if (ev.event === "start" && ev.origin === "background" && ev.label) p.pend.push(p.head = oneLine(ev.label, 80));
    }
    if (ev.event === "step") {
      const tools = Array.isArray(ev.tools) ? ev.tools : [];
      // a step without tool calls is the turn's final answer — it comes with "done", not here
      if (tools.length) {
        // the model's remark reads as plain text; the 🖥 line (the human's words) and 🔧 lines (commands) stay as written
        if (ev.text && String(ev.text).trim()) { const l = `💭 ${oneLine(mdToPlain(ev.text), 400)}`; p.pend.push(l); p.remarks.push(l); }
        for (const t of tools) { const l = toolLine(t?.name, t?.input, cwd); p.pend.push(l); p.last = `${l}(第 ${++p.tools} 個工具)`; }
      }
    }
    if (ev.event === "done") {
      p.finished = true;
      p.done = { text: String(ev.text ?? ""), interrupted: !!ev.interrupted };
      if (p.msgId || p.pend.length || p.tools) p.pend.push(p.last = ev.interrupted ? "⏹ 已中斷" : `✅ 完成(${p.tools} 個工具)`);
    }
    if (p.pend.length || p.done) schedule(sid, p, !p.msgId || !!p.done);
  }
  function schedule(sid, p, now) {
    if (p.timer) { if (!now) return; clearTimeout(p.timer); }
    const wait = now ? 0 : Math.max(0, p.lastFlush + PROGRESS_MS - Date.now());
    p.timer = setTimeout(() => {
      p.timer = null;
      p.chain = p.chain.then(() => flush(sid, p)).catch((e) => log("chat progress err", e.message));
    }, wait);
  }
  const fits = (lines) => lines.join("\n").length <= PROGRESS_LIMIT;
  async function flush(sid, p) {
    const c = chatTopics.get(sid);
    if (!c || c.chat !== CHAT_ID) return;
    const answer = !!p.done; // the turn's last flush: no longer just progress — never dropped
    // a rate limit, or a question / answer waiting to go out, comes first
    if (!answer && (Date.now() < cooldownUntil + 1000 || highWaiting > 0)) {
      p.timer = setTimeout(() => { p.timer = null; p.chain = p.chain.then(() => flush(sid, p)).catch((e) => log("chat progress err", e.message)); },
        Math.max(500, cooldownUntil + 1000 - Date.now()));
      return;
    }
    p.lastFlush = Date.now();
    if (lastOnly()) { if (!(await flushLast(sid, p, c, answer))) return; }
    while (p.pend.length) {
      const atBottom = p.msgId && tails.get(tailKey(c.chat, c.thread)) === p.msgId;
      const together = [...p.seg, ...p.pend];
      if (atBottom && fits(together)) {
        const r = await tg("editMessageText", { chat_id: c.chat, message_id: p.msgId, text: said(c, together.join("\n")) }, 2, { low: !answer });
        if (r.ok || /not modified/i.test(r.description || "")) { p.seg = together; p.pend = []; break; }
        if (r.error_code === 429) return schedule(sid, p, false);
        p.msgId = null; // gone / not editable → continue in a new message
      }
      // a new message at the bottom: as many pending lines as fit
      let n = 1; while (n < p.pend.length && fits(p.pend.slice(0, n + 1))) n++;
      const lines = p.pend.slice(0, n).map((l) => (l.length > PROGRESS_LIMIT ? `${l.slice(0, PROGRESS_LIMIT - 1)}…` : l));
      const r = await chatSend(sid, lines.join("\n"), { silent: true, low: !answer });
      if (r.error_code === 429) return schedule(sid, p, false);
      if (!r.ok) { p.pend.splice(0, n); continue; } // undeliverable — don't loop on it
      p.msgId = r.result.message_id; p.seg = lines; p.pend.splice(0, n);
    }
    if (answer && !p.answered) {
      p.answered = true;
      const text = mdToPlain(p.done.text).trim();
      for (let i = 0; i < text.length; i += ANSWER_CHUNK) await chatSend(sid, text.slice(i, i + ANSWER_CHUNK));
    }
  }
  // last-only view: the message is just [🖥 line, every 💭 remark, newest tool]; it is kept at the bottom — once
  // something lands below, a new one goes out and the old one is deleted. false = rescheduled (429)
  async function flushLast(sid, p, c, answer) {
    if (!p.pend.length) return true;
    // every 💭 is kept; near Telegram's limit the oldest give way (still one message)
    const cut = (l) => (l && l.length > 1800 ? `${l.slice(0, 1799)}…` : l);
    let skip = 0, lines;
    for (;;) {
      lines = [cut(p.head), skip ? `…(前面 ${skip} 句省略)` : null, ...p.remarks.slice(skip), cut(p.last)].filter(Boolean);
      if (fits(lines) || skip >= p.remarks.length) break;
      skip++;
    }
    if (!lines.length) { p.pend = []; return true; }
    if (p.msgId && tails.get(tailKey(c.chat, c.thread)) === p.msgId) {
      if (lines.join("\n") === p.seg.join("\n")) { p.pend = []; return true; }
      const r = await tg("editMessageText", { chat_id: c.chat, message_id: p.msgId, text: said(c, lines.join("\n")) }, 2, { low: !answer });
      if (r.ok || /not modified/i.test(r.description || "")) { p.seg = lines; p.pend = []; return true; }
      if (r.error_code === 429) { schedule(sid, p, false); return false; }
    }
    const old = p.msgId;
    const r = await chatSend(sid, lines.join("\n"), { silent: true, low: !answer });
    if (r.error_code === 429) { schedule(sid, p, false); return false; }
    p.pend = [];
    if (!r.ok) return true; // undeliverable — don't loop on it
    p.msgId = r.result.message_id; p.seg = lines;
    if (old) await tg("deleteMessage", { chat_id: c.chat, message_id: old }, 1, { low: true });
    return true;
  }
  // the session picked the message up → 👀 on it
  async function chatTaken(sid, m) {
    if (!m?.message_id) return;
    await tg("setMessageReaction", { chat_id: m.chat ?? CHAT_ID, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👀" }] });
  }
  // the session ended: its topic stays (the conversation is worth keeping), renamed 🔒
  async function chatClose(sid) {
    const c = chatTopics.get(sid);
    const p = progress.get(sid);
    if (p) { clearTimeout(p.timer); progress.delete(sid); }
    if (!c || c.chat !== CHAT_ID) return;
    c.closed = new Date().toISOString(); saveChatTopics();
    if (c.thread) {
      const name = chatName(c, "🔒");
      const res = await tg("editForumTopic", { chat_id: c.chat, message_thread_id: c.thread, name });
      if (res.ok) { c.name = name; saveChatTopics(); }
    } else await tg("sendMessage", { chat_id: c.chat, text: `🔒 ${c.nick} 已結束。`, disable_notification: true });
    log(`chat: ${c.nick} ended — ${c.thread ? `topic ${c.thread} kept as "${c.name}"` : "main chat notified"}`);
  }
  const chatSidByThread = (chat, thread) => {
    for (const [sid, c] of chatTopics) if (c.thread && c.thread === thread && String(c.chat) === String(chat)) return sid;
    return null;
  };
  // the human wrote to a chat session (in its topic, `@nick …`, or a reply to its message): a Telegram
  // reply to one of its questions answers that question; anything else is a chat message → its inbox —
  // even with a question waiting (typed words meant as chat, or about a question just answered,
  // were taken as the answer to the one still open). No guessing, no confirmation step.
  async function chatIncoming(sid, msg, text) {
    const c = chatTopics.get(sid);
    const chat = String(msg.chat.id);
    const back = (t) => tg("sendMessage", { chat_id: msg.chat.id, ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}), text: t, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
    const replied = [...questionMsg].find(([, q]) => q.message_id === msg.reply_to_message?.message_id && String(q.chat ?? CHAT_ID) === chat);
    if (replied && text) {
      ctx.resolve(replied[0], { kind: "message", text });
      await tg("setMessageReaction", { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "👌" }] });
      return;
    }
    const nick = ctx.chat?.get(sid)?.nick || c?.nick || "session";
    if (!text) { await back(`要對 ${nick} 說什麼?在 @${nick} 後面接著打字。`); return; }
    const from = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || "";
    // a reply to some message (one of the session's own, most often): which one, and its text — the session can
    // tell what the human answered (e.g. a proposal it posted), not just that they wrote
    const to = msg.reply_to_message;
    const reply_to = to?.message_id ? { message_id: to.message_id, text: String(to.text ?? to.caption ?? "").slice(0, 4000) } : undefined;
    const r = ctx.chat?.deliver(sid, { text, from, chat, message_id: msg.message_id, ...(reply_to ? { reply_to } : {}) }) || { closed: true };
    if (r.closed) await back(`🔒 ${nick} 已經結束,訊息沒有送出。`);
    else if (r.stale) await back(`⚠️ ${nick} 目前沒有回應(可能卡住或已關閉),訊息先排隊,它恢復後會收到。`);
  }

  // --- files (SPEC §5.3): a document or photo sent to a chat session ------------------------------
  // Downloaded here (≤ 20 MB, the Bot API's limit) into this relay's inbox; the chat inbox message carries
  // {file: {fid, name, mime, size, sha256, path}} and the session gets the local path (another machine's
  // session: its relay fetches its own copy, src/edge-chat.mjs). Only the paired chat, only a chat
  // session (its topic, a reply to its message, or a caption starting "@nick"); anything else is told why.
  const DIR = path.dirname(cfg.MYNA_ENV || path.join(os.homedir(), ".myna", ".env"));
  const FILE_TIMEOUT_MS = Number(cfg.MYNA_FILE_TIMEOUT_MS || 60000);
  const OTHER_MEDIA = ["video", "audio", "voice", "animation", "video_note", "sticker"];
  const mediaOf = (msg) => {
    if (msg.document?.file_id) return { f: msg.document, name: msg.document.file_name || "", mime: msg.document.mime_type || "" };
    if (Array.isArray(msg.photo) && msg.photo.length) {
      // the biggest size (by bytes, else by pixels) — not the array order, which the docs do not promise
      const big = [...msg.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0) || (b.width * b.height || 0) - (a.width * a.height || 0))[0];
      return { f: big, name: "", mime: "image/jpeg", photo: true };
    }
    return null;
  };
  const hasFile = (msg) => !!mediaOf(msg) || OTHER_MEDIA.some((k) => msg[k]);
  // at most 2 downloads at once (an album is up to 10 files); text and buttons never wait for these
  let downloading = 0;
  const slotWaiters = [];
  async function inSlot(fn) {
    while (downloading >= 2) await new Promise((r) => slotWaiters.push(r));
    downloading++;
    try { return await fn(); } finally { downloading--; slotWaiters.shift()?.(); }
  }
  const failReason = (e) => (e?.code === "too_big" ? "超過 20 MB" : e?.code === "write" ? "寫檔失敗"
    : e?.name === "TimeoutError" || e?.name === "AbortError" ? "逾時" : e?.code === "refused" ? "Telegram 拒絕" : "連不上 Telegram");
  async function download(sid, m, at) {
    const g = await tg("getFile", { file_id: m.f.file_id });
    if (!g.ok || !g.result?.file_path) throw Object.assign(new Error(`getFile: ${g.description || g.error || "no file_path"}`), { code: /too big/i.test(g.description || "") ? "too_big" : "refused" });
    if (g.result.file_size > inbox.MAX_FILE_BYTES) throw Object.assign(new Error("too big"), { code: "too_big" });
    const filePath = String(g.result.file_path).split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`${API_ROOT}/file/bot${TOKEN}/${filePath}`, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw Object.assign(new Error(`download: HTTP ${res.status}`), { code: "refused" });
    // the size Telegram gave (getFile, else the message): a body that ends short is not taken for the file
    const want = Number.isFinite(g.result.file_size) ? g.result.file_size : Number.isFinite(m.f.file_size) ? m.f.file_size : undefined;
    const cl = res.headers.get("content-length");
    if (Number(cl) > inbox.MAX_FILE_BYTES) { await res.body.cancel().catch(() => {}); throw Object.assign(new Error("too big"), { code: "too_big" }); }
    if (cl && want !== undefined && Number(cl) !== want) { await res.body.cancel().catch(() => {}); throw Object.assign(new Error(`download: ${cl} bytes, expected ${want}`), { code: "refused" }); }
    const fid = inbox.newFid();
    let saved;
    const ext = inbox.extOf(m.photo ? "photo.jpg" : m.name, m.mime);
    try { saved = await inbox.save({ dir: DIR, sid, name: inbox.fileName({ fid, ext, at }), body: res.body, size: want }); }
    catch (e) { if (e?.code === "mismatch") e.code = "refused"; throw e; }
    return { fid, name: m.photo ? "photo.jpg" : inbox.displayName(m.name), ext, mime: m.mime, size: saved.size, sha256: saved.sha256, path: saved.path };
  }
  // getUpdates confirms an update before its file is down: a file message being handled is journaled
  // (inbox-pending.json, 0600) until it is delivered or answered, and a relay that stopped mid-way picks
  // it up again at start — skipped when the session already has that message
  const PENDING_FILES = path.join(DIR, "inbox-pending.json");
  const pendingFiles = (() => {
    let text;
    try { text = fs.readFileSync(PENDING_FILES, "utf8"); } catch { return []; }
    try { const j = JSON.parse(text); if (Array.isArray(j)) return j.filter((x) => x?.msg?.chat); } catch {}
    // unreadable: kept aside for a human to look at, never silently overwritten
    try { fs.renameSync(PENDING_FILES, `${PENDING_FILES}.bad-${Date.now()}`); } catch {}
    log(`inbox: ${PENDING_FILES} could not be read — kept aside as .bad-*; file messages in it are not picked up again`);
    return [];
  })();
  // written whole to a temp file, then renamed over the journal (a crash mid-write leaves the old one)
  const savePending = () => {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = `${PENDING_FILES}.${process.pid}.tmp`;
      const buf = Buffer.from(JSON.stringify(pendingFiles));
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        for (let off = 0; off < buf.length;) { const w = fs.writeSync(fd, buf, off, buf.length - off); if (!(w > 0)) throw new Error("no progress writing"); off += w; }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, PENDING_FILES);
      // the rename itself survives a power cut once the folder is synced (POSIX; Windows cannot open a folder for it)
      if (process.platform !== "win32") { try { const dfd = fs.openSync(DIR, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch {} }
      return true;
    } catch (e) { log("inbox: could not persist", PENDING_FILES, e.message); return false; }
  };
  const pendingKey = (msg) => `${msg.chat.id}:${msg.message_id}`;
  const inFlight = new Map(); // pendingKey -> the run handling it (a replay and a re-sent update share it)
  function fileIncoming(msg) {
    const key = pendingKey(msg);
    if (inFlight.has(key)) return inFlight.get(key);
    const run = (async () => {
      let keep = false;
      try { keep = (await fileIncomingNow(msg)) === "keep"; }
      finally {
        inFlight.delete(key);
        const i = pendingFiles.findIndex((x) => pendingKey(x.msg) === key);
        // kept: the file did not come and the human could not be told — the next relay start tries again
        if (keep) log(`inbox: file message ${key} kept in ${PENDING_FILES} — not delivered and the human could not be told; tried again at the next start`);
        else if (i >= 0) { pendingFiles.splice(i, 1); savePending(); }
      }
    })();
    inFlight.set(key, run);
    return run;
  }
  async function fileIncomingNow(msg) {
    const chatId = String(msg.chat.id);
    if (!fromOurChat(msg.chat)) { log(`ignoring a file from ${who(msg.chat, msg.from)} — not the paired chat`); return; }
    noteTail(chatId, msg.message_thread_id, msg.message_id);
    const thread = msg.message_thread_id, replyTo = msg.reply_to_message?.message_id;
    const back = (t) => tg("sendMessage", { chat_id: msg.chat.id, ...(thread ? { message_thread_id: thread } : {}), text: t, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
    const caption = String(msg.caption ?? "").trim();
    const at = /^@([a-z0-9][\w-]{0,23})(?=$|[\s,:，：])[\s,:，：]*([\s\S]*)$/i.exec(caption);
    // which session: its topic, a reply to its message, or "@nick" at the start of the caption
    let sid = (thread && chatSidByThread(chatId, thread)) || (replyTo && owners.get(`${chatId}:${replyTo}`)) || null;
    let text = caption;
    if (at && ctx.chat?.byNick(at[1]) && (!sid || ctx.chat.byNick(at[1]) === sid)) { sid = ctx.chat.byNick(at[1]); text = at[2].trim(); }
    if (!sid) { await back("📎 檔案只能傳給開了聊天(/myna:chat)的 session:在它的 💬 topic 裡傳,或在說明文字開頭寫 @暱稱。"); return; }
    const nick = ctx.chat?.get(sid)?.nick || chatTopics.get(sid)?.nick || "session";
    if (!ctx.chat?.isLive(sid)) { await back(`🔒 ${nick} 已經結束,檔案沒有送出。`); return; }
    const m = mediaOf(msg);
    if (!m) { await back("📎 這種類型還不支援,請改用「檔案」傳送(迴紋針 → 檔案)。"); return; }
    if (m.f.file_size > inbox.MAX_FILE_BYTES) { await back(`📎 超過 20 MB(Telegram bot 的下載上限),沒有交給 ${nick}。`); return; }
    // picked up again after a restart: the session may have it already
    const cs = ctx.chat?.get(sid);
    if ([...(cs?.inbox || []), ...(cs?.unacked || [])].some((x) => String(x.chat) === chatId && x.message_id === msg.message_id)) return;
    // journaled before anything is downloaded (still within the update's own turn: Telegram counts it as
    // handled at the next poll). A journal that cannot be written means a relay stop mid-way would lose the
    // file without a word — so it is not taken, and the human is told
    const key = pendingKey(msg);
    if (!pendingFiles.some((x) => pendingKey(x.msg) === key)) {
      pendingFiles.push({ msg, at: new Date().toISOString() });
      if (!savePending()) {
        pendingFiles.splice(pendingFiles.findIndex((x) => pendingKey(x.msg) === key), 1);
        const label = m.photo ? "照片" : `「${inbox.displayName(m.name) || "檔案"}」`;
        log(`inbox: file message ${key} not taken — its journal entry could not be written`);
        await back(`⚠️ 附檔${label}寫檔失敗(處理紀錄寫不進去),沒有收下,請再傳一次。`);
        return;
      }
    }
    talkTo(sid);
    inbox.prune(DIR, cfg, log).catch((e) => log("inbox prune err", e.message));
    const when = new Date().toISOString();
    let file;
    try { file = await inSlot(() => download(sid, m, when)); }
    catch (e) {
      const why = failReason(e);
      log(`chat: a file for ${nick} was not saved (${why}): ${redact(e?.message || e)}`);
      const told = await back(`⚠️ 檔案沒有下載成功(${why}),沒有交給 ${nick},請再傳一次。`);
      return told?.ok ? undefined : "keep";
    }
    const from = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || "";
    const to = msg.reply_to_message;
    const reply_to = to?.message_id ? { message_id: to.message_id, text: String(to.text ?? to.caption ?? "").slice(0, 4000) } : undefined;
    const r = ctx.chat?.deliver(sid, { text, from, chat: chatId, message_id: msg.message_id, at: when, file, ...(reply_to ? { reply_to } : {}) }) || { closed: true };
    log(`chat: file ${file.fid} (${inbox.fmtSize(file.size)}) saved for ${nick}`);
    if (r.closed) await back(`🔒 ${nick} 已經結束,檔案沒有送出。`);
    else if (r.stale) await back(`⚠️ ${nick} 目前沒有回應(可能卡住或已關閉),檔案先排隊,它恢復後會收到。`);
  }
  const talkTo = (sid) => { const c = chatTopics.get(sid); if (c) { c.talked = Date.now(); saveChatTopics(); } };

  // send a message for a request: into its session topic (if any) + reply_to threading on thread_id.
  // A topic the human deleted/closed ("message thread not found") is recreated once; if that fails
  // too, the message goes to the flat chat — the gate must never be lost over topic bookkeeping.
  async function sendThreaded(s, payload) {
    const p = { ...payload };
    if (s.thread_id && threadLastMsg.has(s.thread_id)) {
      p.reply_parameters = { message_id: threadLastMsg.get(s.thread_id), allow_sending_without_reply: true };
    }
    let res = await tg("sendMessage", inTopic(s.topic, p));
    if (s.topic && isThreadGone(res) && s.chatSid) {
      // a chat session's topic: recreate the chat topic (never a gate topic for it)
      log(`chat topic ${s.topic} of session ${s.session_id} is gone — recreating`);
      const c = chatTopics.get(s.chatSid); chatTopics.delete(s.chatSid);
      s.topic = (await chatOpen(s.chatSid, { nick: c?.nick, label: c?.label, machine: c?.machine })) ?? undefined;
      res = await tg("sendMessage", inTopic(s.topic, p));
      if (s.topic && isThreadGone(res)) { s.topic = undefined; res = await tg("sendMessage", p); }
    } else if (s.topic && isThreadGone(res)) {
      log(`topic ${s.topic} for session ${s.session_id} is gone — recreating`);
      // replace only the thread that failed (another question may already have replaced it), and keep
      // the entry's stale topics — they still have to be ended once their questions are answered.
      // The topic of another gate of the session (stale) failed → drop just it; the question's gate
      // gets a fresh topic
      const cur = topics.get(s.session_id);
      let carry = [];
      if (cur && cur.thread === s.topic) { topics.delete(s.session_id); carry = cur.stale || []; }
      else if (cur?.stale?.some(([t]) => t === s.topic)) {
        cur.stale = cur.stale.filter(([t]) => t !== s.topic);
        if (!cur.stale.length) delete cur.stale;
        saveTopics();
      }
      s.topic = await topicFor(s.session_id, s.session_name, s.gateOf || cur?.gate || s.gate, s, carry);
      res = await tg("sendMessage", inTopic(s.topic, p));
      if (s.topic && isThreadGone(res)) { s.topic = undefined; res = await tg("sendMessage", p); }
    }
    if (s.thread_id && res.ok && res.result?.message_id) threadLastMsg.set(s.thread_id, res.result.message_id);
    if (s.chatSid && res.ok && res.result?.message_id) remember(owners, `${p.chat_id}:${res.result.message_id}`, s.chatSid);
    return res;
  }

  async function sendQuestion(request_id, args = {}) {
    const s = { holds: [] };
    try { await sendQuestionHeld(request_id, args, s); } finally { release(s); }
  }
  // session_label: a topic name for when this ask has to open one, never a rename of the session's
  // current topic (the permission hook knows the session but not ask_human's ticket-bearing name)
  async function sendQuestionHeld(request_id, { header, question, options = [], questionNumber, questionTotal, preamble, thread_id, session_id, session_name, session_label, gate, approves, machine_label } = {}, s) {
    if (!CHAT_ID) throw new Error("no Telegram chat paired yet — run /myna:pair");
    const chat = CHAT_ID; // a re-pair mid-send must not split this question across two chats
    Object.assign(s, { thread_id, session_id, session_name, gate, label: session_label, ...(machine_label ? { machine: machine_label } : {}) });
    // a chat session asks in its chat topic (gate as a header line), never in a gate topic of its own
    const chatPlace = chatOf(session_id);
    if (chatPlace) { s.chatSid = session_id; s.topic = chatPlace.thread ?? undefined; }
    else s.topic = await topicFor(session_id, session_name, gate, s);
    // 1) the orchestrator's reply to the human's last message goes out as its OWN message (chat-like),
    //    so a clarification reads as "AI answered → then the menu", not "menu again".
    if (preamble) await sendThreaded(s, { chat_id: chat, text: mdToPlain(preamble) || preamble });
    // 2) then the question + menu as a separate message
    const numRow = options.map((o, i) => {
      const tk = newToken();
      tokens.set(tk, { request_id, kind: "selection", value: o, topic: s.topic, chat });
      return { text: String(i + 1), callback_data: tk };
    });
    const askTk = newToken(); tokens.set(askTk, { request_id, kind: "ask", topic: s.topic, chat });
    const abortTk = newToken(); tokens.set(abortTk, { request_id, kind: "abort", topic: s.topic, chat });
    const keyboard = [numRow, [{ text: "✍️ 我想先問", callback_data: askTk }, { text: "⏹ 取消", callback_data: abortTk }]];

    // plain text (no parse_mode): question/options are arbitrary content —
    // Markdown parsing chokes on unbalanced _ * [ ] ` (e.g. "ask_human"). Markdown the AI wrote anyway
    // is turned into plain text — on screen only: the buttons above keep the option's own text.
    const show = (t) => (typeof t === "string" ? mdToPlain(t) || t : t);
    // approves stays raw: the command the human approves must read exactly as it will run
    const lines = questionLines({ header: show(header), question: show(question), options: options.map(show), questionNumber, questionTotal, approves });
    if (chatPlace && typeof gate === "string" && gate.trim()) lines.unshift(`🚦 ${oneLine(mdToPlain(gate), 60)}`);
    if (chatPlace && !chatPlace.thread) lines.unshift(`[${chatPlace.nick}]`);
    const res = await sendThreaded(s, {
      chat_id: chat, text: lines.join("\n"),
      reply_markup: { inline_keyboard: keyboard },
    });
    // The question+keyboard IS the request: if it didn't reach the phone, the user can never answer
    // and the client would poll forever. Throw so the relay resolves {kind:"unreachable"} and the
    // orchestrator falls back to the local picker (retro — this was silently absorbed).
    if (!res.ok) throw new Error(`telegram sendMessage failed: ${res.error || res.description || JSON.stringify(res).slice(0, 200)}`);
    // the topic may have been recreated mid-send — make the buttons' confirmations follow it
    if (s.topic !== tokens.get(askTk).topic) for (const tk of [...numRow.map((b) => b.callback_data), askTk, abortTk]) tokens.get(tk).topic = s.topic;
    if (res.result?.message_id) questionMsg.set(request_id, { message_id: res.result.message_id, topic: s.topic, chat, ...(thread_id ? { thread_id } : {}), ...(s.chatSid ? { chatSid: s.chatSid } : {}) });
    log(`sent question ${request_id} (${options.length} options)${thread_id ? " thread=" + thread_id : ""}${s.topic ? " topic=" + s.topic : ""}`);
  }

  // a question is over (answered, ⏹, cancelled): its keyboard message and ✍️ prompts are remembered as
  // closed (a reply to one gets "already answered", never lands on another question) and stop taking replies
  function closeMsgs(request_id, q, kind = "answered") {
    if (q?.message_id) closeMsg(`${q.chat ?? CHAT_ID}:${q.message_id}`, { request_id, kind });
    for (const [m, rid] of askPrompts) if (rid === request_id) { askPrompts.delete(m); closeMsg(m, { request_id, kind }); }
  }
  // the questions open in one place (a chat + topic; no topic = the main chat / a flat chat): the ones on
  // screen with buttons, plus any whose ✍️ answer is awaited there
  const openIn = (chat, topic) => {
    const at = (w) => String(w.chat ?? CHAT_ID) === String(chat) && (w.topic ?? null) === (topic ?? null);
    return new Set([...[...questionMsg].filter(([, q]) => at(q)), ...[...awaiting].filter(([, w]) => at(w))].map(([rid]) => rid));
  };

  async function handleUpdate(u) {
    if (u.callback_query) {
      const cq = u.callback_query;
      const info = tokens.get(cq.data);
      // a button counts only in the chat its question was sent to (after a re-pair, the old chat's
      // open questions stay answerable there); tokens journaled before 0.10.2 carry no chat
      const home = info?.chat ?? CHAT_ID;
      if (home === null || String(cq.message?.chat?.id) !== String(home)) {
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "你沒有權限回答這題" });
        log(`ignoring a button tap from ${who(cq.message?.chat, cq.from)} — not the paired chat`);
        return;
      }
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: info ? "" : "已過期" });
      if (!info) return;
      const chatId = cq.message.chat.id;
      const topic = info.topic;
      if (info.kind === "selection") {
        ctx.resolve(info.request_id, { kind: "selection", value: info.value }); // resolve FIRST
        const r = await tg("sendMessage", inTopic(topic, { chat_id: chatId, text: `✅ 你選了:${mdToPlain(info.value)}` }));
        if (r.ok && r.result?.message_id) { closeMsg(`${chatId}:${r.result.message_id}`, { request_id: info.request_id, kind: "selection" }); ctx.persist?.(); }
      } else if (info.kind === "abort") {
        ctx.resolve(info.request_id, { kind: "aborted" }); // resolve FIRST
        const r = await tg("sendMessage", inTopic(topic, { chat_id: chatId, text: "⏹ 已取消" }));
        if (r.ok && r.result?.message_id) { closeMsg(`${chatId}:${r.result.message_id}`, { request_id: info.request_id, kind: "aborted" }); ctx.persist?.(); }
      } else if (info.kind === "ask") {
        awaiting.set(info.request_id, { chat: String(chatId), topic: topic ?? null }); ctx.persist?.();
        const res = await tg("sendMessage", inTopic(topic, {
          chat_id: chatId, text: "✍️ 請「回覆這則訊息」輸入你的問題:",
          reply_markup: { force_reply: true, input_field_placeholder: "你的問題…" },
        }));
        if (res.ok && res.result?.message_id) { remember(askPrompts, `${chatId}:${res.result.message_id}`, info.request_id); ctx.persist?.(); }
      }
      return;
    }
    // a file (document / photo / other media) without text: for a chat session — never a question's answer
    if (u.message && !u.message.text && hasFile(u.message)) return fileIncoming(u.message);
    if (u.message && u.message.text) {
      const msg = u.message;
      const pm = /^[!！]pair(?:\s+(\S+))?\s*$/i.exec(msg.text.trim());
      if (pm) { await takePairing(msg, pm[1]); return; }
      // the old "/pair <code>": Myna takes no "/" commands on Telegram any more — say how it is typed now
      const oldPair = /^\/pair(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(msg.text.trim());
      if (oldPair) {
        await tg("sendMessage", { chat_id: msg.chat.id, ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}), text: `⚠️ 配對請改打「!pair ${oldPair[1] || "<配對碼>"}」(在群組裡,bot 要先關掉 privacy mode 或設成管理員,才收得到)。` });
        return;
      }
      const chatId = String(msg.chat.id);
      const ours = fromOurChat(msg.chat);
      // the paired chat, or a chat with a question still open there (asked before a re-pair)
      if (!ours && ![...questionMsg.values(), ...awaiting.values()].some((w) => String(w.chat ?? CHAT_ID) === chatId)) {
        log(`ignoring a message from ${who(msg.chat, msg.from)} — not the paired chat`);
        return;
      }
      noteTail(chatId, msg.message_thread_id, msg.message_id);
      const thread = msg.message_thread_id, replyTo = msg.reply_to_message?.message_id;
      // "/cmd@thisbot args" (what Telegram makes of a command picked from its menu) → "/cmd args"
      const unbot = (t) => t.replace(/^(\/[\w:.-]+)@(\w+)(?=\s|$)/, (all, cmd, user) =>
        (botUser ? user.toLowerCase() === botUser.toLowerCase() : /bot$/i.test(user)) ? cmd : all);
      const text = unbot(msg.text.trim());
      const at = /^@([a-z0-9][\w-]{0,23})(?=$|[\s,:，：])[\s,:，：]*([\s\S]*)$/i.exec(text);
      const talk = (sid) => { const c = chatTopics.get(sid); if (c) { c.talked = Date.now(); saveChatTopics(); } return sid; };
      const answer = (rid) => { awaiting.delete(rid); ctx.resolve(rid, { kind: "message", text: msg.text }); };
      const back = (t) => tg("sendMessage", { chat_id: msg.chat.id, ...(thread ? { message_thread_id: thread } : {}), text: t, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
      // 1) a reply to a ✍️ prompt answers that question, wherever it was typed
      const prompted = replyTo && askPrompts.get(`${chatId}:${replyTo}`);
      if (prompted && awaiting.has(prompted)) return answer(prompted);
      // 1b) a reply to a question's own message answers that question (Telegram's own way of saying
      //     which message you answer — no ✍️ needed)
      const quoted = replyTo && [...questionMsg].find(([, q]) => q.message_id === replyTo && String(q.chat ?? CHAT_ID) === chatId);
      if (quoted) {
        answer(quoted[0]);
        await tg("setMessageReaction", { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "👌" }] });
        return;
      }
      // 1c) a reply to a question that is already over (its message, ✍️ prompt or ✅/⏹ line) answers
      //     nothing — never the question still open next to it — and the human is told so
      const over = replyTo && closedMsgs.get(`${chatId}:${replyTo}`);
      if (over) {
        log(`reply to message ${replyTo} of question ${over.request_id} (already ${over.kind}) — not taken as any answer`);
        await back(over.kind === "selection" || over.kind === "message" ? "這題已經答過了,這則回覆沒有記成任何題目的答案。"
          : over.kind === "aborted" ? "這題已經取消了,這則回覆沒有記成任何題目的答案。"
          : "這題已經結束了,這則回覆沒有記成任何題目的答案。");
        return;
      }
      // 2) typed (not a reply) where a ✍️ answer is awaited: it answers only when that is the ONE question
      //    open in this topic. With several open the text is not guessed onto one (a ✍️ tapped earlier
      //    must not take text meant for another question) — the human is asked to reply to the one meant.
      //    Never in chat mode: typed text in a chat session's topic, or for a chat session's question, is
      //    a chat message (chatIncoming below) — only a reply answers there.
      const inChatTopic = ours && thread && chatSidByThread(chatId, thread);
      const here = openIn(chatId, thread);
      const waitingHere = [...here].filter((rid) => awaiting.has(rid) && !questionMsg.get(rid)?.chatSid);
      if (!inChatTopic && waitingHere.length && here.size === 1) return answer(waitingHere[0]);
      if (!inChatTopic && waitingHere.length) {
        log(`text in thread ${thread ?? "none"} with ${here.size} questions open there — not guessed, asked to reply to one`);
        await back(`這裡有 ${here.size} 題在等回答,不確定你回的是哪一題。請直接「回覆」那一題的訊息(或它的 ✍️ 提示)。`);
        return;
      }
      if (ours) {
        // 3a) "/cmd" (bare or after "@nick"): Myna takes no "/" commands on Telegram — Telegram treats one
        //     as a bot command and, in a private chat with topics, may open a NEW topic for it. Not
        //     forwarded; the human is told to type "!cmd"
        const addressed = at && at[2].trim() && ctx.chat?.byNick(at[1]) ? unbot(at[2].trim()) : text;
        if (isSlashCommand(addressed)) {
          const bang = `!${addressed.slice(1)}`;
          log(`chat: slash command ${JSON.stringify(addressed.split(/\s/)[0])} (thread ${thread ?? "none"}, message ${msg.message_id}) → not run, told to use "!"`);
          await tg("sendMessage", { chat_id: msg.chat.id, ...(thread ? { message_thread_id: thread } : {}), text: `⚠️ Myna 在 Telegram 不用「/」指令(Telegram 會把它當成 bot 指令,還可能自己開新 topic),所以沒有轉給 session。要下指令請在 session 的 topic 裡改打「${bang}」;一般文字請別用「/」開頭。`, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
          return;
        }
        // 3) a chat session's topic → that session (or the question it has waiting there)
        const inChat = thread && chatSidByThread(chatId, thread);
        //    ("@<its own nick> …" there is just addressing — the session gets what follows, so a
        //    "@egret !usage" typed in egret's topic still runs !usage)
        if (inChat) return chatIncoming(talk(inChat), msg, at && at[2].trim() && ctx.chat?.byNick(at[1]) === inChat ? unbot(at[2].trim()) : text);
        // 4) the main chat: a reply to a chat session's message, or `@nick …`
        const owner = replyTo && owners.get(`${chatId}:${replyTo}`);
        if (owner) return chatIncoming(talk(owner), msg, text);
        const named = at && ctx.chat?.byNick(at[1]);
        if (named) return chatIncoming(talk(named), msg, unbot(at[2].trim()));
        // 4b) a "!command" outside any chat topic: the session the human last wrote to (30 min), else the
        //     only live one — else ask
        if (isCommand(text)) {
          const liveHere = [...chatTopics.keys()].filter((sid) => chatOf(sid));
          const last = liveHere.reduce((a, sid) => ((chatTopics.get(sid).talked || 0) > (a ? chatTopics.get(a).talked || 0 : 0) ? sid : a), null);
          const recent = last && Date.now() - chatTopics.get(last).talked < TALK_MS ? last : null;
          const target = recent || (liveHere.length === 1 ? liveHere[0] : null);
          log(`chat: command ${JSON.stringify(text.split(/\s/)[0])} outside a chat topic (thread ${thread ?? "none"}, message ${msg.message_id}) → ${target ? chatTopics.get(target)?.nick : "asked which session"}`);
          if (target) {
            await chatIncoming(talk(target), msg, text);
            // the answer lands in the session's topic, not here — say where, so the human isn't left waiting
            const c = chatTopics.get(target), nick = ctx.chat?.get(target)?.nick || c?.nick;
            if (thread && c?.thread && c.thread !== thread) {
              await tg("sendMessage", { chat_id: msg.chat.id, message_thread_id: thread, text: `↪ 已交給 @${nick},結果會在「💬 ${nick}」topic。`, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
            }
            return;
          }
          const nicks = liveHere.map((sid) => `@${chatTopics.get(sid)?.nick}`);
          const ask = `這個指令要給哪個 session?請在它的 topic 裡打,或寫成「${nicks[0] || "@暱稱"} ${text}」。` + (nicks.length ? `目前有:${nicks.join("、")}` : "目前沒有在聊天的 session。");
          await tg("sendMessage", { chat_id: msg.chat.id, ...(thread ? { message_thread_id: thread } : {}), text: ask, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
          return;
        }
      }
      // 5) text outside any topic (e.g. the client dropped the thread) answers a ✍️ only when that is the
      //    ONE question open in the whole chat — unambiguous; otherwise it is ignored rather than guessed
      //    (decision 8a spirit). Text typed in a topic never answers another topic's question.
      if (!thread) {
        const all = new Set([...[...questionMsg].filter(([, q]) => String(q.chat ?? CHAT_ID) === chatId), ...[...awaiting].filter(([, w]) => w.chat === chatId)].map(([rid]) => rid));
        const [only] = all;
        if (all.size === 1 && awaiting.has(only) && !questionMsg.get(only)?.chatSid) return answer(only);
      }
      log(`ignoring stray text from ${chatId} (thread ${thread ?? "none"}): ${JSON.stringify(msg.text)} (decision 8a: only ✍️ replies count)`);
    }
  }

  // --- pairing (/myna:pair → POST /pair/start → `!pair <code>` in the chat to bind) ---------------
  function startPairing() {
    pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, "0"), expires: Date.now() + PAIR_TTL_MS, tries: 0 };
    log(`pairing code issued (valid ${PAIR_TTL_MS / 60000} min)`); // never log the code itself
    return { code: pairing.code, expires_in: PAIR_TTL_MS / 1000, chat: pairStatus().chat };
  }
  function pairStatus() {
    const live = !!pairing && pairing.expires > Date.now();
    return { chat: CHAT_ID ? { id: CHAT_ID, ...(bound && String(bound.chat_id) === CHAT_ID ? { title: bound.title, type: bound.type, paired_at: bound.paired_at } : { source: "TELEGRAM_CHAT_ID" }) } : null, pairing: live };
  }
  async function takePairing(msg, code) {
    const where = { chat_id: msg.chat.id, ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}) };
    const live = !!pairing && pairing.expires > Date.now();
    if (!live || code !== pairing.code) {
      if (live && code && ++pairing.tries >= PAIR_TRIES) { pairing = null; log(`pairing code voided after ${PAIR_TRIES} wrong tries`); }
      log(`pairing attempt from ${who(msg.chat, msg.from)} rejected (${live ? "wrong code" : "no live code"})`);
      await tg("sendMessage", { ...where, text: "❌ 配對碼不正確或已過期。請在 Claude Code 執行 /myna:pair 取得新的配對碼。" });
      return;
    }
    pairing = null;
    const old = CHAT_ID;
    CHAT_ID = String(msg.chat.id);
    bound = { chat_id: CHAT_ID, type: msg.chat.type, title: msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") || msg.chat.username || "", paired_at: new Date().toISOString() };
    try { fs.mkdirSync(path.dirname(CHAT_FILE), { recursive: true }); fs.writeFileSync(CHAT_FILE, JSON.stringify(bound, null, 2), { mode: 0o600 }); }
    catch (e) { log("pairing: could not persist", CHAT_FILE, e.message); }
    log(`paired with chat ${CHAT_ID} (${bound.type}${old && old !== CHAT_ID ? `, was ${old}` : ""})`);
    if (old && old !== CHAT_ID) {
      // the old chat's topics stay where they are (its open questions remain answerable there);
      // new questions open fresh topics in the new chat
      for (const t of graceTimers.values()) clearTimeout(t);
      graceTimers.clear(); topics.clear(); saveTopics();
      await tg("sendMessage", { chat_id: old, text: "🔀 Myna 已改綁到另一個聊天室,之後的問題不會再送到這裡。" });
    }
    await tg("sendMessage", { ...where, text: "✅ 已綁定這個聊天室,之後 Myna 的問題都會送到這裡。" });
  }

  async function start() {
    let offset = 0;
    // file messages a stopped relay was still handling (see PENDING_FILES)
    if (pendingFiles.length) {
      log(`inbox: ${pendingFiles.length} file message(s) from before the restart — handling them again`);
      for (const x of [...pendingFiles]) fileIncoming(x.msg).catch((e) => log("fileIncoming err", redact(e.message)));
    }
    log(`Telegram getUpdates long-poll started (topics=${TOPICS ? "auto" : "off"}, scope=${SCOPE}, round_grace=${ROUND_GRACE_MS / 1000}s, on_end=${ON_END}, ${topics.size} known session topic(s), answers from chat ${CHAT_ID ?? "(none — run /myna:pair)"})`);
    // diagnostics: Bot API 9.3+ getMe reports whether Threaded Mode is on — say so up front, so a
    // "why is everything in one window?" question is answered by the first lines of relay.log.
    tg("getMe", {}).then((me) => {
      if (me.ok && me.result?.username) botUser = me.result.username;
      if (!TOPICS || !me.ok || me.result?.has_topics_enabled === undefined) return;
      log(me.result.has_topics_enabled ? "bot has Threaded Mode ON — one topic per gate"
        : 'bot has Threaded Mode OFF — all sessions share the flat chat. Enable it in @BotFather → /mybots → Bot Settings → Threaded Mode.');
    }).catch(() => {});
    while (!stopper.signal.aborted) {
      try {
        // 40s client timeout > 30s server long-poll: a wedged/half-open socket can't hang forever
        // (it throws → caught below → 1s backoff → retry; offset unchanged so no update is lost).
        const { signal, done } = pollSignal(40000);
        let j;
        try { j = await (await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, { signal })).json(); } finally { done(); }
        if (stopper.signal.aborted) break; // stopped meanwhile: leave these updates unconfirmed for whoever polls next
        if (j.ok) for (const u of j.result) { offset = u.update_id + 1; handleUpdate(u).catch((e) => log("handleUpdate err", e.message)); }
      } catch (e) { if (stopper.signal.aborted) break; log("poll err", errText(e)); await new Promise((r) => setTimeout(r, 1000)); }
    }
    log("Telegram getUpdates long-poll stopped");
  }
  // stop polling for good (an edge that found the hub polls this same bot — two pollers get 409)
  const stopper = new AbortController();
  function stop() { stopper.abort(); }
  // a poll's signal: aborts on its timeout or on stop(). AbortSignal.any is Node 18.17+ / 20.3+; on an
  // older Node the two are combined by hand, so stop() still cuts the poll in flight at once (two pollers
  // on one bot get 409). done() drops the listener on stopper once the poll is over.
  function pollSignal(ms) {
    if (AbortSignal.any) return { signal: AbortSignal.any([AbortSignal.timeout(ms), stopper.signal]), done() {} };
    const c = new AbortController();
    const t = setTimeout(() => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
    const onStop = () => c.abort(stopper.signal.reason);
    if (stopper.signal.aborted) onStop(); else stopper.signal.addEventListener("abort", onStop, { once: true });
    return { signal: c.signal, done() { clearTimeout(t); stopper.signal.removeEventListener("abort", onStop); } };
  }

  // Claude finished its reply and none of the session's gates is open (relay checked): the round —
  // and with it the current gate — is over once the grace passes without another ask (topicFor
  // cancels). endsAt is persisted so a relay restart inside the grace still ends the topic.
  // scope=session keeps the topic until the session ends.
  function scheduleEnd(session_id, delay) {
    clearTimeout(graceTimers.get(session_id));
    graceTimers.set(session_id, setTimeout(() => { graceTimers.delete(session_id); retire(session_id, topics.get(session_id)?.closed ? "ended" : "round ended"); }, delay));
  }
  function endRound(session_id) {
    const t = topics.get(session_id);
    if (SCOPE !== "gate" || !t) return;
    t.endsAt = Date.now() + ROUND_GRACE_MS; saveTopics();
    scheduleEnd(session_id, ROUND_GRACE_MS);
    if (ROUND_GRACE_MS) log(`session ${session_id} round ended — topic ${t.thread} goes in ${ROUND_GRACE_MS / 1000}s unless it asks again`);
  }
  // a previous relay stopped inside a grace → finish it (remaining time, or now if overdue). Either
  // scope: a round end sets endsAt under scope=gate only, a session end under both.
  for (const [sid, t] of topics) if (t.endsAt) scheduleEnd(sid, Math.max(0, t.endsAt - Date.now()));

  // session ended (MCP server exiting): wrap up whatever topic(s) it still has — after the same grace
  // as a round end, so the question and its ✅/⏹/↩️ line stay readable for a while. Ending them at
  // once made a `claude -p` run, which exits the moment it has its answer, delete the topic a second
  // after the tap (live-observed: nothing left on the phone to show the gate was ever
  // asked). A grace already running from the round end keeps its deadline. A resumed session reuses
  // its id — asking again inside the grace keeps the topic, like any ask does (topicFor).
  async function closeSession(session_id) {
    const t = topics.get(session_id);
    const shown = t && (t.thread || (t.stale || []).length);
    if (!shown || !ROUND_GRACE_MS) {
      clearTimeout(graceTimers.get(session_id)); graceTimers.delete(session_id);
      await retire(session_id, "ended").ending;
      return;
    }
    t.closed = true;
    if (!t.endsAt) t.endsAt = Date.now() + ROUND_GRACE_MS;
    saveTopics();
    const left = Math.max(0, t.endsAt - Date.now());
    scheduleEnd(session_id, left);
    log(`session ${session_id} ended — topic ${t.thread} goes in ${Math.round(left / 1000)}s`);
  }

  // the asking side gave up on a question (answered in the terminal / Esc, or its MCP process ended):
  // retract the phone's buttons and say where it went, so nobody answers a question nobody awaits.
  // Called before the relay resolves it (onResolve then drops the tokens). Best-effort.
  // why = "expired": it was handed off (detached) and no session took it over in time.
  // why = "orphaned": left open long past its asker (the relay's orphan sweep).
  // why = "answered": the asker took the human's answer another way (note: what they wrote), e.g. a reply to the
  // message it posted before the question.
  async function cancelQuestion(request_id, why, note = "") {
    const q = questionMsg.get(request_id);
    questionMsg.delete(request_id);
    if (!q) return;
    closeMsgs(request_id, q, why === "answered" ? "message" : "cancelled");
    await tg("editMessageReplyMarkup", { chat_id: q.chat ?? CHAT_ID, message_id: q.message_id, reply_markup: { inline_keyboard: [] } });
    const text = why === "answered" ? `✅ 已照你的回覆${note ? `「${oneLine(note, 80)}」` : ""}處理,這題的按鈕已失效`
      : why === "expired" ? "⌛ 這題交出後沒有 session 接手,已取消;手機上的按鈕已失效"
      : why === "orphaned" ? "⌛ 這題放太久、已經沒有 session 在等答案,已取消;手機上的按鈕已失效"
      : why === "join_expired" ? "⌛ 加入要求逾時沒有回應,已取消;手機上的按鈕已失效"
      : why === "revoked" ? "🚫 發問的機器已被撤銷,這題已取消;手機上的按鈕已失效"
      : why === "same_bot" ? "↩️ 這台機器的 bot 就是主節點那支,不再用它發問;這題改回終端機處理,手機上的按鈕已失效"
      : "↩️ 這題已在終端機處理,手機上的按鈕已失效";
    await tg("sendMessage", inTopic(q.topic, { chat_id: q.chat ?? CHAT_ID, text }));
    log(`question ${request_id} ${why === "expired" ? "expired after a detach" : why === "orphaned" ? "orphaned" : "cancelled by the asking side"} — buttons retracted`);
  }

  // another session took a request over (relay /reattach): its topic moves with it, so that session's
  // follow-ups (same gate, ✍️ re-asks) land in the same topic and the old session's close/round-end no
  // longer touch it. The request in the old session's CURRENT topic → the whole entry moves (its stale
  // topics too: they may hold the old session's other handed-off questions; a stale topic is ended only
  // once no question is open in it, whoever owns it) and an old session that asks again opens a fresh
  // topic. The new session already has a topic → the moved ones join its stale list. The request in a
  // stale topic → just that one moves (as the new session's current topic when it has none, else stale).
  function transferRequest(request_id, from, to) {
    const q = questionMsg.get(request_id);
    const thread = q?.topic ?? [...tokens.values()].find((v) => v.request_id === request_id)?.topic;
    const old = topics.get(from);
    // its ✍️ follow-ups (same thread_id, no `gate`) stay in its gate under the new session too
    const tg0 = q?.thread_id && threadGates.get(`${from}\n${q.thread_id}`);
    if (tg0 && from !== to) remember(threadGates, `${to}\n${q.thread_id}`, tg0);
    if (!thread || !old || from === to) return;
    let moved, current;
    if (old.thread === thread) {
      topics.delete(from); clearTimeout(graceTimers.get(from)); graceTimers.delete(from);
      moved = [...(old.stale || []), [old.thread, old.name, old.gate]];
      current = { thread: old.thread, name: old.name, gate: old.gate, created: old.created, ...(old.stale?.length ? { stale: old.stale } : {}) };
    } else {
      const i = (old.stale || []).findIndex(([t]) => t === thread);
      if (i < 0) return;
      moved = old.stale.splice(i, 1);
      if (!old.stale.length) delete old.stale;
    }
    const mine = topics.get(to);
    if (!mine && current) topics.set(to, current);
    else if (mine) mine.stale = [...(mine.stale || []), ...moved.filter(([t]) => t && t !== mine.thread)];
    else topics.set(to, { thread: moved[0][0], name: moved[0][1], ...(moved[0][2] ? { gate: moved[0][2] } : {}), created: new Date().toISOString() }); // its topic becomes the new session's current one (gate unknown on old entries: the next named gate replaces it)
    saveTopics();
    log(`topic ${thread} moved with request ${request_id}: session ${from} → ${to}`);
  }

  return {
    name, start, stop, sendQuestion, closeSession, endRound, cancelQuestion, transferRequest, startPairing, pairStatus,
    chatOpen, chatProgress, chatTaken, chatClose,
    onResolve(request_id, result) {
      for (const [t, v] of tokens) if (v.request_id === request_id) tokens.delete(t);
      awaiting.delete(request_id);
      closeMsgs(request_id, questionMsg.get(request_id), result?.kind);
      questionMsg.delete(request_id);
    },
    // handoff: everything a fresh relay needs so the buttons/✍️ prompts already on the phone keep
    // working after a restart or upgrade (the relay journals this next to the pending table)
    exportState: () => ({ tokens: [...tokens], awaiting: [...awaiting], threadLastMsg: [...threadLastMsg], questionMsg: [...questionMsg], askPrompts: [...askPrompts], threadGates: [...threadGates], closedMsgs: [...closedMsgs] }),
    importState(s) {
      for (const [k, v] of s?.tokens || []) tokens.set(k, v);
      for (const [k, v] of s?.awaiting || []) awaiting.set(k, v);
      // journals before 0.17.0: one ✍️ per place, `${chat}:${topic}` -> request_id
      for (const [k, rid] of s?.awaitingText || []) {
        const i = String(k).indexOf(":"), t = String(k).slice(i + 1);
        awaiting.set(rid, { chat: String(k).slice(0, i), topic: t ? Number(t) : null });
      }
      for (const [k, v] of s?.threadGates || []) threadGates.set(k, v);
      for (const [k, v] of s?.closedMsgs || []) closedMsgs.set(k, v);
      for (const [k, v] of s?.threadLastMsg || []) threadLastMsg.set(k, v);
      for (const [k, v] of s?.questionMsg || []) questionMsg.set(k, v);
      for (const [k, v] of s?.askPrompts || []) askPrompts.set(k, v);
    },
  };
}
