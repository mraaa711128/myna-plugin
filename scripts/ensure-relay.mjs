#!/usr/bin/env node
// Ensure the Myna relay running on THIS machine is the one from THIS plugin version — idempotent,
// singleton, detached. Called by the SessionStart hook (auto-start), by /myna:relay start|restart, and at
// login by ~/.myna/service/start.mjs when the login start is on (scripts/service.mjs, v0.27.0).
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
import { compareVersions, updatePointer } from "../src/service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env");
const port = Number(process.env.RELAY_PORT || 7800);
const force = process.argv.includes("--force") || process.env.MYNA_RELAY_FORCE === "1";
const ourVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } })();

// myna service (v0.27.0, scripts/service.mjs): when ~/.myna/service/service.json exists, point the login
// start at this myna if it is newer (or the same version while the recorded root is gone). A separate,
// best-effort step after the start flow on every way out: any error is one warning line, never a change
// to what happens to the relay.
function servicePointer() {
  try {
    if (updatePointer({ root, version: ourVersion }) === "updated") console.log(`myna: login start (myna service) now uses v${ourVersion} at ${root}`);
  } catch (e) { console.log(`myna: warning — could not update ~/.myna/service/service.json (${e.message}); the relay start is not affected`); }
}
function done() { servicePointer(); process.exit(0); }

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
if (role !== "hub" && role !== "edge") { console.log(`myna: MYNA_ROLE="${role}" is not hub|edge — relay not started. Fix ${envPath}.`); done(); }
const relayPath = path.join(root, "src", "relay.mjs");
if (role === "edge") {
  if (!String(cfg.MYNA_UPSTREAM || "").trim()) { console.log("myna: MYNA_ROLE=edge but MYNA_UPSTREAM (the hub's URL) is not set — relay not started. Run /myna:join <hub URL> --name <name>."); done(); }
} else {
  const configured =
    cfg.TELEGRAM_BOT_TOKEN || // no chat yet is fine: the relay has to be up to take /myna:pair
    (cfg.DISCORD_BOT_TOKEN && cfg.DISCORD_CHANNEL_ID) ||
    (cfg.SLACK_BOT_TOKEN && cfg.SLACK_APP_TOKEN && cfg.SLACK_CHANNEL_ID) ||
    String(cfg.MYNA_TRANSPORT || "").trim().toLowerCase() === "tree"; // a tree node runs without a bot of its own (SPEC §5.4)
  if (!configured) {
    console.log("myna: not configured — relay not started. Run /myna:setup <token> (Telegram) or /myna:configure discord|slack … (see README).");
    done();
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

// compareVersions (semver order; "?" and anything unparseable are the oldest) lives in src/service.mjs

const running = await probe();
// the relay on the port plays the other role (MYNA_ROLE changed in .env): replace it whatever its
// version — a hub left running on an edge machine would keep polling the bot. Pre-0.20 relays are hubs.
const roleSwitch = !!running && running.version !== "?" && (running.role || "hub") !== role;
if (roleSwitch) console.log(`myna: relay on :${port} runs as ${running.role || "hub"}, this machine is now ${role} (MYNA_ROLE) — replacing it${running.pending > 0 ? ` (its ${running.pending} open gate(s) stay in its journal)` : ""}`);
if (running) {
  if (running.version === ourVersion && !force && !roleSwitch) {
    console.log(`myna: relay already running on :${port} (v${ourVersion})`);
    done();
  }
  if (!force && !roleSwitch && compareVersions(running.version, ourVersion) > 0) {
    console.log(`myna: relay on :${port} is v${running.version} (newer than this plugin's v${ourVersion}) — leaving it. Update this plugin (/plugin update) to match; /myna:relay restart (ensure-relay --force) replaces it anyway.`);
    done();
  }
  const label = running.version === "?" ? "an older version (no /health — pre-0.7.2)"
    : running.version === ourVersion ? `v${running.version} (restart requested)`
    : `v${running.version}${running.root ? ` from ${running.root}` : ""}`;
  if (running.pending > 0 && !running.handoff && !force) {
    console.log(`myna: relay on :${port} is ${label}, but it still has ${running.pending} open gate(s) waiting for an answer and is too old to hand them over — NOT replacing it now. Run /myna:relay restart (or ensure-relay --force) once they are answered to switch to v${ourVersion}.`);
    done();
  }
  const carry = running.pending > 0 && running.handoff ? ` (carrying over ${running.pending} open gate(s) via its journal)` : "";
  console.log(`myna: relay on :${port} is ${label} — replacing it with v${ourVersion}${carry}`);
  try { await fetch(`${base}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1500) }); } catch {}
  if (!(await waitDown())) {
    console.log(`myna: the old relay did not release :${port} in time — leaving it. Stop it manually (/myna:relay stop, or kill the process) and run /myna:relay start.`);
    done();
  }
}

const logDir = path.dirname(process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env")); // next to .env (a test's MYNA_ENV keeps it off ~/.myna)
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "relay.log");
const out = fs.openSync(logFile, "a");
const child = spawn(process.execPath, [relayPath], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
child.unref();
console.log(`myna: started ${role === "edge" ? "relay (edge)" : "relay"} v${ourVersion} (pid ${child.pid}) on :${port} → ${logFile}`);
servicePointer();
