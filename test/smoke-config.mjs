#!/usr/bin/env node
// /myna:config (scripts/config.mjs + the chat mod's "myna:config" hook). Temp HOMEs, a fake relay on a random
// port (never :7800), no real ~/.myna.
//   - every switch on / off: the same files as running its own script; the output is that script's
//   - <item> / no argument: one line per item with its source; writes nothing
//   - hold max 6h / status go to hold.mjs; bad values refused before anything runs
//   - topics / perm-delay → ~/.myna/.env: validated (a bad value leaves the file as it was), the key's line
//     replaced (CRLF kept, duplicates too, comments untouched) or added; an environment variable that wins is named
//   - an unknown item: an error and the list; chat without the chat mod: says the mod is not loaded
//   - the chat mod: /myna:config chat on|off answers like /myna:chat; any other item goes on (next) untouched;
//     /myna:chat's answer carries the hint line
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register, configChatArgs } from "../hooks/chat-mod.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const SCRIPTS = path.join(ROOT, "scripts");
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-config-"));
// a fake relay: hold.mjs status asks /health; 404 = no relay info
const seen = [];
const srv = http.createServer((q, res) => { seen.push(q.url); res.writeHead(404); res.end("{}"); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;

const clean = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$)/.test(k)) delete e[k];
  return e;
})();
let homes = 0;
const newHome = () => { const h = path.join(TMP, `home${++homes}`); fs.mkdirSync(path.join(h, ".myna"), { recursive: true }); return h; };
const envOf = (home, extra = {}) => ({ ...clean, HOME: home, USERPROFILE: home, MYNA_ENV: path.join(home, ".myna", ".env"), RELAY_PORT: String(PORT), ...extra });
const run = (script, args, home, extra) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { env: envOf(home, extra) });
  let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
  c.on("close", (rc) => resolve({ rc, out, err, all: out + err }));
});
const cfg = (args, home, extra) => run("config.mjs", args, home, extra);
// a home's files (name → first line), the time stamps left out
const snap = (home) => {
  const d = path.join(home, ".myna"), o = {};
  for (const f of fs.readdirSync(d).sort()) o[f] = fs.readFileSync(path.join(d, f), "utf8").split(/\r?\n/)[0].replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/, "<t>");
  return o;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = (s) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>").replace(/home\d+/g, "home");

// 1) every switch: the same files and output as its own script
const SW = { autopilot: "autopilot", intercept: "intercept", stopcatch: "stopcatch", brief: "brief", perm: "permission", murmur: "chat-progress", hold: "upstream-hold" };
for (const [k, file] of Object.entries(SW)) {
  for (const v of ["off", "on"]) {
    const a = newHome(), b = newHome();
    const r1 = await cfg([k, v], a), r2 = await run(`${k}.mjs`, [v], b);
    ok(r1.rc === 0 && same(snap(a), snap(b)) && stamp(r1.all) === stamp(r2.all),
      `config ${k} ${v} = ${k}.mjs ${v}: files ${JSON.stringify(snap(a))}, output "${r1.out.trim().split("\n")[0].slice(0, 60)}…"`);
    if (v === "off" && k !== "autopilot") ok(fs.existsSync(path.join(a, ".myna", file)), `  …${k} off writes ~/.myna/${file}`);
  }
}
{
  const a = newHome();
  await cfg(["autopilot", "on"], a);
  const r = await cfg(["autopilot", "off"], a);
  ok(r.rc === 0 && !fs.existsSync(path.join(a, ".myna", "autopilot")), "autopilot on then off → the flag file is gone");
  const up = await cfg(["AUTOPILOT", "ON"], a);
  ok(up.rc === 0 && fs.existsSync(path.join(a, ".myna", "autopilot")), "item and value are case-insensitive (AUTOPILOT ON)");
}

// 2) hold max / status go to hold.mjs; bad values are refused before anything runs
{
  const a = newHome(), b = newHome();
  const r1 = await cfg(["hold", "max", "6h"], a), r2 = await run("hold.mjs", ["max", "6h"], b);
  const l = fs.readFileSync(path.join(a, ".myna", "upstream-hold"), "utf8").split(/\r?\n/);
  ok(r1.rc === 0 && l[1] === "max=21600" && stamp(r1.all) === stamp(r2.all), `hold max 6h → max=21600, output as hold.mjs's (${JSON.stringify(l.slice(0, 2))})`);
  const bad = await cfg(["hold", "max", "5m"], a);
  ok(bad.rc === 1 && /10 分鐘/.test(bad.all), "hold max 5m → hold.mjs refuses it (rc 1)");
  const before = seen.length;
  const st = await cfg(["hold", "status"], a);
  ok(st.rc === 0 && /斷線排隊：開，上限 6 小時/.test(st.out) && seen.length > before && seen.at(-1) === "/health", "hold status → hold.mjs status (asked the fake relay's /health)");
  for (const args of [["hold", "maybe"], ["hold", "max"], ["hold", "on", "now"]]) {
    const pre = JSON.stringify(snap(a)), r = await cfg(args, a);
    ok(r.rc === 1 && JSON.stringify(snap(a)) === pre && /沒有改/.test(r.err), `config ${args.join(" ")} → refused, nothing written`);
  }
}
for (const args of [["autopilot", "yes"], ["intercept", "status"], ["brief", "on", "off"], ["murmur", "1"]]) {
  const a = newHome(), r = await cfg(args, a);
  ok(r.rc === 1 && same(snap(a), {}) && /只接受 on 或 off/.test(r.err), `config ${args.join(" ")} → refused, nothing written`);
}

// 3) no argument / one item: one line each, the source, nothing written
{
  const a = newHome();
  const r = await cfg([], a);
  const items = ["autopilot", "intercept", "stopcatch", "brief", "perm", "murmur", "hold", "chat", "topics", "perm-delay"];
  ok(r.rc === 0 && items.every((k) => new RegExp(`^  ${k} `, "m").test(r.out)) && same(snap(a), {}), "no argument → one line per item (all 10), nothing written");
  ok(/autopilot\s+off（預設）/.test(r.out) && /intercept\s+on（預設）/.test(r.out) && /topics\s+auto（預設）/.test(r.out) && /perm-delay\s+30 秒（預設）/.test(r.out), "defaults: autopilot off, intercept on, topics auto, perm-delay 30 s");
  await cfg(["stopcatch", "off"], a);
  fs.writeFileSync(path.join(a, ".myna", ".env"), "TELEGRAM_TOPICS=off\n");
  const r2 = await cfg([], a, { MYNA_PERMISSION_DELAY: "45" });
  ok(/stopcatch\s+off（設定檔 .*stopcatch）/.test(r2.out) && /topics\s+off（.*\.env）/.test(r2.out) && /perm-delay\s+45 秒（環境變數）/.test(r2.out),
    "sources: the flag file, ~/.myna/.env, the environment");
  const one = await cfg(["topics"], a);
  ok(one.rc === 0 && one.out.trim().split("\n").length === 1 && /^topics\s+off/.test(one.out), `one item → that line only ("${one.out.trim()}")`);
  fs.writeFileSync(path.join(a, ".myna", ".env"), "MYNA_PERMISSION_DELAY=soon\n");
  const odd = await cfg(["perm-delay"], a);
  ok(/30 秒.*看不懂/.test(odd.out), `an unreadable perm-delay in .env → 30 s and says so ("${odd.out.trim()}")`);
  fs.mkdirSync(path.join(a, ".myna", "x"));
  const edge = await cfg([], a, { MYNA_ROLE: "edge", MYNA_UPSTREAM_HOLD: "off" });
  ok(/hold\s+off，上限 1 天（環境變數/.test(edge.out), "hold from MYNA_UPSTREAM_HOLD → off (環境變數)");
}

// 4) topics / perm-delay → ~/.myna/.env
{
  const a = newHome(), ENV = path.join(a, ".myna", ".env");
  let r = await cfg(["topics", "off"], a);
  ok(r.rc === 0 && fs.readFileSync(ENV, "utf8") === "TELEGRAM_TOPICS=off\n" && /restart/.test(r.out), `topics off → a new .env with TELEGRAM_TOPICS=off; says restart ("${r.out.trim()}")`);
  r = await cfg(["perm-delay", "0"], a);
  ok(r.rc === 0 && fs.readFileSync(ENV, "utf8") === "TELEGRAM_TOPICS=off\nMYNA_PERMISSION_DELAY=0\n", "perm-delay 0 → a line added");
  r = await cfg(["topics", "auto"], a);
  ok(r.rc === 0 && fs.readFileSync(ENV, "utf8") === "TELEGRAM_TOPICS=auto\nMYNA_PERMISSION_DELAY=0\n", "topics auto → the same line replaced, not added");
  r = await cfg(["perm-delay", "007"], a);
  ok(fs.readFileSync(ENV, "utf8").includes("MYNA_PERMISSION_DELAY=7\n"), "perm-delay 007 → written as 7");
  const body = "# TELEGRAM_TOPICS=off is how to turn them off\r\nTELEGRAM_BOT_TOKEN=123:abc\r\nTELEGRAM_TOPICS=auto\r\n TELEGRAM_TOPICS = auto\r\nOTHER=1";
  fs.writeFileSync(ENV, body);
  for (const bad of [["topics", "on"], ["topics"], ["perm-delay", "-1"], ["perm-delay", "1.5"], ["perm-delay", "abc"], ["perm-delay", "30", "s"], ["topics", "off", "now"]]) {
    r = await cfg(bad, a);
    ok((bad.length === 1 ? r.rc === 0 : r.rc === 1) && fs.readFileSync(ENV, "utf8") === body, `config ${bad.join(" ")} → ${bad.length === 1 ? "shows" : "refused"}, .env unchanged`);
  }
  r = await cfg(["topics", "off"], a);
  const after = fs.readFileSync(ENV, "utf8");
  ok(after === "# TELEGRAM_TOPICS=off is how to turn them off\r\nTELEGRAM_BOT_TOKEN=123:abc\r\nTELEGRAM_TOPICS=off\r\nTELEGRAM_TOPICS=off\r\nOTHER=1",
    `existing lines (a duplicate, spaces around the key) replaced, CRLF and the comment kept, nothing added: ${JSON.stringify(after)}`);
  ok(!r.all.includes("123:abc"), "the output never shows another .env value (the token)");
  r = await cfg(["topics", "auto"], a, { TELEGRAM_TOPICS: "off" });
  ok(r.rc === 0 && /環境變數 TELEGRAM_TOPICS=off 有設/.test(r.out) && fs.readFileSync(ENV, "utf8").includes("TELEGRAM_TOPICS=auto"), "TELEGRAM_TOPICS in the environment → still written, and it says the variable wins");
  const dirEnv = newHome(); fs.mkdirSync(path.join(dirEnv, ".myna", ".env"));
  r = await cfg(["topics", "off"], dirEnv);
  ok(r.rc === 1 && /寫不進去/.test(r.err), `.env not writable (a folder) → says so, rc 1 ("${r.err.trim()}")`);
  r = await cfg([], dirEnv);
  ok(r.rc === 0 && /讀不到/.test(r.out) && /topics\s+auto（預設）/.test(r.out), ".env unreadable → the list still comes, with a note");
}

// 5) unknown item; chat without the chat mod
{
  const a = newHome();
  let r = await cfg(["nope", "on"], a);
  ok(r.rc === 1 && /不認得的項目「nope」/.test(r.err) && /autopilot、intercept/.test(r.err) && same(snap(a), {}), "unknown item → error with the item list, nothing written");
  r = await cfg(["chat", "on"], a);
  ok(r.rc === 1 && /沒有載入聊天模組/.test(r.out) && same(snap(a), {}), "chat reaching config.mjs (no chat mod) → says the mod is not loaded, nothing written");
  r = await cfg(["files"], a);
  ok(r.rc === 1, "files is not a /myna:config item (it stays /myna:files)");
}

// 6) the chat mod's /myna:config hook (a stub engine; no relay secret → chat never reaches a relay)
ok(configChatArgs("chat") === "" && configChatArgs(" Chat  ON ") === "on" && configChatArgs("chat on now") === "on now" && configChatArgs("chatty") === null && configChatArgs("autopilot on") === null && configChatArgs("") === null && configChatArgs(undefined) === null,
  "configChatArgs: chat / Chat ON / chat on now / chatty / autopilot on / empty");
function engine() {
  const hooks = [], store = new Map();
  register((event, a, b) => {
    const [match, hook] = b ? [a, b] : [null, a];
    const h = { event, match, hook, onError: null };
    hooks.push(h);
    return { catch(f) { h.onError = f; return this; } };
  });
  const $ = {
    http: { fetch: async () => { throw new Error("no network in this test"); } },
    fs: { read: async () => { throw new Error("ENOENT"); } },
    session: { id: async () => "s-1", root: async () => "/w", cwd: async () => "/w", usage: async () => null },
    ui: { status: () => {} },
    prompt: { submit: async ({ text }) => ({ text }) },
    command: { list: async () => [], run: async () => ({}) },
    clock: { every: () => ({ cancel() {} }) },
    store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, keys: async () => [...store.keys()] },
    env: { get: async (n) => ({ HOME: TMP, MYNA_ENV: path.join(TMP, "none.env"), RELAY_PORT: String(PORT), MYNA_RELAY_SECRET_FILE: path.join(TMP, "no-secret") })[n] },
  };
  const fire = async (event, e) => {
    let passed = null;
    for (const h of hooks.filter((x) => x.event === event && (!x.match || Object.entries(x.match).every(([k, v]) => e[k] === v)))) {
      const next = async (ev) => { passed = ev; return { text: "<markdown command ran>" }; };
      try { return { r: await h.hook($, e, next), passed }; } catch (x) { return h.onError ? { r: await h.onError($, e, next), passed } : { r: e, passed }; }
    }
    return { r: e, passed: e };
  };
  return { fire, store, cmd: (command, args = "") => fire("command.run", { command, args, origin: { kind: "composer" } }) };
}
{
  const E = engine();
  await E.fire("session.start", { cwd: "/w", surface: "terminal", isInteractive: true });
  let x = await E.cmd("myna:config", "autopilot on");
  ok(x.passed?.args === "autopilot on" && x.r.text === "<markdown command ran>", "/myna:config autopilot on → next(e) with the same args (the markdown command runs)");
  x = await E.cmd("myna:config", "");
  ok(x.passed?.args === "" && x.r.text === "<markdown command ran>", "/myna:config (no argument) → next(e)");
  x = await E.cmd("myna:config", "chat off");
  ok(x.passed === null && /聊天已關閉/.test(x.r.text) && E.store.get("chat:s-1")?.on === false, `/myna:config chat off → answered by the mod, stored off ("${x.r.text}")`);
  const viaChat = await E.cmd("myna:chat", "");
  x = await E.cmd("myna:config", "chat");
  ok(x.passed === null && x.r.text === "💬 聊天目前關閉。用 /myna:chat on 開啟。" && viaChat.r.text.startsWith(x.r.text), `/myna:config chat → the state, as /myna:chat says it ("${x.r.text}")`);
  ok(/\n提示：\/myna:chat 之後會移除，請改用 \/myna:config chat on\|off$/.test(viaChat.r.text), "/myna:chat's answer ends with the hint line");
  x = await E.cmd("myna:config", "chat on");
  ok(x.passed === null && /聊天已開啟/.test(x.r.text) && E.store.get("chat:s-1")?.on === true, `/myna:config chat on → on, stored ("${x.r.text}")`);
  const viaChatOn = await E.cmd("myna:chat", "on");
  ok(viaChatOn.r.text.split("\n")[0] === x.r.text, "…the same answer as /myna:chat on (without the hint)");
  x = await E.cmd("myna:config", "chat maybe");
  ok(x.passed === null && /只接受 on 或 off/.test(x.r.text) && E.store.get("chat:s-1")?.on === true, `/myna:config chat maybe → refused, unchanged ("${x.r.text}")`);
}

srv.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ smoke-config: all checks passed");
process.exit(failed ? 1 : 0);
