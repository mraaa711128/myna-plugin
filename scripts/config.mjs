#!/usr/bin/env node
// /myna:config — the switches and the common ~/.myna/.env settings in one command.
//   config.mjs                   every item: its value and where it comes from, one line each
//   config.mjs <item>            that item only
//   config.mjs <item> <value>    change it:
//     a switch (autopilot, intercept, stopcatch, brief, perm, murmur, hold) → its own script
//       (scripts/<item>.mjs) with the value, its output as is: same flag files, same reading
//     topics / perm-delay → ~/.myna/.env (TELEGRAM_TOPICS / MYNA_PERMISSION_DELAY): the line replaced, or
//       added. The value is checked first; a bad one changes nothing.
// chat is per session and lives in the chat mod (hooks/chat-mod.mjs), which answers "/myna:config chat …"
// itself; this script only sees "chat" when the mod is not loaded, and says so.
// The current values are read as /myna:status reads them (src/status.mjs SWITCHES).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv, holdSettings, readHoldFile } from "../src/remote.mjs";
import { SWITCHES, readEnvFile, tildePath } from "../src/status.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// an unreadable .env (as scripts/status.mjs): go on with the environment alone, and say so
let cfg, envError;
try { cfg = loadEnv(); }
catch (e) { envError = e.code || e.name; cfg = { ...process.env, MYNA_ENV: process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env") }; }
const env = process.env;
const ENV_PATH = cfg.MYNA_ENV;

const human = (s) => (s % 86400 === 0 ? `${s / 86400} 天` : s % 3600 === 0 ? `${s / 3600} 小時` : s % 60 === 0 ? `${s / 60} 分鐘` : `${s} 秒`);
const sw = (key) => SWITCHES.find((s) => s.key === key);

// --- the .env settings: the value as the program that reads it does ------------------------------------
const ENV_ITEMS = {
  topics: {
    key: "TELEGRAM_TOPICS", usage: "auto|off", ok: (v) => v === "auto" || v === "off",
    // src/providers/telegram.mjs: anything but "off" is auto
    read: (raw) => ({ value: String(raw ?? "auto").trim().toLowerCase() !== "off" ? "auto" : "off" }),
    show: (v) => v.value,
    applies: "relay 啟動時才讀：要 /myna:relay restart 後才生效（不會自動重啟）",
  },
  "perm-delay": {
    key: "MYNA_PERMISSION_DELAY", usage: "<秒數，0 以上的整數>", ok: (v) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)),
    // scripts/permission-request.mjs: a number ≥ 0, else 30
    read: (raw) => { const d = Number(raw ?? 30); return Number.isFinite(d) && d >= 0 ? { value: d } : { value: 30, bad: raw }; },
    show: (v) => `${v.value} 秒`,
    applies: "下一次權限確認就生效",
  },
};
const envSource = (k, file) => (env[k] !== undefined ? "環境變數" : file.values[k] !== undefined ? tildePath(ENV_PATH) : "預設");

// --- one line per item ----------------------------------------------------------------------------------
const ORDER = ["autopilot", "intercept", "stopcatch", "brief", "perm", "murmur", "hold", "chat", "topics", "perm-delay"];
const pad = (k) => k.padEnd(11);
function line(item) {
  if (item === "chat") {
    const d = String(cfg.MYNA_CHAT || "").trim().toLowerCase();
    const def = d === "on" ? `開（MYNA_CHAT=on，${envSource("MYNA_CHAT", readEnvFile(ENV_PATH))}）` : d === "off" ? `關（MYNA_CHAT=off，${envSource("MYNA_CHAT", readEnvFile(ENV_PATH))}）` : "開（終端機 session）";
    return `${pad("chat")}每個 session 各自設定，這個 session 的狀態用 /myna:config chat 看；新 session 預設${def}`;
  }
  if (ENV_ITEMS[item]) {
    const it = ENV_ITEMS[item], file = readEnvFile(ENV_PATH), v = it.read(cfg[it.key]);
    const bad = v.bad !== undefined ? `；${it.key}=${v.bad} 看不懂，當成預設` : "";
    return `${pad(item)}${it.show(v)}（${envSource(it.key, file)}${bad}）`;
  }
  if (item === "hold") {
    // on/off and the cap each come from the first of: the environment, ~/.myna/.env, the hold file, the default
    // (holdSettings tells only "env" for both of the first two, and one source for the two fields)
    const s = holdSettings(cfg), file = sw("hold").file(cfg, env), f = readHoldFile(file), envFile = readEnvFile(ENV_PATH);
    const fileSrc = `設定檔 ${tildePath(file)}`;
    const srcOf = (key, fromEnv, inFile) => (fromEnv !== undefined ? envSource(key, envFile) : !f.bad && inFile ? fileSrc : "預設");
    const onSrc = srcOf("MYNA_UPSTREAM_HOLD", s.env.hold, f.on !== undefined);
    const maxSrc = srcOf("MYNA_UPSTREAM_HOLD_MAX", s.env.max, f.max_s !== undefined);
    const src = onSrc === maxSrc ? onSrc : `${s.on ? "on" : "off"}：${onSrc}；上限：${maxSrc}`;
    return `${pad("hold")}${s.on ? "on" : "off"}，上限 ${human(s.max_s)}（${src}${s.bad ? "；檔案讀不懂，當成預設" : ""}；只在子節點有作用）`;
  }
  const st = sw(item).state(cfg, env);
  const src = st.source === "file" ? `設定檔 ${tildePath(st.file)}` : st.source === "env" ? "環境變數" : "預設";
  return `${pad(item)}${st.on ? "on" : "off"}（${src}）`;
}

const ITEMS_TEXT = ORDER.join("、");
const usageError = (msg) => { console.error(msg); process.exit(1); };
const [item0, ...rest] = process.argv.slice(2);

if (!item0) {
  const warn = envError ? [`注意：${tildePath(ENV_PATH)} 讀不到（${envError}），下面只看環境變數和各開關的檔案`] : [];
  console.log(["Myna 設定（改：/myna:config <項目> <值>）", ...warn, ...ORDER.map((k) => `  ${line(k)}`)].join("\n"));
  process.exit(0);
}
const item = item0.toLowerCase();
if (!ORDER.includes(item)) usageError(`不認得的項目「${item0}」。可以設定的項目：${ITEMS_TEXT}`);

if (item === "chat") {
  // the chat mod answers "/myna:config chat …"; reaching here means it is not loaded in this session
  console.log("chat 是每個 session 各自的開關，由聊天模組處理；這個 session 沒有載入聊天模組（需要 Claude Code 2.1.287 以上）。升級後重開 session 就會自動啟用（終端機 session 預設開啟）。");
  process.exit(1);
}
if (!rest.length) { console.log(line(item)); process.exit(0); }

// --- a switch: its own script, its output as is -----------------------------------------------------------
if (!ENV_ITEMS[item]) {
  const v = rest[0].toLowerCase();
  let args;
  if (item === "hold") {
    if (v === "max" && rest.length === 2) args = ["max", rest[1]];
    else if (["on", "off", "status"].includes(v) && rest.length === 1) args = [v];
    else usageError(`hold 只接受 on、off、status 或 max <30m|6h|1d|秒數|default>（你給的是「${rest.join(" ")}」），沒有改。`);
  } else if ((v === "on" || v === "off") && rest.length === 1) args = [v];
  else usageError(`${item} 只接受 on 或 off（你給的是「${rest.join(" ")}」），沒有改。`);
  const r = spawnSync(process.execPath, [path.join(HERE, sw(item).script), ...args], { stdio: "inherit" });
  if (r.error) usageError(`${sw(item).script} 沒有執行：${r.error.message}`);
  process.exit(r.status ?? 1);
}

// --- a .env setting -------------------------------------------------------------------------------------
const it = ENV_ITEMS[item];
const v = rest[0].toLowerCase();
if (rest.length !== 1 || !it.ok(v)) usageError(`${item} 只接受 ${it.usage}（你給的是「${rest.join(" ")}」），沒有改。`);
const value = item === "perm-delay" ? String(Number(v)) : v;
// as scripts/configure.mjs writes it: the key's line replaced (every one, so a later duplicate can't win),
// or one line added; every other line kept as it was. Written to a temp file next to it and renamed over it
// (keeping its mode): a failed write leaves the old file whole. No lock: the other .env writers
// (configure, hub, join) take none either, and all are run by hand.
let tmp;
try {
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  let found = false;
  text = text.replace(/^[^\r\n]*$/gm, (l) => {
    if (!l || l.startsWith("#") || !l.includes("=") || l.slice(0, l.indexOf("=")).trim() !== it.key) return l;
    found = true;
    return `${it.key}=${value}`;
  });
  if (!found) text += (text && !text.endsWith("\n") ? "\n" : "") + `${it.key}=${value}\n`;
  // a .env that is a link: the file it points to is replaced, the link stays
  let target = ENV_PATH; try { target = fs.realpathSync(ENV_PATH); } catch {}
  let mode = 0o600; try { mode = fs.statSync(target).mode & 0o777; } catch {}
  tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode); // the umask may have narrowed it
  fs.renameSync(tmp, target);
  tmp = null;
} catch (e) {
  if (tmp) try { fs.rmSync(tmp, { force: true }); } catch {}
  usageError(`${tildePath(ENV_PATH)} 寫不進去（${e.code || e.message}），沒有改。`);
}
const out = [`${item}：${it.show(it.read(value))}，寫進 ${tildePath(ENV_PATH)} 的 ${it.key}。${it.applies}。`];
if (env[it.key] !== undefined) out.push(`注意：環境變數 ${it.key}=${env[it.key]} 有設，目前被環境變數蓋過；要讓這個設定生效，先拿掉那個環境變數。`);
console.log(out.join("\n"));
