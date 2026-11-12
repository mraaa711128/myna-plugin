// Is a file (folder) this user's only? What src/private-file.mjs promises, read back independently:
//   Unix: mode 0600 (folder 0700).
//   Windows: the ACL read back with the built-in icacls (/save writes it as SDDL): every entry an allow for
//   the current user's SID — its own, or inherited from Myna's folder, which then has only that entry too
//   (src/private-file.mjs); a folder's inheritable to what is created in it. → null when it is, else what is
//   wrong (for the test's message).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const system32 = (exe) => path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", exe);

let mySid;
function userSid() {
  if (mySid) return mySid;
  const r = spawnSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  mySid = /\bS-1-\d+(?:-\d+)+\b/.exec(r.stdout || "")?.[0];
  if (!mySid) throw new Error(`whoami /user gave no SID: ${r.stdout || r.stderr || r.error?.message}`);
  return mySid;
}

export function sddlOf(p) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myna-acl-")), out = path.join(dir, "acl.txt");
  try {
    const r = spawnSync(system32("icacls.exe"), [p, "/save", out, "/q"], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`icacls /save failed (${r.status}): ${(r.stdout || r.stderr || "").trim()}`);
    // UTF-16LE: the object's name on one line, its SDDL on the next
    const lines = fs.readFileSync(out).toString("utf16le").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    return lines[1] || "";
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// the relay sets it in the background on Windows (restrictToOwnerSoon): what privateProblem says once it is
// null, or after `ms` (an error reading it back counts as a problem, and is retried)
export async function eventualPrivateProblem(p, { dir = false, ms = 5000 } = {}) {
  let bad = "not checked";
  for (const until = Date.now() + ms; ;) {
    try { bad = privateProblem(p, { dir }); } catch (e) { bad = e.message; }
    if (!bad || Date.now() > until) return bad;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function privateProblem(p, { dir = false } = {}) {
  if (process.platform !== "win32") {
    const want = dir ? 0o700 : 0o600, mode = fs.statSync(p).mode & 0o777;
    return mode === want ? null : `mode ${mode.toString(8)}, want ${want.toString(8)}`;
  }
  const sddl = sddlOf(p);
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl) return `no DACL in ${sddl}`;
  const me = userSid();
  // the built-in Administrator account's SID is written as its alias
  const mine = new Set([me, ...(/-500$/.test(me) ? ["LA"] : [])]);
  const aces = [...dacl[2].matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(";"));
  if (!aces.length) return `no entries (${sddl})`;
  for (const [type, flags, rights, , , sid] of aces) {
    if (type !== "A" || !mine.has(sid)) return `an entry for someone else (${sddl})`;
    if (rights !== "FA" && rights !== "0x1f01ff") return `this user's entry is not full control (${sddl})`; // it must still be able to write it
    if (flags.includes("IO")) return `this user's entry applies only to what is created inside (${sddl})`;
    if (dir && !(flags.includes("OI") && flags.includes("CI"))) return `the folder's entry is not inherited by its files (${sddl})`;
  }
  return null;
}
