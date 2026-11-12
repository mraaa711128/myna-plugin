#!/usr/bin/env node
// /myna:config — the switches and the common ~/.myna/.env settings in one command.
//   config.mjs                   every item: its value, where it comes from and the values it takes, then a
//                                line on what it is for
//   config.mjs <item>            that item only, in full: also where it is kept and when a change applies
//   config.mjs <item> <value>    change it:
//     a switch (autopilot, godmode, intercept, stopcatch, brief, perm, murmur, hold) → its own script
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
import { loadEnv, holdSettings, readHoldFile, updateEnvFile, mynaDir } from "../src/remote.mjs";
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

// --- each session's chat on/off (hooks/chat-mod.mjs writes <myna dir>/chat-state/<session>.json) -----------
// The files of sessions that ended (ended_at), and of any not updated for CHAT_STATE_KEEP_MS (a session that
// died without ending), are removed here; the rest are listed, this session (CLAUDE_CODE_SESSION_ID) first.
const CHAT_STATE_KEEP_MS = 30 * 24 * 3600 * 1000; // as the chat mod keeps a session's own on/off ($.store)
const pad2 = (n) => String(n).padStart(2, "0");
const when = (iso) => { const t = new Date(iso); return isNaN(t) ? "?" : `${t.getMonth() + 1}/${t.getDate()} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`; };
function chatSessions() {
  const dir = path.join(mynaDir(cfg), "chat-state"), me = String(env.CLAUDE_CODE_SESSION_ID || "");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  const rows = [];
  for (const n of names) {
    const f = path.join(dir, n);
    let s = null, text = null;
    try { text = fs.readFileSync(f, "utf8"); s = JSON.parse(text); } catch {}
    if (!s || typeof s.session_id !== "string") {
      // unreadable: maybe being written right now — skipped, and removed only once it is old
      try { if (Date.now() - fs.statSync(f).mtimeMs > CHAT_STATE_KEEP_MS) fs.rmSync(f, { force: true }); } catch {}
      continue;
    }
    const age = Date.now() - Date.parse(s.updated_at ?? "");
    if (s.ended_at || !(age < CHAT_STATE_KEEP_MS)) {
      // removed only if it still says what was read: a session resumed meanwhile has written a live record
      try { if (fs.readFileSync(f, "utf8") === text) fs.rmSync(f, { force: true }); } catch {}
      continue;
    }
    rows.push({ ...s, on: s.on === true, current: !!me && s.session_id === me });
  }
  return rows.sort((a, b) => b.current - a.current || Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

// --- what each item is for and what it takes (Stanley 2026-11-11, after trying it: every item shows its
// values and a short purpose). The texts follow each item's own command md (commands/<item>.md) and the
// README; chat's two come from the chat mod, which answers "/myna:config chat" with the same ones.
//   values: the list's "可設：…"; valuesFull: the single item's, when it says more
//   purpose: one line, in the list and the single item; more: the single item only
//   applies: when a change takes effect (the single item only; topics / perm-delay: ENV_ITEMS[item].applies)
const INFO = {
  autopilot: {
    values: "on / off",
    purpose: "手機上的題目自動採用建議選項，不再問你（每個決定都會記錄）",
    more: "題目要有建議選項（recommendedIndex），沒有就照常送到手機；決定記在專案的 MYNA-DECISIONS.jsonl / .md",
    applies: "馬上生效",
  },
  godmode: {
    values: "on / off",
    purpose: "所有權限確認自動同意（含護欄 hook 攔下來要問的動作）、帶 ✅ 核准的 ask_human 題目自動按 ✅，每一筆送通知到 IM 的「🔓 God mode」topic，不再問你；同時帶開 autopilot",
    more: "整台機器一起開，關掉前一直有效；只允許那一次，不寫永久規則；AskUserQuestion 和不帶 approves 的題目不算（交給 intercept／autopilot／手機）；開的時候 autopilot 原本關著就一起打開，關的時候還原（期間手動切過 autopilot 就不動它）；通知送不出去時照樣同意，記在 ~/.myna/godmode-unsent.jsonl（/myna:status 看得到筆數）；通知目前只有 Telegram；也可以用 /myna:godmode",
    applies: "馬上生效",
  },
  intercept: {
    values: "on / off",
    purpose: "AI 用 AskUserQuestion 問的選擇題改送到手機（relay 連不上時照常在終端機選）",
    more: "跟 autopilot 是分開的開關；autopilot 也開著時，轉過去的題目直接採用建議選項",
    applies: "馬上生效",
  },
  stopcatch: {
    values: "on / off",
    purpose: "AI 回合結束時用純文字問你問題，改用 ask_human 送到手機",
    more: "relay 連不上時不動作；同一次回合結束只擋一次。關掉只是不轉問句，回合結束時收 topic 照常",
    applies: "馬上生效",
  },
  brief: {
    values: "on / off",
    purpose: "被攔截的題目另外發一頁決策輔助 Artifact（每個選項的背景、優缺點），手機上的題目附連結",
    more: "只在 intercept 開著時作用；Artifact 的內容會送到 claude.ai，敏感的題目可以先關掉",
    applies: "馬上生效",
  },
  perm: {
    values: "on / off",
    purpose: "終端機的權限確認框沒人回答時，等 perm-delay 秒後送到手機（✅ 允許／❌ 拒絕）",
    more: "終端機和手機都能回答，先答的算；relay 連不上時只在終端機",
    applies: "馬上生效",
  },
  murmur: {
    values: "on / off",
    purpose: "聊天 session 的進度訊息：on 每個工具一行累加，off 只留 💭 和最新一個工具",
    more: "所有 session 共用",
    applies: "下一次進度更新生效",
  },
  hold: {
    values: "on / off / max <時間> / status",
    valuesFull: "on / off / max <30m|6h|1d|秒數|default>（10 分鐘～7 天，預設 1 天）/ status（看主節點連不連得上、排著幾題）",
    purpose: "（子節點）主節點連不上時，新題目先排著，恢復後再送到手機",
    more: "只在加入主節點（/myna:join）的機器有作用；off = 改用這台自己的 bot，沒有就回終端機；環境變數或 .env 的 MYNA_UPSTREAM_HOLD / MYNA_UPSTREAM_HOLD_MAX 優先",
    applies: "馬上生效，不用重啟 relay",
  },
  // the chat mod's texts (hooks/chat-mod.mjs CHAT_CONFIG_PURPOSE / CHAT_CONFIG_VALUES)
  chat: {
    values: "on / off（只改目前這個 session）",
    purpose: "在 Telegram 跟這個 session 聊天：手機上打的字交給它，它做了什麼、怎麼回答都回到手機",
  },
  topics: {
    values: "auto / off",
    purpose: "Telegram 用 topic 分開：每個 gate 一個（TELEGRAM_TOPIC_SCOPE=session 時每個 session 一個），每個聊天 session 也各一個；off = 不再開新的 topic",
    more: "off 之後新的題目和新的聊天 session 在主聊天室，已經有 topic 的聊天 session 照用原本的；bot 要在 BotFather 開 Threaded Mode，auto 時建不了 topic 也會退回主聊天室",
  },
  "perm-delay": {
    values: "0 以上的整數（秒）",
    purpose: "權限確認框在終端機等幾秒沒人回答，才送到手機；0 = 立刻送",
  },
};

// --- one line per item ----------------------------------------------------------------------------------
const ORDER = ["autopilot", "godmode", "intercept", "stopcatch", "brief", "perm", "murmur", "hold", "chat", "topics", "perm-delay"];
const pad = (k) => k.padEnd(11);
function line(item) {
  if (item === "chat") {
    const d = String(cfg.MYNA_CHAT || "").trim().toLowerCase();
    const def = d === "on" ? `開（MYNA_CHAT=on，${envSource("MYNA_CHAT", readEnvFile(ENV_PATH))}）` : d === "off" ? `關（MYNA_CHAT=off，${envSource("MYNA_CHAT", readEnvFile(ENV_PATH))}）` : "開（終端機 session）";
    const rows = chatSessions();
    const head = `${pad("chat")}每個 session 各自設定；新 session 預設${def}`;
    if (!rows.length) return `${head}\n${" ".repeat(13)}（還沒有 session 的紀錄：載入聊天模組的 Claude Code session 開始後才會有）`;
    const proj = (p) => (p ? path.basename(String(p).replace(/[\\/]+$/, "")) || p : "?");
    return [head, ...rows.map((s) => `${" ".repeat(13)}${s.on ? "on " : "off"}  ${proj(s.project)}${s.nick ? `（${s.nick}）` : ""}　最後更新 ${when(s.updated_at)}${s.current ? "　← 這個 session" : ""}`)].join("\n");
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

// the list: the value line with "可設：…", the purpose under it, then (chat) one line per session
function listEntry(item) {
  const [head, ...below] = line(item).split("\n");
  return [`  ${head}　可設：${INFO[item].values}`, `    ${INFO[item].purpose}`, ...below].join("\n");
}
// one item: the value line, then what it is for, what it takes, where it is kept and when a change applies
function itemEntry(item) {
  const info = INFO[item], out = [line(item), `  用途：${info.purpose}${info.more ? `。${info.more}` : ""}`, `  可設：${info.valuesFull || info.values}`];
  if (ENV_ITEMS[item]) out.push(`  存放：${tildePath(ENV_PATH)} 的 ${ENV_ITEMS[item].key}；${ENV_ITEMS[item].applies}`);
  else if (item !== "chat") out.push(`  存放：${tildePath(sw(item).file(cfg, env))}；${info.applies}`);
  return out.join("\n");
}

const ITEMS_TEXT = ORDER.join("、");
const usageError = (msg) => { console.error(msg); process.exit(1); };
const [item0, ...rest] = process.argv.slice(2);
// shown with every reading (the whole list or one item): an unreadable .env makes "預設" a guess
const warn = envError ? [`注意：${tildePath(ENV_PATH)} 讀不到（${envError}），下面只看環境變數和各開關的檔案`] : [];

if (!item0) {
  console.log(["Myna 設定（改：/myna:config <項目> <值>；單項的詳細：/myna:config <項目>）", ...warn, ...ORDER.map(listEntry)].join("\n"));
  process.exit(0);
}
const item = item0.toLowerCase();
if (!ORDER.includes(item)) usageError(`不認得的項目「${item0}」。可以設定的項目：${ITEMS_TEXT}`);

if (item === "chat") {
  // the chat mod answers "/myna:config chat …"; reaching here means it is not loaded in this session
  console.log([
    "chat 是每個 session 各自的開關，由聊天模組處理；這個 session 沒有載入聊天模組（需要 Claude Code 2.1.287 以上）。升級後重開 session 就會自動啟用（終端機 session 預設開啟）。",
    `  用途：${INFO.chat.purpose}`, `  可設：${INFO.chat.values}`,
  ].join("\n"));
  process.exit(1);
}
if (!rest.length) { console.log([...warn, itemEntry(item)].join("\n")); process.exit(0); }

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
// or one line added; every other line kept as it was. updateEnvFile (src/remote.mjs) reads the file again
// under its lock and writes it with a rename, like every other .env writer (configure, hub, join).
try {
  updateEnvFile(ENV_PATH, (text) => {
    let found = false;
    text = text.replace(/^[^\r\n]*$/gm, (l) => {
      if (!l || l.startsWith("#") || !l.includes("=") || l.slice(0, l.indexOf("=")).trim() !== it.key) return l;
      found = true;
      return `${it.key}=${value}`;
    });
    if (!found) text += (text && !text.endsWith("\n") ? "\n" : "") + `${it.key}=${value}\n`;
    return text;
  });
} catch (e) {
  usageError(`${tildePath(ENV_PATH)} 寫不進去（${e.code || e.message}），沒有改。`);
}
const out = [`${item}：${it.show(it.read(value))}，寫進 ${tildePath(ENV_PATH)} 的 ${it.key}。${it.applies}。`];
if (env[it.key] !== undefined) out.push(`注意：環境變數 ${it.key}=${env[it.key]} 有設，目前被環境變數蓋過；要讓這個設定生效，先拿掉那個環境變數。`);
console.log(out.join("\n"));
