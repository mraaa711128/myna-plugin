#!/usr/bin/env node
// /myna:config (scripts/config.mjs + the chat mod's "myna:config" hook). Temp HOMEs, a fake relay on a random
// port (never :7800), no real ~/.myna.
//   - every switch on / off: the same files as running its own script; the output is that script's
//   - no argument: per item its value and source, 可設 <values>, and a purpose line; <item>: also 用途 / 可設 /
//     存放 in full; writes nothing
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
import { privateProblem } from "./helpers/private-mode.mjs";
import { register, configChatArgs, CHAT_CONFIG_PURPOSE, CHAT_CONFIG_VALUES } from "../hooks/chat-mod.mjs";

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
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|CLAUDE_CODE_SESSION_ID$)/.test(k)) delete e[k];
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
  const items = ["autopilot", "godmode", "intercept", "stopcatch", "brief", "perm", "murmur", "hold", "chat", "topics", "perm-delay"];
  ok(r.rc === 0 && items.every((k) => new RegExp(`^  ${k} `, "m").test(r.out)) && same(snap(a), {}), "no argument → one line per item (all 11), nothing written");
  ok(/autopilot\s+off（預設）/.test(r.out) && /godmode\s+off（預設）/.test(r.out) && /intercept\s+on（預設）/.test(r.out) && /topics\s+auto（預設）/.test(r.out) && /perm-delay\s+30 秒（預設）/.test(r.out), "defaults: autopilot off, intercept on, topics auto, perm-delay 30 s");
  // every item: "可設：…" on its line and a purpose line under it (Stanley 2026-11-11, after trying it)
  const VALUES = { autopilot: "on / off", godmode: "on / off", intercept: "on / off", stopcatch: "on / off", brief: "on / off", perm: "on / off", murmur: "on / off",
    hold: "on / off / max <時間> / status", chat: "on / off（只改目前這個 session）", topics: "auto / off", "perm-delay": "0 以上的整數（秒）" };
  const ls = r.out.trimEnd().split("\n");
  const missing = items.filter((k) => {
    const i = ls.findIndex((l) => l.startsWith(`  ${k} `));
    return !(i >= 0 && ls[i].endsWith(`　可設：${VALUES[k]}`) && /^ {4}\S/.test(ls[i + 1] ?? "") && ls[i + 1].trim().length >= 10);
  });
  ok(missing.length === 0, `no argument → every item ends with 可設：<values> and has a purpose line under it (missing: ${missing.join(", ") || "none"})`);
  ok(/^ {4}手機上的題目自動採用建議選項/m.test(r.out) && /^ {4}權限確認框在終端機等幾秒沒人回答/m.test(r.out) && /^ {4}Telegram 用 topic 分開：每個 gate 一個（TELEGRAM_TOPIC_SCOPE=session 時每個 session 一個）/m.test(r.out), "…the purposes read as written (autopilot, perm-delay, topics)");
  ok(ls.length === 1 + items.length * 2 + 1, `…two lines per item, plus the heading and chat's "no record" line (${ls.length} lines)`);
  await cfg(["stopcatch", "off"], a);
  fs.writeFileSync(path.join(a, ".myna", ".env"), "TELEGRAM_TOPICS=off\n");
  const r2 = await cfg([], a, { MYNA_PERMISSION_DELAY: "45" });
  ok(/stopcatch\s+off（設定檔 .*stopcatch）/.test(r2.out) && /topics\s+off（.*\.env）/.test(r2.out) && /perm-delay\s+45 秒（環境變數）/.test(r2.out),
    "sources: the flag file, ~/.myna/.env, the environment");
  const one = await cfg(["topics"], a);
  const ol = one.out.trim().split("\n");
  ok(one.rc === 0 && ol.length === 4 && /^topics\s+off/.test(ol[0]) && /^  用途：Telegram 用 topic 分開.*已經有 topic 的聊天 session 照用原本的.*Threaded Mode/.test(ol[1]) && ol[2] === "  可設：auto / off" && /^  存放：.*\.env 的 TELEGRAM_TOPICS；relay 啟動時才讀/.test(ol[3]),
    `one item → its line, then 用途 / 可設 / 存放 (${JSON.stringify(ol)})`);
  const holdOne = (await cfg(["hold"], a)).out.trim().split("\n");
  ok(/^  可設：on \/ off \/ max <30m\|6h\|1d\|秒數\|default>（10 分鐘～7 天，預設 1 天）\/ status/.test(holdOne[2]) && /^  存放：.*upstream-hold；馬上生效/.test(holdOne[3]),
    `hold alone → the full values (max's forms and range) and its file (${JSON.stringify(holdOne.slice(2))})`);
  for (const k of ["autopilot", "intercept", "stopcatch", "brief", "perm", "murmur", "perm-delay"]) {
    const o = (await cfg([k], a)).out.trim().split("\n");
    ok(o.length === 4 && /^  用途：\S/.test(o[1]) && /^  可設：\S/.test(o[2]) && /^  存放：\S/.test(o[3]), `${k} alone → 用途 / 可設 / 存放 (${JSON.stringify(o[2])})`);
  }
  fs.writeFileSync(path.join(a, ".myna", ".env"), "MYNA_PERMISSION_DELAY=soon\n");
  const odd = await cfg(["perm-delay"], a);
  ok(/30 秒.*看不懂/.test(odd.out), `an unreadable perm-delay in .env → 30 s and says so ("${odd.out.trim()}")`);
  fs.mkdirSync(path.join(a, ".myna", "x"));
  const edge = await cfg([], a, { MYNA_ROLE: "edge", MYNA_UPSTREAM_HOLD: "off" });
  ok(/hold\s+off，上限 1 天（off：環境變數；上限：預設；/.test(edge.out), "hold from MYNA_UPSTREAM_HOLD → off (環境變數), the cap the default");
  // each hold field from its own place (Codex review r1 X2)
  const h = newHome();
  await cfg(["hold", "max", "6h"], h);
  fs.writeFileSync(path.join(h, ".myna", ".env"), "MYNA_UPSTREAM_HOLD=off\n");
  let hr = await cfg(["hold"], h);
  ok(/hold\s+off，上限 6 小時（off：.*\.myna\/\.env；上限：設定檔 .*upstream-hold；/.test(hr.out), `hold: off from .env, the cap from the hold file — both named ("${hr.out.trim()}")`);
  hr = await cfg(["hold"], h, { MYNA_UPSTREAM_HOLD_MAX: "3600" });
  ok(/off，上限 1 小時（off：.*\.myna\/\.env；上限：環境變數；/.test(hr.out), `hold: off from .env, the cap from the environment ("${hr.out.trim()}")`);
  fs.writeFileSync(path.join(h, ".myna", ".env"), "MYNA_UPSTREAM_HOLD=off\nMYNA_UPSTREAM_HOLD_MAX=7200\n");
  hr = await cfg(["hold"], h);
  ok(/off，上限 2 小時（[^；）]*\.myna\/\.env；只在/.test(hr.out), `hold: both from .env → one source ("${hr.out.trim()}")`);
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
  // written by a rename (Codex review r1 X1): no temp file left, the mode kept, a link stays a link
  ok(!fs.readdirSync(path.join(a, ".myna")).some((f) => f.endsWith(".tmp")), "no temp file left next to .env");
  if (process.platform !== "win32") fs.chmodSync(ENV, 0o600);
  await cfg(["perm-delay", "5"], a);
  { const bad = privateProblem(ENV); ok(!bad, `.env stays 0600 after a write (Windows: this user's ACL only, on every write)${bad ? ` — ${bad}` : ""}`); }
  // links: Windows makes symbolic links only in Developer Mode or as an administrator, so not here
  if (process.platform !== "win32") {
    const real = path.join(TMP, "dotfiles.env"), l = newHome(), link = path.join(l, ".myna", ".env");
    fs.writeFileSync(real, "OTHER=1\n"); fs.symlinkSync(real, link);
    await cfg(["topics", "off"], l);
    ok(fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(real, "utf8") === "OTHER=1\nTELEGRAM_TOPICS=off\n", ".env that is a link: the file it points to is written, the link stays");
    // a link to a file that is not there (Codex review r2 X5): the file is created through the link, the
    // link kept — as configure / hub / join always did (they write through the same updateEnvFile now)
    const d = newHome(), dl = path.join(d, ".myna", ".env"), gone = path.join(TMP, "no-such-dotfile");
    fs.symlinkSync(gone, dl);
    const dr = await cfg(["topics", "off"], d);
    ok(dr.rc === 0 && fs.lstatSync(dl).isSymbolicLink() && fs.readFileSync(gone, "utf8") === "TELEGRAM_TOPICS=off\n", `a dangling .env link → its file created, the link kept (rc ${dr.rc})`);
  }
  const dirEnv = newHome(); fs.mkdirSync(path.join(dirEnv, ".myna", ".env"));
  r = await cfg(["topics", "off"], dirEnv);
  ok(r.rc === 1 && /寫不進去/.test(r.err), `.env not writable (a folder) → says so, rc 1 ("${r.err.trim()}")`);
  r = await cfg([], dirEnv);
  ok(r.rc === 0 && /讀不到/.test(r.out) && /topics\s+auto（預設）/.test(r.out), ".env unreadable → the list still comes, with a note");
  r = await cfg(["topics"], dirEnv);
  ok(r.rc === 0 && /讀不到/.test(r.out) && /^topics/m.test(r.out), `.env unreadable → one item comes with the note too (Codex review r2 X7): ${JSON.stringify(r.out.trim())}`);
}

// 4b) two programs writing .env at the same time (Stanley's decision on Codex review X1): every .env writer
// reads and writes under <.env>.lock (updateEnvFile), so neither change is lost
{
  // the helper itself, with the race made certain: each writer sleeps between its read and its write
  const a = newHome(), ENV = path.join(a, ".myna", ".env");
  fs.writeFileSync(ENV, "KEEP=1\n");
  const remoteUrl = new URL("../src/remote.mjs", import.meta.url).href;
  const writer = (k, p = ENV) => new Promise((resolve) => {
    const code = `import { updateEnvFile } from ${JSON.stringify(remoteUrl)};
      updateEnvFile(${JSON.stringify(p)}, (t) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); return t + "${k}=1\\n"; });`;
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: envOf(a) });
    let err = ""; c.stderr.on("data", (d) => (err += d));
    c.on("close", (rc) => resolve({ rc, err }));
  });
  const rs = await Promise.all(["K1", "K2", "K3", "K4"].map((k) => writer(k)));
  const text = fs.readFileSync(ENV, "utf8");
  ok(rs.every((x) => x.rc === 0) && ["KEEP", "K1", "K2", "K3", "K4"].every((k) => text.includes(`${k}=1\n`)) && !fs.existsSync(`${ENV}.lock`),
    `4 writers at once, each slow between read and write → all 4 keys and the old one kept, the lock gone (${JSON.stringify(text)})`);
  // one writer through a link, one through the real path (Codex review of f2e0818, X4): the same lock.
  // Not on Windows: symbolic links need Developer Mode or an administrator there
  if (process.platform !== "win32") {
    const real = path.join(TMP, "linked.env"), l = newHome(), link = path.join(l, ".myna", ".env");
    fs.writeFileSync(real, "KEEP=1\n"); fs.symlinkSync(real, link);
    const both = await Promise.all([writer("L1", link), writer("R1", real)]);
    const t2 = fs.readFileSync(real, "utf8");
    ok(both.every((x) => x.rc === 0) && ["KEEP", "L1", "R1"].every((k) => t2.includes(`${k}=1\n`)) && fs.lstatSync(link).isSymbolicLink(),
      `a writer through the link and one through the real path at once → both keys kept (${JSON.stringify(t2)})`);
    // the same with a link to a file not there yet (Codex review of cb94b79, X1): the lock sits next to that file
    const gone = path.join(TMP, "not-yet.env"), g = newHome(), glink = path.join(g, ".myna", ".env");
    fs.symlinkSync(gone, glink);
    const both2 = await Promise.all([writer("L2", glink), writer("R2", gone)]);
    const t3 = fs.readFileSync(gone, "utf8");
    ok(both2.every((x) => x.rc === 0) && ["L2", "R2"].every((k) => t3.includes(`${k}=1\n`)) && fs.lstatSync(glink).isSymbolicLink(),
      `a dangling link and its target path written at once → both keys kept (${JSON.stringify(t3)})`);
  }
  // the real scripts, five rounds: /myna:config topics + perm-delay and /myna:configure provider at the same time
  let lost = 0;
  for (let i = 0; i < 5; i++) {
    const h = newHome(), E = path.join(h, ".myna", ".env");
    fs.writeFileSync(E, "TELEGRAM_BOT_TOKEN=123:abc\n");
    await Promise.all([cfg(["topics", "off"], h), cfg(["perm-delay", String(10 + i)], h), run("configure.mjs", ["provider", "telegram"], h)]);
    const t = fs.readFileSync(E, "utf8");
    if (!(t.includes("TELEGRAM_BOT_TOKEN=123:abc\n") && t.includes("TELEGRAM_TOPICS=off\n") && t.includes(`MYNA_PERMISSION_DELAY=${10 + i}\n`) && t.includes("MYNA_PROVIDER=telegram\n"))) { lost++; console.log(`   round ${i}: ${JSON.stringify(t)}`); }
  }
  ok(lost === 0, `config topics + config perm-delay + configure provider at once, 5 rounds → no key lost (${lost} rounds lost one)`);
  // the lock held by someone else for too long: config says it could not write, .env unchanged
  const b = newHome(), EB = path.join(b, ".myna", ".env");
  fs.writeFileSync(EB, "X=1\n");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
  fs.writeFileSync(`${EB}.lock`, `${holder.pid} test\n`);
  const t0 = Date.now(), rb = await cfg(["topics", "off"], b);
  holder.kill(); fs.rmSync(`${EB}.lock`, { force: true });
  ok(rb.rc === 1 && /寫不進去/.test(rb.err) && fs.readFileSync(EB, "utf8") === "X=1\n" && Date.now() - t0 >= 9000, `a lock held by a live process → waits, then refuses, .env unchanged ("${rb.err.trim()}")`);
}

// 5) unknown item; chat without the chat mod
{
  const a = newHome();
  let r = await cfg(["nope", "on"], a);
  ok(r.rc === 1 && /不認得的項目「nope」/.test(r.err) && /autopilot、godmode、intercept/.test(r.err) && same(snap(a), {}), "unknown item → error with the item list, nothing written");
  r = await cfg(["chat", "on"], a);
  ok(r.rc === 1 && /沒有載入聊天模組/.test(r.out) && same(snap(a), {}), "chat reaching config.mjs (no chat mod) → says the mod is not loaded, nothing written");
  r = await cfg(["chat"], a);
  ok(r.rc === 1 && r.out.includes(`  用途：${CHAT_CONFIG_PURPOSE}\n`) && r.out.includes(`  可設：${CHAT_CONFIG_VALUES}\n`), "chat alone without the chat mod → still says what it is for and what it takes");
  // the list's chat texts are the chat mod's own (the mod answers "/myna:config chat" with them)
  r = await cfg([], a);
  ok(r.out.includes(`　可設：${CHAT_CONFIG_VALUES}\n    ${CHAT_CONFIG_PURPOSE}\n`), "the list's chat 可設 and purpose = the chat mod's CHAT_CONFIG_VALUES / CHAT_CONFIG_PURPOSE");
  r = await cfg(["files"], a);
  ok(r.rc === 1, "files is not a /myna:config item (it stays /myna:files)");
}

// 6) the chat mod's /myna:config hook (a stub engine; no relay secret → chat never reaches a relay)
ok(configChatArgs("chat") === "" && configChatArgs(" Chat  ON ") === "on" && configChatArgs("chat on now") === "on now" && configChatArgs("chatty") === null && configChatArgs("autopilot on") === null && configChatArgs("") === null && configChatArgs(undefined) === null,
  "configChatArgs: chat / Chat ON / chat on now / chatty / autopilot on / empty");
// dir: the stub's Myna folder (MYNA_ENV is <dir>/.env, so the chat mod's state files go to <dir>/chat-state);
// S.sid: the session id the engine reports (a /clear or a resume changes it)
function engine({ dir = path.join(TMP, "eng0"), root = "/w", sid = "s-1" } = {}) {
  const hooks = [], store = new Map(), S = { sid, delays: [] }; // delays: ms for the next writes, in order
  register((event, a, b) => {
    const [match, hook] = b ? [a, b] : [null, a];
    const h = { event, match, hook, onError: null };
    hooks.push(h);
    return { catch(f) { h.onError = f; return this; } };
  });
  const $ = {
    http: { fetch: async () => { throw new Error("no network in this test"); } },
    // like the engine's $.fs.write: creates the folders, writes the whole text
    fs: { read: async () => { throw new Error("ENOENT"); }, write: async (p, text) => { const d = S.delays.shift(); if (d) await new Promise((res) => setTimeout(res, d)); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); } },
    session: { id: async () => S.sid, root: async () => root, cwd: async () => root, usage: async () => null },
    ui: { status: () => {} },
    prompt: { submit: async ({ text }) => ({ text }) },
    command: { list: async () => [], run: async () => ({}) },
    clock: { every: () => ({ cancel() {} }) },
    store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, keys: async () => [...store.keys()] },
    env: { get: async (n) => ({ HOME: TMP, MYNA_ENV: path.join(dir, ".env"), RELAY_PORT: String(PORT), MYNA_RELAY_SECRET_FILE: path.join(TMP, "no-secret") })[n] },
  };
  const fire = async (event, e) => {
    let passed = null;
    for (const h of hooks.filter((x) => x.event === event && (!x.match || Object.entries(x.match).every(([k, v]) => e[k] === v)))) {
      const next = async (ev) => { passed = ev; return { text: "<markdown command ran>" }; };
      try { return { r: await h.hook($, e, next), passed }; } catch (x) { return h.onError ? { r: await h.onError($, e, next), passed } : { r: e, passed }; }
    }
    return { r: e, passed: e };
  };
  return { S, fire, store, cmd: (command, args = "") => fire("command.run", { command, args, origin: { kind: "composer" } }) };
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
  const state0 = "💬 聊天目前關閉。用 /myna:config chat on 開啟。";
  ok(x.passed === null && x.r.text === `${state0}\n用途：${CHAT_CONFIG_PURPOSE}（需要 Claude Code 2.1.287 以上，只支援 Telegram）\n可設：${CHAT_CONFIG_VALUES}` && viaChat.r.text.startsWith(`${state0}\n提示：`),
    `/myna:config chat → the state as /myna:chat says it, then 用途 / 可設 (${JSON.stringify(x.r.text)})`);
  ok(/\n提示：\/myna:chat 之後會移除，請改用 \/myna:config chat on\|off$/.test(viaChat.r.text), "/myna:chat's answer ends with the hint line");
  x = await E.cmd("myna:config", "chat on");
  ok(x.passed === null && /聊天已開啟/.test(x.r.text) && E.store.get("chat:s-1")?.on === true, `/myna:config chat on → on, stored ("${x.r.text}")`);
  const viaChatOn = await E.cmd("myna:chat", "on");
  ok(viaChatOn.r.text.split("\n")[0] === x.r.text, "…the same answer as /myna:chat on (without the hint)");
  x = await E.cmd("myna:config", "chat maybe");
  ok(x.passed === null && /只接受 on 或 off/.test(x.r.text) && E.store.get("chat:s-1")?.on === true, `/myna:config chat maybe → refused, unchanged ("${x.r.text}")`);
}

// 7) each session's chat on/off in the list (Stanley's decision on Codex review X4): the chat mod writes
// <myna dir>/chat-state/<session>.json; config.mjs lists them, this session marked, ended ones removed
{
  const home = newHome(), dir = path.join(home, ".myna"), stateDir = path.join(dir, "chat-state");
  const state = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), "utf8")); } catch { return null; } };
  const A = engine({ dir, root: "/work/myna-plugin", sid: "sess-a" });
  await A.fire("session.start", { cwd: "/work/myna-plugin", surface: "terminal", isInteractive: true });
  ok(state("sess-a")?.on === true && state("sess-a").project === "/work/myna-plugin" && !Number.isNaN(Date.parse(state("sess-a").updated_at)), `session start (terminal) → its file says on (${JSON.stringify(state("sess-a"))})`);
  const B = engine({ dir, root: "/work/friday-ai", sid: "sess-b" });
  await B.fire("session.start", { cwd: "/work/friday-ai", surface: null, isInteractive: false });
  ok(state("sess-b")?.on === false, "session start (-p / SDK) → its file says off");
  await A.cmd("myna:config", "chat off");
  ok(state("sess-a")?.on === false, "/myna:config chat off → the file says off");
  await A.cmd("myna:chat", "on");
  ok(state("sess-a")?.on === true, "/myna:chat on (the alias) → the file says on");
  let r = await cfg([], home, { CLAUDE_CODE_SESSION_ID: "sess-b" });
  const chatLines = r.out.split("\n").filter((l) => /^ {13}(on |off)/.test(l));
  ok(/^  chat .*新 session 預設開（終端機 session）/m.test(r.out) && chatLines.length === 2 && /^ {13}off  friday-ai　最後更新 .*← 這個 session$/.test(chatLines[0]) && /^ {13}on   myna-plugin　最後更新 /.test(chatLines[1]),
    `the list: the default line kept, one line per session, this one first and marked:\n${chatLines.join("\n")}`);
  // a /clear: the old id ends, the next prompt records the new one
  await A.fire("session.end", { reason: "clear", sessionId: "sess-a" });
  ok(state("sess-a")?.ended_at, "session end → ended_at in its file");
  A.S.sid = "sess-a2";
  await A.fire("prompt.submit", { text: "hi", origin: { kind: "composer" } });
  await new Promise((res) => setTimeout(res, 100)); // the refresh is not awaited by the prompt
  ok(state("sess-a2")?.on === true, "after /clear, the next prompt records the new session id");
  // an unreadable file (being written?) is skipped and kept; one not updated for 31 days is removed
  fs.writeFileSync(path.join(stateDir, "half.json"), "{\"session_id\":");
  fs.writeFileSync(path.join(stateDir, "old.json"), JSON.stringify({ session_id: "old", on: true, project: "/x", updated_at: new Date(Date.now() - 31 * 86400e3).toISOString() }));
  r = await cfg([], home);
  const names = fs.readdirSync(stateDir).sort();
  ok(!/sess-a\b/.test(names.join(",")) && JSON.stringify(names) === JSON.stringify(["half.json", "sess-a2.json", "sess-b.json"]) && r.out.split("\n").filter((l) => /^ {13}(on |off)/.test(l)).length === 2 && !/← 這個 session/.test(r.out),
    `listing removes the ended session and the 31-day-old one, keeps the unreadable one unlisted, marks none without CLAUDE_CODE_SESSION_ID (${JSON.stringify(names)})`);
  // no records at all
  const empty = await cfg([], newHome());
  ok(/還沒有 session 的紀錄/.test(empty.out), "no state files → says there is no record yet");
  // writes land in the order asked (Codex review of be0da2e, Y2): a prompt's refresh whose write is slow,
  // then chat off right after — the file must end up off
  const C = engine({ dir, root: "/work/c", sid: "sess-c" });
  await C.fire("session.start", { cwd: "/work/c", surface: "terminal", isInteractive: true });
  C.S.sid = "sess-c2"; // a /clear: the next prompt's refresh writes the new id
  C.S.delays = [300, 0];
  C.fire("prompt.submit", { text: "hi", origin: { kind: "composer" } });
  await C.cmd("myna:config", "chat off");
  await new Promise((res) => setTimeout(res, 400));
  ok(state("sess-c2")?.on === false, `a slow refresh asked before chat off does not land after it (${JSON.stringify(state("sess-c2"))})`);
  // a turn started from the phone has no prompt.submit (Codex review of f2e0818, X3): turn.start refreshes too
  const D = engine({ dir, root: "/work/d", sid: "sess-d" });
  await D.fire("session.start", { cwd: "/work/d", surface: "terminal", isInteractive: true });
  D.S.sid = "sess-d2";
  await D.fire("turn.start", { text: "The myna plugin sent a message: hi" });
  await new Promise((res) => setTimeout(res, 100));
  ok(state("sess-d2")?.on === true, `a turn with no prompt.submit (from the phone) records the new session id (${JSON.stringify(state("sess-d2"))})`);}

// 8) more from the review of be0da2e: a new .env is 0600 and stays so; hub on checks the role again under the lock
{
  {
    const h = newHome(), E = path.join(h, ".myna", ".env");
    await cfg(["topics", "off"], h);
    const bad1 = privateProblem(E);
    await run("configure.mjs", ["telegram", "123:abc"], h);
    const bad2 = privateProblem(E);
    ok(!bad1 && !bad2, `a .env created by /myna:config is 0600 (Windows: this user's ACL only), still so after configure writes a token${bad1 || bad2 ? ` — ${bad1 || ""} ${bad2 || ""}` : ""}`);
  }
  // hub on starts while the lock is held; meanwhile .env becomes an edge's (a join finished): hub refuses
  const h = newHome(), E = path.join(h, ".myna", ".env");
  fs.writeFileSync(E, "TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID=1\n");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
  fs.writeFileSync(`${E}.lock`, `${holder.pid} test\n`);
  const hubP = run("hub.mjs", ["on"], h);
  await new Promise((res) => setTimeout(res, 1500));
  fs.writeFileSync(E, "TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID=1\nMYNA_ROLE=edge\nMYNA_UPSTREAM=https://hub.example.com\n");
  fs.rmSync(`${E}.lock`, { force: true }); holder.kill();
  const hr = await hubP;
  ok(hr.rc === 1 && /這台是 edge/.test(hr.err) && !fs.readFileSync(E, "utf8").includes("MYNA_REMOTE_PORT") && !fs.existsSync(`${E}.lock`),
    `hub on, the .env turned into an edge's while it waited for the lock → refused, nothing written, the lock gone ("${hr.err.trim().slice(0, 60)}…")`);
}

// 9) --host codex (Codex CLI's $myna:config skill, PR 2): only autopilot / stopcatch / hold / topics — listed,
// changed with the same files and texts as without --host; the other items refused, nothing written; the
// command hints in Codex's words
{
  const cx = (args, home, extra) => cfg(["--host", "codex", ...args], home, extra);
  const ORDER_ALL = ["autopilot", "godmode", "intercept", "stopcatch", "brief", "perm", "murmur", "hold", "chat", "topics", "perm-delay"];
  const a = newHome();
  let r = await cx([], a);
  const listed = ORDER_ALL.filter((k) => new RegExp(`^  ${k} `, "m").test(r.out));
  ok(r.rc === 0 && JSON.stringify(listed) === JSON.stringify(["autopilot", "stopcatch", "hold", "topics"]) && same(snap(a), {}), `--host codex, no argument → the 4 items only (${listed.join(", ")}), nothing written`);
  ok(/^Myna 設定（改：\$myna:config <項目> <值>；單項的詳細：\$myna:config <項目>）/.test(r.out) && !r.out.includes("/myna:"), `…the hints are $myna:config, no /myna: left ("${r.out.split("\n")[0]}")`);
  for (const [k, v] of [["autopilot", "on"], ["stopcatch", "off"], ["hold", "off"], ["topics", "off"]]) {
    const h1 = newHome(), h2 = newHome();
    const r1 = await cx([k, v], h1), r2 = await cfg([k, v], h2);
    const envSame = fs.existsSync(path.join(h1, ".myna", ".env")) ? fs.readFileSync(path.join(h1, ".myna", ".env"), "utf8") === fs.readFileSync(path.join(h2, ".myna", ".env"), "utf8") : true;
    ok(r1.rc === 0 && same(snap(h1), snap(h2)) && envSame, `--host codex ${k} ${v} → the same files as /myna:config ${k} ${v} (${JSON.stringify(snap(h1))})`);
  }
  {
    const h = newHome();
    const t = await cx(["topics", "off"], h);
    ok(/\$myna:manage relay restart/.test(t.out) && !t.out.includes("/myna:"), `--host codex topics off → says to restart with $myna:manage relay restart ("${t.out.trim()}")`);
    const one = await cx(["hold"], h);
    ok(one.rc === 0 && /\$myna:manage join/.test(one.out) && !one.out.includes("/myna:"), "--host codex hold → its details, with $myna:manage join");
    const st = await cx(["hold", "status"], h), direct = await run("hold.mjs", ["status"], h);
    ok(st.rc === 0 && !st.all.includes("/myna:"), `--host codex hold status → hold.mjs's output, its /myna: hints in Codex's words ("${st.out.trim().split("\n")[0]}")`);
    // passed on whole, not cut off by the exit (Codex review r2 X6): every line of hold.mjs's own output is there
    ok(direct.out.trim().split("\n").length > 1 && st.out.trim().split("\n").length === direct.out.trim().split("\n").length, `…every line of it (${st.out.trim().split("\n").length} lines, hold.mjs alone ${direct.out.trim().split("\n").length})`);
  }
  for (const k of ["godmode", "intercept", "brief", "perm", "perm-delay", "murmur", "chat"]) {
    const h = newHome(), v = k === "perm-delay" ? "5" : "on";
    const pre = JSON.stringify(snap(h));
    const rr = await cx([k, v], h), alone = await cx([k], h);
    ok(rr.rc === 1 && /Codex 版還沒有這個功能/.test(rr.err) && alone.rc === 1 && JSON.stringify(snap(h)) === pre && !fs.existsSync(path.join(h, ".myna", ".env")),
      `--host codex ${k} ${v} (and ${k} alone) → "Codex 版還沒有這個功能", exit 1, nothing written`);
  }
  r = await cx(["nope"], newHome());
  ok(r.rc === 1 && /不認得的項目「nope」.*autopilot、stopcatch、hold、topics$/m.test(r.err), `--host codex, an unknown item → the 4 items listed ("${r.err.trim()}")`);
  r = await cfg(["--host", "claude-ish", "autopilot", "on"], a);
  ok(r.rc === 1 && /--host 只接受 codex/.test(r.err) && same(snap(a), {}), "--host <anything else> → refused, nothing written");
  r = await cfg(["autopilot", "on", "--host", "codex"], newHome());
  ok(r.rc === 0, "--host codex may come after the item too");
}

srv.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ smoke-config: all checks passed");
process.exit(failed ? 1 : 0);
