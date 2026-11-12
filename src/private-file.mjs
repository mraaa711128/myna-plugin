// Owner-only files: what Myna writes with mode 0600 (folders 0700) — the relay secret, bound chat, chat
// sessions, machine token, edge state, .env, received files, God mode's unsent notices.
//
// Unix: chmod to 0600 / 0700 (the umask may only have narrowed the mode given at create time).
//
// Windows has no permission bits — Node ignores the mode there except for the read-only flag — so ACLs are
// cut down instead, with the built-in icacls: the inherited entries removed and one full-control entry for
// the current user, named by SID (whoami /user), never by name — a name with a space or non-ASCII letters,
// or a domain account, needs no quoting or code page that way.
//   - ~/.myna, Myna's own folder (every one of these files lives there unless a setting moves it): the FOLDER
//     is made this user's only once for good, with an entry what is created in it inherits, so a file there
//     is this user's only from its first byte and a write costs nothing more. An icacls run is a process start
//     (tens of ms, up to a second on a busy machine), and the relay rewrites some of these files several
//     times a second. Never another folder that holds .env (MYNA_ENV may point into a shared one, e.g. the
//     temp folder).
//   - a file a setting put elsewhere: that file alone, on every write — its temp file before the rename
//     (sealTemp), a file written in place after (restrictToOwner).
// An object that was there before (another user's, an older version's) has its explicit entries reset first,
// so another user's or Everyone's do not survive.
//
// Best-effort and never throws: a failure (icacls missing, a file system without ACLs) is logged once per
// process and kind as a warning and kept for GET /health (lastPrivateFileProblem) so /myna:status shows it;
// the file then keeps its folder's permissions (as before 0.26.3).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const WIN = process.platform === "win32";
const system32 = (exe) => path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", exe);
// tests point this at a missing program to prove a failure does not take the relay down
const icaclsPath = () => process.env.MYNA_ICACLS || system32("icacls.exe");
const ownFolder = () => path.join(os.homedir(), ".myna");
const MARKER = ".myna-private-ok";
const SID_RE = /\bS-1-\d+(?:-\d+)+\b/;
// a path as the file system resolves it — links and junctions followed (the part not there yet kept as written)
const real = (p) => {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); }
  catch { const up = path.dirname(abs); return up === abs ? abs : path.join(real(up), path.basename(abs)); }
};
// p really inside root: a junction in ~/.myna pointing elsewhere is not ~/.myna (its files are restricted one by one)
const within = (root, p) => {
  const r = path.relative(real(root).toLowerCase(), real(p).toLowerCase()); // Windows: case does not matter
  return !r || (!r.startsWith("..") && !path.isAbsolute(r));
};

let sid; // undefined = not looked up yet; null = could not be found
export function currentUserSid() {
  if (sid !== undefined) return sid;
  sid = null;
  try {
    const r = spawnSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    sid = SID_RE.exec(r.stdout || "")?.[0] || null;
  } catch {}
  return sid;
}

let problem = null;
const warned = new Set();
// {file, error, at} of the last failure in this process, or null
export const lastPrivateFileProblem = () => problem;

function failed(p, error) {
  problem = { file: p, error, at: new Date().toISOString() };
  if (warned.has(error)) return false;
  warned.add(error);
  console.error(`[myna ${problem.at}] warning: could not make ${p} private to this user (${error}) — it keeps the permissions of its folder`);
  return false;
}

const NO_SID = "the current user's SID could not be found (whoami /user)";
// A new file whose folder passes nothing on to it gets its creator's default DACL as entries of its own (seen
// on a Windows CI runner: SYSTEM, Administrators and the user, not inherited) — /inheritance:r alone keeps
// those, so the same call removes the well-known accounts a default DACL names (never this user's own SID).
const DEFAULT_DACL = ["S-1-5-18", "S-1-5-32-544", "S-1-5-32-545", "S-1-5-11", "S-1-1-0", "S-1-3-0", "S-1-3-4"];
const icaclsArgs = (p, me, dir) => [p, "/inheritance:r", "/grant:r", `*${me}:${dir ? "(OI)(CI)F" : "F"}`,
  "/remove", ...DEFAULT_DACL.filter((s) => s !== me).map((s) => `*${s}`), "/q"];
const exitProblem = (status, out) => `icacls exit ${status}: ${String(out || "").trim().split(/\r?\n/)[0] || "no output"}`;
// SDDL aliases of well-known SIDs a DACL may show (icacls takes them as *S-1-…)
const ALIAS = { WD: "S-1-1-0", CO: "S-1-3-0", CG: "S-1-3-1", OW: "S-1-3-4", AN: "S-1-5-7", IU: "S-1-5-4", AU: "S-1-5-11",
  SY: "S-1-5-18", LS: "S-1-5-19", NS: "S-1-5-20", BA: "S-1-5-32-544", BU: "S-1-5-32-545", BG: "S-1-5-32-546", PU: "S-1-5-32-547",
  SO: "S-1-5-32-549", BO: "S-1-5-32-551", RD: "S-1-5-32-555", AC: "S-1-15-2-1" };
// the SIDs other than this user's that a DACL (SDDL, from icacls /save) still names → [sids] | null (one it cannot name)
function othersIn(sddl, me) {
  const dacl = /D:[A-Z]*((?:\([^)]*\))*)/.exec(sddl || "");
  if (!dacl) return null;
  const out = new Set();
  for (const [, ace] of dacl[1].matchAll(/\(([^)]*)\)/g)) {
    const sid = ace.split(";")[5];
    const full = sid === "LA" && /-500$/.test(me) ? me : /^S-1-/.test(sid) ? sid : ALIAS[sid];
    if (!full) return null;
    if (full !== me) out.add(full);
  }
  return [...out];
}
const readSddl = (out) => { try { return fs.readFileSync(out).toString("utf16le").replace(/^﻿/, "").split(/\r?\n/)[1] || ""; } catch { return ""; } };

// Never wider for a moment, step by step: (1) /inheritance:r drops the inherited entries, /grant:r gives this
// user full control and /remove drops a default DACL's accounts — for something this process just created
// that is all;
// (2) existing: an object that was there before (another user's, an older version's) may also carry explicit
// entries for others (Everyone…): the DACL is read back (/save) and those are removed (/remove). Each step
// only takes access away, so a failure half-way never leaves it wider than it was.
function icacls(p, dir, existing = true) {
  const me = currentUserSid();
  if (!me) return failed(p, NO_SID);
  let tmpDir;
  try {
    const run = (args) => spawnSync(icaclsPath(), args, { encoding: "utf8", timeout: 30000, windowsHide: true });
    const step = (args) => { const r = run(args); return r.error ? `icacls: ${r.error.code || r.error.message}` : r.status !== 0 ? exitProblem(r.status, r.stderr || r.stdout) : null; };
    let why = step(icaclsArgs(p, me, dir));
    if (why) return failed(p, why);
    if (!existing) return true;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myna-acl-"));
    const out = path.join(tmpDir, "acl");
    if ((why = step([p, "/save", out, "/q"]))) return failed(p, why);
    const rest = othersIn(readSddl(out), me);
    if (!rest) return failed(p, "an entry for an account icacls cannot name is left");
    if (rest.length && (why = step([p, "/remove", ...rest.map((s) => `*${s}`), "/q"]))) return failed(p, why);
    return true;
  } catch (e) { return failed(p, `icacls: ${e.message}`); }
  finally { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} } }
}

// ~/.myna made this user's only (Windows), once for good: a `.myna-private-ok` marker in it says so, and later
// processes run nothing. Only this user (and administrators) can create anything in the user profile, so the
// marker can be trusted there. → true when it is
let own; // undefined (not yet, this process) | true | false
function ownReady() {
  if (own !== undefined) return own;
  const dir = ownFolder();
  try {
    fs.mkdirSync(dir, { recursive: true });
    own = fs.existsSync(path.join(dir, MARKER)) || (icacls(dir, true) && (fs.writeFileSync(path.join(dir, MARKER), ""), true));
  } catch (e) { own = failed(dir, e.code || e.message); }
  return own;
}

// Where to write a temp file that is then renamed to `file`: next to it (same folder, so the rename only
// changes the name). Call sealTemp on it once written.
export function privateTempPath(file) {
  const dir = path.dirname(path.resolve(file));
  if (WIN && within(ownFolder(), dir)) ownReady(); // born this user's only there, from its first byte
  return path.join(dir, `${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
}
// a temp file from privateTempPath, written: Unix → chmod 0600 (the umask may have narrowed the mode). Windows →
// in ~/.myna nothing (it was born so); elsewhere restricted on its own before the rename (an icacls run per write:
// only where a setting moved a file out of ~/.myna). Its DACL is then protected, so nothing it inherits from the
// folder it is renamed in can come back.
export function sealTemp(tmp) {
  if (!WIN) return restrictToOwner(tmp);
  if (within(ownFolder(), tmp) && ownReady()) return true;
  return icacls(tmp, false, false);
}

// write a file only this user can read: a temp file made private (privateTempPath, sealTemp), renamed over the
// file. A rename refused (Windows: a reader holding the file) → written in place, then restricted on its own.
// Windows, outside ~/.myna: an icacls run per write (tens of ms; only where a setting moved the file).
export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = privateTempPath(file);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  sealTemp(tmp); // the rename carries it over
  try { fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, text, { mode: 0o600 }); restrictToOwner(file); try { fs.unlinkSync(tmp); } catch {} }
}

// Make a file (folder) this user's only after it was written in place → true when it is. Windows: in ~/.myna
// that is the folder's (once); elsewhere this one file (an icacls run — for what is written once or rarely).
export function restrictToOwner(p, { dir = false } = {}) {
  if (!WIN) {
    try { fs.chmodSync(p, dir ? 0o700 : 0o600); return true; }
    catch (e) { return failed(p, e.code || e.message); }
  }
  if (within(ownFolder(), p)) return ownReady();
  return icacls(p, dir);
}

// The same for a file made private when it was created and only read since (the relay secret, read at every
// start) — on Windows without making the caller wait: in ~/.myna the folder's once-only setup (which covers an
// older version's file there too); elsewhere icacls runs in the background (a file of an older version there is
// fixed as well). The file is never rewritten, so nothing races it.
// a program run in the background, never for more than 30 s → {code, out} | {error}
const run = (exe, args) => new Promise((resolve) => {
  let out = "", c, done = false;
  const end = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
  const t = setTimeout(() => { try { c?.kill(); } catch {} end({ error: "timeout" }); }, 30000);
  t.unref?.();
  try { c = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return end({ error: e.message }); }
  c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.on("error", (e) => end({ error: e.code || e.message }));
  c.on("close", (code) => end({ code, out }));
});
const why = (r) => (r.error ? `icacls: ${r.error}` : r.code !== 0 ? exitProblem(r.code, r.out) : null);
const sidSoon = async () => {
  if (sid === undefined) { const r = await run(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]); if (sid === undefined) sid = SID_RE.exec(r.out || "")?.[0] || null; }
  return sid;
};

export function restrictToOwnerInBackground(p) {
  if (!WIN) return restrictToOwner(p);
  if (within(ownFolder(), p)) return ownReady();
  (async () => {
    const me = await sidSoon();
    if (!me) return failed(p, NO_SID);
    let w = why(await run(icaclsPath(), icaclsArgs(p, me, false))); // the same steps as icacls(), never wider
    if (w) return failed(p, w);
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myna-acl-"));
      const out = path.join(tmpDir, "acl");
      if ((w = why(await run(icaclsPath(), [p, "/save", out, "/q"])))) return failed(p, w);
      const rest = othersIn(readSddl(out), me);
      if (!rest) return failed(p, "an entry for an account icacls cannot name is left");
      if (rest.length && (w = why(await run(icaclsPath(), [p, "/remove", ...rest.map((s) => `*${s}`), "/q"])))) return failed(p, w);
    } catch (e) { failed(p, `icacls: ${e.message}`); }
    finally { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} } }
  })();
}
