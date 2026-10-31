#!/usr/bin/env node
// Myna relay — one per machine. Owns the single IM connection through exactly ONE provider
// (Telegram getUpdates / Discord Gateway / Slack Socket Mode; see src/providers/*) and exposes
// HTTP for callers: POST /ask -> {request_id}; GET /answer/<id> (bounded long-poll) -> result.
// The provider sends the question to the phone (numbered options in body + [1][2..][✍️][⏹]
// buttons) and calls back resolve() with the discriminated result:
//   button number -> {kind:"selection", value}
//   ✍️            -> {kind:"message", text}
//   ⏹            -> {kind:"aborted"}
// POST /session/close {session_id} tells the provider a Claude session ended (telegram closes its topic).
// While a gate of that session is still open (another MCP process sharing the Claude session id is
// waiting on it) the close is deferred until the last one resolves — a topic is never ended under
// an unanswered question.
// POST /cancel/<id>: the asking side gave up on a request (answered in the terminal / Esc, or its MCP
// process is exiting) → the provider retracts the phone's buttons, the request resolves {kind:"cancelled"}.
// POST /session/round-end {session_id}: the Claude session finished its reply (Stop hook). A round
// is over only then — within one reply the AI may take an answer, work, and come back with the next
// question. If none of that session's gates is still open
// → provider.endRound(session_id) (telegram ends the gate's topic; the next question opens a fresh one).
// GET /health -> {version, provider, pid, pending, handoff, net_attempt_ms…}: lets ensure-relay replace a relay from an older plugin version.
// /chat/*: a session registered as a chatbot (nickname, its own topic, an inbox, one progress message
// per turn) — see src/chat.mjs. Telegram only for now.
// Session handoff (detach / reattach): one session gives an open question away, another takes it over —
// the phone's message, buttons and topic stay exactly as they are.
// POST /detach/<id> {session_id}: the owning session hands the request off. The relay stops
//   delivering its answer to /answer pollers (they get {kind:"detached"} at once, the answer — if one
//   comes — is kept), the owner's exit no longer cancels it, and it expires after MYNA_DETACH_TTL
//   seconds (default 1800) unless reattached: open → cancelled like any other (buttons retracted),
//   answered-uncollected → dropped.
// POST /reattach/<id> {session_id, session_name}: take it over — allowed for a detached request, or for
//   the same session id when no process is polling it (a reconnected session picking up what its dead
//   process left). The request and its topic move to the new session; /answer then works as usual.
// GET /requests?session_id=<sid>: the session's open requests ({request_id, gate, thread_id, header,
//   question, detached, attended}) — how a reconnected session finds what is still waiting for it.
// Approval attestation: an /ask carrying `approves` (the one command line a ✅ option lets run)
//   records an approval {request_id, session_id, command (normalized), chosen, answered_at} ONLY when the
//   human taps THE option starting with ✅ on the IM (provider callback; /ask allows exactly one such
//   option and no invisible/control characters in `approves`) — never for a cancel, a terminal
//   answer, a ✍️ reply or another option. A guard (e.g. a PreToolUse hook) then asks
// POST /attest {command, session_id} → {approved:true, request_id, answered_at, chosen} for a matching
//   unused approval of that session no older than MYNA_APPROVAL_TTL_MS (default 15 min) — marked used in
//   the same synchronous step, so each approval lets exactly one command through — else
//   {approved:false, reason}. Approvals live ONLY in this process's memory: never written to the
//   journal, never read back from it — the journal is a file the agent can write, so anything adopted
//   from it could be forged. A relay restart drops every approval (the human taps ✅ again).
// Open gates survive a relay restart/upgrade: every mutation of the pending table (and of the provider's
// button-token state) is written through to ~/.myna/relay-pending.json; a fresh relay adopts it on start,
// so buttons already on the phone keep working and the client's /answer poll simply resumes.
// No npm deps (Node 18+ for telegram; 22+ for discord/slack — built-in WebSocket).
// Reads config from ~/.myna/.env (stable per-user location — survives plugin updates).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as telegram from "./providers/telegram.mjs";
import * as discord from "./providers/discord.mjs";
import * as slack from "./providers/slack.mjs";
import { validateAskArgs, normalizeCommand, isApproveOption, approveOptionOf } from "./providers/util.mjs";
import { createChat } from "./chat.mjs";
import { applyNetAttemptTimeout } from "./net.mjs";

const PROVIDERS = [telegram, discord, slack]; // auto-pick order when MYNA_PROVIDER is unset

// Own version (from the plugin's package.json) — reported on GET /health so ensure-relay can tell
// whether the process holding the port is THIS plugin version or a stale one left over from before
// an upgrade (the port being answered used to be the only check, so an old relay was never replaced).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } })();
const STARTED_AT = new Date().toISOString();

const ENV_PATH = process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env");
const fileEnv = Object.fromEntries(
  (fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const cfg = { ...fileEnv, ...process.env, MYNA_ENV: ENV_PATH }; // process.env wins (same precedence as before)
const PORT = Number(cfg.RELAY_PORT || 7800);
// bounded long-poll: how long /answer holds a socket before returning {kind:"pending"} so the
// client re-polls on a FRESH socket. Keeps every socket well under undici's 300s headersTimeout
// (the default that silently killed the old unbounded /answer wait → "fetch failed" → fallback).
const ANSWER_HOLD_MS = Number(cfg.MYNA_ANSWER_HOLD_MS || 25000);
const log = (...a) => console.error(`[relay ${new Date().toISOString()}]`, ...a);
// how long each address gets to connect (Happy Eyeballs) — before any provider call goes out (src/net.mjs)
const NET_ATTEMPT_MS = applyNetAttemptTimeout(cfg, log);
// journal of open gates (write-through) — next to .env so it survives plugin updates like the topics map
const PENDING_FILE = cfg.MYNA_PENDING_FILE || path.join(path.dirname(ENV_PATH), "relay-pending.json");
// how long a detached request waits for another session to reattach it. Covers the gap between hand-off
// and take-over (a planned handoff takes well under a minute; a crashed session restarted by a supervisor
// ~10 min worst case; a human reopening one by hand a few to ~15 min) with room to spare: too short and
// it expires before the new session arrives (an answer the human already gave is lost), too long and
// buttons nobody collects stay on the phone.
const DETACH_TTL_MS = (() => {
  const v = String(cfg.MYNA_DETACH_TTL ?? "1800").trim(), n = Number(v);
  if (v === "" || !Number.isFinite(n) || n <= 0) { log(`MYNA_DETACH_TTL="${v}" is not a positive number of seconds — using 1800`); return 1800000; }
  return n * 1000;
})();
// a request counts as attended (some process is waiting on it) while an /answer poll is held, or for
// this long after the last one ended — the client re-polls at once, or retries for ~8s across a relay swap
const ATTENDED_GRACE_MS = Number(cfg.MYNA_ATTENDED_GRACE_MS || 15000);
// an open request nobody has polled for, older than this, is an orphan: its asker is gone (a session
// that ended without cancelling, or one from before the journal kept session ids) and it would
// otherwise be carried across every restart forever. Seconds; 0 = never reap. Detached requests have
// their own expiry and are left to it.
const ORPHAN_TTL_MS = (() => {
  const v = String(cfg.MYNA_ORPHAN_TTL ?? "86400").trim(), n = Number(v);
  if (v === "" || !Number.isFinite(n) || n < 0) { log(`MYNA_ORPHAN_TTL="${v}" is not a number of seconds — using 86400`); return 86400000; }
  return n * 1000;
})();
// how long a ✅ approval stays usable for /attest (ms). Long enough to go from the answer to running
// the command; short enough that an approval nobody used does not linger.
const APPROVAL_TTL_MS = (() => {
  const v = String(cfg.MYNA_APPROVAL_TTL_MS ?? "900000").trim(), n = Number(v);
  if (v === "" || !Number.isFinite(n) || n <= 0) { log(`MYNA_APPROVAL_TTL_MS="${v}" is not a positive number of ms — using 900000`); return 900000; }
  return n;
})();

// pick the provider: explicit MYNA_PROVIDER, else the first configured one
const want = String(cfg.MYNA_PROVIDER || "").trim().toLowerCase();
let mod;
if (want) {
  mod = PROVIDERS.find((p) => p.name === want);
  if (!mod) { log(`unknown MYNA_PROVIDER "${want}" — use telegram | discord | slack`); process.exit(1); }
  if (!mod.configured(cfg) && !mod.pairable?.(cfg)) { log(`MYNA_PROVIDER=${want} but its keys are missing in ${ENV_PATH} — see .env.example`); process.exit(1); }
} else {
  // a fully configured provider first; else one that only waits to be paired (telegram: token, no chat yet)
  mod = PROVIDERS.find((p) => p.configured(cfg)) || PROVIDERS.find((p) => p.pairable?.(cfg));
  if (!mod) { log(`no IM provider configured (telegram/discord/slack keys all missing in ${ENV_PATH}) — see .env.example`); process.exit(1); }
}

// state
// request_id -> {promise, resolve, result?, resolvedAt?, created, session_id?, meta?, detached?}
//   meta = {gate, thread_id, header, question, options} of the ask (what a session taking it over needs);
//   detached = {at, until, by} while handed off; runtime only: wake (held /answer polls to interrupt),
//   holders (polls held now), lastPoll (when the last one ended), expiry (detach TTL timer)
const pending = new Map();
const closing = new Set(); // session ids whose /session/close waits for their open gates
const openFor = (sid) => [...pending.values()].some((q) => q.session_id === sid && q.result === undefined);
const attended = (p) => p.holders > 0 || Date.now() - (p.lastPoll || 0) < ATTENDED_GRACE_MS;
// request_id -> {request_id, session_id, command, chosen, answered_at, used_at?} (see POST /attest).
// In memory only — deliberately NOT part of the journal (see persist / adopt).
const approvals = new Map();
// kind: "permission" marks a Claude Code permission prompt forwarded by the PermissionRequest hook
// approves: the command a ✅ option of this ask approves — informational only (journal, /requests,
// detach info); an approval is recorded from the runtime-only entry.approves, never from meta
const META_KEYS = ["gate", "thread_id", "header", "question", "options", "kind", "questionNumber", "questionTotal", "approves"];
const metaOf = (args) => Object.fromEntries(META_KEYS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

// --- journal (handoff across restarts / upgrades) ---------------------------------------------
// Serialises the pending table + whatever the provider needs to keep its already-sent buttons valid
// (callback tokens, ✍️ waiters, reply anchors). Called on every mutation — a few writes per hour.
// The ✅ approvals are left out on purpose: the journal is agent-writable.
function persist() {
  try {
    const requests = {};
    for (const [id, p] of pending) requests[id] = {
      created: p.created, ...(p.session_id ? { session_id: p.session_id } : {}), ...(p.meta ? { meta: p.meta } : {}),
      ...(p.detached ? { detached: p.detached } : {}), ...(p.result !== undefined ? { result: p.result, resolvedAt: p.resolvedAt } : {}),
    };
    const doc = { version: VERSION, saved_at: new Date().toISOString(), requests, closing: [...closing], provider: provider?.exportState?.() ?? null };
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    // atomic: write a temp file, then rename over the journal — a reader (or a crash mid-write) never
    // sees a truncated journal. Windows may refuse the rename while a reader holds the file → plain write.
    const tmp = `${PENDING_FILE}.${process.pid}.tmp`, text = JSON.stringify(doc, null, 2);
    fs.writeFileSync(tmp, text);
    try { fs.renameSync(tmp, PENDING_FILE); } catch { fs.writeFileSync(PENDING_FILE, text); try { fs.unlinkSync(tmp); } catch {} }
  } catch (e) { log("journal: could not persist", PENDING_FILE, e.message); }
}
function newEntry(created = Date.now(), session_id, meta) {
  let resolveFn; const promise = new Promise((r) => (resolveFn = r));
  return { promise, resolve: resolveFn, created, wake: new Set(), holders: 0, lastPoll: Date.now(), ...(session_id ? { session_id: String(session_id) } : {}), ...(meta ? { meta } : {}) };
}

// --- detach expiry ---------------------------------------------------------------------------
function armExpiry(id, p) {
  clearTimeout(p.expiry);
  p.expiry = setTimeout(() => expireDetached(id), Math.max(0, p.detached.until - Date.now()));
  p.expiry.unref?.();
}
// A forwarded permission prompt is over once its session's turn ends or the session does: no dialog
// outlives either. Its hook retracts it itself (terminal answered, or the hook was stopped), so this
// is the safety net for one that could not — it must never hold a topic or a deferred close open.
function cancelPermissions(sid, why) {
  for (const [id, p] of pending) {
    if (p.session_id !== sid || p.result !== undefined || p.meta?.kind !== "permission") continue;
    log(`request ${id}: permission prompt still open at ${why} — cancelling`);
    Promise.resolve(provider.cancelQuestion?.(id)).catch((e) => log("cancelQuestion err", e.message));
    resolveRequest(id, { kind: "cancelled", reason: why });
  }
}
// nobody took the request over in time → the normal rules apply as if its owner had ended:
// open → cancelled (phone's buttons retracted), answered-uncollected → dropped
function expireDetached(id) {
  const p = pending.get(id);
  if (!p?.detached) return;
  delete p.detached;
  if (p.result === undefined) {
    log(`request ${id}: detached and not reattached within ${DETACH_TTL_MS / 1000}s — cancelling`);
    Promise.resolve(provider.cancelQuestion?.(id, "expired")).catch((e) => log("cancelQuestion err", e.message));
    resolveRequest(id, { kind: "cancelled", reason: "detach expired" });
    pending.delete(id); persist();               // its owner is gone and nobody took it over: no one will collect it
  } else {
    log(`request ${id}: detached, answered, not reattached within ${DETACH_TTL_MS / 1000}s — answer dropped`);
    pending.delete(id); persist(); closeIfDue(p.session_id);
  }
}
// adopt a previous relay's journal: rebuilds the pending table (answers already given but not yet
// collected included) and hands the provider its token state back. Returns counts for the log.
function adopt() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")); } catch { return null; }
  let open = 0, answered = 0;
  const detached = [];
  for (const [id, r] of Object.entries(doc.requests || {})) {
    const e = newEntry(r.created || Date.now(), r.session_id, r.meta);
    if (r.result !== undefined) { e.result = r.result; e.resolvedAt = Date.now(); e.resolve(r.result); answered++; } // fresh TTL — give the client time to collect
    else open++;
    pending.set(id, e);
    if (r.detached) { e.detached = r.detached; detached.push(id); }
  }
  for (const sid of doc.closing || []) closing.add(sid);
  // an `approvals` field (written by an early development build, or planted by hand) is ignored on purpose:
  // the journal is agent-writable, so an approval read from it could be forged — approvals exist only
  // in the memory of the relay that saw the human's tap
  if (doc.approvals !== undefined) log("journal: ignoring its `approvals` field — approvals are never adopted from the journal");
  try { if (doc.provider && provider?.importState) provider.importState(doc.provider); } catch (e) { log("journal: provider state not adopted:", e.message); }
  for (const id of detached) armExpiry(id, pending.get(id)); // remaining time, or now if overdue
  return { open, answered, detached: detached.length, from: doc.version, saved_at: doc.saved_at };
}

// --- approvals ---------------------------------------------------------------------------------
// an unparseable answered_at counts as expired — fail closed
const approvalExpired = (a, now = Date.now()) => { const t = Date.parse(a.answered_at); return !Number.isFinite(t) || now - t > APPROVAL_TTL_MS; };
// The ONLY way an approval comes into being: the provider reports a human's button tap on the IM. The
// relay's own resolutions (cancel / terminal answer / unreachable / expiry) go straight to
// resolveRequest and never record one; neither does a ✍️ reply or an option without ✅.
// The command comes from p.approves, set by /ask in THIS process and never journaled: a question
// adopted from the journal (asked before a restart) records nothing even when its ✅ is tapped —
// otherwise an edited journal could pair a button the human sees with a different command.
function resolveFromIM(request_id, result) {
  const p = pending.get(request_id);
  const cmd = p?.approves;
  // the tapped option must be THE ✅ option of this question (set by /ask in this process), not
  // merely one starting with ✅
  if (p && p.result === undefined && result?.kind === "selection" && typeof cmd === "string" && cmd && isApproveOption(result.value)
    && typeof p.approveOption === "string" && result.value === p.approveOption && p.session_id) {
    approvals.set(request_id, { request_id, session_id: p.session_id, command: cmd, chosen: result.value, answered_at: new Date().toISOString() });
    log(`request ${request_id}: ✅ approval recorded for session ${p.session_id} (usable once, ${APPROVAL_TTL_MS / 1000}s)`);
  }
  resolveRequest(request_id, result);
}

// reap answered entries the client never came back to collect (e.g. it fell back / died mid-wait).
// unanswered entries are left alone — the human may still answer later — until they turn orphan
// (ORPHAN_TTL_MS old and nobody polling): then cancelled like an expired detach, buttons retracted.
// A detached answer waits for its new session until the detach expires (expireDetached drops it then).
function sweep() {
  const now = Date.now();
  let swept = 0;
  for (const [id, p] of pending) {
    if (p.detached) continue;
    if (p.result !== undefined) { if (now - p.resolvedAt > 300000) { pending.delete(id); swept++; } continue; }
    if (ORPHAN_TTL_MS > 0 && now - p.created > ORPHAN_TTL_MS && !attended(p)) {
      log(`request ${id}: open for ${Math.round((now - p.created) / 3600000)}h with nobody waiting on it — cancelling as orphaned`);
      Promise.resolve(provider.cancelQuestion?.(id, "orphaned")).catch((e) => log("cancelQuestion err", e.message));
      resolveRequest(id, { kind: "cancelled", reason: "orphaned" });
      pending.delete(id); swept++;              // nobody will collect it
    }
  }
  if (swept) persist();
  for (const [id, a] of approvals) if (approvalExpired(a, now)) approvals.delete(id); // used or not, past its TTL it can never attest (memory only — nothing to persist)
}
setInterval(sweep, Number(cfg.MYNA_SWEEP_MS || 60000)).unref();

function resolveRequest(request_id, result) {
  const p = pending.get(request_id);
  if (!p || p.result !== undefined) return;   // unknown, or already answered
  // Keep the entry (do NOT delete here): with bounded long-poll the client may be between polls
  // when the human answers, so the result must survive until a re-poll collects it. The /answer
  // handler deletes it on delivery; the TTL sweep reaps any that are never collected.
  p.result = result;
  p.resolvedAt = Date.now();
  provider.onResolve?.(request_id, result);   // provider drops its callback tokens for this request
  log(`resolve ${request_id} -> ${JSON.stringify(result)}`);
  persist();                                   // the answer must survive a restart until the client collects it
  p.resolve(result);                           // wake any /answer waiter currently holding
  closeIfDue(p.session_id);
}
// a deferred /session/close runs once the session has no open gate left
function closeIfDue(sid) {
  if (!sid || !closing.has(sid) || openFor(sid)) return;
  closing.delete(sid); persist();
  log(`session ${sid}: last open gate resolved — running the deferred close`);
  Promise.resolve(provider.closeSession?.(sid)).catch((e) => log("closeSession err", e.message));
}

// chat: sessions registered as chatbots (src/chat.mjs) — /chat/* endpoints, routed before everything else
const chat = createChat({ cfg, log, dir: path.dirname(ENV_PATH) });
let provider;
try { provider = mod.create(cfg, { resolve: resolveFromIM, log, persist, chat: chat.ctx }); }
catch (e) { log(e.message); process.exit(1); }
chat.attach(provider);
const adopted = adopt();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (await chat.handle(req, res, url)) return;
  if (req.method === "GET" && url.pathname === "/health") {
    // identity + liveness for ensure-relay / `/myna:relay status`. `pending` = gates still waiting
    // for a human answer (ensure-relay will not replace a stale relay while one is open).
    let open = 0; for (const p of pending.values()) if (p.result === undefined) open++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "myna-relay", version: VERSION, provider: provider.name, pid: process.pid, root: ROOT, started_at: STARTED_AT, pending: open, detached: [...pending.values()].filter((p) => p.detached).length, handoff: true, attest: true, approval_ttl_ms: APPROVAL_TTL_MS, journal: PENDING_FILE, chat: !!provider.chatOpen, chat_sessions: chat.count(), net_attempt_ms: NET_ATTEMPT_MS }));
    return;
  }
  // pairing (Telegram): /myna:pair asks for a one-time code; the human sends `/pair <code>` from the
  // chat to bind. Discord/Slack bind by the channel id given to /myna:configure — nothing to pair.
  if ((req.method === "POST" && url.pathname === "/pair/start") || (req.method === "GET" && url.pathname === "/pair/status")) {
    res.writeHead(provider.startPairing ? 200 : 400, { "content-type": "application/json" });
    if (!provider.startPairing) { res.end(JSON.stringify({ error: `pairing is Telegram-only — ${provider.name} uses the channel id given to /myna:configure` })); return; }
    res.end(JSON.stringify(url.pathname === "/pair/start" ? provider.startPairing() : provider.pairStatus()));
    return;
  }
  if (req.method === "POST" && url.pathname === "/shutdown") {
    res.writeHead(200); res.end("bye"); log("shutdown requested"); setTimeout(() => process.exit(0), 50); return;
  }
  if (req.method === "POST" && url.pathname === "/session/close") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let sid; try { sid = JSON.parse(body || "{}").session_id; } catch {}
      sid = sid ? String(sid) : "";
      if (sid) cancelPermissions(sid, "session end");
      if (sid && openFor(sid)) {
        closing.add(sid); persist();
        log(`session ${sid} closed with open gate(s) — its topics stay until they are answered`);
      } else if (sid && provider.closeSession) { try { await provider.closeSession(sid); } catch (e) { log("closeSession err", e.message); } }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/session/round-end") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let sid; try { sid = JSON.parse(body || "{}").session_id; } catch {}
      sid = sid ? String(sid) : "";
      if (sid) cancelPermissions(sid, "round end");
      // a gate of this session still waiting (e.g. a background subagent's) → the round is not over
      const open = sid && [...pending.values()].some((q) => q.session_id === sid && q.result === undefined);
      if (sid && !open && provider.endRound) { try { provider.endRound(sid); } catch (e) { log("endRound err", e.message); } }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ended: !!sid && !open }));
    });
    return;
  }
  // /attest: a guard asks whether the human approved exactly this command for this session. Everything
  // after the body is read runs synchronously — look up and mark used in one step, so two concurrent
  // attests for one approval can never both get approved:true (the relay is a single process).
  if (req.method === "POST" && url.pathname === "/attest") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      let a; try { a = JSON.parse(body || "{}"); } catch { return reply(400, { approved: false, reason: "bad_json" }); }
      if (typeof a?.command !== "string" || !a.command.trim()) return reply(400, { approved: false, reason: "command_required" });
      if (typeof a.session_id !== "string" || !a.session_id) return reply(400, { approved: false, reason: "session_id_required" });
      const command = normalizeCommand(a.command), now = Date.now();
      let hit, used = false, expired = false;
      for (const ap of approvals.values()) {
        if (ap.session_id !== a.session_id || ap.command !== command) continue;
        if (ap.used_at) { used = true; continue; }
        if (approvalExpired(ap, now)) { expired = true; continue; }
        if (!hit || Date.parse(ap.answered_at) < Date.parse(hit.answered_at)) hit = ap; // oldest first: it expires first
      }
      if (!hit) {
        const reason = expired ? "expired" : used ? "already_used" : "no_approval";
        log(`attest denied (${reason}) for session ${a.session_id}`);
        return reply(200, { approved: false, reason });
      }
      hit.used_at = new Date(now).toISOString(); // in memory only: a restart forgets it along with the approval itself
      log(`attest approved: request ${hit.request_id} (session ${a.session_id}) — approval now used`);
      return reply(200, { approved: true, request_id: hit.request_id, answered_at: hit.answered_at, chosen: hit.chosen });
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/ask") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let args;
      try { args = JSON.parse(body || "{}"); } catch (e) {
        res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `bad JSON: ${e.message}` })); return;
      }
      // Second line of defense — never ship a button-less menu / markup residue to the phone.
      const problems = validateAskArgs(args);
      if (problems.length) {
        log("rejecting /ask (400):", problems.join("; "));
        res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: problems.join("; ") })); return;
      }
      const request_id = crypto.randomBytes(5).toString("hex");
      const entry = newEntry(Date.now(), args.session_id, metaOf(args));
      // runtime only (persist() never writes it): the command a ✅ tap on THIS question approves
      // and the one ✅ option whose tap approves it (validateAskArgs allows exactly one)
      if (typeof args.approves === "string") { entry.approves = normalizeCommand(args.approves); entry.approveOption = approveOptionOf(args.options); }
      pending.set(request_id, entry);
      // sendQuestion throws when the question/keyboard could not be delivered to the phone (after the
      // provider's own transient retries). Resolve the request as {kind:"unreachable"} so the client's
      // /answer poll returns immediately and the orchestrator falls back to the local picker — instead
      // of polling forever for an answer to a message the human never received (retro: this was
      // logged-and-absorbed, so the 3-layer fallback never fired). request_id is still returned so the
      // client has something to poll and collect the unreachable verdict.
      try { await provider.sendQuestion(request_id, args); persist(); } // buttons are on the phone → journal them
      catch (e) {
        log("sendQuestion delivery failed — resolving unreachable:", e.message);
        resolveRequest(request_id, { kind: "unreachable", error: `question delivery failed: ${e.message}` });
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ request_id }));
    });
    return;
  }
  const cm = url.pathname.match(/^\/cancel\/([a-f0-9]+)$/);
  if (req.method === "POST" && cm) {
    const entry = pending.get(cm[1]);
    const open = !!entry && entry.result === undefined;
    if (open) {
      Promise.resolve(provider.cancelQuestion?.(cm[1])).catch((e) => log("cancelQuestion err", e.message)); // reads its state synchronously, before resolve drops it
      resolveRequest(cm[1], { kind: "cancelled" });
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ cancelled: open }));
    return;
  }
  const m = url.pathname.match(/^\/answer\/([a-f0-9]+)$/);
  if (req.method === "GET" && m) {
    const entry = pending.get(m[1]);
    if (!entry) { res.writeHead(404); res.end('{"error":"no such request"}'); return; }
    const json = { "content-type": "application/json" };
    // handed off: the answer (now or later) belongs to whoever reattaches it — never deliver it here
    const detachedReply = () => JSON.stringify({ kind: "detached", request_id: m[1], until: new Date(entry.detached.until).toISOString() });
    if (entry.detached) { res.writeHead(200, json); res.end(detachedReply()); return; }
    // already answered (human replied while the client was between polls) → deliver and consume.
    if (entry.result !== undefined) {
      pending.delete(m[1]); persist();
      res.writeHead(200, json); res.end(JSON.stringify(entry.result));
      return;
    }
    // bounded long-poll: hold at most ANSWER_HOLD_MS, then return {kind:"pending"} so the client
    // re-polls on a fresh short-lived socket. entry.promise resolves to a (never-undefined) result;
    // the timer resolves to undefined — so `=== undefined` cleanly means "hold expired, still waiting".
    // A detach while held wakes the poll (wake) so the answer is not collected by the old owner.
    let timer, wake;
    const held = new Promise((r) => { timer = setTimeout(() => r(undefined), ANSWER_HOLD_MS); wake = () => r(undefined); entry.wake.add(wake); });
    entry.holders++;
    const result = await Promise.race([entry.promise, held]);
    clearTimeout(timer); entry.wake.delete(wake);
    entry.holders--; entry.lastPoll = Date.now();
    if (entry.detached) { res.writeHead(200, json); res.end(detachedReply()); return; }
    if (result === undefined) {
      res.writeHead(200, json); res.end(JSON.stringify({ kind: "pending" }));
      return;
    }
    pending.delete(m[1]); persist();          // answered while we held → consume
    res.writeHead(200, json); res.end(JSON.stringify(result));
    return;
  }
  const dm = url.pathname.match(/^\/(detach|reattach)\/([a-f0-9]+)$/);
  if (req.method === "POST" && dm) {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let args = {}; try { args = JSON.parse(body || "{}"); } catch {}
      const sid = args.session_id ? String(args.session_id) : "";
      const [, op, id] = dm;
      const entry = pending.get(id);
      const reply = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (!entry) return reply(404, { error: "no such request (already answered and collected, cancelled, or expired)" });
      if (!sid) return reply(400, { error: "session_id required" });
      const info = { request_id: id, ...(entry.meta || {}), answered: entry.result !== undefined };
      if (op === "detach") {
        // only the session that asked may hand its question off
        if (entry.session_id !== sid) return reply(403, { error: "request belongs to another session" });
        if (!entry.detached) {
          entry.detached = { at: Date.now(), until: Date.now() + DETACH_TTL_MS, by: sid };
          armExpiry(id, entry); persist();
          for (const w of entry.wake) w();      // the owner's held poll returns {kind:"detached"} now
          log(`request ${id} detached by session ${sid} — reattach within ${DETACH_TTL_MS / 1000}s`);
        }
        return reply(200, { detached: true, ...info, until: new Date(entry.detached.until).toISOString() });
      }
      // reattach: a detached request (any session holding its id), or the same session's own request
      // that nobody polls anymore (its process died; the session reconnected)
      const ownOrphan = entry.session_id === sid && !attended(entry);
      if (!entry.detached && !ownOrphan) {
        return reply(entry.session_id === sid ? 409 : 403, { error: entry.session_id === sid ? "another process of this session is still waiting on it" : "request is not detached — its session must detach it first" });
      }
      const from = entry.session_id;
      delete entry.detached; clearTimeout(entry.expiry);
      entry.lastPoll = Date.now();                // the new owner is about to poll — not an orphan anymore
      if (from !== sid) {
        entry.session_id = sid;
        try { provider.transferRequest?.(id, from, sid); } catch (e) { log("transferRequest err", e.message); }
      }
      persist();
      log(`request ${id} reattached by session ${sid}${from !== sid ? ` (from ${from})` : ""}`);
      if (from && from !== sid) closeIfDue(from); // its old session may have been waiting for it to close
      return reply(200, { reattached: true, ...info });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/requests") {
    const sid = url.searchParams.get("session_id") || "";
    const list = [];
    for (const [id, p] of pending) {
      if (sid && p.session_id !== sid) continue;
      if (p.result !== undefined && !p.detached && attended(p)) continue; // answered: on its way to its poller
      list.push({ request_id: id, ...(p.meta || {}), session_id: p.session_id, created: new Date(p.created).toISOString(), answered: p.result !== undefined, detached: !!p.detached, attended: attended(p) });
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ requests: list }));
    return;
  }
  res.writeHead(404); res.end(`relay(${provider.name} v${VERSION}): POST /ask | GET /answer/<id> | POST /cancel/<id> | POST /detach/<id> | POST /reattach/<id> | GET /requests?session_id= | POST /attest | POST /session/close | POST /session/round-end | POST /pair/start | GET /pair/status | GET /health | POST /chat/register|take|progress|nick|close | GET /chat/session?session_id=`);
});
// single relay per machine: if the port is already owned, another relay is running — exit
// (do NOT start the IM connection, which would conflict on the shared bot).
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { log(`another relay already owns :${PORT} — exiting (single relay per machine).`); process.exit(0); }
  log("server error:", e.message); process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  log(`relay v${VERSION} http on http://127.0.0.1:${PORT}  provider=${provider.name}  root=${ROOT}  net_attempt_ms=${NET_ATTEMPT_MS ?? "(Node default)"}`);
  if (adopted && (adopted.open || adopted.answered)) log(`adopted ${adopted.open} open gate(s) + ${adopted.answered} answered-uncollected (${adopted.detached} detached) from the previous relay (v${adopted.from || "?"}, journal ${adopted.saved_at}) — buttons already on the phone stay valid`);
  provider.start();
});
