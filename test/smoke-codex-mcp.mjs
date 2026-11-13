#!/usr/bin/env node
// Codex CLI host (PR 2 of the Codex support): the bundled MCP server with MYNA_HOST=codex, the SessionEnd hook
// (scripts/session-end.mjs) and ensure-relay --host codex. Isolated: a stub relay on a random port, temp
// HOMEs (HOME and USERPROFILE), MYNA_ENV inside them, never :7800, never the real ~/.myna.
//   - initialize: the codex/sandbox-state capability with MYNA_HOST=codex; none without it (Claude unchanged)
//   - tools/list: exactly ask_human / detach_human / await_human, also in tree mode (no message_session);
//     without MYNA_HOST tree mode still lists message_session
//   - ask_human: session_id = this call's _meta.sessionId, session_name = the sandboxCwd folder's name
//     (file:// URI or a plain path), the decision log in that folder; another id in the same process → asked
//     under it, the old one NOT closed, one diagnostic line; no sandboxCwd → <home>/.myna/decisions; a
//     by:"godmode" answer → mode "godmode"
//   - await_human / detach_human use _meta.sessionId; message_session → an error, nothing sent
//   - session-end.mjs: /session/close with the hook's session_id; relay down, silent, or stdin never closed → exits 0 by itself
//   - ensure-relay --host codex: service.json not touched; without --host the 0.27.0 rule (pointed here)
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cwdFromMeta, folderName } from "../src/mcp/codex.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const serverPath = path.join(ROOT, process.env.MYNA_SERVER || "dist/ask-human.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return undefined; await sleep(50); } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 120s"); process.exit(1); }, 120000);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-codex-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// --- stub relay: records what arrives, answers at once ---------------------------------------------------
const hits = []; // {url, body}
let n = 0;
const relay = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (o, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let b = {}; try { b = JSON.parse(body || "{}"); } catch {}
    hits.push({ url: req.url, body: b });
    if (req.url === "/ask") return json({ request_id: b.approves ? `g${++n}` : `r${++n}` });
    if (req.url.startsWith("/answer/g")) return json({ kind: "selection", value: "✅ 核准", by: "godmode" });
    if (req.url.startsWith("/answer/")) return json({ kind: "selection", value: "A" });
    if (req.url.startsWith("/requests?")) return json({ requests: [{ request_id: "r900", gate: "g-w", attended: false }] });
    if (req.url === "/reattach/r900") return json({ gate: "g-w", header: "h", question: "q-w?", options: ["A", "B"] });
    if (req.url.startsWith("/detach/")) return json({ error: "unknown request" }, 404);
    json({ ok: true });
  });
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const RELAY = `http://127.0.0.1:${relay.address().port}`;
const hitsTo = (p) => hits.filter((h) => (typeof p === "string" ? h.url === p : p.test(h.url)));

const cleanEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|CLAUDE_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$)/.test(k)) delete e[k];
  return e;
})();
let homes = 0;
const newHome = (envText = "") => {
  const h = path.join(TMP, `home${++homes}`);
  fs.mkdirSync(path.join(h, ".myna"), { recursive: true });
  if (envText) fs.writeFileSync(path.join(h, ".myna", ".env"), envText);
  return h;
};
const homeEnv = (home) => ({ ...cleanEnv, HOME: home, USERPROFILE: home, MYNA_ENV: path.join(home, ".myna", ".env") });

// The server is started the way Codex starts it from codex/mcp.json (Codex review r1 X3): the plugin's folder as
// cwd ("cwd": "." → a temp copy standing for ~/.codex/plugins/cache/…/<version>/, where a decision log must never
// land), the relative args resolved there, the environment = only a few base variables (Codex passes MCP servers
// a short allowlist, not the shell's MYNA_* / RELAY_PORT) plus codex/mcp.json's "env". MYNA_RELAY_URL is added the
// only way a Codex install could add it — as if written into that "env" — to reach the stub relay. host "" = the
// same server as Claude Code starts it (no MYNA_HOST).
const CODEX_MCP = JSON.parse(fs.readFileSync(path.join(ROOT, "codex", "mcp.json"), "utf8")).mcpServers.myna;
const BASE_VARS = ["PATH", "Path", "SystemRoot", "windir", "SYSTEMDRIVE", "TEMP", "TMP", "COMSPEC", "PATHEXT", "LANG"];
async function startServer({ host = "codex", home = newHome() } = {}) {
  const env = Object.fromEntries(BASE_VARS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  Object.assign(env, { HOME: home, USERPROFILE: home }, host ? CODEX_MCP.env : {}, { MYNA_RELAY_URL: RELAY });
  const cacheDir = path.join(TMP, `plugin-cache-${homes}`);
  fs.mkdirSync(path.join(cacheDir, "dist"), { recursive: true });
  fs.copyFileSync(serverPath, path.join(cacheDir, "dist", "ask-human.mjs"));
  const args = host ? CODEX_MCP.args : ["./dist/ask-human.mjs"];
  const transport = new StdioClientTransport({ command: process.execPath, args, env, cwd: path.resolve(cacheDir, host ? CODEX_MCP.cwd : "."), stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const c = new Client({ name: "smoke-codex", version: "0" }, { capabilities: {} });
  await c.connect(transport);
  return { c, home, cacheDir, err: () => stderr };
}
const meta = (sessionId, cwd) => ({ ...(sessionId ? { sessionId, threadId: sessionId } : {}), ...(cwd !== undefined ? { "codex/sandbox-state": { sandboxCwd: cwd } } : {}) });
const call = async (c, name, args, m) => {
  const r = await c.callTool({ name, arguments: args, _meta: m }, undefined, { timeout: 15000 });
  return { raw: r, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
};
const readLog = (dir) => { try { return fs.readFileSync(path.join(dir, "MYNA-DECISIONS.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
const projDir = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };

try {
  // 1) codex.mjs: the folder from either form of sandboxCwd
  {
    const winUri = cwdFromMeta(meta("s", "file:///C:/Users/someone/myproj"));
    ok(process.platform === "win32" ? winUri === "C:\\Users\\someone\\myproj" : folderName(winUri) === "myproj", `file:///C:/… → ${JSON.stringify(winUri)} (folder ${folderName(winUri)})`);
    ok(folderName(cwdFromMeta(meta("s", "C:\\Users\\someone\\proj2"))) === "proj2", "a plain Windows path (drive letter) → its folder name, on any OS");
    ok(folderName(cwdFromMeta(meta("s", "/home/someone/proj3/"))) === "proj3", "a plain POSIX path → its folder name");
    ok(cwdFromMeta(meta("s", "relative/dir")) === "" && cwdFromMeta(meta("s", "")) === "" && cwdFromMeta(meta("s")) === "" && cwdFromMeta(undefined) === "", "relative / empty / missing → no folder");
  }

  // 2) initialize + tools/list, Codex and Claude, single machine and tree mode
  {
    const tree = "MYNA_TRANSPORT=tree\n";
    const cx = await startServer({ home: newHome(tree) });
    ok(!!cx.c.getServerCapabilities()?.experimental?.["codex/sandbox-state"], "MYNA_HOST=codex → initialize declares experimental codex/sandbox-state");
    const names = (await cx.c.listTools()).tools.map((t) => t.name).sort();
    ok(JSON.stringify(names) === JSON.stringify(["ask_human", "await_human", "detach_human"]), `MYNA_HOST=codex in tree mode → exactly the 3 tools (${names.join(", ")})`);
    const before = hitsTo("/peer/send").length;
    const ms = await call(cx.c, "message_session", { to: "finch", text: "hi" }, meta("t-ms", projDir("ms")));
    ok(ms.raw.isError === true && /Codex 版還沒有 session 互傳/.test(ms.raw.content[0].text) && hitsTo("/peer/send").length === before, `message_session called anyway → error, nothing sent ("${ms.raw.content[0].text}")`);
    await cx.c.close();
    const cl = await startServer({ host: "", home: newHome(tree) });
    ok(!cl.c.getServerCapabilities()?.experimental, "no MYNA_HOST → no experimental capability (Claude unchanged)");
    ok((await cl.c.listTools()).tools.some((t) => t.name === "message_session"), "no MYNA_HOST in tree mode → message_session still listed (Claude unchanged)");
    await cl.c.close();
  }

  // 3) ask_human: the call's session and project folder
  {
    const projA = projDir("專案 A"), projB = projDir("projB");
    const s = await startServer();
    let r = await call(s.c, "ask_human", { question: "q1?", options: ["A", "B"], gate: "g1" }, meta("thread-1", pathToFileURL(projA).href));
    let ask = hitsTo("/ask").at(-1)?.body;
    ok(r.json?.kind === "selection" && ask?.session_id === "thread-1", `ask_human → relay /ask with session_id = _meta.sessionId (${ask?.session_id})`);
    ok(/^專案 A \d\d\/\d\d \d\d:\d\d$/.test(ask?.session_name || ""), `session_name = the sandboxCwd folder (file:// URI) + time ("${ask?.session_name}")`);
    ok(readLog(projA).some((x) => x.question === "q1?" && x.mode === "human" && x.chosen === "A"), "the decision log is written in the sandboxCwd folder");
    ok(readLog(s.cacheDir).length === 0, "…not in the server's own cwd (the plugin cache folder)");
    const closesBefore = hitsTo("/session/close").length;
    r = await call(s.c, "ask_human", { question: "q2?", options: ["A", "B"], gate: "g2" }, meta("thread-2", projB));
    ask = hitsTo("/ask").at(-1)?.body;
    ok(ask?.session_id === "thread-2", `another _meta.sessionId in the same process → asked under it (${ask?.session_id})`);
    ok(/^專案 A /.test(ask?.session_name || ""), `…the topic name stays the process's first one ("${ask?.session_name}")`);
    await sleep(300);
    ok(hitsTo("/session/close").length === closesBefore, "…and the old session is NOT closed at the relay (no session switch in Codex)");
    ok(/not a switch, nothing closed/.test(s.err()), "…one diagnostic line on stderr");
    ok(readLog(projB).some((x) => x.question === "q2?"), "…its decision log goes to its own sandboxCwd (a plain path)");
    // godmode answer → mode godmode
    r = await call(s.c, "ask_human", { question: "merge?", options: ["✅ 核准", "❌ 不要"], approves: "gh pr merge 4 --squash", gate: "g3" }, meta("thread-2", projB));
    ok(r.json?.by === "godmode" && readLog(projB).some((x) => x.question === "merge?" && x.mode === "godmode" && x.approves === "gh pr merge 4 --squash"), "a by:\"godmode\" answer → decision log mode \"godmode\" (with approves)");
    // logDir still wins
    const own = projDir("own-logdir");
    await call(s.c, "ask_human", { question: "q4?", options: ["A"], gate: "g4", logDir: own }, meta("thread-2", projB));
    ok(readLog(own).some((x) => x.question === "q4?") && !readLog(projB).some((x) => x.question === "q4?"), "logDir passed by the call still wins over sandboxCwd");
    // await_human / detach_human
    const w = projDir("await-proj");
    r = await call(s.c, "await_human", {}, meta("thread-w", w));
    const reqHit = hitsTo(/^\/requests\?/).at(-1), re = hitsTo("/reattach/r900").at(-1)?.body;
    ok(new URL(reqHit?.url || "/", "http://x").searchParams.get("session_id") === "thread-w" && re?.session_id === "thread-w" && r.json?.kind === "selection",
      `await_human → /requests and /reattach under _meta.sessionId (${re?.session_id})`);
    ok(readLog(w).some((x) => x.reattached === "r900"), "…its decision log in the call's sandboxCwd");
    r = await call(s.c, "detach_human", { request_id: "r-other" }, meta("thread-d", w));
    ok(hitsTo("/detach/r-other").at(-1)?.body?.session_id === "thread-d", "detach_human of a request not asked here → /detach with _meta.sessionId");
    await s.c.close();
  }

  // 4) a project folder with spaces as a plain path; no sandboxCwd → <home>/.myna/decisions
  {
    const s = await startServer();
    await call(s.c, "ask_human", { question: "q?", options: ["A"], gate: "g" }, meta("thread-p", projDir("with space")));
    ok(/^with space \d\d\/\d\d/.test(hitsTo("/ask").at(-1)?.body?.session_name || ""), `plain path first → its folder names the topic ("${hitsTo("/ask").at(-1)?.body?.session_name}")`);
    await s.c.close();
    const t = await startServer();
    await call(t.c, "ask_human", { question: "no cwd?", options: ["A"], gate: "g" }, meta("thread-n"));
    const fb = path.join(t.home, ".myna", "decisions");
    ok(readLog(fb).some((x) => x.question === "no cwd?") && readLog(t.cacheDir).length === 0, "no codex/sandbox-state → the decision log goes to <home>/.myna/decisions, not the plugin folder");
    ok(/no project folder/.test(t.err()), "…and says so on stderr");
    const first = hitsTo("/ask").at(-1)?.body?.session_name || "";
    ok(/^session \d\d\/\d\d/.test(first), `…the topic is named "session <time>" (${first})`);
    // the stand-in name is fixed for the process (Codex review r2 X5); a later call with a folder upgrades it
    await call(t.c, "ask_human", { question: "no cwd again?", options: ["A"], gate: "g" }, meta("thread-n"));
    ok(hitsTo("/ask").at(-1)?.body?.session_name === first, "a second call without a project folder → the same stand-in name");
    await call(t.c, "ask_human", { question: "now with a folder", options: ["A"], gate: "g" }, meta("thread-n", projDir("late-folder")));
    ok(/^late-folder \d\d\/\d\d/.test(hitsTo("/ask").at(-1)?.body?.session_name || ""), `the first call with a project folder → its name from then on (${hitsTo("/ask").at(-1)?.body?.session_name})`);
    await t.c.close();
  }

  // 5) session-end.mjs
  {
    const SE = path.join(ROOT, "scripts", "session-end.mjs");
    const run = (input, env) => new Promise((resolve) => {
      const t0 = Date.now(), c = spawn(process.execPath, [SE], { env: { ...cleanEnv, ...env } });
      c.stdin.on("error", () => {});
      c.on("close", (rc) => resolve({ rc, ms: Date.now() - t0 }));
      c.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    });
    let r = await run({ session_id: "thread-end", hook_event_name: "SessionEnd", reason: "other" }, { MYNA_RELAY_URL: RELAY });
    ok(r.rc === 0 && hitsTo("/session/close").some((h) => h.body.session_id === "thread-end"), "session-end.mjs → POST /session/close with the hook's session_id, exit 0");
    const before = hitsTo("/session/close").length;
    r = await run({ hook_event_name: "SessionEnd" }, { MYNA_RELAY_URL: RELAY });
    ok(r.rc === 0 && hitsTo("/session/close").length === before, "no session_id → nothing sent, exit 0");
    r = await run("not json", { MYNA_RELAY_URL: RELAY });
    ok(r.rc === 0, "unreadable input → exit 0");
    // relay down: a port nothing listens on
    const free = http.createServer(); await new Promise((res) => free.listen(0, "127.0.0.1", res)); const freePort = free.address().port; await new Promise((res) => free.close(res));
    r = await run({ session_id: "x" }, { RELAY_PORT: String(freePort) });
    ok(r.rc === 0 && r.ms < 4000, `relay down (RELAY_PORT) → exit 0 in ${r.ms} ms`);
    // relay that never answers
    const silent = http.createServer(() => {}); await new Promise((res) => silent.listen(0, "127.0.0.1", res));
    r = await run({ session_id: "x" }, { MYNA_RELAY_URL: `http://127.0.0.1:${silent.address().port}` });
    ok(r.rc === 0 && r.ms < 4000, `relay that never answers → gives up by itself (exit 0 in ${r.ms} ms; 1.5 s request timeout plus node's start)`);
    // stdin left open (the hook runner never closes it) → still out in time
    const t0 = Date.now(), c = spawn(process.execPath, [SE], { env: { ...cleanEnv, MYNA_RELAY_URL: RELAY } });
    const rc = await new Promise((resolve) => c.on("close", resolve));
    // its own 2 s cap, plus node's start (slow on Windows runners); Codex kills it at 3 s anyway
    ok(rc === 0 && Date.now() - t0 < 4500, `stdin never closed → exits by itself (exit 0 in ${Date.now() - t0} ms)`);
    silent.closeAllConnections?.(); silent.close();
  }

  // 6) ensure-relay --host codex leaves service.json alone
  {
    const ENSURE = path.join(ROOT, "scripts", "ensure-relay.mjs");
    const home = newHome(), SDIR = path.join(home, ".myna", "service"), REC = path.join(SDIR, "service.json");
    const oldRoot = projDir("older-myna");
    fs.mkdirSync(SDIR, { recursive: true });
    const text = JSON.stringify({ root: oldRoot, version: "0.1.0", node: "/x/node" });
    fs.writeFileSync(REC, text);
    const free = http.createServer(); await new Promise((res) => free.listen(0, "127.0.0.1", res)); const port = free.address().port; await new Promise((res) => free.close(res));
    // no .env: ensure-relay starts no relay; the pointer step is all that runs
    const env = { ...homeEnv(home), RELAY_PORT: String(port) };
    let r = spawnSync(process.execPath, [ENSURE, "--host", "codex"], { env, encoding: "utf8", timeout: 20000 });
    ok(r.status === 0 && fs.readFileSync(REC, "utf8") === text && /not configured/.test(r.stdout), `ensure-relay --host codex (newer than service.json) → service.json byte for byte unchanged (rc ${r.status})`);
    r = spawnSync(process.execPath, [ENSURE], { env, encoding: "utf8", timeout: 20000 });
    const rec = JSON.parse(fs.readFileSync(REC, "utf8"));
    ok(r.status === 0 && rec.root === ROOT && rec.version === VERSION, `the same without --host → pointed here as in 0.27.0 (Claude unchanged): ${rec.root}`);
  }
} catch (e) {
  ok(false, `smoke crashed: ${e.stack || e}`);
}

clearTimeout(watchdog);
relay.closeAllConnections?.();
relay.close();
console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ smoke-codex-mcp: all checks passed");
process.exit(failed ? 1 : 0);
