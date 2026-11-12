// God mode (v0.25.0): every permission dialog on this machine is allowed at once, and each one is told
// to the IM as a one-way notice (scripts/permission-request.mjs, relay POST /notify).
//
// The flag file is a contract other tools read too (SPEC, README): the path is MYNA_GODMODE_FILE, else
// ~/.myna/godmode; the file EXISTING means on (its content — the time it was turned on — is only for
// /myna:status). Nothing else about it is promised.
//
// A notice that could not be sent (relay down, no bot, an IM without notices) is kept in
// godmode-unsent.jsonl next to it (MYNA_GODMODE_UNSENT_FILE, else ~/.myna/godmode-unsent.jsonl): one JSON
// line each, the newest UNSENT_MAX lines only. Every helper here is best-effort and never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { withFileLock } from "./remote.mjs";

export const UNSENT_MAX = 200;
export const godmodeFile = (env = process.env) => env.MYNA_GODMODE_FILE || path.join(os.homedir(), ".myna", "godmode");
export const unsentFile = (env = process.env) => env.MYNA_GODMODE_UNSENT_FILE || path.join(os.homedir(), ".myna", "godmode-unsent.jsonl");
export const godmodeOn = (env = process.env) => { try { return fs.existsSync(godmodeFile(env)); } catch { return false; } };

// when it was turned on: the time written in the file, else the file's mtime; null when off / unknown
export function godmodeSince(env = process.env) {
  const f = godmodeFile(env);
  try {
    const t = Date.parse(fs.readFileSync(f, "utf8").split(/\r?\n/)[0].trim());
    if (Number.isFinite(t)) return t;
  } catch {}
  try { return fs.statSync(f).mtimeMs; } catch { return null; }
}

const lines = (text) => text.split(/\r?\n/).filter((l) => l.trim());
// spool files: lines written while the lock was busy — <unsent file>.<time>-<pid>-<random>.spool, next to it
const spoolFiles = (f) => {
  const dir = path.dirname(f), base = `${path.basename(f)}.`;
  try { return fs.readdirSync(dir).filter((n) => n.startsWith(base) && n.endsWith(".spool")).sort().map((n) => path.join(dir, n)); } catch { return []; }
};

// One line kept. Several hooks may write at once (relay down, many sessions), so the main file is only ever
// changed under its lock (withFileLock, src/remote.mjs): the spooled lines merged in, this line appended, the
// file cut to the newest UNSENT_MAX lines (a temp file + rename). A cut never drops another hook's line: no
// one appends to the main file outside the lock. The lock not had within waitMs → the line goes to a spool
// file of its own (never touched by a rename), merged by the next writer that gets the lock.
// waitMs: what is left of the hook's time (it answers within GODMODE_NOTIFY_MS overall); 0 → straight to a spool.
export function appendUnsent(record, env = process.env, { waitMs = 500 } = {}) {
  const f = unsentFile(env);
  const line = JSON.stringify(record) + "\n";
  const write = () => {
    let extra = "";
    const spools = spoolFiles(f);
    for (const s of spools) { try { extra += fs.readFileSync(s, "utf8"); } catch {} }
    let cur = ""; try { cur = fs.readFileSync(f, "utf8"); } catch {}
    const all = lines(cur + (cur && !cur.endsWith("\n") ? "\n" : "") + extra + line);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, all.slice(-UNSENT_MAX).join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, f);
    for (const s of spools) { try { fs.rmSync(s, { force: true }); } catch {} } // only after the merge is written
  };
  const spool = () => fs.writeFileSync(`${f}.${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.spool`, line, { mode: 0o600, flag: "wx" });
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!(waitMs > 0)) { spool(); return true; }
    try { withFileLock(f, write, { waitMs }); }
    catch (e) { if (!/is held by another process/.test(e?.message || "")) throw e; spool(); }
    return true;
  } catch { return false; }
}

// the unsent notices since a time (ms): {count, file}, spooled lines included. Unreadable lines are not counted.
export function unsentSince(since, env = process.env) {
  const f = unsentFile(env);
  let n = 0;
  for (const file of [f, ...spoolFiles(f)]) {
    let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const l of lines(text)) {
      try { const t = Date.parse(JSON.parse(l).at); if (Number.isFinite(t) && (since == null || t >= since)) n++; } catch {}
    }
  }
  return { count: n, file: f };
}
