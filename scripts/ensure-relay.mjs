#!/usr/bin/env node
// Ensure the Myna relay running on THIS machine is the one from THIS plugin version — idempotent,
// singleton, detached. Called by the SessionStart hook (auto-start) and by /myna:relay start|restart.
// MYNA_ROLE=edge (0.20): the relay forwards to a hub and needs no IM of its own (MYNA_UPSTREAM is what
// makes it "configured"). A relay of the other role on the port is replaced whatever its version.
// Safe to run many times:
//   - no IM provider configured in ~/.myna/.env             -> no-op
//   - relay on :PORT answers GET /health with OUR version    -> no-op (--force: restart it anyway —
//                                                              e.g. to pick up an edited ~/.myna/.env)
//   - relay on :PORT is NEWER than this plugin (semver)      -> no-op, leave it (--force: replace it anyway).
//                                                              Several sessions may run different plugin
//                                                              versions (an old cache still in use); without
//                                                              this an older session's SessionStart swapped
//                                                              a newer relay for its own, and the
//                                                              relay flipped between versions
//   - relay on :PORT is an older version (or too old to have -> ask it to /shutdown, then start ours.
//     /health at all — pre-0.7.2)                              Open gates carry over through the journal
//                                                              (~/.myna/relay-pending.json, 0.7.2+); a relay
//                                                              too old to journal is left alone while it
//                                                              holds an open gate — --force overrides
//   - nothing on :PORT                                       -> spawn relay DETACHED (survives this session)
// Why the version check: a plugin upgrade swaps the files on disk but never touches the relay process
// that is already listening. Checking only "does the port answer" kept a stale relay (e.g. 0.5.1, no
// topic support) in service forever, while every new session printed "already running".
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { localHeaders } from "../src/local-auth.mjs"; // the relay secret (MYNA_LOCAL_AUTH)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env");
const port = Number(process.env.RELAY_PORT || 7800);
const force = process.argv.includes("--force") || process.env.MYNA_RELAY_FORCE === "1";
const ourVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } })();

// same env merge as the relay: file keys, overridden by process.env
const fileEnv = Object.fromEntries(
  (fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const cfg = { ...fileEnv, ...process.env };
// role (0.20): hub (default) = the relay other machines forward to; edge = it forwards this machine's
// questions to a hub (MYNA_UPSTREAM), its own bot — when it has one — being the fallback. Same script.
const role = String(cfg.MYNA_ROLE || "hub").trim().toLowerCase();
if (role !== "hub" && role !== "edge") { console.log(`myna: MYNA_ROLE="${role}" is not hub|edge — relay not started. Fix ${envPath}.`); process.exit(0); }
const relayPath = path.join(root, "src", "relay.mjs");
if (role === "edge") {
  if (!String(cfg.MYNA_UPSTREAM || "").trim()) { console.log("myna: MYNA_ROLE=edge but MYNA_UPSTREAM (the hub's URL) is not set — relay not started. Run /myna:join <hub URL> --name <name>."); process.exit(0); }
} else {
  const configured =
    cfg.TELEGRAM_BOT_TOKEN || // no chat yet is fine: the relay has to be up to take /myna:pair
    (cfg.DISCORD_BOT_TOKEN && cfg.DISCORD_CHANNEL_ID) ||
    (cfg.SLACK_BOT_TOKEN && cfg.SLACK_APP_TOKEN && cfg.SLACK_CHANNEL_ID);
  if (!configured) {
    console.log("myna: not configured — relay not started. Run /myna:setup <token> (Telegram) or /myna:configure discord|slack … (see README).");
    process.exit(0);
  }
}

const base = `http://127.0.0.1:${port}`;
// who is on the port? null = nobody; {version:"?"} = something answers but has no /health (pre-0.7.2 relay)
async function probe() {
  let res;
  try { res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }); }
  catch { return null; }
  try { const j = await res.json(); if (j && j.name === "myna-relay") return j; } catch {}
  return { version: "?", pending: undefined };
}
async function waitDown(ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!(await probe())) return true; await sleep(150); }
  return false;
}

// semver order of two version strings: <0 a older, 0 same, >0 a newer. "?" (no /health, pre-0.7.2) and
// anything unparseable count as the oldest — such a relay keeps being replaced, as before. A
// pre-release ("0.7.2-old") sorts before its release; two pre-releases compare as plain strings.
function compareVersions(a, b) {
  const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim()); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] } : null; };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i] - pb.n[i];
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

const running = await probe();
// the relay on the port plays the other role (MYNA_ROLE changed in .env): replace it whatever its
// version — a hub left running on an edge machine would keep polling the bot. Pre-0.20 relays are hubs.
const roleSwitch = !!running && running.version !== "?" && (running.role || "hub") !== role;
if (roleSwitch) console.log(`myna: relay on :${port} runs as ${running.role || "hub"}, this machine is now ${role} (MYNA_ROLE) — replacing it${running.pending > 0 ? ` (its ${running.pending} open gate(s) stay in its journal)` : ""}`);
if (running) {
  if (running.version === ourVersion && !force && !roleSwitch) {
    console.log(`myna: relay already running on :${port} (v${ourVersion})`);
    process.exit(0);
  }
  if (!force && !roleSwitch && compareVersions(running.version, ourVersion) > 0) {
    console.log(`myna: relay on :${port} is v${running.version} (newer than this plugin's v${ourVersion}) — leaving it. Update this plugin (/plugin update) to match; /myna:relay restart (ensure-relay --force) replaces it anyway.`);
    process.exit(0);
  }
  const label = running.version === "?" ? "an older version (no /health — pre-0.7.2)"
    : running.version === ourVersion ? `v${running.version} (restart requested)`
    : `v${running.version}${running.root ? ` from ${running.root}` : ""}`;
  if (running.pending > 0 && !running.handoff && !force) {
    console.log(`myna: relay on :${port} is ${label}, but it still has ${running.pending} open gate(s) waiting for an answer and is too old to hand them over — NOT replacing it now. Run /myna:relay restart (or ensure-relay --force) once they are answered to switch to v${ourVersion}.`);
    process.exit(0);
  }
  const carry = running.pending > 0 && running.handoff ? ` (carrying over ${running.pending} open gate(s) via its journal)` : "";
  console.log(`myna: relay on :${port} is ${label} — replacing it with v${ourVersion}${carry}`);
  try { await fetch(`${base}/shutdown`, { method: "POST", headers: localHeaders({}, { ...process.env, MYNA_ENV: envPath }), signal: AbortSignal.timeout(1500) }); } catch {}
  if (!(await waitDown())) {
    console.log(`myna: the old relay did not release :${port} in time — leaving it. Stop it manually (/myna:relay stop, or kill the process) and run /myna:relay start.`);
    process.exit(0);
  }
}

const logDir = path.dirname(process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env")); // next to .env (a test's MYNA_ENV keeps it off ~/.myna)
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "relay.log");
const out = fs.openSync(logFile, "a");
const child = spawn(process.execPath, [relayPath], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
child.unref();
console.log(`myna: started ${role === "edge" ? "relay (edge)" : "relay"} v${ourVersion} (pid ${child.pid}) on :${port} → ${logFile}`);
