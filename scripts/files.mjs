#!/usr/bin/env node
// /myna:files — how long this machine keeps the files sent to chat sessions from the phone (SPEC §5.3).
// ~/.myna/inbox-keep (MYNA_INBOX_KEEP_FILE: tests): "days=<n>" then when it was set. No file = 7 days.
// The relay reads it each time it saves a new file and drops what is older then — no restart.
//   files.mjs [status]        the setting, where it comes from, and what this machine's inbox holds
//   files.mjs keep <days>     1 to 90 days
//   files.mjs keep default    back to 7 days (the file is removed)
// Each machine keeps its own inbox (the relay with the bot, and one that forwards chat to it): this sets
// the machine it runs on.
import fs from "node:fs";
import path from "node:path";
import { loadEnv, mynaDir } from "../src/remote.mjs";
import { keepFile, readKeep, usage, fmtSize, inboxDir, KEEP_DEFAULT_DAYS, KEEP_MIN_DAYS, KEEP_MAX_DAYS } from "../src/inbox.mjs";

const cfg = loadEnv();
const DIR = mynaDir(cfg);
const FILE = keepFile(DIR, cfg);
const [cmd0 = "status", arg] = process.argv.slice(2);
const cmd = cmd0.toLowerCase();

if (cmd === "keep") {
  const a = String(arg ?? "").trim().toLowerCase();
  if (a === "default") {
    try { fs.rmSync(FILE, { force: true }); } catch {}
    console.log(`附檔保留期間改回預設 ${KEEP_DEFAULT_DAYS} 天(收檔後算起)。檔案:${FILE}`);
    process.exit(0);
  }
  if (!/^\d+$/.test(a)) { console.error(`看不懂「${arg ?? ""}」:用天數(${KEEP_MIN_DAYS} 到 ${KEEP_MAX_DAYS} 的整數),或 keep default 回到預設 ${KEEP_DEFAULT_DAYS} 天。沒有改。`); process.exit(1); }
  const n = Number(a);
  if (n < KEEP_MIN_DAYS || n > KEEP_MAX_DAYS) { console.error(`天數要在 ${KEEP_MIN_DAYS} 到 ${KEEP_MAX_DAYS} 之間(你給的是 ${n}),沒有改。`); process.exit(1); }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `days=${n}\n${new Date().toISOString()}\n`);
  console.log(`附檔保留 ${n} 天(收檔後算起),下一次收到檔案時清掉更舊的。檔案:${FILE}`);
  process.exit(0);
}
if (cmd !== "status") { console.error("用法:/myna:files [status | keep <天數> | keep default]"); process.exit(2); }
const k = readKeep(FILE);
const u = usage(DIR);
console.log([
  `附檔保留 ${k.days} 天(收檔後算起;${k.source === "file" ? "/myna:files 設定" : "預設"})。設定檔:${FILE}`,
  k.bad ? `設定檔讀不懂(要是 days=${KEEP_MIN_DAYS}～${KEEP_MAX_DAYS}),目前當成預設 ${KEEP_DEFAULT_DAYS} 天。` : "",
  `這台的附檔:${u.files} 個,${fmtSize(u.bytes)}(${inboxDir(DIR)})`,
].filter(Boolean).join("\n"));
