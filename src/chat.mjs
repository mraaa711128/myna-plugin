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
//   POST /chat/take      Authorization: Bearer <token>  {max?}  → {message: {id, text, from, at} | null, messages: [...], queued}
//                        (up to `max` queued messages, default 1; a slash command "/name args" is always taken alone)
//   POST /chat/progress  Authorization: Bearer <token>  {event: "start", origin: "phone"|"terminal"|"background", prompt?, label?}
//        (terminal: the prompt typed there; background: a turn nobody typed, shown as the mod's one-line label)
//        | {event: "step", text?, tools?: [{name, input}]} | {event: "done", text?, interrupted?}
//   POST /chat/nick      Authorization: Bearer <token>  {nick} → {nick}
//   POST /chat/close     Authorization: Bearer <token>  → the session ended; its topic is kept, marked 🔒
//   GET  /chat/session?session_id=<sid> → {chat, nick?}  (no auth: the Stop hook asks whether a session chats)
// A per-session token scopes everything after registering: one session never reads another's inbox.
// Nicknames are unique among live sessions (a taken one gets a number: egret → egret2).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const NICK_MAX = 24;
// "!name args" (or full-width "！name") — a command typed on the phone (run as a command in the session,
// never batched with text)
export const isCommand = (t) => /^[!！][^\s/!！]+(?:\s|$)/.test(String(t ?? "").trim());
// "/name args" — a Telegram bot command: Myna takes none (Telegram may open a topic of its own for one),
// so the Telegram provider does not forward it to a session; it tells the human to type "!name" instead
export const isSlashCommand = (t) => /^\/[\w:.-]+(?:\s|$)/.test(String(t ?? "").trim());
export const normNick = (n) => String(n ?? "").trim().toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_-]/g, "").slice(0, NICK_MAX);

export function createChat({ cfg, log, dir }) {
  const SECRET_FILE = cfg.MYNA_RELAY_SECRET_FILE || path.join(dir, "relay-secret");
  const FILE = cfg.MYNA_CHAT_FILE || path.join(dir, "chat-sessions.json");
  // a session that has not polled for this long is probably stuck or gone — the sender is told
  const STALE_MS = Number(cfg.MYNA_CHAT_STALE_MS || 90000);
  const KEEP_CLOSED_MS = 7 * 24 * 3600 * 1000; // an ended session's record (nick, topic) for a resume
  const MAX_BODY = 256 * 1024;

  const secret = loadSecret();
  // sid -> {nick, label, cwd, registered, closed?, inbox: [{id, text, from, at, chat, message_id}]}
  const sessions = load();
  const tokens = new Map();   // token -> sid (runtime only: after a relay restart the session registers again)
  const lastSeen = new Map(); // sid -> last take/progress (runtime)
  const staleNoticed = new Map(); // sid -> when the sender was last told the session is unresponsive
  let provider = null;

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
    byNick: (nick) => { const n = normNick(nick); for (const [sid, s] of sessions) if (!s.closed && s.nick === n) return sid; return null; },
    // queue a message for the session → {queued, closed?, stale?} (stale: say so to the sender, once in a while)
    deliver(sid, m) {
      const s = sessions.get(sid);
      if (!s) return { closed: true };
      if (s.closed) return { closed: true, nick: s.nick };
      s.inbox.push({ id: crypto.randomBytes(4).toString("hex"), at: new Date().toISOString(), ...m });
      save();
      const seen = lastSeen.get(sid) || 0, told = staleNoticed.get(sid) || 0;
      const stale = Date.now() - seen > STALE_MS && Date.now() - told > STALE_MS;
      if (stale) staleNoticed.set(sid, Date.now());
      log(`chat: message queued for ${s.nick} (${s.inbox.length} waiting)`);
      return { queued: s.inbox.length, nick: s.nick, stale };
    },
  };

  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/chat/")) return false;
    const reply = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "GET" && url.pathname === "/chat/session") {
      const sid = url.searchParams.get("session_id") || "";
      const s = sessions.get(sid);
      reply(200, { chat: live(sid), ...(s ? { nick: s.nick } : {}) });
      return true;
    }
    if (req.method !== "POST") { reply(405, { error: "POST only" }); return true; }
    // whole buffers, decoded once: a multi-byte character split across chunks must not turn into U+FFFD
    const chunks = []; let size = 0;
    for await (const c of req) { chunks.push(c); size += c.length; if (size > MAX_BODY) { reply(413, { error: "body too large" }); return true; } }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { reply(400, { error: `bad JSON: ${e.message}` }); return true; }
    if (!provider?.chatOpen) { reply(501, { error: `chat is Telegram-only for now (provider: ${provider?.name})` }); return true; }

    if (url.pathname === "/chat/register") {
      if (!sameSecret(bearer(req))) { reply(401, { error: "relay secret required (Authorization: Bearer <~/.myna/relay-secret>)" }); return true; }
      const sid = body.session_id ? String(body.session_id) : "";
      if (!sid) { reply(400, { error: "session_id required" }); return true; }
      const s = sessions.get(sid) || { inbox: [], registered: new Date().toISOString() };
      const reopened = !!s.closed;
      s.nick = uniqueNick(body.nick || s.nick, sid);
      if (body.label !== undefined) s.label = String(body.label).slice(0, 80);
      if (body.cwd !== undefined) s.cwd = String(body.cwd);
      delete s.closed;
      sessions.set(sid, s);
      for (const [t, owner] of tokens) if (owner === sid) tokens.delete(t); // one live token per session
      const token = crypto.randomBytes(24).toString("hex");
      tokens.set(token, sid); lastSeen.set(sid, Date.now());
      save();
      let topic = null;
      try { topic = await provider.chatOpen(sid, { nick: s.nick, label: s.label, reopened }); } catch (e) { log("chatOpen err", e.message); }
      log(`chat: session ${sid} registered as ${s.nick}${reopened ? " (reopened)" : ""}`);
      reply(200, { token, nick: s.nick, topic: topic ?? null, queued: s.inbox.length });
      return true;
    }

    const sid = tokens.get(bearer(req));
    const s = sid && sessions.get(sid);
    if (!s || s.closed) { reply(401, { error: "unknown or expired token — register again" }); return true; }
    lastSeen.set(sid, Date.now());

    if (url.pathname === "/chat/take") {
      // up to `max` messages at once (default 1): what piled up while the session was busy goes in as
      // one prompt; a slash command always goes on its own (it runs as a command, not as text)
      const max = Math.max(1, Math.min(50, Number(body.max) || 1));
      const out = [];
      while (s.inbox.length && out.length < max) {
        if (out.length && isCommand(s.inbox[0].text)) break;
        const m = s.inbox.shift();
        out.push(m);
        if (isCommand(m.text)) break;
      }
      if (out.length) save();
      for (const m of out) Promise.resolve(provider.chatTaken?.(sid, m)).catch((e) => log("chatTaken err", e.message));
      const view = (m) => ({ id: m.id, text: m.text, from: m.from, at: m.at });
      reply(200, { message: out[0] ? view(out[0]) : null, messages: out.map(view), queued: s.inbox.length });
      return true;
    }
    if (url.pathname === "/chat/progress") {
      if (!["start", "step", "done"].includes(body.event)) { reply(400, { error: "event must be start | step | done" }); return true; }
      try { provider.chatProgress(sid, body, { cwd: s.cwd }); } catch (e) { log("chatProgress err", e.message); }
      reply(200, { ok: true, queued: s.inbox.length });
      return true;
    }
    if (url.pathname === "/chat/nick") {
      s.nick = uniqueNick(body.nick, sid); save();
      try { await provider.chatOpen(sid, { nick: s.nick, label: s.label }); } catch (e) { log("chatOpen err", e.message); }
      reply(200, { nick: s.nick });
      return true;
    }
    if (url.pathname === "/chat/close") {
      s.closed = new Date().toISOString();
      const unread = s.inbox.length; s.inbox = [];
      for (const [t, owner] of tokens) if (owner === sid) tokens.delete(t);
      save();
      try { await provider.chatClose?.(sid); } catch (e) { log("chatClose err", e.message); }
      log(`chat: session ${sid} (${s.nick}) closed${unread ? ` — ${unread} unread message(s) dropped` : ""}`);
      reply(200, { closed: true });
      return true;
    }
    reply(404, { error: "unknown chat endpoint" });
    return true;
  }

  return {
    ctx, handle,
    attach(p) { provider = p; },
    count: () => [...sessions.values()].filter((s) => !s.closed).length,
  };
}
