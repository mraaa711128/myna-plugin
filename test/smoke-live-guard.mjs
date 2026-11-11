#!/usr/bin/env node
// The tests that could reach the relay serving the phone refuse to run unless asked to:
//   - smoke-relay / smoke-relay-multiround (manual live tests) exit 2 without an explicit
//     MYNA_RELAY_URL, before any network call. Run here with fetch blocked and recorded
//     (test/helpers/block-fetch.mjs via NODE_OPTIONS, so the MCP server they would spawn inherits it):
//     even if the check regressed, nothing could reach :7800.
//   - smoke-daemon's isolation check is a pure function, tested with synthetic values only. This test
//     never runs smoke-daemon against :7800 or the real ~/.myna (that is what a regressed check would
//     hit); it runs it once only against a port this test owns, with a fake .env and a temp HOME, to see
//     it refuse a port that is already taken. The "isolated → runs" path is the CI smoke-daemon step
//     (fake MYNA_ENV, RELAY_PORT=17899).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonIsolationProblem, INHERITED_LIVE_KEYS, isInheritedLiveKey, liveTestOptedIn, portInUse } from "./helpers/live-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) fail++; };

// --- live tests: opt-in predicate ---------------------------------------------------------------
ok(!liveTestOptedIn({}), "live test: no MYNA_RELAY_URL → not opted in");
ok(!liveTestOptedIn({ MYNA_RELAY_URL: "" }) && !liveTestOptedIn({ MYNA_RELAY_URL: "  " }), "live test: empty MYNA_RELAY_URL → not opted in");
ok(liveTestOptedIn({ MYNA_RELAY_URL: "http://127.0.0.1:7800" }), "live test: explicit MYNA_RELAY_URL → opted in");

// --- live tests: the real files exit 2 with zero requests ---------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myna-live-guard-"));
const preload = pathToFileURL(path.join(root, "test", "helpers", "block-fetch.mjs")).href;
const runLive = (file) => new Promise((resolve) => {
  const log = path.join(tmp, `${file}.fetch.log`);
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, MYNA_TEST_FETCH_LOG: log,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import="${preload}"`.trim() };
  delete env.MYNA_RELAY_URL;
  const c = spawn(process.execPath, [path.join(root, "test", file)], { env });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => c.kill(), 20000);
  c.on("close", (status) => {
    clearTimeout(timer);
    let requests = [];
    try { requests = fs.readFileSync(log, "utf8").split("\n").filter(Boolean); } catch {}
    resolve({ status, out, requests });
  });
});
for (const file of ["smoke-relay.mjs", "smoke-relay-multiround.mjs"]) {
  const r = await runLive(file);
  ok(r.status === 2, `${file}: exits 2 without MYNA_RELAY_URL (got ${r.status})`);
  ok(/MANUAL live test/.test(r.out) && /MYNA_RELAY_URL/.test(r.out), `${file}: says it is a manual live test and how to opt in`);
  ok(r.requests.length === 0, `${file}: 0 network requests (got ${r.requests.length}${r.requests.length ? ": " + r.requests.join(", ") : ""})`);
}
fs.rmSync(tmp, { recursive: true, force: true });

// --- smoke-daemon: isolation predicate, synthetic values only -----------------------------------
const posixUser = "/home/alice", winUser = "C:\\Users\\Alice";
const P = (env, homedir = posixUser, userHomedir = posixUser, platform = "linux") => daemonIsolationProblem({ env, homedir, userHomedir, platform });

let m = P({});
ok(m && /RELAY_PORT/.test(m) && /config folder/.test(m), "daemon: nothing set (port 7800, real ~/.myna) → refused, names both");
m = P({ MYNA_ENV: "/tmp/x/myna.env" });
ok(m && /RELAY_PORT/.test(m) && !/config folder/.test(m), "daemon: fake MYNA_ENV but default port 7800 → refused for the port");
m = P({ RELAY_PORT: "7800", MYNA_ENV: "/tmp/x/myna.env" });
ok(m && /RELAY_PORT/.test(m), "daemon: RELAY_PORT=7800 explicitly → refused");
m = P({ RELAY_PORT: "17899" });
ok(m && /config folder/.test(m) && !/RELAY_PORT is/.test(m), "daemon: other port but real ~/.myna (no MYNA_ENV, real HOME) → refused for the folder");
m = P({ RELAY_PORT: "17899", MYNA_ENV: "/home/alice/.myna/.env" });
ok(m && /config folder/.test(m), "daemon: MYNA_ENV pointing at the real ~/.myna/.env → refused");
m = P({ RELAY_PORT: "17899", MYNA_ENV: "/home/alice/.myna/other.env" });
ok(m && /config folder/.test(m), "daemon: any MYNA_ENV inside the real ~/.myna → refused");
m = P({ RELAY_PORT: "17899" }, "/tmp/home-xyz");
ok(m === null, "daemon: temp HOME (os.homedir moved, real home unchanged) + other port → allowed");
m = P({ RELAY_PORT: "17899", MYNA_ENV: "/tmp/x/myna.env" });
ok(m === null, "daemon: fake MYNA_ENV + other port (the CI way) → allowed");
m = P({ RELAY_PORT: "17899", MYNA_ENV: "c:\\users\\alice\\.MYNA\\.env" }, winUser, winUser, "win32");
ok(m && /config folder/.test(m), "daemon: Windows paths compare case-insensitively → real ~/.myna refused");
m = P({ RELAY_PORT: "17899", MYNA_ENV: "C:\\Temp\\x\\myna.env" }, winUser, winUser, "win32");
ok(m === null, "daemon: Windows fake MYNA_ENV + other port → allowed");
m = P({ RELAY_PORT: "17899", MYNA_ENV: "/Users/Alice/.Myna/.env" }, "/Users/alice", "/Users/alice", "darwin");
ok(m && /config folder/.test(m), "daemon: macOS (case-insensitive by default) → real ~/.myna refused");
for (const k of [...INHERITED_LIVE_KEYS, "MYNA_PENDING_FILE", "MYNA_TOPICS_FILE", "MYNA_CHAT_TOPICS_FILE", "MYNA_TELEGRAM_CHAT_FILE",
  "MYNA_MACHINES_FILE", "MYNA_EDGE_STATE_FILE", "MYNA_RELAY_SECRET_FILE", "MYNA_UPSTREAM_HOLD_FILE"]) {
  m = P({ RELAY_PORT: "17899", MYNA_ENV: "/tmp/x/myna.env", [k]: "x" });
  ok(m && m.includes(k) && !/RELAY_PORT is|config folder/.test(m), `daemon: ${k} in the environment (it wins over the fake .env) → refused`);
}
m = P({ RELAY_PORT: "17899", MYNA_ENV: "/tmp/x/myna.env", TELEGRAM_BOT_TOKEN: "" });
ok(m === null, "daemon: an empty inherited key does not count");
m = P({ RELAY_PORT: "17899", MYNA_ENV: "/tmp/x/myna.env", MYNA_NET_ATTEMPT_MS: "3000", TELEGRAM_API_BASE: "http://127.0.0.1:9" });
ok(m === null, "daemon: harmless settings (timeouts, a stub API base) do not count");

// --- smoke-daemon: something already on its port → exit 2 before touching it ----------------------
// Only a server THIS test owns, on a random port, with a fake .env, a temp HOME and fetch blocked: even
// if both checks regressed, smoke-daemon would only reach this server (and the fetch log), never :7800.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myna-live-guard-daemon-"));
  const fakeEnv = path.join(home, "fake", "myna.env");
  fs.mkdirSync(path.dirname(fakeEnv), { recursive: true });
  fs.writeFileSync(fakeEnv, "TELEGRAM_BOT_TOKEN=fake\nTELEGRAM_CHAT_ID=1\nTELEGRAM_API_BASE=http://127.0.0.1:9\n");
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end("not a relay"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const busy = srv.address().port;
  ok(await portInUse(busy), "portInUse: a listening port → in use");
  const log = path.join(home, "fetch.log");
  const env = { ...process.env, HOME: home, USERPROFILE: home, MYNA_ENV: fakeEnv, RELAY_PORT: String(busy), MYNA_TEST_FETCH_LOG: log,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import="${preload}"`.trim() };
  for (const k of Object.keys(env)) if (/^(TELEGRAM|DISCORD|SLACK)_/.test(k) || isInheritedLiveKey(k) || k === "MYNA_RELAY_URL") delete env[k];
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(root, "test", "smoke-daemon.mjs")], { env });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => c.kill(), 20000);
    c.on("close", (status) => { clearTimeout(timer); resolve({ status, out }); });
  });
  let fetched = [];
  try { fetched = fs.readFileSync(log, "utf8").split("\n").filter(Boolean); } catch {}
  ok(r.status === 2 && /already listening/.test(r.out), `daemon: port already taken → exit 2, says so (got ${r.status})`);
  ok(hits === 0 && fetched.length === 0, `daemon: no request to the server on that port (got ${hits} HTTP, ${fetched.length} fetch)`);
  await new Promise((res) => srv.close(res));
  ok(!(await portInUse(busy)), "portInUse: a closed port → free");
  fs.rmSync(home, { recursive: true, force: true });
}

// --- smoke-daemon: the check runs before anything else --------------------------------------------
// (order is a code-review item; this only catches the check being removed or moved below the first call)
const daemonSrc = fs.readFileSync(path.join(root, "test", "smoke-daemon.mjs"), "utf8");
const checkAt = daemonSrc.indexOf("if (isolation)");
const firstEffect = Math.min(...["run(\"", "runAsync(\"", "await up(", "fakeRelay("].map((s) => daemonSrc.indexOf(s)).filter((i) => i >= 0));
ok(checkAt > 0 && checkAt < firstEffect, "daemon: the isolation check comes before the first spawn / request");

console.log(fail ? `\n❌ ${fail} failed` : "\n✅ all passed");
process.exit(fail ? 1 : 0);
