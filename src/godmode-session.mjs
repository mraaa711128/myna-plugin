// God mode for ONE session (v0.29.0, /myna:godmode-session): next to the machine-wide flag file
// (src/godmode.mjs) a session has a flag file of its own —
//   <MYNA_GODMODE_SESSIONS_DIR, else ~/.myna/godmode-sessions>/<session id>
// The file EXISTING means on for that session (its content, the time it was turned on, is only for status).
// The file name is the session id with everything outside [A-Za-z0-9_-] replaced, 128 characters at most
// (as hooks/chat-mod.mjs stateFileName). Myna's own: not a contract for other tools (a guard does not read it).
// Kept apart from src/godmode.mjs (which pulls in the lock and private-file helpers) so the MCP server's
// bundle (dist/ask-human.mjs) only takes these few lines. Every helper is best-effort and never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const godmodeSessionsDir = (env = process.env) => env.MYNA_GODMODE_SESSIONS_DIR || path.join(os.homedir(), ".myna", "godmode-sessions");
export const sessionFlagName = (sid) => String(sid).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
// a usable session id: a non-empty string (anything else never has a flag)
const usable = (sid) => typeof sid === "string" && !!sid.trim();
export const sessionGodmodeFile = (sid, env = process.env) => path.join(godmodeSessionsDir(env), sessionFlagName(String(sid).trim()));
export const sessionGodmodeOn = (sid, env = process.env) => {
  if (!usable(sid)) return false;
  try { return fs.existsSync(sessionGodmodeFile(sid, env)); } catch { return false; }
};
// when it was turned on: the time written in the file, else the file's mtime; null when off / unknown
export function sessionGodmodeSince(sid, env = process.env) {
  if (!usable(sid)) return null;
  const f = sessionGodmodeFile(sid, env);
  try { const t = Date.parse(fs.readFileSync(f, "utf8").split(/\r?\n/)[0].trim()); if (Number.isFinite(t)) return t; } catch {}
  try { return fs.statSync(f).mtimeMs; } catch { return null; }
}
