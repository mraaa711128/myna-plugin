// Codex CLI host for the ask_human MCP server (bundled into dist/ask-human.mjs).
// Only codex/mcp.json sets MYNA_HOST=codex; Claude Code's .mcp.json never does, so with it unset nothing in
// here is used and ask-human.mjs runs exactly as before.
// What differs under Codex (the design: friday-ai docs/designs/myna-codex/design.md, PR 2):
//   - session id: every tools/call carries the Codex thread's id in _meta.sessionId (the same value as the
//     hooks' session_id) — read per call, not from ~/.claude/sessions/<ppid>.json
//   - project folder: the server runs with cwd = the plugin's cache folder (codex/mcp.json "cwd": "."), so
//     the project comes from _meta["codex/sandbox-state"].sandboxCwd, which Codex sends on each call once the
//     server declares the experimental capability below. Windows sends a file:///C:/… URI.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX = String(process.env.MYNA_HOST || "").trim().toLowerCase() === "codex";

// declared at initialize so that Codex adds codex/sandbox-state (with sandboxCwd) to every call's _meta
export const CODEX_CAPABILITIES = { tools: {}, experimental: { "codex/sandbox-state": {} } };

// the Codex thread this call belongs to ("" when the call carries none)
export function sessionFromMeta(meta) {
  const id = meta?.sessionId;
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

// the project folder of this call's turn, as an absolute path ("" when there is none or it is not one).
// A file:// URI is converted with fileURLToPath; anything else is taken as a path.
export function cwdFromMeta(meta) {
  const s = meta?.["codex/sandbox-state"]?.sandboxCwd;
  if (typeof s !== "string" || !s.trim()) return "";
  let p = s.trim();
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch { return ""; }
  }
  return path.win32.isAbsolute(p) || path.posix.isAbsolute(p) ? p : "";
}

// the folder's own name, for the topic label — split on both separators, so a Windows path reads the same
// on any OS
export const folderName = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

// where the decision log goes when a call has no logDir, no MYNA_LOG_DIR and no project folder: never the
// plugin's cache folder (process.cwd() here), which an upgrade removes
export const fallbackLogDir = () => path.join(os.homedir(), ".myna", "decisions");
