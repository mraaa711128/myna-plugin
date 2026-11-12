#!/usr/bin/env node
// Start the Myna relay at login — without Claude Code (SPEC §5.5). Plain node, no npm install:
//   node <myna>/scripts/service.mjs on       register "run ~/.myna/service/start.mjs at login" with the OS
//                                              (macOS LaunchAgent, the Windows Startup folder, Linux systemd --user),
//                                              write start.mjs + service.json, make sure a relay runs now
//   node <myna>/scripts/service.mjs off      take the registration away, then delete ~/.myna/service/.
//                                              The running relay is NOT stopped (it may serve sessions now):
//                                              /myna:relay stop, or node <myna>/scripts/stop-relay.mjs
//   node <myna>/scripts/service.mjs [status] registration, the paths service.json points at, the relay's /health
// What runs at login is ensure-relay — the same idempotent, version-ordered start as SessionStart — so the
// relay started at login and the one a session starts are the same thing; nothing watches or restarts it.
// /myna:service is a thin wrapper around this script.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { serviceDir, recordFile, startFile, writeAtomic, START_MJS, adapter, platformOf, runner, defaultEnvPath } from "../src/service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } })();
const USAGE = "用法：node <myna>/scripts/service.mjs [status] | on | off";
const cmd = String(process.argv[2] || "status").toLowerCase();
const fail = (m) => { console.error(`myna service：${m}`); process.exit(1); };
const platform = platformOf();
const os_ = adapter(platform, { run: runner() });
if (!["on", "off", "status"].includes(cmd)) fail(USAGE);
if (!os_) fail(`這個平台（${platform}）不支援；只支援 macOS（launchd）、Windows（「啟動」資料夾）、Linux（systemd --user）。`);

const readRecord = () => { try { return JSON.parse(fs.readFileSync(recordFile(), "utf8")); } catch { return null; } };
// the .env (and so the port) the login start uses: with a service.json, its env — none recorded means the
// default, whatever this shell's MYNA_ENV says (start.mjs drops an inherited one too); without one, this
// shell's MYNA_ENV, else the default
const envPathFor = (rec) => rec
  ? ((typeof rec.env === "string" && rec.env) || defaultEnvPath())
  : (process.env.MYNA_ENV || defaultEnvPath());
const portFor = (envPath) => {
  // the relay's own rule (src/relay.mjs): .env lines trimmed, the last one of a key wins, the process
  // environment over the file — the login start inherits the user's environment the same way
  let fileEnv = {};
  try {
    fileEnv = Object.fromEntries(fs.readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  } catch {}
  return Number({ ...fileEnv, ...process.env }.RELAY_PORT || 7800);
};
async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    const j = await r.json();
    return j && j.name === "myna-relay" ? j : null;
  } catch { return null; }
}
const relayLine = (h, port) => h
  ? `relay：在跑 v${h.version}（pid ${h.pid}，啟動於 ${h.started_at}，127.0.0.1:${port}）`
  : `relay：沒有在跑（127.0.0.1:${port} 沒有回應）`;
const there = (p) => (p && fs.existsSync(p) ? "在" : "不在");
// a registration file that cannot be written or removed is an OS error like any other
const attempt = (f) => { try { return f(); } catch (e) { return { ok: false, out: e.message }; } };

if (cmd === "on") {
  const rec = { root, version, node: process.execPath };
  if (process.env.MYNA_ENV) rec.env = path.resolve(process.env.MYNA_ENV);
  try {
    fs.mkdirSync(serviceDir(), { recursive: true });
    writeAtomic(startFile(), START_MJS);
    writeAtomic(recordFile(), JSON.stringify(rec, null, 2) + "\n");
  } catch (e) { fail(`${serviceDir()} 寫不進去（${e.message}）。沒有登記。`); }
  console.log(`myna service：${startFile()}、service.json → ${root}（v${version}）${rec.env ? `，.env：${rec.env}` : ""}`);
  const envPath = envPathFor(rec), port = portFor(envPath), log = path.join(path.dirname(envPath), "relay.log");
  // what start.mjs writes to relay.log from here on (macOS: launchd ran it, its output is not ours to read)
  const logFrom = (() => { try { return fs.statSync(log).size; } catch { return 0; } })();
  const newLog = () => { try { const b = fs.readFileSync(log); return b.subarray(Math.min(logFrom, b.length)).toString("utf8"); } catch { return ""; } };
  const r = attempt(() => os_.register({ node: process.execPath, start: startFile() }));
  if (!r.ok) fail(`登記失敗：${os_.name}\n${r.out}\n${startFile()} 和 service.json 留著；問題排除後重跑 on，或用 off 清掉。`);
  console.log(`已登記：${os_.name}${os_.file ? `（${os_.file}）` : ""}。下次登入會自動跑 ${startFile()}（node：${process.execPath}）。`);
  if (os_.notice) console.log(os_.notice);
  // now, not at the next login: macOS RunAtLoad already ran start.mjs at bootstrap; the others did not
  let started = "", startFailed = false;
  if (!os_.runsAtRegister) {
    const s = spawnSync(process.execPath, [startFile()], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    started = ((s.stdout || "") + (s.stderr || "")).trim();
    if (started) console.log(started);
    startFailed = !!s.error || s.status !== 0;
  }
  // "relay not started" is ensure-relay's word for "nothing to start" (no bot, bad MYNA_ROLE): not an error
  // of `on` — the registration stands and the next login starts it once it is set up
  const notConfigured = () => /relay not started/.test(started) || /relay not started/.test(newLog());
  let h = null;
  if (!notConfigured()) {
    const until = Date.now() + 10000;
    while (Date.now() < until && !(h = await health(port)) && !notConfigured() && !/login start\)/.test(newLog())) await sleep(200);
  }
  console.log(relayLine(h, port));
  if (h) process.exit(0);
  if (notConfigured()) { console.log(`還沒設定（${log} 有說明）：先跑 configure.mjs 或 /myna:setup，之後下次登入（或現在再跑一次 on）relay 就會起來。登記留著。`); process.exit(0); }
  const why = [startFailed && "start.mjs 失敗", newLog().trim().split("\n").filter((l) => /login start\)/.test(l)).pop()].filter(Boolean).join("；");
  fail(`登記好了，但 relay 沒有起來${why ? `（${why}）` : ""}。看 ${log}${os_.runsAtRegister ? `、${os_.logHint}` : ""}。登記留著；排除問題後重跑 on。`);
}

if (cmd === "off") {
  const r = attempt(() => os_.unregister());
  if (!r.ok) fail(`拿掉登記失敗：${os_.name}\n${r.out}\n${serviceDir()} 留著，排除問題後重跑 off。`);
  if (r.warn) console.log(`提醒：${r.warn}`);
  try { fs.rmSync(serviceDir(), { recursive: true, force: true }); }
  catch (e) { fail(`登記已拿掉，但 ${serviceDir()} 刪不掉（${e.message}）。下次登入不會再自己起來；這個資料夾可以手動刪。`); }
  console.log(`myna service：${r.had ? `已拿掉 ${os_.name}` : `本來就沒有登記（${os_.name}）`}，${serviceDir()} 已清掉。下次登入不會自己啟動 relay。`);
  console.log("正在跑的 relay 沒有停（可能正在服務 session）。要停：/myna:relay stop，或 node <myna>/scripts/stop-relay.mjs。");
  process.exit(0);
}

// status (default): read-only
const rec = readRecord();
const q = os_.query();
console.log(`登記：${q.registered === true ? "有" : q.registered === false ? "沒有" : "查不到"}（${os_.name}）${q.registered === null && q.out ? ` — ${q.out.split("\n")[0]}` : ""}`);
if (os_.file) {
  // Windows: the file IS the registration — check it is exactly what `on` writes for the recorded node
  const content = os_.matches && fs.existsSync(os_.file)
    ? (rec && os_.matches({ node: rec.node, start: startFile() }) ? "，內容正確" : "，內容跟 on 寫的不一樣：重跑 on")
    : "";
  console.log(`登記檔：${os_.file}（${there(os_.file)}${content}）`);
}
if (os_.notice) console.log(os_.notice);
if (!fs.existsSync(serviceDir())) console.log(`${serviceDir()}：不在（沒有開常駐；node <myna>/scripts/service.mjs on 開啟）`);
else {
  console.log(`啟動檔：${startFile()}（${there(startFile())}）`);
  if (!rec) console.log(`service.json：讀不到或壞掉（${recordFile()}）；重跑 on。`);
  else {
    console.log(`指向：${rec.root}（${there(rec.root)}），v${rec.version}`);
    console.log(`node：${rec.node}（${there(rec.node)}）`);
    console.log(`.env：${rec.env || "預設（~/.myna/.env）"}`);
    if (!fs.existsSync(rec.root || "") || !fs.existsSync(rec.node || "")) console.log("路徑不在：登入時會啟動失敗。開一次新版的 Claude Code session（會自動改指向），或重跑 on。");
  }
}
const envPath = envPathFor(rec), port = portFor(envPath);
console.log(relayLine(await health(port), port));
console.log(`登入啟動失敗時看：${path.join(path.dirname(envPath), "relay.log")}；${os_.logHint}`);
process.exit(0);
