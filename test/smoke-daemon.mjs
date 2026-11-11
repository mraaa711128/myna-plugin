#!/usr/bin/env node
// Autonomous test of the relay daemon lifecycle: ensure-relay (idempotent + detached),
// the singleton guard (a 2nd relay exits on EADDRINUSE), stop-relay, and the version guard:
// a relay of another plugin version (or a pre-0.7.2 one without /health) holding the port gets
// replaced by ensure-relay; one with an open gate is left alone unless --force; --force restarts
// even a same-version relay; a relay NEWER than this plugin is never downgraded unless --force;
// stop → ensure back-to-back leaves a running relay. Refuses to run (exit 2) unless it is isolated
// from the live relay: RELAY_PORT other than 7800, and MYNA_ENV (or HOME) pointing away from the real
// ~/.myna — see test/helpers/live-guard.mjs. CI: MYNA_ENV=<temp>/myna.env RELAY_PORT=17899.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { daemonIsolationProblem, portInUse } from "./helpers/live-guard.mjs";

// before any network call or spawn: never stop / replace the relay that is serving the phone
let userHomedir;
try { userHomedir = os.userInfo().homedir; } catch { userHomedir = os.homedir(); } // no passwd entry → fail closed on HOME
const isolation = daemonIsolationProblem({ env: process.env, homedir: os.homedir(), userHomedir, platform: process.platform });
if (isolation) { console.error(isolation); process.exit(2); }
{
  const p = Number(process.env.RELAY_PORT || 7800);
  if (await portInUse(p)) {
    console.error(`smoke-daemon refuses to run: something is already listening on 127.0.0.1:${p}, and the test would stop it.
If it is a leftover test relay, stop it (RELAY_PORT=${p} node scripts/stop-relay.mjs); otherwise pick a free RELAY_PORT.`);
    process.exit(2);
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const port = Number(process.env.RELAY_PORT || 7800);
const run = (rel, args = [], timeout = 6000) => {
  const r = spawnSync(node, [path.join(root, rel), ...args], { encoding: "utf8", timeout });
  return { out: ((r.stdout || "") + (r.stderr || "")).trim(), status: r.status };
};
// async variant for the version-guard cases: the fake relay lives in THIS process, so the launcher
// must not block the event loop (spawnSync would starve the fake server and the probe would time out)
const runAsync = (rel, args = []) => new Promise((resolve) => {
  const c = spawn(node, [path.join(root, rel), ...args]); let out = "";
  c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.on("close", (status) => resolve({ out: out.trim(), status }));
});
const up = async () => { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); return true; } catch { return false; } };
const health = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })).json(); } catch { return null; } };
const ourVersion = JSON.parse(await import("node:fs").then((m) => m.readFileSync(path.join(root, "package.json"), "utf8"))).version;
// a stand-in for a stale relay holding the port: answers /shutdown like a real one; `health` = what
// its GET /health says (null = pre-0.7.2 relay that 404s everything it does not know)
const fakeRelay = (health) => new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/shutdown") { res.end("bye"); setTimeout(() => srv.close(), 20); return; }
    if (req.method === "GET" && req.url === "/health" && health) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(health)); return; }
    res.writeHead(404); res.end("relay(telegram): POST /ask | GET /answer/<id>");
  });
  srv.listen(port, "127.0.0.1", () => resolve(srv));
});
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) fail++; };

let r;
r = run("scripts/stop-relay.mjs"); console.log("[stop ]", r.out);
await sleep(300);
ok(!(await up()), "relay down before start");

r = run("scripts/ensure-relay.mjs"); console.log("[ensure ]", r.out);
await sleep(1300);
ok(await up(), "ensure-relay started the relay (detached — outlives the launcher)");

r = run("scripts/ensure-relay.mjs"); console.log("[ensure2]", r.out);
ok(/already running/.test(r.out), "ensure-relay is idempotent (no 2nd relay)");

r = run("src/relay.mjs", [], 4000); console.log("[direct ]", r.out);
ok(r.status === 0 && /already owns|single relay/.test(r.out), "a 2nd relay exits on EADDRINUSE (singleton guard)");

r = run("scripts/ensure-relay.mjs"); console.log("[ensure3]", r.out);
ok(new RegExp("already running.*v" + ourVersion.replace(/\./g, "\\.")).test(r.out), "ensure-relay recognises its own version via /health");

// restart = ensure-relay --force: a relay of the SAME version is replaced too (e.g. to pick up an
// edited ~/.myna/.env) — it used to answer "already running" and keep the old process
const pidBefore = (await health())?.pid;
r = run("scripts/ensure-relay.mjs", ["--force"]); console.log("[restart]", r.out);
await sleep(1300);
const hr = await health();
ok(/restart requested.*replacing/.test(r.out) && hr?.pid && hr.pid !== pidBefore, `--force restarts a same-version relay (pid ${pidBefore} → ${hr?.pid})`);

// stop → start right away: stop-relay returns only once the port is free, so the start is real
// (it used to return while the relay was still exiting → "already running" → no relay at all)
r = run("scripts/stop-relay.mjs"); console.log("[stop ]", r.out);
const r2 = run("scripts/ensure-relay.mjs"); console.log("[ensure4]", r2.out);
await sleep(1300);
ok(/stopped/.test(r.out) && /started relay/.test(r2.out) && await up(), "stop → immediate ensure-relay starts a fresh relay (no 'already running' race)");

r = run("scripts/stop-relay.mjs"); console.log("[stop ]", r.out);
ok(!(await up()), "stop-relay stopped it (returns only once the port is free)");

// --- version guard -------------------------------------------------------------------------
let fake = await fakeRelay(null);                       // pre-0.7.2 relay: no /health at all
r = await runAsync("scripts/ensure-relay.mjs"); console.log("[stale-old]", r.out);
await sleep(1300);
let h = await health();
ok(/older version.*replacing/.test(r.out) && h?.version === ourVersion, "a relay without /health (pre-0.7.2) is replaced by ours");
r = await runAsync("scripts/stop-relay.mjs"); await sleep(400);

fake = await fakeRelay({ ok: true, name: "myna-relay", version: "0.5.1", pending: 0 });
r = await runAsync("scripts/ensure-relay.mjs"); console.log("[stale-ver]", r.out);
await sleep(1300);
h = await health();
ok(/v0\.5\.1.*replacing/.test(r.out) && h?.version === ourVersion, "a relay of another version (no open gate) is replaced by ours");
r = await runAsync("scripts/stop-relay.mjs"); await sleep(400);

fake = await fakeRelay({ ok: true, name: "myna-relay", version: "0.5.1", pending: 2 });
r = await runAsync("scripts/ensure-relay.mjs"); console.log("[stale-busy]", r.out);
h = await health();
ok(/open gate.*NOT replacing/.test(r.out) && h?.version === "0.5.1", "a stale relay with open gates and no journal support is left alone (no --force)");
r = await runAsync("scripts/ensure-relay.mjs", ["--force"]); console.log("[stale-force]", r.out);
await sleep(1300);
h = await health();
ok(/replacing/.test(r.out) && h?.version === ourVersion, "--force replaces it even with open gates");
r = await runAsync("scripts/stop-relay.mjs"); await sleep(400);

fake = await fakeRelay({ ok: true, name: "myna-relay", version: "0.7.2-old", pending: 3, handoff: true });
r = await runAsync("scripts/ensure-relay.mjs"); console.log("[stale-handoff]", r.out);
await sleep(1300);
h = await health();
ok(/carrying over 3 open gate/.test(r.out) && h?.version === ourVersion, "a stale relay that journals (handoff:true) is replaced even with open gates — they carry over");
r = await runAsync("scripts/stop-relay.mjs"); await sleep(400);

// --- never downgrade: a relay NEWER than this plugin is left alone unless --force -----------------
// several sessions may run different plugin versions; an older one's SessionStart must not swap a
// newer relay for its own (e.g. a session on an old plugin cache replacing a newer relay)
const [maj, min, pat] = ourVersion.split(/[.-]/).map(Number);
const newerPatch = `${maj}.${min}.${pat + 1}`, newerMajor = `${maj + 1}.0.0`;
const olderPatch = pat > 0 ? `${maj}.${min}.${pat - 1}` : `${maj}.${Math.max(0, min - 1)}.99`;
for (const v of [newerPatch, newerMajor]) {
  fake = await fakeRelay({ ok: true, name: "myna-relay", version: v, pending: 0, handoff: true });
  r = await runAsync("scripts/ensure-relay.mjs"); console.log("[newer]", r.out);
  await sleep(300);
  h = await health();
  ok(r.status === 0 && new RegExp(`v${v.replace(/\./g, "\\.")} \\(newer than this plugin's v${ourVersion.replace(/\./g, "\\.")}\\) — leaving it`).test(r.out) && h?.version === v,
    `a relay newer than this plugin (v${v} > v${ourVersion}) is left alone (exit 0)`);
  if (v === newerMajor) {
    r = await runAsync("scripts/ensure-relay.mjs", ["--force"]); console.log("[newer-force]", r.out);
    await sleep(1300);
    h = await health();
    ok(/replacing/.test(r.out) && h?.version === ourVersion, `--force replaces even a newer relay (v${v} → v${ourVersion})`);
    r = await runAsync("scripts/stop-relay.mjs"); await sleep(400);
  } else { fake.closeAllConnections(); fake.close(); await sleep(200); }
}
fake = await fakeRelay({ ok: true, name: "myna-relay", version: olderPatch, pending: 0, handoff: true });
r = await runAsync("scripts/ensure-relay.mjs"); console.log("[older]", r.out);
await sleep(1300);
h = await health();
ok(new RegExp(`v${olderPatch.replace(/\./g, "\\.")}.*replacing`).test(r.out) && h?.version === ourVersion, `a relay one patch older (v${olderPatch}) is still replaced by ours`);
fake = null;
r = await runAsync("scripts/ensure-relay.mjs"); console.log("[same ]", r.out);
ok(/already running/.test(r.out), "same version: still a no-op");

r = await runAsync("scripts/stop-relay.mjs"); console.log("[stop ]", r.out);
await sleep(400);
ok(!(await up()), "relay stopped at the end");

console.log(fail ? `\n❌ ${fail} check(s) FAILED` : "\n✅ DAEMON (ensure / idempotent / singleton / stop / version guard) PASS");
process.exit(fail ? 1 : 0);
