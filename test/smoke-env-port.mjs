#!/usr/bin/env node
// #28: RELAY_PORT (and MYNA_RELAY_URL) written only in ~/.myna/.env — not in the environment — reach every
// client of the relay, as the relay itself reads them (src/remote.mjs loadEnv: the .env, overridden by the
// environment). Each entry point runs against an HTTP stub that stands in for the relay on a random port:
// ensure-relay, stop-relay, ask_human (src and dist), the AskUserQuestion / Stop / Codex SessionEnd hooks,
// pair.mjs, hub.mjs status. Then the environment still wins over the .env, and MYNA_RELAY_URL in the .env
// wins over RELAY_PORT.
// Isolated: HOME and USERPROFILE are a temp folder, MYNA_ENV a .env inside it with a fake bot token and
// TELEGRAM_API_BASE at a closed port, every MYNA_* / RELAY_PORT / TELEGRAM_* … of the shell dropped, and
// test/helpers/no-live-ports.mjs (NODE_OPTIONS) rejects any fetch to 127.0.0.1:7800/7801/7802 — so a
// regression to the default port is caught and recorded instead of reaching the live relay.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ourVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-env-port-"));
const HOME = path.join(TMP, "home");
const DIR = path.join(HOME, ".myna");
fs.mkdirSync(DIR, { recursive: true });
const ENV_FILE = path.join(DIR, ".env");
const FETCH_LOG = path.join(TMP, "blocked-fetches.log");
let realHome;
try { realHome = os.userInfo().homedir; } catch { realHome = os.homedir(); }
if (path.resolve(HOME).toLowerCase() === path.resolve(realHome).toLowerCase()) { console.error("refusing: the temp HOME is the real home"); process.exit(2); }

const env = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|CLAUDE_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|NODE_OPTIONS$)/.test(k)) delete e[k];
  const preload = pathToFileURL(path.join(root, "test", "helpers", "no-live-ports.mjs")).href;
  return { ...e, HOME, USERPROFILE: HOME, MYNA_ENV: ENV_FILE, CLAUDE_CONFIG_DIR: path.join(HOME, ".claude"),
    MYNA_TEST_FETCH_LOG: FETCH_LOG, NODE_OPTIONS: `--import=${preload}` };
})();

// a stand-in relay: records every request; /health answers as a relay of this plugin's version; after
// POST /shutdown it drops every connection (stop-relay waits until the port stops answering)
function stub() {
  const seen = [];
  let down = false;
  const srv = http.createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url.split("?")[0]}`);
      const json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (req.url === "/health") return json({ ok: true, name: "myna-relay", version: ourVersion, role: "hub", pid: 1, pending: 0, remote: null });
      if (req.url === "/shutdown") { res.end("bye"); down = true; return; }
      if (req.url === "/pair/start") return json({ code: "ABC123", expires_in: 600, chat: null });
      if (req.url.startsWith("/chat/session")) return json({ registered: false });
      json({});
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port, up: () => { down = false; } })));
}
const writeEnv = (lines) => fs.writeFileSync(ENV_FILE, ["TELEGRAM_BOT_TOKEN=fake", "TELEGRAM_CHAT_ID=1", "TELEGRAM_API_BASE=http://127.0.0.1:9", ...lines, ""].join("\n"));
const script = (rel, args = [], { input, extra = {}, timeout = 15000 } = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(root, rel), ...args], { env: { ...env, ...extra } });
  let out = "";
  c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.stdin.on("error", () => {});
  const t = setTimeout(() => c.kill(), timeout);
  c.on("close", (status) => { clearTimeout(t); resolve({ out: out.trim(), status }); });
  c.stdin.end(input ?? "");
});
// the MCP server logs the relay it talks to once it is connected; then it is closed (stdin end)
const mcpRelay = (rel, extra = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(root, rel)], { env: { ...env, MYNA_SESSION_ID: "env-port-test", ...extra } });
  let err = "";
  const done = (v) => { clearTimeout(t); try { c.stdin.end(); } catch {} setTimeout(() => { try { c.kill(); } catch {} }, 1500); resolve(v); };
  const t = setTimeout(() => done(null), 10000);
  c.stderr.on("data", (d) => { err += d; const m = /connected \((?:host=codex, )?relay=(\S+?),/.exec(err); if (m) done(m[1]); });
  c.stdin.on("error", () => {});
});

const A = await stub(), B = await stub();
const has = (s, line) => s.seen.includes(line);
const clear = () => { A.seen.length = 0; B.seen.length = 0; };

// --- 1. RELAY_PORT only in the .env -------------------------------------------------------------------
writeEnv([`RELAY_PORT=${A.port}`]);

let r = await script("scripts/ensure-relay.mjs");
ok(new RegExp(`already running on :${A.port} \\(v${ourVersion.replace(/\./g, "\\.")}\\)`).test(r.out) && has(A, "GET /health"),
  `ensure-relay probes the .env's RELAY_PORT (:${A.port}) and finds the relay there — no second relay (${r.out.split("\n").at(-1)})`);

for (const rel of ["src/mcp/ask-human.mjs", "dist/ask-human.mjs"]) {
  const url = await mcpRelay(rel);
  ok(url === `http://127.0.0.1:${A.port}`, `ask_human (${rel}) connects to the .env's RELAY_PORT (relay=${url})`);
}
ok((await mcpRelay("dist/ask-human.mjs", { MYNA_HOST: "codex" })) === `http://127.0.0.1:${A.port}`, "ask_human with MYNA_HOST=codex (Codex's MCP gets no RELAY_PORT from the shell) reads it from the .env too");

clear();
const askQ = { cwd: TMP, session_id: "s-int", tool_name: "AskUserQuestion", tool_input: { questions: [
  { header: "Auth", question: "Which auth?", multiSelect: false, options: [{ label: "OAuth" }, { label: "JWT" }] }] } };
r = await script("scripts/intercept-ask.mjs", [], { input: JSON.stringify(askQ) });
ok(has(A, "GET /") && /"permissionDecision":\s*"deny"/.test(r.out), "AskUserQuestion hook finds the relay on the .env's port (probe there → it intercepts)");

clear();
r = await script("scripts/stop-catch-question.mjs", [], { input: JSON.stringify({ session_id: "s-stop", last_assistant_message: "All done." }) });
ok(has(A, "POST /session/round-end"), `Stop hook tells the relay on the .env's port the round ended (${A.seen.join(", ") || "nothing"})`);

clear();
r = await script("scripts/session-end.mjs", [], { input: JSON.stringify({ session_id: "s-end" }) });
ok(r.status === 0 && has(A, "POST /session/close"), "Codex SessionEnd hook closes the session at the relay on the .env's port");

clear();
r = await script("scripts/pair.mjs");
ok(r.status === 0 && has(A, "POST /pair/start") && /ABC123/.test(r.out), "pair.mjs asks the relay on the .env's port for a code");

clear();
r = await script("scripts/hub.mjs", ["status"]);
ok(has(A, "GET /health") && !new RegExp(`127\\.0\\.0\\.1:7800`).test(r.out), `hub.mjs status reads /health on the .env's port (${r.out.split("\n")[0]})`);

clear();
r = await script("scripts/stop-relay.mjs");
ok(has(A, "POST /shutdown") && new RegExp(`relay on :${A.port} stopped`).test(r.out), `stop-relay stops the relay on the .env's port (${r.out})`);
A.up();

// --- 2. the environment still wins over the .env ------------------------------------------------------
clear();
r = await script("scripts/session-end.mjs", [], { input: JSON.stringify({ session_id: "s-env" }), extra: { RELAY_PORT: String(B.port) } });
ok(has(B, "POST /session/close") && !A.seen.length, "RELAY_PORT in the environment wins over the .env's (session-end)");
ok((await mcpRelay("src/mcp/ask-human.mjs", { RELAY_PORT: String(B.port) })) === `http://127.0.0.1:${B.port}`, "…and for ask_human");
r = await script("scripts/ensure-relay.mjs", [], { extra: { RELAY_PORT: String(B.port) } });
ok(new RegExp(`already running on :${B.port} `).test(r.out), "…and for ensure-relay");

// --- 3. MYNA_RELAY_URL in the .env wins over RELAY_PORT for the clients ---------------------------------
writeEnv([`RELAY_PORT=${A.port}`, `MYNA_RELAY_URL=http://127.0.0.1:${B.port}`]);
clear();
r = await script("scripts/session-end.mjs", [], { input: JSON.stringify({ session_id: "s-url" }) });
ok(has(B, "POST /session/close") && !A.seen.length, "MYNA_RELAY_URL in the .env is where session-end goes");
ok((await mcpRelay("dist/ask-human.mjs")) === `http://127.0.0.1:${B.port}`, "…and ask_human");

// --- no default port anywhere --------------------------------------------------------------------------
const blocked = fs.existsSync(FETCH_LOG) ? fs.readFileSync(FETCH_LOG, "utf8").trim() : "";
ok(!blocked, `no process tried the live ports 7800/7801/7802${blocked ? ` (tried: ${blocked.split("\n").join(", ")})` : ""}`);
const relayLog = path.join(DIR, "relay.log");
ok(!fs.existsSync(relayLog), "no relay was spawned (ensure-relay found the stub every time)");

A.srv.close(); B.srv.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(failed ? `\n❌ ${failed} check(s) FAILED` : "\n✅ ENV PORT (RELAY_PORT / MYNA_RELAY_URL from ~/.myna/.env) PASS");
process.exit(failed ? 1 : 0);
