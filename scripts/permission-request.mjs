#!/usr/bin/env node
// PermissionRequest hook — a permission dialog nobody answers at the terminal goes to the phone.
//
// Claude Code shows its dialog and runs this hook at the same time; whichever answers first wins
// (live-verified in a real TUI): the phone's allow/deny closes the dialog, a terminal answer
// makes the hook's answer moot. So:
//   1. wait MYNA_PERMISSION_DELAY seconds (default 30) — someone at the desk answers there and the
//      phone never hears of it;
//   2. still open → ask through the relay (POST /ask, kind:"permission"): ✅ allow / ❌ deny, ✍️ = deny
//      with the human's words as the reason, ⏹ = deny and stop the turn;
//   3. retract the phone's question the moment it is moot — the terminal answered (seen in the
//      transcript: a result for this tool call), or the hook is being stopped (SIGTERM: a terminal
//      "No" in the TUI, the hook timeout, the session ending). The relay also cancels any permission
//      prompt of a session at its session end, and the main thread's at its round end, for a hook
//      that could not.
// A background subagent's prompt (the hook input carries agent_id) is marked with that agent_id: its
// dialog can outlive the main thread's turn, so the relay leaves it open at round end while this hook
// still polls for the answer (a stopped subagent's hook is killed — on Windows without a signal, so
// it cannot retract it — and the relay does once it stopped polling), and the
// terminal's answer is looked for in the subagent's own transcript (<session>/subagents/agent-<id>.jsonl)
// — the hook's transcript_path is always the main thread's.
// Fail-safe: relay down, flag off, a delivery failure, anything unexpected → exit 0 with no output,
// i.e. the hook abstains and the terminal dialog stays exactly as it would be without Myna.
// Toggle: /myna:perm on|off (~/.myna/permission, first line "off" = off; default on).
//
// God mode (v0.25.0, /myna:godmode; flag file ~/.myna/godmode or MYNA_GODMODE_FILE — it existing = on):
// checked before everything above, whatever /myna:perm says. Every permission dialog except
// AskUserQuestion (a question, not a permission: left to intercept / autopilot) is allowed at once —
// this one call only, no updatedPermissions — after a one-way notice to the IM (relay POST /notify,
// waited for at most GODMODE_NOTIFY_MS). The notice not going out (relay down, no bot, an IM without
// notices) still allows; its text is kept in ~/.myna/godmode-unsent.jsonl (newest 200 lines).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { godmodeOn, appendUnsent } from "../src/godmode.mjs";

// settings: process env first, then ~/.myna/.env (same precedence as the relay)
const fileEnv = (() => {
  try {
    return Object.fromEntries(fs.readFileSync(process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env"), "utf8")
      .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  } catch { return {}; }
})();
const setting = (k) => process.env[k] ?? fileEnv[k];
const FLAG = process.env.MYNA_PERMISSION_FILE || path.join(os.homedir(), ".myna", "permission");
const PORT = Number(setting("RELAY_PORT") || 7800);
const RELAY = setting("MYNA_RELAY_URL") || `http://127.0.0.1:${PORT}`;
const delaySetting = Number(setting("MYNA_PERMISSION_DELAY") ?? 30);
const DELAY_MS = (Number.isFinite(delaySetting) && delaySetting >= 0 ? delaySetting : 30) * 1000;
const WATCH_MS = Number(process.env.MYNA_PERMISSION_WATCH_MS || 1500); // transcript check interval
const ANSWER_POLL_MS = 35000; // > the relay's 25 s hold, like ask_human

const abstain = () => process.exit(0); // no output → the terminal dialog decides
process.stdout.on("error", () => {});

const flagOff = () => { try { return fs.readFileSync(FLAG, "utf8").split(/\r?\n/)[0].trim() === "off"; } catch { return false; } };
const GOD = godmodeOn();
if (!GOD && flagOff()) abstain();

const input = await (async () => {
  const chunks = []; try { for await (const c of process.stdin) chunks.push(c); } catch {}
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
})();
if (!input.tool_name) abstain();

const post = (p, body, ms = 3000) => fetch(`${RELAY}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(ms) });

// how a call reads on the phone (the permission question and God mode's notice)
const MAX = 1500;
const clip = (s, n = MAX) => { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n)}…` : s; };
function describe(tool, i = {}, [open, close] = ["(", ")"]) {
  const lines = [];
  if (tool === "Bash" || tool === "PowerShell") { lines.push(clip(i.command)); if (i.description) lines.push(`${open}${clip(i.description, 200)}${close}`); }
  else if (["Edit", "Write", "MultiEdit", "Read", "NotebookEdit"].includes(tool)) lines.push(clip(i.file_path || i.notebook_path));
  else if (tool === "WebFetch") lines.push(clip(i.url));
  else lines.push(clip(JSON.stringify(i, null, 1), 800));
  return lines.join("\n");
}
const two = (n) => String(n).padStart(2, "0"), d = new Date();
const dir = path.basename(input.cwd || process.cwd()) || "session";
const AGENT_ID = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
const sessionLabel = `${dir} ${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;

// --- God mode: allow at once, tell the IM -------------------------------------------------------------
if (GOD && input.tool_name !== "AskUserQuestion") {
  const GODMODE_NOTIFY_MS = 5000;
  const sid = String(input.session_id || "");
  const text = [
    `🔓 God mode 已自動同意｜${dir}`,
    `${input.tool_name}：${describe(input.tool_name, input.tool_input, ["（", "）"])}`,
    `session：${sessionLabel}${sid ? `・${sid.slice(0, 8)}` : ""}${AGENT_ID ? `・背景 agent ${AGENT_ID}` : ""}`,
  ].join("\n");
  let why = null;
  try {
    const r = await post("/notify", { text, session_id: input.session_id, ...(AGENT_ID ? { agent_id: AGENT_ID } : {}) }, GODMODE_NOTIFY_MS);
    if (!r.ok) why = `HTTP ${r.status}${await r.json().then((j) => (j?.error ? `: ${j.error}` : ""), () => "")}${r.status === 504 ? " (may still have been sent)" : ""}`;
  } catch (e) {
    // a timeout (or a connection cut mid-request) is not a sure "not sent": the relay may still deliver it
    why = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout (may still have been sent)"
      : e?.cause?.code === "UND_ERR_SOCKET" ? "connection dropped (may have been sent)"
      : e?.cause?.code || e?.message || "error";
  }
  if (why) appendUnsent({ at: new Date().toISOString(), session_id: input.session_id ?? null, ...(AGENT_ID ? { agent_id: AGENT_ID } : {}), tool: input.tool_name, reason: why, text });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }), () => process.exit(0));
  await new Promise(() => {}); // the write callback exits
}
if (flagOff()) abstain();

// --- stop / retract ---------------------------------------------------------------------------------
let requestId = null, done = false;
async function retractAndExit() {
  if (done) return; done = true;
  if (requestId) await post(`/cancel/${requestId}`, {}, 1500).catch(() => {});
  abstain();
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, retractAndExit);

// --- has the terminal already answered? -----------------------------------------------------------
// The dialog's tool call shows up in the transcript as a tool_use with this name + input; once a
// tool_result for it exists, the dialog is over (allowed and ran, or denied). The same call made
// earlier in the session is ignored: ids already answered when the hook started don't count.
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const want = stable(input.tool_input ?? {});
// a subagent's own transcript; never the main one in its place (it cannot show this subagent's
// result, and the main thread making the same call would look like an answer). Unknown → null (AGENT_ID).
const transcriptFile = () => {
  if (!AGENT_ID) return input.transcript_path || null;
  if (!input.transcript_path || !/^[A-Za-z0-9_-]+$/.test(AGENT_ID)) return null;
  return path.join(input.transcript_path.replace(/\.jsonl$/, ""), "subagents", `agent-${AGENT_ID}.jsonl`);
};
function scanTranscript() {
  const file = transcriptFile();
  if (!file) return null;
  let text;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024); // the tail is enough: the call is recent
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const calls = new Set(), answered = new Set();
  for (const line of text.split("\n")) {
    if (!line.includes("tool_")) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    for (const c of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (c?.type === "tool_use" && c.name === input.tool_name && stable(c.input ?? {}) === want) calls.add(c.id);
      else if (c?.type === "tool_result" && c.tool_use_id) answered.add(c.tool_use_id);
    }
  }
  return { calls, answered };
}
const before = scanTranscript();
const alreadyAnswered = new Set(before ? [...before.calls].filter((id) => before.answered.has(id)) : []);
function terminalAnswered() {
  const t = scanTranscript();
  return !!t && [...t.calls].some((id) => !alreadyAnswered.has(id) && t.answered.has(id));
}

// 1) give the terminal its head start
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let waited = 0; waited < DELAY_MS; waited += WATCH_MS) {
  await sleep(Math.min(WATCH_MS, DELAY_MS - waited));
  if (terminalAnswered()) abstain();
}

// 2) ask the phone
const ALLOW = "✅ 允許", DENY = "❌ 拒絕";
let asked;
try {
  const r = await post("/ask", {
    kind: "permission",
    header: "🔐 權限確認",
    question: `Claude 想使用 ${input.tool_name}(${dir}):\n${describe(input.tool_name, input.tool_input)}\n\n終端機的確認框也還在,哪邊先回答都可以。`,
    options: [ALLOW, DENY],
    session_id: input.session_id,
    ...(AGENT_ID ? { agent_id: AGENT_ID } : {}),
    session_label: sessionLabel,
  });
  asked = r.ok ? await r.json() : null;
} catch { asked = null; }
if (!asked?.request_id) abstain();
requestId = asked.request_id;

// 3) whichever comes first: the phone's answer, or the terminal's (→ retract)
const watcher = setInterval(() => { if (terminalAnswered()) retractAndExit(); }, WATCH_MS);
const decide = (decision) => {
  if (done) return; done = true; clearInterval(watcher);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
  process.exit(0);
};
for (;;) {
  let a;
  try {
    const r = await fetch(`${RELAY}/answer/${requestId}`, { signal: AbortSignal.timeout(ANSWER_POLL_MS) });
    a = await r.json();
  } catch { await sleep(1000); continue; } // relay restarting: its journal keeps the question — poll again
  if (done) break;
  if (a.kind === "pending") continue;
  if (a.kind === "selection" && a.value === ALLOW) decide({ behavior: "allow" });
  else if (a.kind === "selection") decide({ behavior: "deny", message: "The user denied this on their phone (Myna)." });
  else if (a.kind === "message") decide({ behavior: "deny", message: `The user answered on their phone (Myna) instead of allowing this: ${a.text}` });
  else if (a.kind === "aborted") decide({ behavior: "deny", message: "The user stopped this on their phone (Myna).", interrupt: true });
  else { clearInterval(watcher); abstain(); } // cancelled / unreachable / no such request → the terminal decides
}
