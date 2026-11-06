// Chat through the hub (SPEC §5.2, 0.21.0) — an EDGE relay's /chat/* when the hub supports it.
//
// The local chat mod talks to this machine's relay exactly as on a single machine (POST /chat/register
// with the relay secret, then take / progress / nick / close with the per-session token it got). When
// the hub advertises features:["chat"] the edge relays all of it to the hub's remote port: the hub opens
// the session's topic on ITS bot ("<machine> · 💬 <nick> · <label>"), shows each turn's progress, and
// queues what the human types there for this machine. Two tokens per session: the local one the mod
// holds, and the hub's (X-Myna-Chat-Token on the remote port; Authorization carries the machine token).
// The mod never sees the hub's.
//   the human's words: a background long-poll per session (POST /chat/take {wait_ms, ack}) moves them from
//     the hub's inbox into a local one; the mod's /chat/take reads that (a "!command" still alone). The hub
//     hands a batch out again until the next take acks it (a reply cut on the way back loses nothing);
//     ids already taken are skipped
//   progress: sent in order, spaced under the hub's per-session limit (5 a second); a backlog merges
//     its steps; a 429 waits and retries
//   the hub away: register answers {topic:null, upstream:"down"} and the mod runs on; progress keeps only
//     the turn's latest state (start + the last step, or start + done — the hub shows one message per
//     turn anyway), at most 50 sessions × 32 KB; take answers what is already here plus upstream:"down".
//     Once the hub is back: registered again (same session id → same topic), the latest state sent, the
//     long-polls resumed. Nothing moves to this machine's own bot: one conversation stays in one place.
//   the hub restarted: its chat tokens are gone → a 401 with reregister:true → register again, resend
//   an edge restart: the sessions, their unread messages and unsent progress are in edge-state.json
//     (local tokens are not — the mod gets a 401 and registers again, as after any relay restart)
import crypto from "node:crypto";
import { CHAT_TOKEN_HEADER, takeBatch, takeView, normNick } from "./chat.mjs";

const MAX_BODY = 256 * 1024;
const POST_GAP_MS = 220;            // between two progress posts of one session: under the hub's 5 a second
const MERGE_BACKLOG = 8;            // more queued progress than this → consecutive steps are merged
const DOWN_SESSIONS = 50, DOWN_BYTES = 32 * 1024; // what is kept while the hub is away
const TAKE_WAIT_MS = 20000;         // the long-poll for the human's words
const LOCAL_IDLE_MS = 90000;        // a mod silent this long: stop pulling its messages (the hub may say it is unresponsive)

// hub: the edge's hub link (src/relay.mjs edgeLink): {url, reachable, headers(), markDown(), why(), failStatus()}
// secretOk(token): the relay secret check; save(): persist edge-state.json (it calls exportState)
export function createEdgeChat({ hub, log, secretOk, save }) {
  // sid -> {nick, label, cwd, topic, inbox, queue, closing?, ever?: registered at the hub once,
  //         remote?: hub token, registered?, pumping?, sending?, lastLocal, hubQueued}
  const sessions = new Map();
  const locals = new Map(); // local token -> sid (runtime)

  const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "") || [])[1] || "";
  const reply = (res, code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const down = () => !hub.reachable;
  const changed = () => save();

  // a call to the hub's remote /chat/* → {ok, status, json} | {ok:false} (unreachable, refused: the link is marked down)
  async function hubCall(p, body, chatToken, timeoutMs = 15000) {
    let r, json = null;
    try {
      r = await fetch(`${hub.url}${p}`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        headers: hub.headers({ "content-type": "application/json", ...(chatToken ? { [CHAT_TOKEN_HEADER]: chatToken } : {}) }),
        body: JSON.stringify(body ?? {}),
      });
      json = await r.json().catch(() => null);
    } catch (e) { hub.markDown(`cannot connect (${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message})`); return { ok: false }; }
    // a 401 about the chat token only (the hub restarted, or the session was closed there) is not the link's fault
    if (r.status === 401 && json?.reregister) return { ok: true, status: 401, json, reregister: true };
    if (hub.failStatus(r.status)) { hub.markDown(hub.why(r.status, json)); return { ok: false }; }
    return { ok: true, status: r.status, json };
  }

  async function register(sid) {
    const s = sessions.get(sid);
    if (!s || down()) return false;
    const r = await hubCall("/chat/register", { session_id: sid, nick: s.nick, label: s.label, cwd: s.cwd });
    if (!r.ok || r.status !== 200 || !r.json?.token) {
      if (r.ok) log(`edge chat: the hub refused to register ${sid} (HTTP ${r.status}${r.json?.error ? `: ${r.json.error}` : ""})`);
      return false;
    }
    Object.assign(s, { remote: r.json.token, nick: r.json.nick || s.nick, topic: r.json.topic ?? null, hubQueued: r.json.queued || 0, registered: true, ever: true });
    changed();
    pump(sid); flush(sid);
    return true;
  }

  // the human's words: keep a long-poll open at the hub while the mod is polling here
  async function pump(sid) {
    const s = sessions.get(sid);
    if (!s || s.pumping || s.closing || !s.registered || down() || Date.now() - s.lastLocal > LOCAL_IDLE_MS) return;
    s.pumping = true;
    try {
      while (sessions.get(sid) === s && !s.closing && s.registered && !down() && Date.now() - s.lastLocal < LOCAL_IDLE_MS) {
        const r = await hubCall("/chat/take", { max: 50, wait_ms: TAKE_WAIT_MS, ack: s.ack || [] }, s.remote, TAKE_WAIT_MS + 15000);
        if (!r.ok) break;
        if (r.reregister) { s.registered = false; if (!(await register(sid))) break; continue; }
        if (r.status !== 200) { log(`edge chat: take for ${sid} → HTTP ${r.status}`); break; }
        const got = Array.isArray(r.json?.messages) ? r.json.messages : [];
        s.hubQueued = r.json?.queued || 0;
        s.ack = got.map((m) => m.id);
        const fresh = got.filter((m) => !s.seen.includes(m.id));
        s.seen = [...s.seen, ...fresh.map((m) => m.id)].slice(-200);
        if (fresh.length) s.inbox.push(...fresh);
        if (got.length) changed();
      }
    } finally { s.pumping = false; }
  }

  // progress: what piles up while the hub is away is cut to the turn's latest state
  function compact(q) {
    let i = -1;
    for (let k = q.length - 1; k >= 0; k--) if (q[k].event === "start") { i = k; break; }
    const turn = i >= 0 ? q.slice(i) : q;
    const start = i >= 0 ? turn[0] : null;
    const done = [...turn].reverse().find((e) => e.event === "done");
    const step = [...turn].reverse().find((e) => e.event === "step");
    return [start, done || step].filter(Boolean);
  }
  const bytes = (q) => Buffer.byteLength(JSON.stringify(q));
  function trimDown() {
    for (const [sid, s] of sessions) {
      if (!s.queue.length) continue;
      s.queue = compact(s.queue);
      while (s.queue.length && bytes(s.queue) > DOWN_BYTES) { s.queue.shift(); log(`edge chat: ${sid}'s progress over ${DOWN_BYTES} bytes while the hub is away — dropping its oldest part`); }
    }
    const held = [...sessions].filter(([, s]) => s.queue.length);
    while (held.length > DOWN_SESSIONS) { const [sid, s] = held.shift(); s.queue = []; log(`edge chat: progress of over ${DOWN_SESSIONS} sessions held while the hub is away — dropping ${sid}'s`); }
  }
  const mergeSteps = (q) => {
    const out = [];
    for (const e of q) {
      const last = out[out.length - 1];
      if (e.event === "step" && last?.event === "step") {
        out[out.length - 1] = { event: "step", text: [last.text, e.text].filter((t) => t && String(t).trim()).join("\n"), tools: [...(last.tools || []), ...(e.tools || [])] };
      } else out.push(e);
    }
    return out;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function flush(sid) {
    const s = sessions.get(sid);
    if (!s || s.sending || !s.registered || down() || !s.queue.length) return;
    s.sending = true;
    try {
      while (sessions.get(sid) === s && s.queue.length && !down()) {
        if (s.queue.length > MERGE_BACKLOG) s.queue = mergeSteps(s.queue);
        const ev = s.queue[0];
        const r = await hubCall("/chat/progress", ev, s.remote);
        if (!r.ok) break;
        if (r.reregister) { s.registered = false; if (!(await register(sid))) break; continue; }
        if (r.status === 429) { await sleep(Math.max(50, Number(r.json?.retry_after_ms) || 500)); continue; }
        s.queue.shift(); changed();
        if (r.status !== 200) log(`edge chat: progress of ${sid} → HTTP ${r.status} (dropped)`);
        await sleep(POST_GAP_MS);
      }
    } finally {
      s.sending = false;
      if (down()) trimDown();
    }
  }

  async function finishClose(sid) {
    const s = sessions.get(sid);
    if (!s?.closing || down()) return;
    if (!s.ever) { sessions.delete(sid); changed(); return; } // the hub never heard of it
    if (!s.registered && !(await register(sid))) return;
    const r = await hubCall("/chat/close", {}, s.remote);
    if (r.ok) { sessions.delete(sid); changed(); }
  }

  // the hub is reachable again (or for the first time): catch up on everything held
  async function onUp() {
    for (const [sid, s] of [...sessions]) {
      if (down()) return;
      if (s.closing) { await finishClose(sid); continue; }
      if (!s.registered) await register(sid);
      else { pump(sid); flush(sid); }
    }
  }

  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/chat/session") {
      const s = sessions.get(url.searchParams.get("session_id") || "");
      reply(res, 200, { chat: !!s && !s.closing, ...(s ? { nick: s.nick } : {}) });
      return;
    }
    if (req.method !== "POST") return reply(res, 405, { error: "POST only" });
    const chunks = []; let size = 0;
    for await (const c of req) { chunks.push(c); size += c.length; if (size > MAX_BODY) return reply(res, 413, { error: "body too large" }); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return reply(res, 400, { error: `bad JSON: ${e.message}` }); }
    const p = url.pathname;

    if (p === "/chat/register") {
      if (!secretOk(bearer(req))) return reply(res, 401, { error: "relay secret required (Authorization: Bearer <~/.myna/relay-secret>)" });
      const sid = body.session_id ? String(body.session_id) : "";
      if (!sid) return reply(res, 400, { error: "session_id required" });
      const s = sessions.get(sid) || { inbox: [], queue: [], seen: [], lastLocal: Date.now() };
      s.nick = normNick(body.nick) || s.nick || "claude";
      if (body.label !== undefined) s.label = String(body.label).slice(0, 80);
      if (body.cwd !== undefined) s.cwd = String(body.cwd);
      delete s.closing; s.registered = false; s.lastLocal = Date.now();
      sessions.set(sid, s);
      for (const [t, owner] of locals) if (owner === sid) locals.delete(t); // one live token per session
      const token = crypto.randomBytes(24).toString("hex");
      locals.set(token, sid);
      changed();
      const up = await register(sid);
      log(`edge chat: session ${sid} registered as ${s.nick} — ${up ? `through the hub (topic ${s.topic ?? "none"})` : "the hub is away, it is registered there once it is back"}`);
      return reply(res, 200, { token, nick: s.nick, topic: s.topic ?? null, queued: s.inbox.length + (s.hubQueued || 0), ...(up ? {} : { upstream: "down" }) });
    }

    const sid = locals.get(bearer(req));
    const s = sid && sessions.get(sid);
    if (!s || s.closing) return reply(res, 401, { error: "unknown or expired token — register again" });
    s.lastLocal = Date.now();
    if (!down() && !s.registered) await register(sid);
    else pump(sid);
    const extra = down() ? { upstream: "down" } : {};

    if (p === "/chat/take") {
      const max = Math.max(1, Math.min(50, Number(body.max) || 1));
      const out = takeBatch(s.inbox, max);
      if (out.length) changed();
      return reply(res, 200, { message: out[0] ? takeView(out[0]) : null, messages: out.map(takeView), queued: s.inbox.length + (s.hubQueued || 0), ...extra });
    }
    if (p === "/chat/progress") {
      if (!["start", "step", "done"].includes(body.event)) return reply(res, 400, { error: "event must be start | step | done" });
      s.queue.push(body);
      if (down()) trimDown();
      changed();
      flush(sid);
      return reply(res, 200, { ok: true, queued: s.inbox.length + (s.hubQueued || 0), ...extra });
    }
    if (p === "/chat/nick") {
      if (s.registered && !down()) {
        const r = await hubCall("/chat/nick", { nick: body.nick }, s.remote);
        if (r.ok && r.status === 200 && r.json?.nick) { s.nick = r.json.nick; changed(); return reply(res, 200, { nick: s.nick }); }
      }
      // the hub away: the new nickname goes with the next registration there
      s.nick = normNick(body.nick) || s.nick; s.registered = false; changed();
      return reply(res, 200, { nick: s.nick, ...extra });
    }
    if (p === "/chat/close") {
      s.closing = true;
      for (const [t, owner] of locals) if (owner === sid) locals.delete(t);
      changed();
      await finishClose(sid);
      return reply(res, 200, { closed: true, ...(sessions.has(sid) ? { queued: true } : {}) });
    }
    return reply(res, 404, { error: "unknown chat endpoint" });
  }

  return {
    handle, onUp,
    count: () => [...sessions.values()].filter((s) => !s.closing).length,
    held: () => [...sessions.values()].reduce((n, s) => n + s.queue.length, 0),
    // edge-state.json: sessions, unread messages and unsent progress (no tokens)
    exportState: () => [...sessions].map(([sid, s]) => [sid, { nick: s.nick, label: s.label, cwd: s.cwd, topic: s.topic ?? null, inbox: s.inbox, queue: s.queue, seen: s.seen, ack: s.ack || [], ...(s.closing ? { closing: true } : {}), ...(s.ever ? { ever: true } : {}) }]),
    importState(list) {
      for (const [sid, v] of Array.isArray(list) ? list : []) {
        const list = (x) => (Array.isArray(x) ? x : []);
        sessions.set(String(sid), { nick: v.nick, label: v.label, cwd: v.cwd, topic: v.topic ?? null, inbox: list(v.inbox), queue: list(v.queue), seen: list(v.seen), ack: list(v.ack), ...(v.closing ? { closing: true } : {}), ...(v.ever ? { ever: true } : {}), lastLocal: Date.now() });
      }
      return sessions.size;
    },
  };
}
