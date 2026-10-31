#!/usr/bin/env node
// An in-app /resume or /clear keeps the Claude Code process (and so this MCP server) but
// switches the session. ask_human must ask under the CURRENT session — read from
// <claude config dir>/sessions/<ppid>.json, which Claude Code keeps current — not the
// CLAUDE_CODE_SESSION_ID it was spawned with; and wrap up the old session at the relay.
// Isolated: a stub relay on a random port, a temp CLAUDE_CONFIG_DIR, no ~/.myna, no ~/.claude.
import http from "node:http";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL(process.env.MYNA_SERVER ? `../${process.env.MYNA_SERVER}` : "../dist/ask-human.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return undefined; await sleep(50); } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 60s"); process.exit(1); }, 60000);

// --- stub relay: records what the MCP server sends, answers every question at once ---
const asks = [], closes = [];
let n = 0;
const relay = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const b = JSON.parse(body || "{}");
    if (req.url === "/ask") { asks.push(b); return json({ request_id: `r${++n}` }); }
    if (req.url.startsWith("/answer/")) return json({ kind: "selection", value: "A" });
    if (req.url === "/session/close") { closes.push(b.session_id); return json({ ok: true }); }
    json({ ok: true });
  });
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const RELAY = `http://127.0.0.1:${relay.address().port}`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "myna-session-switch-"));
const sessionsDir = path.join(scratch, "claude", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });
// the MCP server is spawned by this process, so its ppid is our pid
const sessionsFile = path.join(sessionsDir, `${process.pid}.json`);
const writeSession = (sessionId, pid = process.pid) => fs.writeFileSync(sessionsFile, JSON.stringify({ pid, sessionId, kind: "interactive" }));

async function startServer(extraEnv = {}) {
  const env = { ...process.env };
  delete env.MYNA_SESSION_ID;
  Object.assign(env, {
    MYNA_RELAY_URL: RELAY, CLAUDE_CONFIG_DIR: path.join(scratch, "claude"), CLAUDE_CODE_SESSION_ID: "spawn-id",
    MYNA_AUTOPILOT_FILE: path.join(scratch, "no-autopilot"), MYNA_LOG_DIR: scratch, MYNA_HEARTBEAT_MS: "60000",
    ...extraEnv,
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" });
  const c = new Client({ name: "session-switch", version: "0" }, { capabilities: {} });
  await c.connect(transport);
  return c;
}
const ask = async (c, gate) => {
  const r = await c.callTool({ name: "ask_human", arguments: { question: "q?", options: ["A", "B"], gate } }, undefined, { timeout: 10000 });
  return JSON.parse(r.content[0].text);
};
const lastAsk = () => asks[asks.length - 1]?.session_id;

// 1) the live session file wins over the spawn-time env
writeSession("live-A");
let c = await startServer();
let r = await ask(c, "g1");
ok(r.kind === "selection" && r.value === "A", "ask_human gets the stub relay's answer");
ok(lastAsk() === "live-A", `asks under the session in sessions/<ppid>.json (got ${lastAsk()})`);

// 2) an in-app /resume: Claude Code rewrites the file — the next question follows it, the old one is wrapped up
writeSession("live-B");
await ask(c, "g2");
ok(lastAsk() === "live-B", `after the switch asks under the new session (got ${lastAsk()})`);
ok(await until(() => closes.includes("live-A")), "the session switched away from is closed at the relay");
ok(!closes.includes("live-B"), "the current session is not closed");

// 3) a bad file falls back to CLAUDE_CODE_SESSION_ID: pid mismatch, broken JSON, missing file
writeSession("someone-else", process.pid + 1);
await ask(c, "g3");
ok(lastAsk() === "spawn-id", `a file for another pid is ignored (got ${lastAsk()})`);
fs.writeFileSync(sessionsFile, "{not json");
await ask(c, "g4");
ok(lastAsk() === "spawn-id", `a broken file is ignored (got ${lastAsk()})`);
fs.rmSync(sessionsFile);
await ask(c, "g5");
ok(lastAsk() === "spawn-id", `no file → CLAUDE_CODE_SESSION_ID (got ${lastAsk()})`);

// 4) process exit closes the session it asked under last
closes.length = 0;
await c.close();
ok(await until(() => closes.includes("spawn-id")), "exit closes the current session at the relay");

// 5) MYNA_SESSION_ID overrides everything
writeSession("live-C");
c = await startServer({ MYNA_SESSION_ID: "explicit" });
await ask(c, "g6");
ok(lastAsk() === "explicit", `MYNA_SESSION_ID wins over the session file (got ${lastAsk()})`);
await c.close();

clearTimeout(watchdog);
relay.close();
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall session-switch checks passed");
process.exit(failed ? 1 : 0);
