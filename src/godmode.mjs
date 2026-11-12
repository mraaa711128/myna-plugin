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

// one line appended; the file cut to the newest UNSENT_MAX lines (rewritten through a temp file + rename).
// Several hooks may write at once (relay down, many sessions): the append and the cut run under the file's
// lock (withFileLock, src/remote.mjs — the .env writers' lock), so a cut never drops a line another hook
// appended meanwhile. The lock not had within its wait → appended anyway, not cut (the next write cuts it).
export function appendUnsent(record, env = process.env) {
  const f = unsentFile(env);
  const line = JSON.stringify(record) + "\n";
  const write = () => {
    fs.appendFileSync(f, line, { mode: 0o600 });
    const all = lines(fs.readFileSync(f, "utf8"));
    if (all.length > UNSENT_MAX) {
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, all.slice(-UNSENT_MAX).join("\n") + "\n", { mode: 0o600 });
      fs.renameSync(tmp, f);
    }
  };
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { withFileLock(f, write, { waitMs: UNSENT_LOCK_WAIT_MS }); }
    catch (e) { if (!/is held by another process/.test(e?.message || "")) throw e; fs.appendFileSync(f, line, { mode: 0o600 }); }
    return true;
  } catch { return false; }
}
const UNSENT_LOCK_WAIT_MS = 2000; // the hook waits for its notice at most 5 s; this is on top of it

// the unsent notices since a time (ms): {count, file}. Lines that cannot be read are not counted.
export function unsentSince(since, env = process.env) {
  const f = unsentFile(env);
  let n = 0;
  try {
    for (const l of lines(fs.readFileSync(f, "utf8"))) {
      try { const t = Date.parse(JSON.parse(l).at); if (Number.isFinite(t) && (since == null || t >= since)) n++; } catch {}
    }
  } catch {}
  return { count: n, file: f };
}
