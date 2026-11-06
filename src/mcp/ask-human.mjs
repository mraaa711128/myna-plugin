#!/usr/bin/env node
// Myna — ask_human MCP server (per machine, one per claude session; connects to the local relay).
// Blocking MCP tool: relays a gated decision to the local relay (→ Telegram/Discord/Slack) and
// waits for the human's answer; or, in autopilot, auto-accepts the recommended option and logs it.
// Returns a discriminated result as JSON text: {kind:'selection'|'message'|'aborted'|'unreachable', ...}.
// Session handoff: detach_human hands this process's waiting questions off (the pending calls return
// {kind:'detached', request_id}; exiting no longer cancels them); await_human in another session — or
// this same session after its process died — reattaches one by request id and blocks on its answer.
//
// Load-bearing config on EACH machine's .mcp.json (verified in spike — survives long blocks):
//   "myna": { "command":"node", "args":[".../src/mcp/ask-human.mjs"], "timeout": 86400000 }
//   (+ env CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { validateAskArgs } from "../providers/util.mjs";

const RELAY = process.env.MYNA_RELAY_URL || "http://127.0.0.1:7800";
const AUTOPILOT_FILE = process.env.MYNA_AUTOPILOT_FILE || path.join(os.homedir(), ".myna", "autopilot");
const HEARTBEAT_MS = Number(process.env.MYNA_HEARTBEAT_MS || 15000);
// each /answer poll is a short request (relay returns {kind:"pending"} after ~25s); allow a little
// more than the relay's hold before the client aborts and retries the poll.
const ANSWER_POLL_MS = Number(process.env.MYNA_ANSWER_POLL_MS || 35000);
const log = (...a) => console.error(`[myna ${new Date().toISOString()}]`, ...a);

// Session identity — one MCP server process per Claude Code process. Using Claude's session id lets
// the Stop hook (which gets the same id as `session_id`) tell the relay "this session finished its
// reply" → the current gate's topic ends, and lets the relay put the questions into the session's
// chat topic. The id is looked up at each use, not once at startup: an in-app /resume or /clear
// keeps this process but switches the session. Order: MYNA_SESSION_ID (explicit override)
// → <claude config dir>/sessions/<ppid>.json, which Claude Code keeps current for the process that
// spawned us → CLAUDE_CODE_SESSION_ID (the session at spawn time) → a process-lifetime random id
// (older Claude Code / other hosts: still groups the session; only the reply-end cleanup is lost).
// The relay's IM provider groups a session's gates (Telegram: one topic per gate, named
// "<gate> · <ticket> · <dir> <start time>"). Override the label with MYNA_SESSION_NAME when the
// cwd basename is not descriptive.
const FALLBACK_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || crypto.randomBytes(4).toString("hex");
const SESSIONS_FILE = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "sessions", `${process.ppid}.json`);
function liveSessionId() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    if (s?.pid === process.ppid && typeof s.sessionId === "string" && s.sessionId) return s.sessionId;
  } catch {}
  return "";
}
let lastSessionId = "";
function sessionId() {
  const id = process.env.MYNA_SESSION_ID || liveSessionId() || FALLBACK_SESSION_ID;
  if (lastSessionId && id !== lastSessionId) {
    log(`session changed ${lastSessionId} → ${id} (in-app /resume or /clear)`);
    retireSession(lastSessionId);
  }
  lastSessionId = id;
  return id;
}
const SESSION_BASE = process.env.MYNA_SESSION_NAME || (() => {
  const d = new Date(), two = (n) => String(n).padStart(2, "0");
  return `${path.basename(process.cwd()) || "session"} ${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
})();
// Ticket key (an issue key such as PROJ-1234, supplied by the caller) labels the topic — "PROJ-1234 · <dir> <time>".
// The caller owns the ticket: the call's `ticket` arg (per ask) or MYNA_TICKET (session default).
// Myna deliberately does NOT sniff it out of the git branch or the `header` text — that bakes one
// team's naming convention into the tool and misfires on things like "UTF-8" or a mid-session
// checkout the model never asked to be reflected. A session that works through several tickets in
// sequence re-labels its topic each time `ticket` changes (editForumTopic on the relay side) — one
// topic, current ticket in its name.
const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;
const ticketIn = (s) => (typeof s === "string" && s.match(TICKET_RE)?.[0]) || "";
let sessionTicket = ticketIn(String(process.env.MYNA_TICKET || "").toUpperCase());
const sessionName = () => (sessionTicket ? `${sessionTicket} · ${SESSION_BASE}` : SESSION_BASE);
// pick this call's ticket: explicit arg > whatever the session already has
const currentTicket = (args) => ticketIn(String(args.ticket || "").toUpperCase()) || sessionTicket;
// sessions this process asked under — only tell the relay about a session that actually reached the
// phone. Usually one; more after an in-app /resume or /clear switched the session mid-process.
const askedSessions = new Set();
// requests this process is still waiting on — cancelled at the relay if the call is cancelled
// (the human answered in the terminal / pressed Esc) or the process exits, so the phone never keeps
// buttons for a question nobody awaits and the gate's topic can be cleaned up. detach_human takes a
// request out of this set: it is handed off, and this process's exit must not cancel it.
const inflight = new Set();
const requestSession = new Map(); // request_id → the session it was asked (or reattached) under
const cancelAtRelay = (request_id) => fetch(`${RELAY}/cancel/${request_id}`, { method: "POST", signal: AbortSignal.timeout(1500) }).catch(() => {});
const closeAtRelay = (session_id) => fetch(`${RELAY}/session/close`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ session_id }), signal: AbortSignal.timeout(1500),
}).catch(() => {});
// the session switched away: wrap up the old one's topics now (as its process exit would have),
// unless one of its questions is still waiting here — then the exit does it
function retireSession(id) {
  if (!askedSessions.has(id) || [...inflight].some((r) => requestSession.get(r) === id)) return;
  askedSessions.delete(id);
  closeAtRelay(id);
}

// fetch JSON with a small transient-error retry. Idempotent GET /answer is always safe to retry;
// a POST /ask that throws did so on a stale localhost keep-alive socket BEFORE delivery (undici
// resets on first write to a dead pooled socket), so a fresh-socket retry won't double-send.
// delayMs between attempts lets the poll ride out a relay restart/upgrade (ensure-relay swaps the
// process in ~1–2s; the new relay adopts the open gate from its journal, so the poll just resumes).
async function fetchRelayJson(url, opts, tries = 2, delayMs = 0) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      return { status: r.status, json: await r.json().catch(() => ({})) };
    } catch (e) { lastErr = e; if (delayMs && i < tries - 1) await new Promise((r) => setTimeout(r, delayMs)); }
  }
  throw lastErr;
}
const ANSWER_POLL_TRIES = Number(process.env.MYNA_ANSWER_POLL_TRIES || 8);   // × 1s gap ≈ how long a relay may be down mid-gate

const autopilotOn = () => { try { return fs.existsSync(AUTOPILOT_FILE); } catch { return false; } };

function recommendedIdx(args) {
  if (Number.isInteger(args.recommendedIndex)) return args.recommendedIndex;
  const i = (args.options || []).findIndex((o) => /\(recommended\)/i.test(o));
  return i >= 0 ? i : -1;
}

// Decision audit trail — jsonl (source of truth) + md (human view). Written into logDir
// (the run's worktree, passed per-call) or cwd, so decisions travel with the branch into the PR.
function logDecision(rec, logDir) {
  try {
    const base = logDir || process.env.MYNA_LOG_DIR || process.cwd();
    fs.appendFileSync(path.join(base, "MYNA-DECISIONS.jsonl"), JSON.stringify(rec) + "\n");
    const md = path.join(base, "MYNA-DECISIONS.md");
    if (!fs.existsSync(md)) fs.writeFileSync(md, "# Myna decisions\n\n| time | mode | header | question | chosen |\n|---|---|---|---|---|\n");
    const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    fs.appendFileSync(md, `| ${rec.ts} | ${rec.mode} | ${cell(rec.header)} | ${cell(rec.question)} | ${cell(JSON.stringify(rec.chosen))} |\n`);
  } catch (e) { log("logDecision failed:", e.message); }
}

// "question x of y" of a gate asking several related questions — kept in the decision log with the answer
const partOf = (a) => (a.questionNumber && a.questionTotal ? { questionNumber: a.questionNumber, questionTotal: a.questionTotal } : {});

const relayPost = (p, body) => fetchRelayJson(`${RELAY}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
}, 2);
const textResult = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const toolError = (text) => ({ isError: true, content: [{ type: "text", text }] });

// Block on a request's answer (shared by ask_human and await_human): heartbeat keeps the long call
// alive; a cancelled call (Esc / answered in the terminal) cancels it at the relay. Returns the
// discriminated result — {kind:"detached"} when a detach_human handed it off meanwhile.
async function waitForAnswer(request_id, extra, progressToken) {
  const started = Date.now();
  const heartbeat = setInterval(async () => {
    const secs = Math.round((Date.now() - started) / 1000);
    log(`waiting ${secs}s for human… (${request_id})`);
    if (progressToken !== undefined && extra?.sendNotification) {
      try { await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: secs, message: `waiting ${secs}s` } }); } catch {}
    }
  }, HEARTBEAT_MS);
  inflight.add(request_id);
  const signal = extra?.signal;
  const onCancel = () => {
    if (!inflight.has(request_id)) return; // handed off — cancelling the call must not cancel the question
    log(`call cancelled by the client — cancelling ${request_id} at the relay`); cancelAtRelay(request_id);
  };
  if (signal?.aborted) onCancel(); else signal?.addEventListener("abort", onCancel, { once: true });
  // Bounded long-poll loop: the relay returns {kind:"pending"} every ~25s; re-poll on a fresh
  // short-lived socket until a terminal kind. This is what makes a slow human (>5 min) safe —
  // no single socket ever approaches undici's 300s headersTimeout (the old fetch-failed cause).
  try {
    let heldSaid = false;
    for (;;) {
      if (signal?.aborted) return { kind: "cancelled" };
      const { status, json } = await fetchRelayJson(`${RELAY}/answer/${request_id}`, { signal: AbortSignal.timeout(ANSWER_POLL_MS) }, ANSWER_POLL_TRIES, 1000);
      if (status === 404) return { kind: "unreachable", error: "relay lost the request (restarted without its journal?)" };
      // an edge holding the question while its hub is away (SPEC §5.2): said once, then wait as usual
      if (json?.kind === "pending" && json.queued && !heldSaid) { heldSaid = true; log(`${request_id}: 主節點連不上，這題先排著，恢復後送到手機`); }
      if (json?.kind === "pending") continue;
      return json;
    }
  } finally {
    inflight.delete(request_id);
    requestSession.delete(request_id);
    signal?.removeEventListener("abort", onCancel);
    clearInterval(heartbeat);
  }
}

const mcp = new Server({ name: "myna", version: "0.1.0" }, { capabilities: { tools: {} } });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "ask_human",
    description:
      "Ask the human a gated decision. BLOCKS until they answer on their phone (Telegram/Discord/Slack); returns a discriminated result as JSON: " +
      "{kind:'selection',value} | {kind:'message',text} | {kind:'aborted'} | {kind:'unreachable'} | {kind:'detached',request_id} (handed off with detach_human — another session takes it over with await_human). " +
      "kind='message' means the human replied with free text (a clarifying question) — respond to it and call again with the SAME thread_id (put your reply in preamble) to continue the conversation. " +
      "Tag each question with `gate` (the same short name for every question of one decision) so each gate gets its own IM topic. " +
      "Several gates may be open at once (e.g. parallel calls): each keeps its own topic and every answer is tied to its own question. " +
      "To get a guard-blocked command approved, pass it in `approves` and start the approving option — and only that one — with \"✅\": tapping it on the phone lets exactly that one command line through ONCE. " +
      "In autopilot mode this auto-accepts the recommended option (needs recommendedIndex) and logs it instead of asking (never for a question with `approves`).",
    inputSchema: {
      type: "object",
      properties: {
        header: { type: "string", description: "short chip label, e.g. 'AC scope'" },
        question: { type: "string", description: "the question text only — plain prose, no markup; choices go in `options`, never inline here" },
        options: { type: "array", items: { type: "string" }, minItems: 1, description: "REQUIRED structured choices — JSON array of short label strings; the phone renders them as numbered buttons" },
        multiSelect: { type: "boolean" },
        recommendedIndex: { type: "integer", description: "0-based index of the recommended option; enables autopilot auto-accept" },
        thread_id: { type: "string", description: "reuse across rounds to keep the same Telegram thread" },
        gate: { type: "string", description: "short name of the decision gate this question belongs to (e.g. 'gate② space-time', 'AC scope'). A gate may be 1..n questions: pass the SAME value for all of them; a NEW value starts a new gate with a fresh IM topic named after it. Starting a new gate cleans up only the session's gates with nothing left to answer — a gate whose question is still waiting keeps its topic and stays answerable, and later questions with its name go back into it. May be omitted on re-asks after a ✍️ reply (same thread_id → that thread's gate; otherwise the gate asked last)." },
        questionNumber: { type: "integer", minimum: 1, description: "x of 'question x/y' when this gate asks several related questions (e.g. in parallel); shown as '第 x/y 題' only together with questionTotal" },
        questionTotal: { type: "integer", minimum: 1, description: "y of 'question x/y': how many related questions this gate asks; shown only together with questionNumber" },
        ticket: { type: "string", description: "issue key this session is working on (e.g. 'PROJ-1234'); labels this session's IM topic (renamed in place when it changes). Falls back to MYNA_TICKET when omitted; never inferred from the branch or header." },
        preamble: { type: "string", description: "your reply to the human's last message, shown above the question" },
        logDir: { type: "string", description: "absolute dir to write the decision log (MYNA-DECISIONS.jsonl/.md); pass the run's worktree cwd so decisions travel with the branch. Defaults to cwd." },
        approves: { type: "string", maxLength: 2000, description: "OPTIONAL — when this question asks the human to approve running one command that a guard blocks (e.g. a push to main, merging a PR): the ONE full command line to run once approved, exactly as you will run it (≤2000 chars; printable characters and newlines only — tabs, control characters and invisible/bidi characters such as U+200B or U+202E are rejected). EXACTLY ONE option, the approving one, MUST start with \"✅\" (e.g. '✅ 核准執行'); no other option may (two ✅ options are rejected). The phone shows the command verbatim under '核准後執行：'. If the human taps the ✅ option on their phone, the relay records an approval that lets exactly this command (whitespace-normalized, same session) through the guard ONCE within its TTL (default 15 min); a ✍️ reply, another option, a cancel or a terminal answer approves nothing. To run a different command, ask again. Autopilot never approves: a question with `approves` always goes to the human." },
      },
      required: ["question", "options"],
    },
  }, {
    name: "detach_human",
    description:
      "Hand off ask_human questions this process is still waiting on, so ANOTHER Claude session can take them over with await_human (e.g. before this session ends). " +
      "The phone's message, buttons and topic stay as they are; the pending ask_human calls return {kind:'detached', request_id}; ending this session no longer cancels them. " +
      "Returns {detached:[{request_id, gate, thread_id, header, question, until}], failed:[...]}. Pass each request_id to the session that takes over; " +
      "if none reattaches before `until` (relay's MYNA_DETACH_TTL, default 30 min) the question is cancelled as usual.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "hand off only this request (default: every question this process is waiting on)" },
      },
    },
  }, {
    name: "await_human",
    description:
      "Take over a question another session handed off (detach_human) — or one this same session left waiting when its previous process died — and BLOCK until the human answers it. " +
      "Returns the same discriminated result as ask_human. With request_id: reattach that request. Without: look for this session's own questions that no process is waiting on " +
      "→ exactly one: reattach it; none: {kind:'none'}; several: {kind:'choose', requests:[...]} — call again with one request_id.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "request id returned by detach_human (or the ask_human {kind:'detached'} result)" },
        logDir: { type: "string", description: "absolute dir to write the decision log (MYNA-DECISIONS.jsonl/.md). Defaults to cwd." },
      },
    },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  if (req.params.name === "detach_human") return detachHuman(req.params.arguments || {});
  if (req.params.name === "await_human") return awaitHuman(req.params.arguments || {}, req, extra);
  if (req.params.name !== "ask_human") throw new Error(`unknown tool: ${req.params.name}`);
  const args = req.params.arguments || {};
  const ts = new Date().toISOString();
  const machine = os.hostname();

  // --- validate BEFORE anything touches the phone. A malformed tool call (markup
  // residue absorbing the options array) must bounce back to the model as an immediate,
  // self-correcting error — never a silent broken menu on Telegram, never an unreachable fallback.
  const problems = validateAskArgs(args);
  if (problems.length) {
    log(`rejecting ask_human call: ${problems.join("; ")}`);
    return {
      isError: true,
      content: [{ type: "text", text: [
        "ask_human REJECTED — the call's parameters are malformed; NOTHING was sent to the human:",
        ...problems.map((p) => `- ${p}`),
        "",
        "Re-issue the ask_human call NOW with clean parameters:",
        "- `question`: the question text only — short, no <tag> markup of any kind.",
        "- `options`: a JSON array of short label strings (one per choice). NEVER write the choices inside `question`.",
        "- Keep the same `thread_id` if this is a follow-up round; put your reply to the human in `preamble`.",
        "This is usually a transient tool-call serialization glitch — rewrite the parameters, don't change the content.",
      ].join("\n") }],
    };
  }

  // --- autopilot: auto-accept the recommended option, no relay, log it ---
  // An approval (approval attestation) only exists when a human taps ✅ on the phone — an auto-accept could never let
  // the guarded command through, so a question with `approves` always goes to the human.
  if (autopilotOn() && args.approves !== undefined) log("autopilot ON but the question carries `approves` → asking the human (only a human tap approves)");
  else if (autopilotOn()) {
    const ri = recommendedIdx(args);
    if (ri >= 0 && (args.options || [])[ri] !== undefined) {
      const value = args.options[ri];
      logDecision({ ts, answered_at: new Date().toISOString(), machine, mode: "auto", ...(args.gate ? { gate: args.gate } : {}), ...partOf(args), header: args.header, question: args.question, options: args.options, recommendedIndex: ri, chosen: value }, args.logDir);
      log(`autopilot auto-accepted [${ri}] ${JSON.stringify(value)}`);
      return { content: [{ type: "text", text: JSON.stringify({ kind: "selection", value, auto: true }) }] };
    }
    log("autopilot ON but no recommended option → falling back to relay (safety: never guess)");
  }

  // --- relay to phone, block for the answer (heartbeat keeps the long call alive) ---
  try {
    const t = currentTicket(args);
    if (t && t !== sessionTicket) { log(`session ticket ${sessionTicket || "(none)"} → ${t} — topic will be re-labelled`); sessionTicket = t; }
    const sid = sessionId();
    const asked = await fetchRelayJson(`${RELAY}/ask`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...args, session_id: sid, session_name: sessionName() }),
    }, 2);
    askedSessions.add(sid);
    // relay-side validation rejected the args (second line of defense) — surface it as a
    // tool error so the model fixes the call; falling back to the local picker would be WRONG here.
    if (asked.status === 400) {
      log(`relay rejected /ask (400): ${asked.json?.error}`);
      return toolError(`ask_human REJECTED by relay — fix the parameters and re-call (do NOT fall back to AskUserQuestion): ${asked.json?.error || "invalid arguments"}`);
    }
    const request_id = asked.json?.request_id;
    if (!request_id) throw new Error("relay /ask returned no request_id");
    requestSession.set(request_id, sid);
    const result = await waitForAnswer(request_id, extra, req.params?._meta?.progressToken);
    const answered_at = new Date().toISOString(); // when this server got the answer (ts = when it was asked)
    if (result.kind === "selection") {
      logDecision({ ts, answered_at, machine, mode: "human", ...(args.gate ? { gate: args.gate } : {}), ...partOf(args), header: args.header, question: args.question, options: args.options, chosen: result.value, ...(args.approves !== undefined ? { approves: args.approves } : {}) }, args.logDir);
    }
    return textResult(result);
  } catch (e) {
    log(`relay unreachable: ${e.message} → {kind:'unreachable'} (orchestrator should fall back to local gate)`);
    return textResult({ kind: "unreachable", error: e.message });
  }
});

// detach_human: hand this process's waiting questions off to whichever session reattaches them.
// A request leaves `inflight` only once the relay confirmed the detach — until then an exit still
// cancels it (better than an orphan nobody can find). The relay wakes the pending ask_human poll,
// which returns {kind:"detached"}.
async function detachHuman(args) {
  const ids = args.request_id ? [String(args.request_id)] : [...inflight];
  const detached = [], failed = [];
  for (const id of ids) {
    try {
      const { status, json } = await relayPost(`/detach/${id}`, { session_id: requestSession.get(id) || sessionId() });
      if (status === 200 && json?.detached) {
        inflight.delete(id);
        const { detached: _, answered, ...info } = json;
        detached.push(info);
      } else failed.push({ request_id: id, error: json?.error || `relay answered ${status}` });
    } catch (e) { failed.push({ request_id: id, error: `relay unreachable: ${e.message}` }); }
  }
  log(`detach_human: ${detached.length} handed off, ${failed.length} failed`);
  return textResult({ detached, failed, ...(ids.length ? {} : { note: "no question is waiting in this process" }) });
}

// await_human: reattach a handed-off request (or this session's own orphan) and block on its answer.
async function awaitHuman(args, req, extra) {
  const ts = new Date().toISOString();
  try {
    let id = args.request_id ? String(args.request_id) : "";
    const sid = sessionId();
    if (!id) {
      const { json } = await fetchRelayJson(`${RELAY}/requests?session_id=${encodeURIComponent(sid)}`, { signal: AbortSignal.timeout(5000) }, 2);
      const orphans = (json?.requests || []).filter((r) => r.detached || !r.attended);
      if (!orphans.length) return textResult({ kind: "none", note: "no question of this session is waiting without a process" });
      if (orphans.length > 1) return textResult({ kind: "choose", requests: orphans.map(({ request_id, gate, thread_id, header, question, created, detached }) => ({ request_id, gate, thread_id, header, question, created, detached })) });
      id = orphans[0].request_id;
    }
    const { status, json: info } = await relayPost(`/reattach/${id}`, { session_id: sid, session_name: sessionName() });
    if (status !== 200) return toolError(`await_human: could not reattach ${id} — ${info?.error || `relay answered ${status}`}`);
    askedSessions.add(sid); // this session now owns a question at the relay → close it on exit
    requestSession.set(id, sid);
    log(`reattached ${id}${info.gate ? ` (gate "${info.gate}")` : ""}`);
    const result = await waitForAnswer(id, extra, req.params?._meta?.progressToken);
    const answered_at = new Date().toISOString();
    if (result.kind === "selection") {
      logDecision({ ts, answered_at, machine: os.hostname(), mode: "human", ...(info.gate ? { gate: info.gate } : {}), header: info.header, question: info.question, options: info.options, chosen: result.value, ...(info.approves !== undefined ? { approves: info.approves } : {}), reattached: id }, args.logDir);
    }
    return textResult({ ...result, request_id: id });
  } catch (e) {
    log(`relay unreachable: ${e.message} → {kind:'unreachable'}`);
    return textResult({ kind: "unreachable", error: e.message });
  }
}

// Session end (Claude Code closes our stdin / signals us): cancel what this process still waits on
// (nobody will collect those answers; handed-off ones are no longer in inflight), then tell the relay so the provider can wrap up the session's
// IM grouping (Telegram closes the topic). The relay defers the close while another process of the
// same Claude session still has a gate open. Best-effort, short timeouts — never delays exit
// noticeably, never matters if the relay is already gone.
let closing = false;
async function endSession() {
  if (closing) return; closing = true;
  await Promise.all([...inflight].map(cancelAtRelay));
  await Promise.all([...askedSessions].map(closeAtRelay));
  process.exit(0);
}
process.stdin.on("end", endSession);
process.stdin.on("close", endSession);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, endSession);

await mcp.connect(new StdioServerTransport());
log(`myna ask_human connected (relay=${RELAY}, autopilot=${autopilotOn()}, session=${sessionId()} "${sessionName()}")`);
