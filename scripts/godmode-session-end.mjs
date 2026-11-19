#!/usr/bin/env node
// Myna — SessionEnd hook (Claude Code, hooks/hooks.json; v0.29.0): God mode turned on for one session
// (/myna:godmode-session) ends with that session. Removes the flag file of the hook input's session_id
// (src/godmode-session.mjs) — every reason alike: leaving, /clear, a /resume to another session, logout.
// A session that comes back later (--resume) is asked again as usual until someone turns it on again.
// Only that session's file: another session's flag, and the machine-wide God mode, are not touched.
// Never fails and never prints: no input, no session id, no file, a delete that fails → exit 0 quietly
// (a session that crashed leaves its file; it can be deleted by hand, ~/.myna/godmode-sessions/).
import fs from "node:fs";
import { sessionGodmodeFile } from "../src/godmode-session.mjs";

setTimeout(() => process.exit(0), 2000).unref();

const chunks = [];
try { for await (const c of process.stdin) chunks.push(c); } catch { /* no stdin */ }
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}

const sid = typeof input?.session_id === "string" ? input.session_id.trim() : "";
if (sid) { try { fs.rmSync(sessionGodmodeFile(sid), { force: true }); } catch {} }
process.exit(0);
