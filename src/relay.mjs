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
// Several machines, one inbox (0.20.0, SPEC §5.1). As the HUB, with MYNA_REMOTE_PORT set, this relay
// also listens on 127.0.0.1:<that> for other machines' EDGE relays — every request there carries a
// machine token (machines.json holds their SHA-256), only /health, /ask, /answer, /cancel,
// /session/close, /session/round-end and the join endpoints exist, and a machine sees only its own
// requests (session ids become m:<machine_id>:<session_id>). A new machine joins by asking
// (POST /machines/join): the phone gets ✅/❌ buttons and only a human tap issues its token.
// A reply lost on the way back (a tunnel cut mid-reply) loses nothing (0.20.3): a remote question's
// answer stays MYNA_ANSWER_REDELIVER_MS after it was first handed out, an approved join's token
// MYNA_JOIN_TTL_MS — the same machine / enroll secret asking again gets the very same result.
// As an EDGE (MYNA_ROLE=edge) this same relay forwards this machine's questions to the hub and keeps
// its own bot (if any, and not the hub's) as the fallback while the hub is away — see "edge" below.
// Without MYNA_REMOTE_PORT and MYNA_ROLE=edge nothing of this runs.
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
import { validateAskArgs, normalizeCommand, isApproveOption, approveOptionOf, oneLine } from "./providers/util.mjs";
import { createChat } from "./chat.mjs";
import { createEdgeChat } from "./edge-chat.mjs";
import { applyNetAttemptTimeout } from "./net.mjs";
import { LOCAL_SECRET_HEADER, localAuthOn, localExempt } from "./local-auth.mjs";
import {
  PROTOCOL, PROTOCOL_HEADER, ENROLL_SECRET_HEADER, REQUEST_ID_HEADER, VERSION_HEADER, FEATURES, LOCAL_ID, NAME_RE, CODE_RE, ASK_MAX_BYTES_DEFAULT,
  roleOf, machinesFile, seenFile, machineStore, newMachineId, newMachineToken, sha256hex, sameHex, bearerOf,
  readBody, refuseTooLarge, localRefusal, writePrivate, upstreamUrl, cfHeaders, tokenFile, botIdentity, holdSettings,
} from "./remote.mjs";

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
// role: hub (default) = this relay is the one other machines forward to (when MYNA_REMOTE_PORT is set);
// edge = it forwards this machine's questions to a hub (MYNA_UPSTREAM) and keeps its own bot, if it
// has one, as the fallback while the hub is away (see "edge" below)
const ROLE = roleOf(cfg);
if (ROLE !== "hub" && ROLE !== "edge") { log(`unknown MYNA_ROLE "${ROLE}" — use hub (default) | edge`); process.exit(1); }
const EDGE = ROLE === "edge";
// MYNA_LOCAL_AUTH=1: the local listener wants the relay secret (src/local-auth.mjs); off by default
const LOCAL_AUTH = localAuthOn(cfg);
// an edge holding questions while the hub is away (SPEC §5.2): /myna:hold's file, or MYNA_UPSTREAM_HOLD(_MAX)
const hold = () => holdSettings(cfg);
// MYNA_CHAT_FORWARD=off: this edge's chat stays on its own bot even when the hub forwards chat
const CHAT_FORWARD = String(cfg.MYNA_CHAT_FORWARD ?? "").trim().toLowerCase() !== "off";
const intCfg = (k, dflt, min = 0) => {
  const v = String(cfg[k] ?? "").trim(), n = Number(v);
  if (v === "") return dflt;
  if (!Number.isInteger(n) || n < min) { log(`${k}="${v}" is not an integer ≥ ${min} — using ${dflt}`); return dflt; }
  return n;
};
// body cap of POST /ask (both ports) — a question is a few KB; a megabyte body is a mistake or abuse
const ASK_MAX_BYTES = intCfg("MYNA_ASK_MAX_BYTES", ASK_MAX_BYTES_DEFAULT, 1024);
const SMALL_BODY_BYTES = 64 * 1024;     // every other body (session ids, a command line)
// the remote listener (other machines), off unless MYNA_REMOTE_PORT is set
const REMOTE_PORT = (() => {
  const v = String(cfg.MYNA_REMOTE_PORT ?? "").trim();
  if (!v) return null;
  if (EDGE) { log(`MYNA_REMOTE_PORT is ignored on an edge (MYNA_ROLE=edge) — only the hub takes other machines`); return null; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535 || n === PORT) { log(`MYNA_REMOTE_PORT="${v}" must be a port other than RELAY_PORT (${PORT}) — remote listener off`); return null; }
  return n;
})();
let remoteListening = false;
// several machines are configured on this one (hub with a remote port, or an edge). Without it the
// relay takes /ask bodies of any size and does not check the local port for proxy headers (no tunnel).
const MULTI = !!REMOTE_PORT || EDGE;
// this machine's short name (topic prefix once other machines have joined; logs)
const MACHINE_NAME = (String(cfg.MYNA_MACHINE_NAME || os.hostname().split(".")[0] || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16)) || "hub";
// MYNA_TOPIC_MACHINE: auto (default) = prefix topic names with the machine name once a remote machine
// is registered (a single machine sees no change); on = always; off = never
const TOPIC_MACHINE = (() => {
  const v = String(cfg.MYNA_TOPIC_MACHINE || "auto").trim().toLowerCase();
  if (!["auto", "on", "off"].includes(v)) { log(`MYNA_TOPIC_MACHINE="${v}" is not auto|on|off — using auto`); return "auto"; }
  return v;
})();
const REMOTE_ASK_MAX = intCfg("MYNA_REMOTE_ASK_MAX", 30, 1);                 // asks per machine per window
const REMOTE_ASK_WINDOW_MS = intCfg("MYNA_REMOTE_ASK_WINDOW_MS", 600000, 1000);
const REMOTE_MAX_POLLS = intCfg("MYNA_REMOTE_MAX_POLLS", 50, 1);             // /answer polls held at once per machine
const JOIN_TTL_MS = intCfg("MYNA_JOIN_TTL_MS", 600000, 1000);                // a join request waits this long for the tap
const JOIN_INTERVAL_MS = intCfg("MYNA_JOIN_INTERVAL_MS", 60000, 0);          // at most one new join request per interval
const JOIN_MAX_OPEN = intCfg("MYNA_JOIN_MAX_OPEN", 3, 1);                    // join requests waiting at once
// a remote question's answer, once handed out, stays this long for the same machine to ask again: the
// reply may have been lost on the way back, and the edge retries the same /answer. Covers the edge's
// MYNA_UPSTREAM_GRACE (default 120 s — past it the edge gives the question up and never asks again)
// plus checks and recovery. A grace set longer than this, with an outage longer than this, can still lose it.
const REDELIVER_MS = intCfg("MYNA_ANSWER_REDELIVER_MS", 900000, 1000);
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
  if (!mod.configured(cfg) && !mod.pairable?.(cfg)) {
    // an edge needs no IM of its own (SPEC §5.1): a provider named without its keys (an .env from before
    // the join) means it has none — forward only, do not refuse to run
    if (EDGE) { log(`MYNA_PROVIDER=${want} but its keys are missing in ${ENV_PATH} — this edge has no bot of its own, forwarding only`); mod = undefined; }
    else { log(`MYNA_PROVIDER=${want} but its keys are missing in ${ENV_PATH} — see .env.example`); process.exit(1); }
  }
} else {
  // a fully configured provider first; else one that only waits to be paired (telegram: token, no chat yet)
  mod = PROVIDERS.find((p) => p.configured(cfg)) || PROVIDERS.find((p) => p.pairable?.(cfg));
  // an edge needs no IM of its own: without one it only forwards to the hub
  if (!mod && !EDGE) { log(`no IM provider configured (telegram/discord/slack keys all missing in ${ENV_PATH}) — see .env.example`); process.exit(1); }
}

// state
// request_id -> {promise, resolve, result?, resolvedAt?, deliveredAt?, created, session_id?, meta?, detached?}
//   deliveredAt = when a remote machine was first handed the answer (kept for REDELIVER_MS, then gone);
//   such an entry is over — only that machine's /answer still sees it
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
      created: p.created, ...(p.session_id ? { session_id: p.session_id } : {}), ...(p.machine_id ? { machine_id: p.machine_id } : {}), ...(p.meta ? { meta: p.meta } : {}),
      ...(p.detached ? { detached: p.detached } : {}), ...(p.result !== undefined ? { result: p.result, resolvedAt: p.resolvedAt } : {}),
      ...(p.deliveredAt !== undefined ? { deliveredAt: p.deliveredAt } : {}),
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
// machine_id: which machine asked — absent for this machine's own (local) requests, so a journal
// without the field (any pre-0.20 one) reads as all-local
function newEntry(created = Date.now(), session_id, meta, machine_id) {
  let resolveFn; const promise = new Promise((r) => (resolveFn = r));
  return { promise, resolve: resolveFn, created, wake: new Set(), holders: 0, lastPoll: Date.now(), ...(session_id ? { session_id: String(session_id) } : {}), ...(meta ? { meta } : {}), ...(machine_id && machine_id !== LOCAL_ID ? { machine_id: String(machine_id) } : {}) };
}
const machineOf = (p) => p?.machine_id || LOCAL_ID;

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
    const e = newEntry(r.created || Date.now(), r.session_id, r.meta, r.machine_id);
    if (r.result !== undefined) {
      e.result = r.result; e.resolvedAt = Date.now(); e.resolve(r.result); answered++; // fresh TTL — give the client time to collect
      // handed out before the restart: its window goes on (never later than now — the journal is agent-writable)
      if (Number.isFinite(r.deliveredAt)) e.deliveredAt = Math.min(r.deliveredAt, Date.now());
    } else open++;
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
  // a tap on a join request's buttons (not a question of any session — never in `pending`)
  if (joinByQ.has(request_id)) return joinAnswered(joinByQ.get(request_id), result);
  const p = pending.get(request_id);
  const cmd = p?.approves;
  // the tapped option must be THE ✅ option of this question (set by /ask in this process), not
  // merely one starting with ✅
  if (p && p.result === undefined && result?.kind === "selection" && typeof cmd === "string" && cmd && isApproveOption(result.value)
    && typeof p.approveOption === "string" && result.value === p.approveOption && p.session_id) {
    approvals.set(request_id, { request_id, machine_id: machineOf(p), session_id: p.session_id, command: cmd, chosen: result.value, answered_at: new Date().toISOString() });
    log(`request ${request_id}: ✅ approval recorded for session ${p.session_id} (usable once, ${APPROVAL_TTL_MS / 1000}s)`);
  }
  resolveRequest(request_id, result);
}

// reap answered entries the client never came back to collect (e.g. it fell back / died mid-wait).
// unanswered entries are left alone — the human may still answer later — until they turn orphan
// (ORPHAN_TTL_MS old and nobody polling): then cancelled like an expired detach, buttons retracted.
// A detached answer waits for its new session until the detach expires (expireDetached drops it then).
// A remote answer already handed out goes REDELIVER_MS after its first hand-out instead.
function sweep() {
  const now = Date.now();
  let swept = 0;
  for (const [id, p] of pending) {
    if (p.detached) continue;
    if (p.result !== undefined) {
      if (p.deliveredAt !== undefined ? now - p.deliveredAt > REDELIVER_MS : now - p.resolvedAt > 300000) { pending.delete(id); swept++; }
      continue;
    }
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
  // handler deletes it on delivery (a remote one: REDELIVER_MS later); the TTL sweep reaps any that are never collected.
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
// --- edge: the hub link -----------------------------------------------------------------------------
// An edge forwards this machine's questions to the hub (MYNA_UPSTREAM) with its machine token. Its own
// bot (if it has one) is the fallback: it keeps polling — so a fallback question's answer and the
// questions still open on it are handled — but sends questions only while the hub is away.
// The hub reports its bot's id on its remote /health; the same bot as this machine's → this machine
// never uses its own (two pollers on one bot fight: Telegram 409, Discord/Slack events twice).
const NO_IM = { name: "none", start() {}, async sendQuestion() { throw new Error("this machine has no IM of its own (edge forwarding only)"); } };
const hub = EDGE ? edgeLink() : null;
function edgeLink() {
  const up = upstreamUrl(cfg.MYNA_UPSTREAM);
  if (up.error) { log(`${up.error} — set MYNA_UPSTREAM in ${ENV_PATH} to the hub's URL (run /myna:join)`); process.exit(1); }
  const CF = cfHeaders(cfg);
  if (!!String(cfg.MYNA_CF_ACCESS_CLIENT_ID || "").trim() !== !!String(cfg.MYNA_CF_ACCESS_CLIENT_SECRET || "").trim()) log("only one of MYNA_CF_ACCESS_CLIENT_ID / MYNA_CF_ACCESS_CLIENT_SECRET is set — sending neither");
  const TOKEN_FILE = tokenFile(cfg);
  const token = () => { if (cfg.MYNA_MACHINE_TOKEN) return String(cfg.MYNA_MACHINE_TOKEN).trim(); try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; } };
  const BOT_FILE = path.join(path.dirname(ENV_PATH), "upstream.json"); // the hub's bot id last seen (decides at start while the hub is away)
  // upstream.json and edge-state.json say which hub they were written for: a file of another hub (this
  // machine joined a new one) is ignored. Files without it (0.20.0 / 0.20.1) are taken as before.
  const forThisHub = (s) => !s?.upstream || s.upstream === up.url;
  const h = {
    url: up.url, cf: !!Object.keys(CF).length, tokenFile: TOKEN_FILE,
    reachable: false,      // the last check (or forward) reached the hub
    active: false,         // new questions go to the hub (after MYNA_UPSTREAM_RECOVER good checks in a row once it was away)
    everUp: false, okStreak: 0, reason: "not checked yet", since: Date.now(), downSince: Date.now(),
    version: null, protocol: null, machine: null,
    bot: null,             // the hub's bot id (upstream.json; refreshed by every check)
    features: null,        // the hub's remote features (its /health `features`): null = never heard from it
    forwarded: new Map(),  // request_id -> {at}: forwarded to the hub, answer not collected yet
    abandoned: new Set(),  // given up while the hub was away → cancelled at the hub once it is back
    queued: new Map(),     // request_id -> {body, at, session_id, tried?}: asked while the hub was away, held for it (SPEC §5.2)
    results: new Map(),    // request_id -> a held question's end (over the cap, refused by the hub): its client's next /answer
    CHECK_MS: intCfg("MYNA_UPSTREAM_CHECK_MS", 10000, 50),
    GRACE_MS: intCfg("MYNA_UPSTREAM_GRACE", 120, 0) * 1000,
    RECOVER: intCfg("MYNA_UPSTREAM_RECOVER", 3, 1),
    headers: (extra = {}) => ({ authorization: `Bearer ${token()}`, [PROTOCOL_HEADER]: String(PROTOCOL), [VERSION_HEADER]: VERSION, ...CF, ...extra }),
    onBot: null,           // set below: called when the hub's bot id is learned / changes
  };
  try { const s = JSON.parse(fs.readFileSync(BOT_FILE, "utf8")); if (forThisHub(s)) { h.bot = s.bot_id || null; if (Array.isArray(s.features)) h.features = s.features.map(String); } } catch {}
  // forwarded / abandoned / the outage start survive a restart (an upgrade mid-outage must neither
  // cut a question's grace short nor forget to retract the buttons of one given up): edge-state.json.
  // recovering too (it had been up, and new questions do not go to it yet): a restart mid-outage or
  // mid-recovery is a recovery, not a first connection — the hub gets new questions back only after
  // MYNA_UPSTREAM_RECOVER good checks in a row after the restart
  const STATE_FILE = cfg.MYNA_EDGE_STATE_FILE || path.join(path.dirname(ENV_PATH), "edge-state.json");
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!forThisHub(s)) log(`edge: ${STATE_FILE} was written for another hub (${s.upstream}) — not using it`);
    else {
      for (const [id, v] of s.forwarded || []) h.forwarded.set(String(id), v);
      for (const id of s.abandoned || []) h.abandoned.add(String(id));
      for (const [id, v] of s.queued || []) if (v && typeof v.body === "string") h.queued.set(String(id), v);
      for (const [id, v] of s.results || []) h.results.set(String(id), v);
      h.chatState = s.chat || [];
      if (Number.isFinite(s.down_since)) h.downSince = s.down_since;
      if (s.recovering) h.everUp = true;
      // it had been up before this start: if this start first finds the hub away, its return is a recovery
      if (s.recovering || s.ever_up) h.upBefore = true;
      if (h.forwarded.size || h.abandoned.size || h.queued.size) log(`edge: picked up ${h.forwarded.size} question(s) waiting on the hub, ${h.queued.size} held for it and ${h.abandoned.size} to cancel there from ${STATE_FILE}`);
    }
  } catch {}
  let saveQueued = false;
  h.save = () => {
    if (saveQueued) return; saveQueued = true;
    setImmediate(() => {
      saveQueued = false;
      try { writePrivate(STATE_FILE, JSON.stringify({ upstream: h.url, forwarded: [...h.forwarded], abandoned: [...h.abandoned], queued: [...h.queued], results: [...h.results], chat: h.exportChat?.() ?? h.chatState ?? [], down_since: h.reachable ? null : h.downSince, recovering: h.everUp && !h.active, ever_up: h.everUp || !!h.upBefore }) + "\n"); }
      catch (e) { log("edge: could not save", STATE_FILE, e.message); }
    });
  };
  h.markDown = (reason) => {
    if (h.reachable) { h.downSince = Date.now(); h.save(); log(`hub unreachable: ${reason} — ${hold().on ? "new questions are held for it (/myna:hold)" : ownBot.on ? "new questions go to this machine's own bot" : "local clients fall back to this machine's terminal"} until it is back`); }
    else if (h.reason !== reason) log(`hub still unavailable: ${reason}`);
    Object.assign(h, { reachable: false, active: false, okStreak: 0, reason, since: Date.now() });
    if (h.upBefore) h.everUp = true; // up before a restart, away now: coming back is a recovery
  };
  h.why = (status, body) => status === 401 ? "machine token refused (revoked or wrong) — run /myna:join again"
    : status === 403 || (status >= 300 && status < 400) ? `access denied before the hub (HTTP ${status} — Cloudflare Access service token missing or wrong?)`
    : status === 426 ? `the hub speaks another remote protocol (${body?.protocol ?? "?"}; this machine speaks ${PROTOCOL}) — update myna on both`
    : `hub answered HTTP ${status}`;
  h.failStatus = (s) => s === 401 || s === 403 || s === 426 || (s >= 300 && s < 400) || s >= 500;
  h.check = async () => {
    if (!token()) return h.markDown(`no machine token (${TOKEN_FILE}) — run /myna:join`);
    let r, j = null;
    try { r = await fetch(`${h.url}/health`, { headers: h.headers(), redirect: "manual", signal: AbortSignal.timeout(5000) }); j = await r.json().catch(() => null); }
    catch (e) { return h.markDown(`cannot connect (${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message})`); }
    if (h.failStatus(r.status)) return h.markDown(h.why(r.status, j));
    if (r.status !== 200 || j?.name !== "myna-relay") return h.markDown(`not a myna hub (HTTP ${r.status})`);
    if (j.protocol !== PROTOCOL) return h.markDown(h.why(426, j));
    const was = h.reachable;
    Object.assign(h, { reachable: true, reason: "", since: was ? h.since : Date.now(), version: j.version, protocol: j.protocol, machine: j.machine?.name || null });
    h.okStreak++;
    // features: what this hub takes beyond protocol 1 (0.21.0: "chat"); a hub without the field takes none
    const feats = Array.isArray(j.features) ? j.features.map(String) : [];
    if ((j.bot_id || null) !== h.bot || JSON.stringify(feats) !== JSON.stringify(h.features)) {
      h.bot = j.bot_id || null; h.features = feats;
      try { writePrivate(BOT_FILE, JSON.stringify({ upstream: h.url, bot_id: h.bot, features: h.features, seen_at: new Date().toISOString() }) + "\n"); } catch {}
    }
    h.onBot?.(h.bot);
    // back after an outage: new questions return to the hub only after RECOVER good checks in a row
    // (a flapping link must not bounce questions between two bots). Without a bot of its own there
    // is nothing to bounce to — forward again at once. The very first check runs before the own bot is
    // decided: count the bot as on when it will be (configured, not the hub's).
    // Holding questions (/myna:hold, the default) means no fallback for them: the hub takes them at once.
    const fallback = !hold().on && (ownBot.decided ? ownBot.on : !!mod && !(h.bot && ownBot.id && h.bot === ownBot.id));
    if (!h.active && (!h.everUp || !fallback || h.okStreak >= h.RECOVER)) {
      h.active = true;
      log(`hub ${h.url} ${h.everUp ? "back" : "reachable"} — v${j.version}, protocol ${j.protocol}, this machine = ${h.machine}; new questions go to the hub`);
      h.everUp = true;
      h.save();
    }
    if (!was) h.save();
    h.flush();
    if (h.active) h.sendHeld?.();
    h.onUp?.();
  };
  // cancel at the hub what was given up — retried on every good check until the hub confirms it: 200
  // (cancelled, or already over) or 404 (it never got the question). Anything else (401, 403, 3xx, 5xx,
  // timeout) keeps the id for the next check.
  let flushing = false;
  h.flush = async () => {
    if (flushing || !h.abandoned.size) return;
    flushing = true;
    try {
      for (const id of [...h.abandoned]) {
        let r;
        try { r = await fetch(`${h.url}/cancel/${id}`, { method: "POST", headers: h.headers(), redirect: "manual", signal: AbortSignal.timeout(5000) }); }
        catch { return; }
        if (r.status === 200 || r.status === 404) { h.abandoned.delete(id); h.save(); log(`edge: question ${id} given up during the outage — ${r.status === 200 ? "cancelled at the hub" : "the hub never had it"}`); }
      }
    } finally { flushing = false; }
  };
  // how long a forwarded question waits for the hub once it is away: holding (the default) → up to the
  // hold cap; /myna:hold off → MYNA_UPSTREAM_GRACE (0.20.3's rule)
  h.waitMs = () => { const s = hold(); return s.on ? s.max_s * 1000 : h.GRACE_MS; };
  h.inGrace = (id) => h.forwarded.has(id) && Date.now() - h.downSince < h.waitMs();
  return h;
}
// this machine's own bot: on = its provider runs (questions go to it only while the hub is away)
const ownBot = { on: false, id: mod ? botIdentity(mod.name, cfg) : null, reason: mod ? "" : "no bot configured on this machine" };
if (EDGE) {
  hub.first = hub.check();
  await Promise.race([hub.first, new Promise((r) => setTimeout(r, 6000))]);
  if (mod && hub.bot && ownBot.id && hub.bot === ownBot.id) ownBot.reason = `same bot as the hub (${ownBot.id}) — not using it, forwarding only`;
  else if (mod) {
    ownBot.on = true;
    if (!hub.bot) log(`the hub's bot id is not known yet (hub ${hub.reachable ? "reports none" : "not reachable"}) — starting this machine's own bot; it is stopped if it turns out to be the hub's`);
  }
  if (!ownBot.on) log(`edge: ${ownBot.reason}`);
  ownBot.decided = true;
}
// a chat session's topic carries the machine name like its questions' (MYNA_TOPIC_MACHINE); a remote session's is its machine's
const chat = createChat({
  cfg, log, dir: path.dirname(ENV_PATH), topicMachine: (scope) => topicMachine(scope || LOCAL_SCOPE),
  // an edge chatting on its own bot because its hub is older than 0.21.0: the mod says so
  registerNote: () => (EDGE && CHAT_FORWARD && hub.features && !hub.features.includes("chat") ? `${OLD_HUB_CHAT}，聊天改用這台自己的 bot` : ""),
});
// an edge whose hub forwards chat relays /chat/* there (src/edge-chat.mjs); its state rides in edge-state.json
const edgeChat = EDGE ? createEdgeChat({ hub, log, secretOk: chat.secretOk, save: () => hub.save() }) : null;
if (edgeChat) {
  const n = edgeChat.importState(hub.chatState);
  if (n) log(`edge: picked up ${n} chat session(s) forwarded to the hub from the last run`);
  hub.exportChat = edgeChat.exportState;
  hub.onUp = () => { edgeChat.onUp().catch((e) => log("edge chat: catching up failed:", e.message)); };
}
// where this edge's chat goes: "forwarded" (the hub's bot), "down" (the hub's, but it is away — held),
// "own-bot" (the hub does not forward chat, or MYNA_CHAT_FORWARD=off), "unsupported" (neither)
const chatMode = () => (CHAT_FORWARD && hub.features?.includes("chat") ? (hub.reachable ? "forwarded" : "down") : ownBot.on ? "own-bot" : "unsupported");
const OLD_HUB_CHAT = "主節點的 Myna 版本不支援轉送聊天（要 0.21.0 以上）";
let provider;
if (!EDGE || ownBot.on) {
  try { provider = mod.create(cfg, { resolve: resolveFromIM, log, persist, chat: chat.ctx }); }
  catch (e) { log(e.message); process.exit(1); }
} else provider = NO_IM;
chat.attach(provider);
if (EDGE) {
  // the hub's bot turns out to be this machine's (learned after start, or the hub switched bots):
  // stop polling it at once and only forward from now on
  hub.onBot = (botId) => {
    if (!ownBot.on || !botId || botId !== ownBot.id) return;
    ownBot.on = false; ownBot.reason = `same bot as the hub (${botId}) — stopped using it, forwarding only`;
    log(`edge: ${ownBot.reason}`);
    const old = provider;
    try { old.stop(); } catch (e) { log("could not stop the provider:", e.message, "— exiting so the next start sees the hub's bot id (upstream.json) and never starts it"); process.exit(1); }
    // questions already sent on that bot: their button tokens live only in the provider just stopped, and
    // the hub — polling the same bot — cannot resolve a tap on them. Retract the buttons (cancelQuestion
    // uses the Bot API, not the poll) and give each back to its client as unreachable (terminal picker).
    // A question still being sent is withdrawn once its message exists (only a sent message can be retracted).
    for (const [id, p] of pending) {
      if (p.result !== undefined) continue;
      log(`request ${id}: on this machine's own bot, which is the hub's — giving it back to the terminal`);
      const withdraw = () => {
        if (p.result !== undefined) return;
        const result = { kind: "unreachable", error: "this machine's own bot turned out to be the hub's — the question was withdrawn there" };
        Promise.resolve(old.cancelQuestion?.(id, "same_bot")).catch((e) => log("cancelQuestion err", e.message)); // reads its state before its tokens are dropped
        if (provider !== old) old.onResolve?.(id, result); // resolveRequest tells only the current provider (NO_IM by now)
        resolveRequest(id, result);
      };
      if (p.sending) p.sending.then(withdraw); else withdraw();
    }
    provider = NO_IM; chat.attach(provider);
  };
  hub.onBot(hub.bot);
  setInterval(() => {
    hub.check().then(edgeGraceCheck, edgeGraceCheck);
  }, hub.CHECK_MS).unref();
}
// past the grace: the questions still waiting on the hub are given up (their clients get
// {kind:"unreachable"} and fall back); once the hub is back they are cancelled there. They are NOT
// re-sent on this machine's bot: the hub may still be up behind a broken link and take a tap on its
// own buttons — a second copy here could be answered twice.
function edgeGraceCheck() {
  expireHeld();
  if (hub.reachable || !hub.forwarded.size || Date.now() - hub.downSince < hub.waitMs()) return;
  log(`hub away for over ${hub.waitMs() / 1000}s — giving up ${hub.forwarded.size} question(s) waiting on it; they are cancelled at the hub once it is back`);
  for (const id of hub.forwarded.keys()) hub.abandoned.add(id);
  hub.forwarded.clear(); hub.save();
}
// Questions held while the hub is away (SPEC §5.2; /myna:hold on, the default): the client got a request id
// and polls it ({kind:"pending", queued:true}); nothing goes to this machine's own bot, the connection is
// not dropped. Once the hub takes new questions again they go out oldest first, under the same request id
// (X-Myna-Request-Id — the hub answers the same id twice with the same request), with a line saying they
// were held. Held longer than the cap (/myna:hold max, default 1 day) → {kind:"unreachable"}; if a send
// may have reached the hub, it is cancelled there once it is back.
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
function expireHeld() {
  if (!EDGE || !hub.queued.size) return;
  const capMs = hold().max_s * 1000;
  for (const [id, q] of hub.queued) {
    if (Date.now() - q.at <= capMs) continue;
    hub.queued.delete(id);
    hub.results.set(id, { kind: "unreachable", error: `the hub was away for over ${capMs / 1000}s — this question was held that long and given up (/myna:hold max)` });
    if (q.tried) hub.abandoned.add(id); // a send may have reached the hub: cancel it there once it is back
    log(`edge: question ${id} held for over ${capMs / 1000}s — given up`);
    hub.save();
  }
}
let sendingHeld = false;
if (EDGE) hub.sendHeld = async () => {
  if (sendingHeld || !hub.queued.size) return;
  sendingHeld = true;
  try {
    expireHeld();
    for (const [id, q] of [...hub.queued].sort((a, b) => a[1].at - b[1].at)) {
      if (!hub.active || !hub.queued.has(id)) break;
      let args; try { args = JSON.parse(q.body); } catch { args = null; }
      if (!args || typeof args !== "object") { hub.queued.delete(id); hub.results.set(id, { kind: "unreachable", error: "the held question could not be read back" }); hub.save(); continue; }
      const line = `（這題在主節點斷線時排著，${hhmm(q.at)} 問的，${hhmm(Date.now())} 送出）`;
      args.preamble = args.preamble ? `${line}\n\n${args.preamble}` : line;
      q.tried = true; hub.save();
      let r;
      try {
        r = await fetch(`${hub.url}/ask`, { method: "POST", headers: hub.headers({ "content-type": "application/json", [REQUEST_ID_HEADER]: id }), body: JSON.stringify(args), redirect: "manual", signal: AbortSignal.timeout(30000) });
      } catch (e) { hub.markDown(`cannot connect (${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message})`); break; }
      let j = null; try { j = await r.json(); } catch {}
      if (hub.failStatus(r.status)) { hub.markDown(hub.why(r.status, j)); break; }
      if (r.status === 429) break; // the hub's rate limit: the rest goes out with the next good check
      hub.queued.delete(id);
      if (r.status === 200 && j?.request_id === id) { hub.forwarded.set(id, { at: Date.now() }); log(`edge: question ${id} held since ${hhmm(q.at)} — sent to the hub`); }
      else { hub.results.set(id, { kind: "unreachable", error: `the hub refused the held question (HTTP ${r.status}${j?.error ? `: ${j.error}` : ""})` }); log(`edge: question ${id}: the hub refused it (HTTP ${r.status})`); }
      hub.save();
    }
  } finally { sendingHeld = false; }
};
const adopted = adopt();

// --- request handlers shared by the local and the remote listener ------------------------------
// A scope says who is asking: this machine (local listener, no credentials — as before 0.20) or a
// remote machine identified by its token. A remote machine's session ids are namespaced
// m:<machine_id>:<session_id> (two machines using the same id never meet, one cannot act on the
// other's sessions) and it only ever sees its own requests.
const LOCAL_SCOPE = { id: LOCAL_ID, name: MACHINE_NAME, remote: false, sid: (s) => (s ? String(s) : ""), owns: () => true };
const remoteScope = (m) => ({ id: m.id, name: m.name, remote: true, sid: (s) => (s ? `m:${m.id}:${String(s)}` : ""), owns: (p) => machineOf(p) === m.id });
const send = (res, code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const jsonOf = (body) => { try { return { v: JSON.parse(body || "{}") }; } catch (e) { return { err: e }; } };
// machines.json is read only when the remote listener is on — without it nothing below changes a topic
// onLoad: machines.json unreadable when this relay started → the revoked-while-down check runs once it reads
let listening = false;
const machines = REMOTE_PORT ? machineStore(machinesFile(cfg), { onRevoked: (ids) => machinesRevoked(ids), onError: (m) => log(`machines: ${m}`), onLoad: () => { if (listening) revokedWhileDown(); } }) : null;
// the machine-name prefix a question's topic gets (see MYNA_TOPIC_MACHINE)
const topicMachine = (scope) => (TOPIC_MACHINE === "on" || (TOPIC_MACHINE === "auto" && machines && machines.active().length > 0) ? scope.name : "");
const remoteAsks = new Map();   // machine_id -> timestamps of its recent /ask (rate limit)
const remotePolls = new Map();  // machine_id -> /answer polls held now

// pre: the body when the caller already read it (an edge that fell back from forwarding)
async function handleAsk(req, res, scope, pre) {
  // body cap only where a question can come from another machine (a single machine keeps no cap, as before)
  const { body, tooLarge } = pre || await readBody(req, MULTI ? ASK_MAX_BYTES : Infinity);
  if (tooLarge) { log(`rejecting /ask (413): body over ${ASK_MAX_BYTES} bytes${scope.remote ? ` from machine=${scope.name}` : ""}`); return refuseTooLarge(req, res, `request body over ${ASK_MAX_BYTES} bytes`); }
  const { v: args, err } = jsonOf(body);
  if (err) return send(res, 400, { error: `bad JSON: ${err.message}` });
  // Second line of defense — never ship a button-less menu / markup residue to the phone.
  const problems = validateAskArgs(args);
  if (problems.length) {
    log("rejecting /ask (400):", problems.join("; "));
    return send(res, 400, { error: problems.join("; ") });
  }
  // an edge may pick the request id (X-Myna-Request-Id, 10 hex) so it can cancel the question even when
  // this reply never reaches it; the same id again from the same machine returns that request (idempotent)
  let request_id;
  if (scope.remote && req.headers[REQUEST_ID_HEADER] !== undefined) {
    const want = String(req.headers[REQUEST_ID_HEADER]).trim().toLowerCase();
    if (!/^[a-f0-9]{10}$/.test(want)) return send(res, 400, { error: "X-Myna-Request-Id must be 10 lowercase hex characters" });
    const ex = pending.get(want);
    if (ex) return machineOf(ex) === scope.id ? send(res, 200, { request_id: want }) : send(res, 409, { error: "request id in use — pick another" });
    request_id = want;
  }
  if (scope.remote) {
    const now = Date.now(), recent = (remoteAsks.get(scope.id) || []).filter((t) => now - t < REMOTE_ASK_WINDOW_MS);
    if (recent.length >= REMOTE_ASK_MAX) {
      remoteAsks.set(scope.id, recent);
      log(`rejecting /ask (429) from machine=${scope.name}: ${recent.length} asks in ${REMOTE_ASK_WINDOW_MS / 1000}s`);
      return send(res, 429, { error: `too many questions from this machine (${REMOTE_ASK_MAX} per ${REMOTE_ASK_WINDOW_MS / 1000}s)`, retry_after_s: Math.ceil((REMOTE_ASK_WINDOW_MS - (now - recent[0])) / 1000) });
    }
    recent.push(now); remoteAsks.set(scope.id, recent);
    if (args.session_id) args.session_id = scope.sid(args.session_id);
  }
  // set by the relay only, never taken from the caller
  delete args.machine_label;
  const label = topicMachine(scope);
  if (label) args.machine_label = label;
  request_id ||= crypto.randomBytes(5).toString("hex");
  const entry = newEntry(Date.now(), args.session_id, metaOf(args), scope.id);
  // runtime only (persist() never writes it): the command a ✅ tap on THIS question approves
  // and the one ✅ option whose tap approves it (validateAskArgs allows exactly one)
  if (typeof args.approves === "string") { entry.approves = normalizeCommand(args.approves); entry.approveOption = approveOptionOf(args.options); }
  pending.set(request_id, entry);
  if (scope.remote) log(`remote ask from machine=${scope.name} (${scope.id}) → request ${request_id}${args.session_id ? ` session ${args.session_id}` : ""}`);
  // sendQuestion throws when the question/keyboard could not be delivered to the phone (after the
  // provider's own transient retries). Resolve the request as {kind:"unreachable"} so the client's
  // /answer poll returns immediately and the orchestrator falls back to the local picker — instead
  // of polling forever for an answer to a message the human never received (retro: this was
  // logged-and-absorbed, so the 3-layer fallback never fired). request_id is still returned so the
  // client has something to poll and collect the unreachable verdict.
  // a remote machine's /cancel waits for this send to finish (entry.sending): an edge that gave the
  // question up may cancel it while Telegram is still sending it, and only a sent message can be retracted
  try {
    const sending = provider.sendQuestion(request_id, args);
    // a remote /cancel, or an edge giving its own bot up (hub.onBot), waits for the send to finish
    entry.sending = Promise.resolve(sending).catch(() => {});
    await sending; persist(); // buttons are on the phone → journal them
  }
  catch (e) {
    log("sendQuestion delivery failed — resolving unreachable:", e.message);
    resolveRequest(request_id, { kind: "unreachable", error: `question delivery failed: ${e.message}` });
  }
  send(res, 200, { request_id });
}

// body (optional JSON) {why: "answered", text}: the asker took the human's answer another way (e.g. a reply to the
// message it posted before the question) — the phone says so instead of "handled in the terminal"
async function handleCancel(res, id, scope, body = "") {
  let why;
  let note = "";
  try { const b = JSON.parse(body || "{}"); if (b?.why === "answered") { why = "answered"; note = String(b.text ?? "").slice(0, 200); } } catch {}
  let entry = pending.get(id);
  // another machine's request does not exist for this one (404 — not even its existence leaks)
  if (scope.remote && (!entry || !scope.owns(entry))) return send(res, 404, { error: "no such request" });
  if (scope.remote && entry.sending) { await entry.sending; entry = pending.get(id); if (!entry) return send(res, 200, { cancelled: false }); }
  const open = !!entry && entry.result === undefined;
  if (open) {
    Promise.resolve(provider.cancelQuestion?.(id, why, note)).catch((e) => log("cancelQuestion err", e.message)); // reads its state synchronously, before resolve drops it
    resolveRequest(id, { kind: "cancelled" });
  }
  send(res, 200, { cancelled: open });
}

async function handleAnswer(res, id, scope) {
  const entry = pending.get(id);
  if (!entry || !scope.owns(entry)) { res.writeHead(404); res.end('{"error":"no such request"}'); return; }
  const json = { "content-type": "application/json" };
  // a remote answer handed out before: the same machine gets it again within REDELIVER_MS of the first
  // hand-out (that reply may have been lost on the way back); past it the entry is gone — judged here,
  // not left to the sweep. The local port never sees it again.
  if (entry.deliveredAt !== undefined) {
    const expired = Date.now() - entry.deliveredAt > REDELIVER_MS;
    if (expired) { pending.delete(id); persist(); }
    if (expired || !scope.remote) { res.writeHead(404); res.end('{"error":"no such request"}'); return; }
    res.writeHead(200, json); res.end(JSON.stringify(entry.result));
    return;
  }
  // the local port consumes the answer; a remote machine's stays for REDELIVER_MS (deliveredAt: first hand-out only)
  const deliver = (result) => {
    if (!scope.remote) { pending.delete(id); persist(); }
    else if (entry.deliveredAt === undefined) { entry.deliveredAt = Date.now(); persist(); }
    res.writeHead(200, json); res.end(JSON.stringify(result));
  };
  // handed off: the answer (now or later) belongs to whoever reattaches it — never deliver it here
  const detachedReply = () => JSON.stringify({ kind: "detached", request_id: id, until: new Date(entry.detached.until).toISOString() });
  if (entry.detached) { res.writeHead(200, json); res.end(detachedReply()); return; }
  // already answered (human replied while the client was between polls) → deliver
  if (entry.result !== undefined) return deliver(entry.result);
  if (scope.remote) {
    const held = remotePolls.get(scope.id) || 0;
    if (held >= REMOTE_MAX_POLLS) return send(res, 429, { error: `too many /answer polls held for this machine (${REMOTE_MAX_POLLS})` });
    remotePolls.set(scope.id, held + 1);
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
  if (scope.remote) remotePolls.set(scope.id, Math.max(0, (remotePolls.get(scope.id) || 1) - 1));
  if (entry.detached) { res.writeHead(200, json); res.end(detachedReply()); return; }
  if (result === undefined) {
    res.writeHead(200, json); res.end(JSON.stringify({ kind: "pending" }));
    return;
  }
  deliver(result);                         // answered while we held
}

async function handleSessionClose(req, res, scope, pre) {
  const { body } = pre || await readBody(req, SMALL_BODY_BYTES);
  const sid = scope.sid((jsonOf(body).v || {}).session_id);
  if (sid) cancelPermissions(sid, "session end");
  if (sid && openFor(sid)) {
    closing.add(sid); persist();
    log(`session ${sid} closed with open gate(s) — its topics stay until they are answered`);
  } else if (sid && provider.closeSession) { try { await provider.closeSession(sid); } catch (e) { log("closeSession err", e.message); } }
  send(res, 200, {});
}

async function handleRoundEnd(req, res, scope, pre) {
  const { body } = pre || await readBody(req, SMALL_BODY_BYTES);
  const sid = scope.sid((jsonOf(body).v || {}).session_id);
  if (sid) cancelPermissions(sid, "round end");
  // a gate of this session still waiting (e.g. a background subagent's) → the round is not over
  const open = sid && [...pending.values()].some((q) => q.session_id === sid && q.result === undefined);
  if (sid && !open && provider.endRound) { try { provider.endRound(sid); } catch (e) { log("endRound err", e.message); } }
  send(res, 200, { ended: !!sid && !open });
}

// --- machines: revoke + join ----------------------------------------------------------------------
// a machine revoked (machines.mjs revoke edits machines.json; the hub notices on its next look): its
// token stops working at once (verify reads the file), its open questions are cancelled (buttons
// retracted) and its approvals dropped
function machinesRevoked(ids) {
  const gone = new Set(ids);
  for (const [id, p] of pending) {
    if (!gone.has(machineOf(p)) || p.result !== undefined) continue;
    log(`request ${id}: machine ${p.machine_id} revoked — cancelling`);
    // a question still being sent is cancelled once its message exists (only a sent message can be retracted)
    const cancel = () => {
      if (p.result !== undefined) return;
      Promise.resolve(provider.cancelQuestion?.(id, "revoked")).catch((e) => log("cancelQuestion err", e.message));
      resolveRequest(id, { kind: "cancelled", reason: "machine revoked" });
    };
    if (p.sending) p.sending.then(cancel); else cancel();
  }
  for (const [rid, a] of approvals) if (gone.has(a.machine_id)) approvals.delete(rid);
  // its chat sessions end too: topics 🔒, inboxes cleared
  for (const id of ids) chat.closeMachine(id).catch((e) => log("chat: closing a revoked machine's sessions failed:", e.message));
  for (const id of ids) log(`machine ${id} revoked — its token no longer works`);
}
if (machines) setInterval(() => machines.refresh(), 5000).unref();
// machines revoked while no relay ran (machines.mjs revoke during a restart): the first read of
// machines.json reports no change, so their journaled questions are cancelled here
function revokedWhileDown() {
  const revoked = new Set(machines.all().filter((m) => m.revoked_at).map((m) => m.id));
  const hit = [...new Set([...pending.values()].filter((p) => p.result === undefined && revoked.has(machineOf(p))).map(machineOf))];
  if (hit.length) machinesRevoked(hit);
}

// when a machine was last seen and from where (Cf-Connecting-Ip behind Cloudflare) — machines-seen.json,
// written by the hub alone, at most once a minute
const seen = !machines ? {} : (() => { try { return JSON.parse(fs.readFileSync(seenFile(cfg), "utf8")) || {}; } catch { return {}; } })();
let seenSavedAt = 0;
function noteSeen(m, req) {
  const h = req.headers;
  // version: the edge's plugin version (0.21.0+ send it; /myna:machines marks the older ones)
  const v = String(h[VERSION_HEADER] || "").trim().slice(0, 32);
  seen[m.id] = { last_seen_at: new Date().toISOString(), last_addr: String(h["cf-connecting-ip"] || String(h["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || ""), ...(/^[0-9][\w.+-]*$/.test(v) ? { version: v } : {}) };
  if (Date.now() - seenSavedAt < 60000) return;
  seenSavedAt = Date.now();
  try { writePrivate(seenFile(cfg), JSON.stringify(seen, null, 2) + "\n"); } catch (e) { log("machines: could not save", seenFile(cfg), e.message); }
}

// Joining (a machine with no token yet): POST /machines/join {name, os, hostname, code,
// enroll_secret_hash} → the phone gets "🆕 <name> 要加入，核對碼 <code> [✅ 允許] [❌ 拒絕]"; the
// joining machine polls GET /machines/join/<enroll_id> with its enroll secret (whose hash it sent) and
// gets the token only after the ✅ tap (the same token again for a JOIN_TTL_MS after its first hand-out,
// in case that reply was lost). Only the provider's button callback approves — the relay
// never auto-answers, autopilot lives in the MCP client and never sees this question. Join requests
// live in memory only: a relay restart drops them (the machine asks again).
const JOIN_ALLOW = "✅ 允許", JOIN_DENY = "❌ 拒絕";
const joins = new Map();   // enroll_id -> {qid, name, os, hostname, code, secretHash, expires, status, token?, machine?, wake, timer, doneAt?, collectedAt?}
const joinByQ = new Map(); // the join question's request_id -> enroll_id
let lastJoinAt = 0;
const shown = (s, n) => oneLine(String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " "), n) || "?";
function finishJoin(j, status, extra = {}) {
  clearTimeout(j.timer);
  Object.assign(j, { status, doneAt: Date.now(), ...extra });
  joinByQ.delete(j.qid);
  for (const w of j.wake) w();
}
function joinAnswered(enrollId, result) {
  const j = joins.get(enrollId);
  joinByQ.delete(j?.qid);
  if (!j || j.status !== "pending") return;
  provider.onResolve?.(j.qid, result);   // the provider drops the question's button tokens
  if (result?.kind !== "selection" || result.value !== JOIN_ALLOW) {
    log(`join: ${j.name} denied on the phone (${result?.kind}${result?.value ? ` "${result.value}"` : ""})`);
    return finishJoin(j, "denied");
  }
  if (machines.active().some((m) => m.name === j.name)) {
    log(`join: ${j.name} approved, but that name was taken meanwhile — denied`);
    return finishJoin(j, "denied", { reason: "name_taken" });
  }
  const id = newMachineId(), token = newMachineToken(id);
  try { machines.add({ id, name: j.name, sha256: sha256hex(token), os: j.os, hostname: j.hostname, created_at: new Date().toISOString() }); }
  catch (e) { log("join: could not save machines.json:", e.message); return finishJoin(j, "denied", { reason: "save_failed" }); }
  log(`join: ${j.name} approved on the phone — machine ${id} added to ${machines.file}`);
  finishJoin(j, "approved", { token, machine: { id, name: j.name } });
}
function expireJoin(enrollId) {
  const j = joins.get(enrollId);
  if (!j || j.status !== "pending") return;
  log(`join: ${j.name} not answered within ${JOIN_TTL_MS / 1000}s — expired`);
  Promise.resolve(provider.cancelQuestion?.(j.qid, "join_expired")).catch((e) => log("cancelQuestion err", e.message))
    .finally(() => provider.onResolve?.(j.qid, { kind: "cancelled" }));
  finishJoin(j, "expired");
}
async function joinStart(req, res) {
  const { body, tooLarge } = await readBody(req, 4096);
  if (tooLarge) return refuseTooLarge(req, res, "request body too large");
  const a = jsonOf(body).v;
  if (!a || typeof a !== "object") return send(res, 400, { error: "bad JSON" });
  const name = String(a.name ?? "").trim().toLowerCase();
  if (!NAME_RE.test(name)) return send(res, 400, { error: "name must be 1–16 of a-z 0-9 - (starting with a letter or digit)" });
  if (!CODE_RE.test(String(a.code ?? ""))) return send(res, 400, { error: "code must look like ABC-234" });
  if (!/^[a-f0-9]{64}$/.test(String(a.enroll_secret_hash ?? ""))) return send(res, 400, { error: "enroll_secret_hash must be a hex SHA-256" });
  const open = [...joins.values()].filter((j) => j.status === "pending");
  if (open.length >= JOIN_MAX_OPEN) return send(res, 429, { error: `too many join requests waiting (${JOIN_MAX_OPEN})`, retry_after_s: Math.ceil(Math.max(1000, Math.min(...open.map((j) => j.expires)) - Date.now()) / 1000) });
  const since = Date.now() - lastJoinAt;
  if (since < JOIN_INTERVAL_MS) return send(res, 429, { error: "one join request per interval — try again later", retry_after_s: Math.ceil((JOIN_INTERVAL_MS - since) / 1000) });
  if (machines.active().some((m) => m.name === name) || open.some((j) => j.name === name)) return send(res, 409, { error: `a machine named "${name}" is already registered or joining — pick another --name, or revoke the old one on the hub (machines.mjs revoke ${name})` });
  lastJoinAt = Date.now();
  const enrollId = crypto.randomBytes(8).toString("hex"), qid = crypto.randomBytes(5).toString("hex");
  const j = { qid, name, os: shown(a.os, 24), hostname: shown(a.hostname, 64), code: a.code, secretHash: a.enroll_secret_hash, expires: Date.now() + JOIN_TTL_MS, status: "pending", wake: new Set() };
  joins.set(enrollId, j); joinByQ.set(qid, enrollId);
  try {
    await provider.sendQuestion(qid, {
      header: "🆕 新機器要加入",
      question: `${name}（${j.os}，主機名 ${j.hostname}）要加入這個 relay。\n核對碼：${j.code}\n先確認跟那台機器終端機上顯示的核對碼一樣，再按允許。不是你發起的就按拒絕。`,
      options: [JOIN_ALLOW, JOIN_DENY],
    });
  } catch (e) {
    log(`join: could not send ${name}'s join request to the phone: ${e.message}`);
    joins.delete(enrollId); joinByQ.delete(qid);
    return send(res, 503, { error: `the hub could not reach the phone: ${e.message}` });
  }
  j.timer = setTimeout(() => expireJoin(enrollId), JOIN_TTL_MS); j.timer.unref?.();
  log(`join: ${name} (${j.os}, host ${j.hostname}) asks to join — code ${j.code}, waiting for the tap (${JOIN_TTL_MS / 1000}s)`);
  send(res, 202, { enroll_id: enrollId, expires_at: new Date(j.expires).toISOString(), protocol: PROTOCOL });
}
async function joinPoll(req, res, enrollId) {
  const j = joins.get(enrollId);
  // unknown id and wrong secret look the same: 404
  if (!j || !sameHex(sha256hex(String(req.headers[ENROLL_SECRET_HEADER] || "")), j.secretHash)) return send(res, 404, { error: "no such join request" });
  // an approved token handed out before: the same secret gets it again within JOIN_TTL_MS of the first
  // hand-out (that reply may have been lost on the way back); past it the record is gone — judged here,
  // not left to the cleanup (which runs once a minute)
  if (j.collectedAt !== undefined && Date.now() - j.collectedAt >= JOIN_TTL_MS) { joins.delete(enrollId); return send(res, 404, { error: "no such join request" }); }
  if (j.status === "pending") {
    let timer, wake;
    await new Promise((r) => { timer = setTimeout(r, ANSWER_HOLD_MS); wake = r; j.wake.add(wake); });
    clearTimeout(timer); j.wake.delete(wake);
  }
  if (joins.get(enrollId) !== j) return send(res, 404, { error: "no such join request" }); // another poll collected it meanwhile
  if (j.status === "pending") return send(res, 200, { status: "pending", expires_at: new Date(j.expires).toISOString() });
  if (j.status === "approved") {
    j.collectedAt ??= Date.now(); // first hand-out only — asking again never extends it
    return send(res, 200, { status: "approved", machine_id: j.machine.id, name: j.machine.name, token: j.token, protocol: PROTOCOL });
  }
  joins.delete(enrollId); // denied / expired: handed out once (nothing to lose)
  return send(res, 200, { status: j.status, ...(j.reason ? { reason: j.reason } : {}) });
}
// finished join requests: one whose token was handed out is dropped a TTL after that (its machine stays);
// any other is dropped a TTL after it finished, and an approved one's machine is revoked then (its
// token was never handed out — nobody can use it)
if (machines) setInterval(() => {
  for (const [eid, j] of joins) {
    if (j.status === "pending") continue;
    if (j.collectedAt !== undefined) { if (Date.now() - j.collectedAt >= JOIN_TTL_MS) joins.delete(eid); continue; }
    if (Date.now() - j.doneAt < JOIN_TTL_MS) continue;
    if (j.status === "approved") {
      try { machines.revoke(j.machine.id); log(`join: ${j.name}'s token was never collected — machine ${j.machine.id} revoked`); }
      catch (e) { log(`join: could not revoke ${j.name}'s uncollected machine ${j.machine.id} (${e.message}) — trying again next time`); continue; }
    }
    joins.delete(eid);
  }
}, Math.min(60000, JOIN_TTL_MS)).unref();

// --- the remote listener (other machines' edge relays, through a tunnel) ------------------------
async function handleRemote(req, res) {
  const url = new URL(req.url, "http://x");
  const proto = req.headers[PROTOCOL_HEADER];
  if (proto !== undefined && String(proto).trim() !== String(PROTOCOL)) return send(res, 426, { error: `this hub speaks remote protocol ${PROTOCOL}`, protocol: PROTOCOL });
  // joining needs no machine token (the machine has none yet): rate-limited, approved by a human tap
  if (req.method === "POST" && url.pathname === "/machines/join") return joinStart(req, res);
  const jm = url.pathname.match(/^\/machines\/join\/([a-f0-9]{16})$/);
  if (req.method === "GET" && jm) return joinPoll(req, res, jm[1]);
  // everything else: a valid, unrevoked machine token first — unknown paths included (401, not 404)
  const m = machines.verify(bearerOf(req));
  if (!m) { log(`remote: 401 ${req.method} ${url.pathname} (machine token missing, wrong or revoked)`); return send(res, 401, { error: "machine token missing, wrong or revoked" }); }
  noteSeen(m, req);
  const scope = remoteScope(m);
  if (req.method === "GET" && url.pathname === "/health") {
    // no local paths, pids or counts of other machines here
    // bot_id: which bot this hub polls (Telegram: getMe's numeric id, the part of the token before ":")
    // — an edge with the same bot must not poll it too
    // features (0.21.0): what this hub takes beyond protocol 1 — "chat" when its provider has chat topics
    return send(res, 200, { ok: true, name: "myna-relay", version: VERSION, protocol: PROTOCOL, role: "hub", machine: { id: m.id, name: m.name }, bot_id: botIdentity(provider.name, cfg), features: FEATURES.filter((f) => f !== "chat" || !!provider.chatOpen) });
  }
  // chat through the hub (SPEC §5.2): an edge relays its sessions' /chat/* — scoped to its machine
  if (req.method === "POST" && /^\/chat\/(register|take|progress|nick|close)$/.test(url.pathname)) { await chat.handle(req, res, url, scope); return; }
  if (req.method === "POST" && url.pathname === "/ask") return handleAsk(req, res, scope);
  const am = url.pathname.match(/^\/answer\/([a-f0-9]+)$/);
  if (req.method === "GET" && am) return handleAnswer(res, am[1], scope);
  const cm = url.pathname.match(/^\/cancel\/([a-f0-9]+)$/);
  if (req.method === "POST" && cm) { const { body } = await readBody(req, SMALL_BODY_BYTES); return handleCancel(res, cm[1], scope, body); }
  if (req.method === "POST" && url.pathname === "/session/close") return handleSessionClose(req, res, scope);
  if (req.method === "POST" && url.pathname === "/session/round-end") return handleRoundEnd(req, res, scope);
  // /pair, /shutdown, /attest, /detach, /reattach, /requests, GET /chat/session … do not exist here
  send(res, 404, { error: `not available on the remote port (protocol ${PROTOCOL}): ${req.method} ${url.pathname}` });
}

// --- edge routing (MYNA_ROLE=edge) -------------------------------------------------------------------
// Which way a local request goes. Returns true when handled here, false → the normal local handlers
// (this machine's own bot, approvals, journal — exactly as on a single machine).
//   new question: hub active → forwarded; else own bot (if any); else the connection is dropped so the
//     client falls back to the terminal, as if no relay ran
//   /answer, /cancel: a question of the own bot → local; one forwarded → the hub (a short outage: pending
//     within MYNA_UPSTREAM_GRACE; past it → {kind:"unreachable"}, cancelled at the hub once back)
//   /attest: always local — an approval lives in the relay whose bot took the tap; one from the hub is
//     never asked for in this version (fail closed)
const dropConn = (req) => { req.socket.destroy(); };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function edgeForward(req, p, body, timeoutMs, extra = {}) {
  let r, text;
  try {
    r = await fetch(`${hub.url}${p}`, {
      method: req.method, headers: hub.headers({ ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }),
      ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    text = await r.text();
  } catch (e) { hub.markDown(`cannot connect (${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message})`); return { ok: false }; }
  let json = null; try { json = JSON.parse(text); } catch {}
  if (hub.failStatus(r.status)) { hub.markDown(hub.why(r.status, json)); return { ok: false }; }
  return { ok: true, status: r.status, json, text, type: r.headers.get("content-type") || "application/json" };
}
const relayBack = (res, r) => { res.writeHead(r.status, { "content-type": r.type }); res.end(r.text); };
async function edgeAnswer(req, res, id) {
  if (hub.abandoned.has(id)) return send(res, 200, { kind: "unreachable", error: `the hub was away for over ${hub.GRACE_MS / 1000}s — this question was given up (its buttons are retracted once the hub is back)` });
  if (hub.reachable) {
    const r = await edgeForward(req, `/answer/${id}`, undefined, ANSWER_HOLD_MS + 30000);
    if (r.ok) {
      if (r.status === 404 || (r.status === 200 && r.json?.kind && r.json.kind !== "pending")) { hub.forwarded.delete(id); hub.save(); }
      return relayBack(res, r);
    }
  }
  if (!hub.inGrace(id)) { edgeGraceCheck(); return hub.abandoned.has(id) ? edgeAnswer(req, res, id) : dropConn(req); }
  // a short outage: hold a moment, then "pending" — the client polls again
  const until = Date.now() + Math.min(ANSWER_HOLD_MS, 5000);
  while (Date.now() < until && !hub.reachable) await sleepMs(250);
  if (hub.reachable) return edgeAnswer(req, res, id);
  send(res, 200, { kind: "pending" });
}
async function edgeRoute(req, res, url) {
  const p = url.pathname, M = req.method;
  if ((M === "GET" && p === "/health") || (M === "POST" && p === "/shutdown") || p === "/attest") return false;
  // chat: through the hub when it forwards chat (SPEC §5.2), else this machine's own bot, else none
  if (p.startsWith("/chat/")) {
    const mode = chatMode();
    if (mode === "forwarded" || mode === "down") { await edgeChat.handle(req, res, url); return true; }
    if (mode === "own-bot") return false;
    if (M === "GET" && p === "/chat/session") { send(res, 200, { chat: false }); return true; }
    const hint = hub.features ? `${OLD_HUB_CHAT}，聊天沒有開` : "主節點還沒連上過、這台也沒有自己的 bot，聊天沒有開";
    send(res, 501, { error: `${p}: the hub does not forward chat (${hub.features ? `its Myna is older than 0.21.0` : "never reached"}) and this edge has no bot of its own`, hint }); return true;
  }
  if (p.startsWith("/pair/") || /^\/(detach|reattach)\//.test(p) || p === "/requests") {
    if (ownBot.on) return false;   // pairing / handoff of this machine's own bot
    if (p.startsWith("/pair/")) { send(res, 400, { error: `this machine is an edge (MYNA_ROLE=edge) without a bot of its own — pairing is done on the hub` }); return true; }
    send(res, 501, { error: `${p} is not available on an edge without a bot of its own (remote protocol ${PROTOCOL})` }); return true;
  }
  await hub.first;
  const am = p.match(/^\/answer\/([a-f0-9]+)$/), cm = p.match(/^\/cancel\/([a-f0-9]+)$/);
  if (M === "GET" && am) {
    const id = am[1];
    if (pending.has(id)) return false;
    // a held question: still waiting for the hub (pending, queued) — or how it ended
    if (hub.results.has(id)) { const r = hub.results.get(id); hub.results.delete(id); hub.save(); send(res, 200, r); return true; }
    if (hub.queued.has(id)) {
      const until = Date.now() + Math.min(ANSWER_HOLD_MS, 5000);
      while (Date.now() < until && hub.queued.has(id)) await sleepMs(250);
      if (hub.queued.has(id)) expireHeld();
      // it ended while we waited (over the cap, refused) — or went out to the hub: ask there
      if (hub.results.has(id)) { const r = hub.results.get(id); hub.results.delete(id); hub.save(); send(res, 200, r); return true; }
      if (!hub.queued.has(id)) { await edgeAnswer(req, res, id); return true; }
      send(res, 200, { kind: "pending", queued: true }); return true;
    }
    await edgeAnswer(req, res, id); return true;
  }
  if (M === "POST" && cm) {
    const id = cm[1];
    if (pending.has(id)) return false;
    await readBody(req, SMALL_BODY_BYTES);
    // a held question the client gave up on (answered in the terminal): it never goes out — and if a send
    // may have reached the hub, it is cancelled there once it is back
    if (hub.queued.has(id) || hub.results.has(id)) {
      const q = hub.queued.get(id);
      hub.queued.delete(id); hub.results.delete(id);
      if (q?.tried) hub.abandoned.add(id);
      hub.save(); send(res, 200, { cancelled: !!q }); return true;
    }
    if (hub.reachable) { const r = await edgeForward(req, `/cancel/${id}`, "{}", 10000); if (r.ok) { hub.forwarded.delete(id); hub.save(); return relayBack(res, r), true; } }
    if (hub.forwarded.has(id)) { hub.forwarded.delete(id); hub.abandoned.add(id); hub.save(); send(res, 200, { cancelled: true, queued: true }); return true; }
    dropConn(req); return true;
  }
  if (M === "POST" && p === "/ask") {
    const pre = await readBody(req, ASK_MAX_BYTES);
    if (pre.tooLarge) { refuseTooLarge(req, res, `request body over ${ASK_MAX_BYTES} bytes`); return true; }
    if (hub.active) {
      // the edge picks the request id (X-Myna-Request-Id): when the forward fails it still knows which
      // question the hub may have put on the phone (the reply lost in a broken link), and cancels it
      // there once the hub is back — a copy that might exist does not stay answerable
      const rid = crypto.randomBytes(5).toString("hex");
      const r = await edgeForward(req, "/ask", pre.body, 30000, { [REQUEST_ID_HEADER]: rid });
      if (r.ok) { if (r.status === 200 && r.json?.request_id) { hub.forwarded.set(String(r.json.request_id), { at: Date.now() }); hub.save(); } relayBack(res, r); return true; }
      // the send may have reached the hub: held, it goes out again under the same id (the hub answers it
      // with the same request); not held, it is given up and cancelled there once the hub is back
      if (hold().on) { holdAsk(res, rid, pre.body, true); return true; }
      hub.abandoned.add(rid); hub.save();
    }
    if (hold().on) { holdAsk(res, crypto.randomBytes(5).toString("hex"), pre.body, false); return true; }
    if (ownBot.on) { log(`hub away (${hub.reason}) — asking on this machine's own bot`); await handleAsk(req, res, LOCAL_SCOPE, pre); return true; }
    dropConn(req); return true;
  }
  if (M === "POST" && (p === "/session/close" || p === "/session/round-end")) {
    // both places may hold this session's topics: the hub's and this machine's own bot's
    const pre = await readBody(req, SMALL_BODY_BYTES);
    const r = hub.reachable ? await edgeForward(req, p, pre.body || "{}", 10000) : { ok: false };
    if (ownBot.on) { await (p === "/session/close" ? handleSessionClose : handleRoundEnd)(req, res, LOCAL_SCOPE, pre); return true; }
    if (r.ok) { relayBack(res, r); return true; }
    dropConn(req); return true;
  }
  if (!hub.reachable && !ownBot.on) { dropConn(req); return true; } // GET / and the like: "is a relay there?"
  return false;
}
// a question asked while the hub is away, held for it: the client gets its id and polls it
function holdAsk(res, id, body, tried) {
  const { v: args, err } = jsonOf(body);
  if (err) return send(res, 400, { error: `bad JSON: ${err.message}` });
  const problems = validateAskArgs(args);
  if (problems.length) { log("rejecting /ask (400):", problems.join("; ")); return send(res, 400, { error: problems.join("; ") }); }
  hub.queued.set(id, { body, at: Date.now(), ...(args.session_id ? { session_id: String(args.session_id) } : {}), ...(tried ? { tried: true } : {}) });
  hub.save();
  log(`hub away (${hub.reason}) — question ${id} held for it (${hub.queued.size} held)`);
  send(res, 200, { request_id: id, queued: true });
}
const holdHealth = () => {
  const s = hold(), oldest = Math.min(...[...hub.queued.values()].map((q) => q.at));
  return { on: s.on, max_s: s.max_s, source: s.source, ...(s.bad ? { bad: s.bad } : {}), queued: hub.queued.size, oldest_at: hub.queued.size ? new Date(oldest).toISOString() : null, waiting: hub.forwarded.size };
};
const edgeHealth = () => ({
  upstream: { url: hub.url, reachable: hub.reachable, active: hub.active, reason: hub.reason || undefined, since: new Date(hub.since).toISOString(), version: hub.version, protocol: hub.protocol, machine: hub.machine, bot_id: hub.bot, cf_access: hub.cf, forwarded: hub.forwarded.size, abandoned: hub.abandoned.size,
    features: hub.features, chat: chatMode(), ...(CHAT_FORWARD ? {} : { chat_forward: "off" }), ...(edgeChat ? { chat_sessions: edgeChat.count(), chat_held: edgeChat.held() } : {}), hold: holdHealth() },
  own_bot: { on: ownBot.on, id: ownBot.id, ...(ownBot.reason ? { reason: ownBot.reason } : {}) },
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  // the local listener takes no credentials — refuse what is not a local client:
  //   always: a non-loopback Host (DNS rebinding from a web page) and a browser request (Origin; a page
  //     could otherwise POST /ask, /shutdown, /pair/start). Local clients (Node fetch, curl, hooks)
  //     send neither. /chat/* is exempt from the Origin check: it authenticates with its own secrets.
  //   multi-machine only: a request a proxy forwarded (a tunnel pointed at this port by mistake) — only
  //     there does a tunnel run next to the relay.
  const refused = localRefusal(req, { checkOrigin: !url.pathname.startsWith("/chat/"), checkProxy: MULTI });
  if (refused) { log(`local: 403 ${req.method} ${url.pathname} — ${refused}`); return send(res, 403, { error: refused }); }
  // MYNA_LOCAL_AUTH=1: everything but GET /health and /chat/* (their own secrets) carries the relay secret — on an
  // edge too, before anything is forwarded to its hub
  if (LOCAL_AUTH && !localExempt(req.method, url.pathname) && !chat.secretOk(req.headers[LOCAL_SECRET_HEADER])) {
    log(`local: 401 ${req.method} ${url.pathname} — no relay secret (MYNA_LOCAL_AUTH is on)`);
    req.resume();
    return send(res, 401, { error: `local auth is on (MYNA_LOCAL_AUTH): send the relay secret (${path.join(path.dirname(ENV_PATH), "relay-secret")}) in X-Myna-Local-Secret` });
  }
  if (EDGE && await edgeRoute(req, res, url)) return;
  if (await chat.handle(req, res, url)) return;
  if (req.method === "GET" && url.pathname === "/health") {
    // identity + liveness for ensure-relay / `/myna:relay status`. `pending` = gates still waiting
    // for a human answer (ensure-relay will not replace a stale relay while one is open).
    let open = 0; for (const p of pending.values()) if (p.result === undefined) open++;
    if (EDGE) open += hub.forwarded.size + hub.queued.size; // questions waiting on (or held for) the hub count too
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "myna-relay", version: VERSION, provider: provider.name, pid: process.pid, root: ROOT, started_at: STARTED_AT, pending: open, detached: [...pending.values()].filter((p) => p.detached).length, handoff: true, attest: true, approval_ttl_ms: APPROVAL_TTL_MS, journal: PENDING_FILE, chat: !!provider.chatOpen, chat_sessions: chat.count(), net_attempt_ms: NET_ATTEMPT_MS,
      role: ROLE, protocol: PROTOCOL, machine: MACHINE_NAME, local_auth: LOCAL_AUTH, ...(EDGE ? edgeHealth() : {}), remote: REMOTE_PORT ? { port: REMOTE_PORT, listening: remoteListening, machines: machines.active().length, joining: [...joins.values()].filter((j) => j.status === "pending").length } : null }));
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
  if (req.method === "POST" && url.pathname === "/session/close") return handleSessionClose(req, res, LOCAL_SCOPE);
  if (req.method === "POST" && url.pathname === "/session/round-end") return handleRoundEnd(req, res, LOCAL_SCOPE);
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
        // bound to (machine, session, command): this listener is the hub's own machine — another
        // machine's approval never matches here, whatever session id is given
        if ((ap.machine_id || LOCAL_ID) !== LOCAL_ID || ap.session_id !== a.session_id || ap.command !== command) continue;
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
  if (req.method === "POST" && url.pathname === "/ask") return handleAsk(req, res, LOCAL_SCOPE);
  const cm = url.pathname.match(/^\/cancel\/([a-f0-9]+)$/);
  if (req.method === "POST" && cm) { const { body } = await readBody(req, SMALL_BODY_BYTES); return handleCancel(res, cm[1], LOCAL_SCOPE, body); }
  const m = url.pathname.match(/^\/answer\/([a-f0-9]+)$/);
  if (req.method === "GET" && m) return handleAnswer(res, m[1], LOCAL_SCOPE);
  const dm = url.pathname.match(/^\/(detach|reattach)\/([a-f0-9]+)$/);
  if (req.method === "POST" && dm) {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      let args = {}; try { args = JSON.parse(body || "{}"); } catch {}
      const sid = args.session_id ? String(args.session_id) : "";
      const [, op, id] = dm;
      const entry = pending.get(id);
      const reply = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (!entry || entry.deliveredAt !== undefined) return reply(404, { error: "no such request (already answered and collected, cancelled, or expired)" });
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
      if (p.deliveredAt !== undefined) continue;                           // handed out to its remote machine: over
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
  log(`relay v${VERSION} http on http://127.0.0.1:${PORT}  provider=${provider.name}  root=${ROOT}  net_attempt_ms=${NET_ATTEMPT_MS ?? "(Node default)"}  local_auth=${LOCAL_AUTH ? "on" : "off"}`);
  if (adopted && (adopted.open || adopted.answered)) log(`adopted ${adopted.open} open gate(s) + ${adopted.answered} answered-uncollected (${adopted.detached} detached) from the previous relay (v${adopted.from || "?"}, journal ${adopted.saved_at}) — buttons already on the phone stay valid`);
  if (EDGE) log(`edge → hub ${hub.url} (${hub.reachable ? "reachable" : `not reachable: ${hub.reason}`}; CF Access headers ${hub.cf ? "on" : "off"}); own bot: ${ownBot.on ? `${ownBot.id || provider.name} — fallback while the hub is away` : ownBot.reason}`);
  provider.start();
  // machines revoked while no relay ran: checked once this process owns the port (a second relay that
  // exits above never touches the journal) — now, or at the first good read of machines.json
  listening = true;
  if (machines?.loaded()) revokedWhileDown();
  // the remote listener starts only once this process owns the local port (a second relay exits above)
  if (REMOTE_PORT) {
    // a request must arrive whole within 30 s (headers within 15 s) — a slow or never-ending body cannot
    // hold a socket for long; the time spent answering (the /answer long-poll) does not count
    const remote = http.createServer({ requestTimeout: 30000, headersTimeout: 15000, connectionsCheckingInterval: 5000 }, (req, res) => {
      handleRemote(req, res).catch((e) => { log("remote handler error:", e.message); try { send(res, 500, { error: "internal error" }); } catch {} });
    });
    // a port someone else holds: say so loudly, keep serving this machine (the local side is unaffected)
    remote.on("error", (e) => log(`remote listener on 127.0.0.1:${REMOTE_PORT} failed: ${e.message} — other machines cannot reach this hub until it is fixed (restart the relay)`));
    remote.listen(REMOTE_PORT, "127.0.0.1", () => {
      remoteListening = true;
      log(`remote listener on http://127.0.0.1:${REMOTE_PORT} (protocol ${PROTOCOL}) — ${machines.active().length} machine(s) in ${machines.file}; point the tunnel here, never at :${PORT}`);
    });
  }
});
