// Myna service (v0.27.0): start the relay at login, without Claude Code (SPEC §5.5, scripts/service.mjs).
// The OS runs a FIXED small file, ~/.myna/service/start.mjs, at login; it reads ~/.myna/service/service.json
// ({root, version, node, env?}) and runs <root>/scripts/ensure-relay.mjs — the same idempotent start a
// SessionStart hook does. An upgrade only rewrites service.json (updatePointer, called by ensure-relay);
// the OS registration never changes.
// Node built-ins only: start.mjs and ensure-relay must run on a machine without npm install.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// fixed place, NOT next to MYNA_ENV: start.mjs has to find service.json without any environment
export const serviceDir = () => path.join(os.homedir(), ".myna", "service");
export const recordFile = () => path.join(serviceDir(), "service.json");
export const startFile = () => path.join(serviceDir(), "start.mjs");

// semver order of two version strings: <0 a older, 0 same, >0 a newer. "?" (no /health, pre-0.7.2) and
// anything unparseable count as the oldest — such a relay keeps being replaced, as before. A
// pre-release ("0.7.2-old") sorts before its release; two pre-releases compare as plain strings.
const parseVersion = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim()); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] } : null; };
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i] - pb.n[i];
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// write through a temp file + rename; the temp name is unique per call, so two writers never share one
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

// ensure-relay's part (best-effort; it catches and warns): service.json exists → point it at THIS myna when
// this one is newer, or the same version while the recorded root is gone. Never older (no going back),
// never when either version is unreadable, never creates the file, never touches the OS registration.
// Only for the relay the login start is for: an ensure-relay run with another .env (MYNA_ENV — a test, a
// second setup) starts a different relay and leaves the pointer alone. Returns what it did.
export const defaultEnvPath = () => path.join(os.homedir(), ".myna", ".env");
export function updatePointer({ root, version, envPath = process.env.MYNA_ENV || defaultEnvPath() }) {
  const file = recordFile();
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return "none"; throw e; }
  const rec = JSON.parse(text);
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error(`${file} is not a JSON object`);
  if (path.resolve(envPath) !== path.resolve(typeof rec.env === "string" && rec.env ? rec.env : defaultEnvPath())) return "other-env";
  if (!parseVersion(version) || !parseVersion(rec.version)) return "kept";
  const cmp = compareVersions(version, rec.version);
  const gone = typeof rec.root !== "string" || !fs.existsSync(rec.root);
  if (!(cmp > 0 || (cmp === 0 && gone && path.resolve(rec.root || ".") !== path.resolve(root)))) return "kept";
  writeAtomic(file, JSON.stringify({ ...rec, root, version }, null, 2) + "\n");
  return "updated";
}

// The file the OS runs at login. Its text never depends on the myna version: an upgrade does not need to
// rewrite it. It reports a failure (no myna at the recorded root, service.json unreadable, ensure-relay
// not starting a relay — e.g. not configured) with one line in relay.log, next to the .env it uses.
export const START_MJS = `#!/usr/bin/env node
// Written by myna's scripts/service.mjs on — the OS runs this at login (LaunchAgent, Task Scheduler,
// systemd --user). It reads service.json next to it and runs <root>/scripts/ensure-relay.mjs, the same
// start a Claude Code SessionStart does. The same text for every myna version; do not edit.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const recFile = path.join(here, "service.json");
const env = { ...process.env };
let rec = null, why = "";
try { rec = JSON.parse(fs.readFileSync(recFile, "utf8")); } catch (e) { why = recFile + " could not be read (" + e.message + ")"; }
// the login environment has no MYNA_ENV an interactive shell set: use the one recorded by service.mjs on
if (rec && typeof rec.env === "string" && rec.env) env.MYNA_ENV = rec.env;
const ensure = rec && typeof rec.root === "string" ? path.join(rec.root, "scripts", "ensure-relay.mjs") : "";
if (!why && !(ensure && fs.existsSync(ensure))) why = "no myna at " + (rec && rec.root) + " (the recorded root is gone)";
let out = "";
if (!why) {
  const r = spawnSync(process.execPath, [ensure], { env, encoding: "utf8", windowsHide: true, timeout: 60000 });
  out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (out) console.log(out);
  // ensure-relay says "relay not started" for every reason it starts nothing (not configured, bad MYNA_ROLE)
  if (r.error || r.status !== 0) why = "ensure-relay failed (" + (r.error ? r.error.message : "exit " + r.status) + ")";
  else if (/relay not started/.test(out)) why = "ensure-relay started no relay";
}
if (why) {
  const log = path.join(path.dirname(env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env")), "relay.log");
  const line = new Date().toISOString() + " myna service (login start): " + why + (out ? " — " + out.replace(/\\s+/g, " ") : "") +
    ". Open a Claude Code session, or run: node <myna>/scripts/service.mjs on\\n";
  try { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, line); } catch {}
  console.error(line.trim());
  process.exit(1);
}
`;

// --- the OS layer ---------------------------------------------------------------------------------------
// Every OS command goes through run(): a test points MYNA_SERVICE_LAUNCHCTL / _SCHTASKS / _SYSTEMCTL at a
// fake program (a .mjs/.js path is run with this node), so nothing is ever registered for real.
// MYNA_SERVICE_PLATFORM (darwin|win32|linux) lets one machine test all three.
export const LABEL = "com.myna.relay";      // macOS LaunchAgent
export const TASK = "Myna relay";            // Windows Task Scheduler
export const UNIT = "myna-relay.service";   // Linux systemd --user

export const platformOf = (env = process.env) => String(env.MYNA_SERVICE_PLATFORM || process.platform);

export function runner(env = process.env) {
  return (tool, args) => {
    const override = env[`MYNA_SERVICE_${tool.toUpperCase()}`];
    const [cmd, argv] = override
      ? (/\.(c|m)?js$/i.test(override) ? [process.execPath, [override, ...args]] : [override, args])
      : [tool, args];
    const r = spawnSync(cmd, argv, { encoding: "utf8", windowsHide: true, timeout: 30000, env });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    return { ok: !r.error && r.status === 0, status: r.status, stdout: (r.stdout || "").trim(), out: r.error ? `${tool}: ${r.error.message}` : out, error: r.error };
  };
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// systemd unit quoting: a double-quoted word; % is a specifier, $ an env expansion, \ and " escape
const sdQuote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// one adapter per OS: file (the registration file, if any), query() → {registered: true|false|null, out},
// register({node, start}) → {ok, out}, unregister() → {ok, out}, runsAtRegister (the OS runs start.mjs
// itself when registering — macOS RunAtLoad — so `on` must not run it a second time), logHint.
export function adapter(platform, { run, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const target = `gui/${uid}/${LABEL}`;
    const file = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const query = () => {
      const r = run("launchctl", ["print", target]);
      return { registered: r.error ? null : r.ok, out: r.out };
    };
    return {
      name: `macOS LaunchAgent ${LABEL}`, file, target, runsAtRegister: true,
      logHint: `${path.join(serviceDir(), "launchd.err")}（launchd 連 start.mjs 都跑不起來時）`,
      query,
      register({ node, start }) {
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(start)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(serviceDir(), "launchd.err"))}</string>
</dict>
</plist>
`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, plist);
        // loaded already (an earlier `on`): bootout first, or bootstrap refuses
        if (query().registered) {
          const b = run("launchctl", ["bootout", target]);
          if (!b.ok) return { ok: false, out: `launchctl bootout ${target}: ${b.out}` };
        }
        // right after a bootout, bootstrap can fail for a moment while launchd is still unloading it
        let r;
        for (let i = 0; i < 3; i++) { r = run("launchctl", ["bootstrap", `gui/${uid}`, file]); if (r.ok || r.error) break; sleepSync(500); }
        return r.ok ? { ok: true, out: r.out } : { ok: false, out: `launchctl bootstrap gui/${uid} ${file}: ${r.out}` };
      },
      unregister() {
        const q = query();
        if (q.registered !== false) {
          const b = run("launchctl", ["bootout", target]);
          if (!b.ok) return { ok: false, out: `launchctl bootout ${target}: ${b.out}` };
        }
        const had = q.registered !== false || fs.existsSync(file);
        fs.rmSync(file, { force: true }); // the plist is what loads it at the next login
        return { ok: true, out: "", had };
      },
    };
  }
  if (platform === "win32") {
    const query = () => {
      const r = run("schtasks", ["/Query", "/TN", TASK]);
      // a missing task is a non-zero exit with a localized message: anything but a spawn error is "not there"
      return { registered: r.error ? null : r.ok, out: r.out };
    };
    return {
      name: `Windows 工作排程器「${TASK}」`, file: null, runsAtRegister: false,
      logHint: `schtasks /Query /TN "${TASK}" /V /FO LIST 的「上次執行結果」`,
      query,
      register({ node, start }) {
        // /TR is one string: both paths quoted (spaces); execFile passes it as one argument, no shell
        const r = run("schtasks", ["/Create", "/TN", TASK, "/SC", "ONLOGON", "/TR", `"${node}" "${start}"`, "/F"]);
        return r.ok ? { ok: true, out: r.out } : { ok: false, out: `schtasks /Create: ${r.out}` };
      },
      unregister() {
        const q = query();
        if (q.registered === false) return { ok: true, out: "", had: false };
        const r = run("schtasks", ["/Delete", "/TN", TASK, "/F"]);
        return r.ok ? { ok: true, out: r.out, had: true } : { ok: false, out: `schtasks /Delete: ${r.out}` };
      },
    };
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, ".config");
    const file = path.join(configHome, "systemd", "user", UNIT);
    const query = () => {
      const r = run("systemctl", ["--user", "is-enabled", UNIT]);
      if (r.error) return { registered: null, out: r.out };
      const state = r.stdout.split(/\s+/)[0] || "";
      if (r.ok || /^(enabled|enabled-runtime|linked|linked-runtime|alias)$/.test(state)) return { registered: true, out: r.out };
      if (/^(disabled|not-found|masked|static|indirect|generated|transient|bad)$/.test(state) || /No such file|not found|does not exist/i.test(r.out)) return { registered: false, out: r.out };
      return { registered: null, out: r.out }; // e.g. "Failed to connect to bus": no user instance to ask
    };
    return {
      name: `Linux systemd --user ${UNIT}`, file, runsAtRegister: false,
      logHint: `journalctl --user -u ${UNIT}`,
      query,
      register({ node, start }) {
        // oneshot + RemainAfterExit: the unit stays active after start.mjs exits, so systemd does not clean
        // up its cgroup — the detached relay lives in it. No Restart=: /myna:relay stop must stay stopped.
        const unit = `[Unit]
Description=Myna relay (started at login by myna service; the relay itself runs detached)

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${sdQuote(node)} ${sdQuote(start)}

[Install]
WantedBy=default.target
`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, unit);
        for (const args of [["--user", "daemon-reload"], ["--user", "enable", UNIT]]) {
          const r = run("systemctl", args);
          if (!r.ok) return { ok: false, out: `systemctl ${args.join(" ")}: ${r.out}` };
        }
        return { ok: true, out: "" };
      },
      unregister() {
        // disable only, never stop: stopping the RemainAfterExit unit would kill the relay in its cgroup
        const q = query();
        if (q.registered !== false) {
          const r = run("systemctl", ["--user", "disable", UNIT]);
          if (!r.ok) return { ok: false, out: `systemctl --user disable ${UNIT}: ${r.out}` };
        }
        const hadFile = fs.existsSync(file);
        const had = q.registered !== false || hadFile;
        fs.rmSync(file, { force: true });
        if (hadFile) { const r = run("systemctl", ["--user", "daemon-reload"]); if (!r.ok) return { ok: true, out: "", had, warn: `systemctl --user daemon-reload: ${r.out}` }; }
        return { ok: true, out: "", had };
      },
    };
  }
  return null;
}
