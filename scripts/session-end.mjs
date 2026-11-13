#!/usr/bin/env node
// Myna — SessionEnd hook for Codex CLI (codex/hooks.json only; Claude Code does not use it).
// Codex ends a session by killing the MCP server without closing its stdin, so ask-human.mjs's endSession
// never runs and the relay never hears /session/close for that session. This hook says it instead:
// POST /session/close {session_id} with the hook input's session_id (the same id the MCP calls carry in
// _meta.sessionId). Unlike endSession it cancels nothing: a question still waiting stays on the phone and the
// relay closes the session's topics once it is answered (src/relay.mjs handleSessionClose / closeIfDue).
// Codex caps a SessionEnd hook at 3 seconds; this one gives up well before that, and never fails: no relay,
// no answer, no session id → exit 0 quietly.
const PORT = Number(process.env.RELAY_PORT || 7800);
const RELAY = process.env.MYNA_RELAY_URL || `http://127.0.0.1:${PORT}`;

setTimeout(() => process.exit(0), 2000).unref();

const chunks = [];
try { for await (const c of process.stdin) chunks.push(c); } catch { /* no stdin */ }
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}

const sid = typeof input.session_id === "string" ? input.session_id.trim() : "";
if (sid) {
  try {
    await fetch(`${RELAY}/session/close`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sid }), signal: AbortSignal.timeout(1500),
    });
  } catch {}
}
process.exit(0);
