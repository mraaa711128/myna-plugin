// Myna chat — a Claude Code session registered as a chatbot (relay side, provider-agnostic).
//
// A session registers under a nickname; the IM provider gives it a place of its own (Telegram: a
// topic "💬 <nick> · <label>"). What the human types there — or `@nick …` / a reply to one of its
// messages in the main chat — queues in the session's inbox; the session (its chat mod) takes what
// queued while it was busy as one prompt (a slash command on its own, run as a command). While a turn runs the session reports its steps and
// the provider keeps ONE progress message per turn up to date, then sends the final answer.
//
// HTTP (all JSON; the relay routes /chat/* here):
//   POST /chat/register  Authorization: Bearer <relay secret>   {session_id, nick, label?, cwd?}
//        → {token, nick, topic, queued}. The relay secret is ~/.myna/relay-secret (0600, created by the
//        relay): only a process of this user can register — a web page can't reach these endpoints
//        (a bearer header forces a CORS preflight the relay never answers). Registering again (resume,
//        or after a relay restart dropped the tokens → 401) keeps the session's topic and inbox.
//   POST /chat/take      Authorization: Bearer <token>  {max?, wait_ms?}  → {message: {id, text, from, at, reply_to?} | null, messages: [...], queued}
//                        (up to `max` queued messages, default 1; a slash command "/name args" is always taken alone;
//                        reply_to {message_id, text}: the message the human replied to, when they replied to one;
//                        wait_ms (≤ 25000): with nothing queued, hold until a message comes or it runs out;
//                        remote port only — ack: [ids] of the last batch it got: a batch is handed out again
//                        until acked, so one lost on the way back (a tunnel cut mid-reply) is not lost)
//   POST /chat/progress  Authorization: Bearer <token>  {event: "start", origin: "phone"|"terminal"|"background", prompt?, label?}
//        (terminal: the prompt typed there; background: a turn nobody typed, shown as the mod's one-line label)
//        | {event: "step", text?, tools?: [{name, input}]} | {event: "done", text?, interrupted?}
//   POST /chat/nick      Authorization: Bearer <token>  {nick} → {nick}
//   POST /chat/close     Authorization: Bearer <token>  → the session ended; its topic is kept, marked 🔒
//   GET  /chat/session?session_id=<sid> → {chat, nick?}  (no auth: the Stop hook asks whether a session chats)
// Files from the phone (SPEC §5.3): an inbox message may carry file {fid, name, mime, size, sha256, path}. The
// local take puts the file's local path at the front of its text (+ file_path, for the mod's tool.check); the
// remote take, asked with files: true, gives the description without the path, and another machine's relay
// fetches its own copy with GET /chat/file/<fid> (remote port only: machine token + X-Myna-Chat-Token).
// A per-session token scopes everything after registering: one session never reads another's inbox.
// Nicknames are unique among live sessions (a taken one gets a number: egret → egret2).
// Another machine's edge relay (SPEC §5.2) reaches the same endpoints on the hub's remote port: its
// machine token stands in for the relay secret, its session ids become m:<machine_id>:<session_id>,
// the per-session token travels in X-Myna-Chat-Token (Authorization carries the machine token there),
// a 401 that only wants a new registration says so (reregister: true), and progress is rate-limited.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileText, FID_RE } from "./inbox.mjs";
import { projectOf } from "./project.mjs";
import { writePrivate } from "./remote.mjs";

// a session token file's name (src/node.mjs, src/mcp/ask-human.mjs use the same rule)
const sessionTokenName = (sid) => String(sid).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);

const NICK_MAX = 24;
// "!name args" (or full-width "！name") — a command typed on the phone (run as a command in the session,
// never batched with text)
export const isCommand = (t) => /^[!！][^\s/!！]+(?:\s|$)/.test(String(t ?? "").trim());
// "/name args" — a Telegram bot command: Myna takes none (Telegram may open a topic of its own for one),
// so the Telegram provider does not forward it to a session; it tells the human to type "!name" instead
export const isSlashCommand = (t) => /^\/[\w:.-]+(?:\s|$)/.test(String(t ?? "").trim());
export const normNick = (n) => String(n ?? "").trim().toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_-]/g, "").slice(0, NICK_MAX);
export const CHAT_TOKEN_HEADER = "x-myna-chat-token";
export const TAKE_WAIT_MAX_MS = 25000;
// up to `max` messages off the front of an inbox (mutates it): what piled up goes in as one prompt; a
// "!command" always goes on its own (it runs as a command, not as text)
export function takeBatch(inbox, max) {
  const out = [];
  while (inbox.length && out.length < max) {
    if (out.length && isCommand(inbox[0].text)) break;
    const m = inbox.shift();
    out.push(m);
    if (isCommand(m.text)) break;
  }
  return out;
}
// via "session": a message another session sent (tree transport, SPEC §5.4) — `from` is its address and
// `peer` the stamps its relay put on it; the mod quotes it under a header line of its own
export const takeView = (m) => ({ id: m.id, text: m.text, from: m.from, at: m.at, ...(m.reply_to ? { reply_to: m.reply_to } : {}), ...(m.via ? { via: m.via } : {}), ...(m.peer ? { peer: m.peer } : {}) });
// what a local chat mod gets (SPEC §5.3): a message with a file has the file's local path at the front of
// its text, and file_path (the mod lets the session Read exactly that file without a prompt)
export const takeLocal = (m) => {
  if (!m.file) return takeView(m);
  const { text, path: p } = fileText(m);
  return { ...takeView(m), text, ...(p ? { file_path: p } : {}) };
};
export const OLD_EDGE_FILE = "📎 有附檔沒有送到:這台機器的 Myna 要升級到 0.22.0 以上。";
// what another machine's relay gets: the file's description without its path here (it fetches its own copy,
// GET /chat/file/<fid>) — or, for a relay too old to fetch, a line saying the file did not come
const takeRemote = (m, files) => {
  if (!m.file) return takeView(m);
  if (!files) return { ...takeView(m), text: `${OLD_EDGE_FILE}${m.text ? `\n${m.text}` : ""}` };
  const { fid, name, ext, mime, size, sha256 } = m.file;
  return { ...takeView(m), file: { fid, name, ...(ext ? { ext } : {}), mime, size, sha256 } };
};

// topicMachine(scope): the machine-name prefix of a session's topic ("" = none; see MYNA_TOPIC_MACHINE)
// progressPerSec: progress posts per second one remote session may make (more → 429)
// registerNote(): a line for the registering mod to show (an edge whose hub is too old to forward chat)
// tree (tree transport on, SPEC §5.4): () → {tokenDir, onHuman(sid), onClose(sid)} or null. With it a session
// registers without a bot (no topic — the bot is an add-on, M8), its project stamp is locked at the first
// registration (2.5), and its token is also written to <tokenDir>/<sid> (0600) for its MCP server's /peer/send
export function createChat({ cfg, log, dir, topicMachine = () => "", progressPerSec = 5, registerNote = () => "", tree = () => null }) {
  const SECRET_FILE = cfg.MYNA_RELAY_SECRET_FILE || path.join(dir, "relay-secret");
  const FILE = cfg.MYNA_CHAT_FILE || path.join(dir, "chat-sessions.json");
  // a session that has not polled for this long is probably stuck or gone — the sender is told
  const STALE_MS = Number(cfg.MYNA_CHAT_STALE_MS || 90000);
  const KEEP_CLOSED_MS = 7 * 24 * 3600 * 1000; // an ended session's record (nick, topic) for a resume
  const MAX_BODY = 256 * 1024;

  const secret = loadSecret();
  // sid -> {nick, label, cwd, registered, closed?, inbox: [{id, text, from, at, chat, message_id, reply_to?}]}
  const sessions = load();
  const tokens = new Map();   // token -> sid (runtime only: after a relay restart the session registers again)
  const lastSeen = new Map(); // sid -> last take/progress (runtime)
  const staleNoticed = new Map(); // sid -> when the sender was last told the session is unresponsive
  const waiters = new Map();  // sid -> Set of wake functions of /chat/take calls holding for a message (wait_ms)
  const posts = new Map();    // sid -> recent progress timestamps of a remote session (rate limit)
  let provider = null;
  const wakeTakers = (sid) => { for (const w of waiters.get(sid) || []) w(); };

  function loadSecret() {
    try {
      const s = fs.readFileSync(SECRET_FILE, "utf8").trim();
      if (s.length >= 32) { try { fs.chmodSync(SECRET_FILE, 0o600); } catch {} return s; }
    } catch {}
    const s = crypto.randomBytes(32).toString("hex");
    try {
      fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
      fs.writeFileSync(SECRET_FILE, `${s}\n`, { mode: 0o600 });
      fs.chmodSync(SECRET_FILE, 0o600);
      log(`chat: relay secret created at ${SECRET_FILE}`);
    } catch (e) { log("chat: could not write the relay secret", SECRET_FILE, e.message); }
    return s;
  }
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      const m = new Map();
      for (const [sid, s] of Object.entries(j.sessions || {})) {
        if (s.closed && Date.now() - Date.parse(s.closed) > KEEP_CLOSED_MS) continue;
        m.set(sid, { ...s, inbox: Array.isArray(s.inbox) ? s.inbox : [] });
      }
      return m;
    } catch { return new Map(); }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`, text = JSON.stringify({ sessions: Object.fromEntries(sessions) }, null, 2);
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      try { fs.renameSync(tmp, FILE); } catch { fs.writeFileSync(FILE, text, { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch {} }
    } catch (e) { log("chat: could not persist", FILE, e.message); }
  }

  const live = (sid) => { const s = sessions.get(sid); return !!s && !s.closed; };
  function uniqueNick(want, self) {
    const base = normNick(want) || "claude";
    const taken = new Set([...sessions].filter(([sid, s]) => sid !== self && !s.closed).map(([, s]) => s.nick));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) { const c = `${base.slice(0, NICK_MAX - String(n).length)}${n}`; if (!taken.has(c)) return c; }
  }
  const sameSecret = (given) => {
    const a = Buffer.from(String(given || "")), b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "") || [])[1] || "";

  // what the provider uses to route the human's messages
  const ctx = {
    isLive: live,
    get: (sid) => sessions.get(sid),
    list: () => [...sessions.values()].filter((s) => !s.closed).map((s) => s.nick),
    byNick: (nick) => { const n = normNick(nick); for (const [sid, s] of sessions) if (!s.closed && s.nick === n) return sid; return null; },
    // queue a message for the session → {queued, closed?, stale?} (stale: say so to the sender, once in a while)
    deliver(sid, m) {
      const s = sessions.get(sid);
      if (!s) return { closed: true };
      if (s.closed) return { closed: true, nick: s.nick };
      s.inbox.push({ id: crypto.randomBytes(4).toString("hex"), at: new Date().toISOString(), ...m });
      save();
      wakeTakers(sid);
      const seen = lastSeen.get(sid) || 0, told = staleNoticed.get(sid) || 0;
      const stale = Date.now() - seen > STALE_MS && Date.now() - told > STALE_MS;
      if (stale) staleNoticed.set(sid, Date.now());
      log(`chat: message queued for ${s.nick} (${s.inbox.length} waiting)`);
      return { queued: s.inbox.length, nick: s.nick, stale };
    },
  };

  // scope: who calls — this machine's local listener (no scope) or another machine's edge relay
  // through the hub's remote port ({id, name, remote: true, sid}, its machine token already checked)
  async function handle(req, res, url, scope) {
    if (!url.pathname.startsWith("/chat/")) return false;
    const remote = !!scope?.remote;
    const reply = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!remote && req.method === "GET" && url.pathname === "/chat/session") {
      const sid = url.searchParams.get("session_id") || "";
      const s = sessions.get(sid);
      reply(200, { chat: live(sid), ...(s ? { nick: s.nick } : {}) });
      return true;
    }
    // another machine's relay fetches a file of one of its sessions (SPEC §5.3): its machine token was
    // checked by the remote listener; the session's chat token says which session; a file that is not
    // that session's — or is gone — is a 404 either way
    const fm = remote && req.method === "GET" ? /^\/chat\/file\/([^/]+)$/.exec(url.pathname) : null;
    if (fm) {
      const sid = tokens.get(String(req.headers[CHAT_TOKEN_HEADER] || ""));
      const s = sid && sessions.get(sid);
      if (!s || s.closed || s.machine_id !== scope.id) { reply(401, { error: "unknown or expired token — register again", reregister: true }); return true; }
      lastSeen.set(sid, Date.now());
      const fid = fm[1];
      const m = FID_RE.test(fid) ? [...(s.unacked || []), ...s.inbox].find((x) => x.file?.fid === fid) : null;
      let st = null;
      try { st = m?.file?.path ? fs.lstatSync(m.file.path) : null; } catch {}
      if (!st || !st.isFile() || st.isSymbolicLink()) { reply(404, { error: "file unavailable" }); return true; }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(st.size) });
      fs.createReadStream(m.file.path).on("error", () => res.destroy()).pipe(res);
      return true;
    }
    if (req.method !== "POST") { reply(405, { error: "POST only" }); return true; }
    // whole buffers, decoded once: a multi-byte character split across chunks must not turn into U+FFFD
    const chunks = []; let size = 0;
    for await (const c of req) { chunks.push(c); size += c.length; if (size > MAX_BODY) { reply(413, { error: "body too large" }); return true; } }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { reply(400, { error: `bad JSON: ${e.message}` }); return true; }
    const T = remote ? null : tree();
    if (!provider?.chatOpen && !T) { reply(501, { error: `chat is Telegram-only for now (provider: ${provider?.name})` }); return true; }

    if (url.pathname === "/chat/register") {
      // a remote machine's token was checked by the remote listener; locally only the relay secret registers
      if (!remote && !sameSecret(bearer(req))) { reply(401, { error: "relay secret required (Authorization: Bearer <~/.myna/relay-secret>)" }); return true; }
      const sid = body.session_id ? (remote ? scope.sid(body.session_id) : String(body.session_id)) : "";
      if (!sid) { reply(400, { error: "session_id required" }); return true; }
      const s = sessions.get(sid) || { inbox: [], registered: new Date().toISOString() };
      if (T) {
        // the project stamp: from what the session froze at its start (remote, root), locked once set
        const pj = projectOf({ remote: body.project_remote, root: body.cwd });
        if (s.project && s.project !== pj.project) { log(`chat: session ${sid} registered again with project ${pj.project} — locked to ${s.project}, refused`); reply(409, { error: `project_locked: this session is ${s.project}` }); return true; }
        Object.assign(s, pj);
      }
      const reopened = !!s.closed;
      s.nick = uniqueNick(body.nick || s.nick, sid);
      if (body.label !== undefined) s.label = String(body.label).slice(0, 80);
      if (body.cwd !== undefined) s.cwd = String(body.cwd); // shown only — the hub never reads a remote path
      if (remote) s.machine_id = scope.id;
      s.machine = topicMachine(scope || null) || undefined;
      delete s.closed;
      sessions.set(sid, s);
      for (const [t, owner] of tokens) if (owner === sid) tokens.delete(t); // one live token per session
      const token = crypto.randomBytes(24).toString("hex");
      tokens.set(token, sid); lastSeen.set(sid, Date.now());
      save();
      if (T?.tokenDir) { try { writePrivate(path.join(T.tokenDir, sessionTokenName(sid)), `${token}\n`); } catch (e) { log("chat: could not write the session token file", e.message); } }
      let topic = null;
      if (provider?.chatOpen) { try { topic = await provider.chatOpen(sid, { nick: s.nick, label: s.label, machine: s.machine, reopened }); } catch (e) { log("chatOpen err", e.message); } }
      log(`chat: session ${sid} registered as ${s.nick}${reopened ? " (reopened)" : ""}${remote ? ` (machine ${scope.name})` : ""}`);
      const note = remote ? "" : registerNote();
      reply(200, { token, nick: s.nick, topic: topic ?? null, queued: s.inbox.length, ...(note ? { note } : {}) });
      return true;
    }

    const sid = tokens.get(remote ? String(req.headers[CHAT_TOKEN_HEADER] || "") : bearer(req));
    const s = sid && sessions.get(sid);
    // another machine's token is no token for this one
    if (!s || s.closed || (remote && s.machine_id !== scope.id)) { reply(401, { error: "unknown or expired token — register again", reregister: true }); return true; }
    lastSeen.set(sid, Date.now());

    if (url.pathname === "/chat/take") {
      // up to `max` messages at once (default 1): what piled up while the session was busy goes in as
      // one prompt; a slash command always goes on its own (it runs as a command, not as text)
      const max = Math.max(1, Math.min(50, Number(body.max) || 1));
      // wait_ms: nothing queued → hold until a message comes (or the time runs out); an edge relay polls
      // the hub this way instead of every 2 seconds. A caller that sends none is answered at once.
      const wait = Math.max(0, Math.min(TAKE_WAIT_MAX_MS, Number(body.wait_ms) || 0));
      // a remote batch stays until the edge acks it (its next take): the reply may never arrive
      if (remote && s.unacked?.length) {
        const ack = new Set(Array.isArray(body.ack) ? body.ack.map(String) : []);
        const left = s.unacked.filter((m) => !ack.has(m.id));
        if (left.length !== s.unacked.length) { s.unacked = left; save(); }
      }
      let gone = false;
      if (wait && !s.inbox.length && !s.unacked?.length) {
        let timer, wake;
        await new Promise((r) => {
          timer = setTimeout(r, wait); wake = r;
          if (!waiters.has(sid)) waiters.set(sid, new Set());
          waiters.get(sid).add(wake);
          res.on("close", () => { gone = !res.writableEnded; r(); }); // the caller gave up — stop holding
        });
        clearTimeout(timer); waiters.get(sid)?.delete(wake);
        if (gone || res.writableEnded) return true;
        if (!live(sid)) { reply(401, { error: "the session was closed", reregister: true }); return true; }
      }
      const again = remote && s.unacked?.length ? s.unacked : null;
      const out = again || takeBatch(s.inbox, max);
      if (remote && !again) s.unacked = out;
      if (out.length && !again) save();
      if (!again) for (const m of out) Promise.resolve(provider.chatTaken?.(sid, m)).catch((e) => log("chatTaken err", e.message));
      const view = remote ? (m) => takeRemote(m, body.files === true) : takeLocal;
      reply(200, { message: out[0] ? view(out[0]) : null, messages: out.map(view), queued: s.inbox.length });
      return true;
    }
    if (url.pathname === "/chat/progress") {
      if (!["start", "step", "done"].includes(body.event)) { reply(400, { error: "event must be start | step | done" }); return true; }
      if (remote) {
        // a remote session: at most progressPerSec posts a second (its edge merges what piled up and retries)
        const now = Date.now(), recent = (posts.get(sid) || []).filter((t) => now - t < 1000);
        if (recent.length >= progressPerSec) { posts.set(sid, recent); reply(429, { error: `too many progress posts (${progressPerSec} per second)`, retry_after_ms: Math.max(50, 1000 - (now - recent[0])) }); return true; }
        recent.push(now); posts.set(sid, recent);
      }
      // a person typed (terminal, or the phone): the tree's per-pair auto-reply count starts over
      if (body.event === "start" && (body.origin === "terminal" || body.origin === "phone")) T?.onHuman?.(sid);
      try { provider.chatProgress?.(sid, body, { cwd: s.cwd }); } catch (e) { log("chatProgress err", e.message); }
      reply(200, { ok: true, queued: s.inbox.length });
      return true;
    }
    if (url.pathname === "/chat/nick") {
      s.nick = uniqueNick(body.nick, sid); save();
      if (provider?.chatOpen) { try { await provider.chatOpen(sid, { nick: s.nick, label: s.label, machine: s.machine }); } catch (e) { log("chatOpen err", e.message); } }
      reply(200, { nick: s.nick });
      return true;
    }
    if (url.pathname === "/chat/close") {
      await closeSession(sid);
      reply(200, { closed: true });
      return true;
    }
    reply(404, { error: "unknown chat endpoint" });
    return true;
  }

  // the session ended: its topic is kept, marked 🔒; unread messages are dropped; a held take returns
  async function closeSession(sid, why = "closed") {
    const s = sessions.get(sid);
    if (!s || s.closed) return;
    s.closed = new Date().toISOString();
    const unread = s.inbox.length; s.inbox = []; delete s.unacked;
    for (const [t, owner] of tokens) if (owner === sid) tokens.delete(t);
    save();
    wakeTakers(sid);
    const T = tree();
    if (T?.tokenDir) { try { fs.rmSync(path.join(T.tokenDir, sessionTokenName(sid)), { force: true }); } catch {} }
    T?.onClose?.(sid);
    try { await provider.chatClose?.(sid); } catch (e) { log("chatClose err", e.message); }
    log(`chat: session ${sid} (${s.nick}) ${why}${unread ? ` — ${unread} unread message(s) dropped` : ""}`);
  }

  return {
    ctx, handle,
    secretOk: (t) => sameSecret(t), // the relay secret (an edge forwarding chat to its hub checks it too)
    sidOfToken: (t) => (t ? tokens.get(String(t)) || null : null), // a local session's own chat token → its id (/peer/send)
    attach(p) { provider = p; },
    count: () => [...sessions.values()].filter((s) => !s.closed).length,
    // a machine was revoked: every chat session of it ends (topics 🔒, inboxes cleared)
    async closeMachine(machineId) {
      for (const [sid, s] of sessions) if (!s.closed && s.machine_id === machineId) await closeSession(sid, "closed — its machine was revoked");
    },
  };
}
