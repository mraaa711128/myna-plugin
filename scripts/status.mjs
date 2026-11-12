#!/usr/bin/env node
// /myna:status — one read-only page: the relay, the Telegram chat and topics, every switch, the main
// settings and what to do next. Writes nothing; asks the local relay GET /health and GET /pair/status,
// and Telegram getMe (+ getChat / getChatMember for a group). The data comes from src/status.mjs collect();
// this only lays it out. Credentials are never printed (and the whole output goes through a redactor).
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../src/remote.mjs";
import { collect, makeRedactor, readEnvFile, tildePath as p } from "../src/status.mjs";

// a .env that exists but cannot be read must not stop the page: carry on with the environment alone
let cfg, envError;
try { cfg = loadEnv(); }
catch (e) { envError = e.code || e.name; cfg = { ...process.env, MYNA_ENV: process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env") }; }
const d = await collect(cfg, { envError });
const pad = (n) => String(n).padStart(2, "0");
const when = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? "?" : `${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`; };
const OS = { win32: "Windows", darwin: "macOS", linux: "Linux" }[d.machine.platform] || d.machine.platform;
const SRC = { env: "環境變數", ".env": p(d.env_file.path), default: "預設" };
const human = (s) => (s % 86400 === 0 ? `${s / 86400} 天` : s % 3600 === 0 ? `${s / 3600} 小時` : s % 60 === 0 ? `${s / 60} 分鐘` : `${s} 秒`);
const L = [];

L.push(`Myna 狀態 · ${d.machine.name}（${OS}）· ${when(d.at)}`);
L.push("（不含 token；有聊天室 id、名稱和 bot 名稱，給別人看之前自己確認）");

// --- relay
L.push("", "relay");
const r = d.relay;
if (d.env_file.error) L.push(`  ⚠ 設定檔 ${p(d.env_file.path)} 讀不到（${d.env_file.error}），下面只用這個 session 的環境變數`);
if (r.other) {
  L.push(`  127.0.0.1:${r.port} 有程式在回應，但不是 myna relay（${r.why}）`);
} else if (!r.running) {
  L.push(`  ${r.why === "沒在跑" ? "沒在跑" : `沒在跑或沒回應（${r.why}）`}（127.0.0.1:${r.port}）`);
  L.push(`  ${r.autostart ? "下一個 session 開始時會自動啟動（有設定）" : "不會自動啟動：還沒設定 IM（或子節點沒有主節點網址）"}`);
} else if (r.legacy) {
  L.push("  在跑，但是很舊的 relay（/health 不是 JSON，0.7.2 以前）");
} else {
  const cmp = r.compare === 0 ? "跟 plugin 同版" : r.compare < 0 ? `比 plugin v${d.plugin_version} 舊` : r.compare > 0 ? `比 plugin v${d.plugin_version} 新` : "版本看不懂";
  L.push(`  在跑：v${r.version}（${cmp}）${r.started_at ? `，${when(r.started_at)} 啟動` : ""}`);
  L.push(`  角色：${r.role === "edge" ? "子節點（edge）" : "主節點（hub）"}；provider：${r.provider ?? "這版 relay 沒回報"}；等待中的題目 ${r.pending ?? "?"}`);
  if (d.relay_differs?.role) L.push(`  ⚠ 角色：relay 用的是 ${r.role}，照設定檔／這個 session 會是 ${d.role_config}：/myna:relay restart 後才會照設定`);
  if (d.relay_differs?.provider) L.push(`  ⚠ provider：relay 用的是 ${r.provider}，照設定檔／這個 session 會是 ${d.expected_provider}：/myna:relay restart 後才會照設定`);
}
if (d.env_changed_since_start) L.push(`  ⚠ ${p(d.env_file.path)} 在 relay 啟動之後改過：/myna:relay restart 後才會生效`);

// --- edge
if (d.edge) {
  const e = d.edge;
  L.push("", "子節點（edge）");
  L.push(`  主節點：${e.upstream || "沒設定（MYNA_UPSTREAM）"}`);
  if (!e.reported) L.push(`  主節點連線：${r.running ? "這版 relay 沒回報" : "relay 沒在跑"}`);
  else {
    L.push(`  主節點連線：${e.reachable ? "連得上" : `連不上（${e.reason || "原因沒回報"}）`}；主節點版本 ${e.hub_version ?? "沒回報"}`);
    L.push(`  這台自己的 bot：${e.own_bot === null ? "這版 relay 沒回報" : e.own_bot ? "有（主節點連不上、斷線排隊關著時接手新題目）" : "沒在用"}`);
  }
}

// --- Telegram
const t = d.telegram;
if (t?.unused) {
  L.push("", "Telegram", `  token 有設，但 relay 用的是 ${t.unused}，不檢查 Telegram`);
} else if (t) {
  L.push("", "Telegram");
  const maybe = t.bot_maybe_other ? "（用設定檔的 bot 查的，relay 可能用別支）" : "";
  if (!t.token_set) L.push("  bot：token 沒設");
  else if (!t.bot) L.push("  bot：token 有設");
  else if (t.bot.ok) L.push(`  bot：token 有設（${SRC[t.token_source] || t.token_source}），@${t.bot.username}（id ${t.bot.id}）${maybe}`);
  else L.push(`  bot：token 有設，Telegram 查不到：${t.bot.why}`);
  const TYPE = { private: "私聊", group: "一般群組", supergroup: "超級群組", channel: "頻道" };
  if (!t.chat) L.push("  配對的聊天室：還沒配對（題目會回終端機）");
  else {
    const c = t.chat;
    const name = c.title ? `「${c.title}」` : "";
    const src = c.from === "relay" ? "relay 在用" : "relay 沒回報，從設定檔讀";
    L.push(`  配對的聊天室：${TYPE[c.type] || c.type || "類型不明"}${name}（id ${c.id}）${c.paired_at ? `，${when(c.paired_at)} 配對` : ""}${c.legacy_env ? "，用 TELEGRAM_CHAT_ID" : ""}（${src}）`);
  }
  const ts = t.topic_settings;
  const fileSrc = ts.file_source.TELEGRAM_TOPICS;
  L.push(`  TELEGRAM_TOPICS：${ts.relay ? `relay 在用 ${ts.relay.topics}` : `relay 實際在用的：${ts.relay_why}`}；設定檔 ${ts.file.topics}（${SRC[fileSrc]}）`);
  const rest = (s) => `${s.scope}／${s.on_end}／${s.round_grace}s`;
  // each value's source; one source for all three → said once
  const srcs = ["TELEGRAM_TOPIC_SCOPE", "TELEGRAM_TOPIC_ON_END", "TELEGRAM_TOPIC_ROUND_GRACE"].map((k) => SRC[ts.file_source[k]]);
  const fileRest = srcs.every((x) => x === srcs[0]) ? `${rest(ts.file)}（${srcs[0]}）`
    : `${ts.file.scope}（${srcs[0]}）／${ts.file.on_end}（${srcs[1]}）／${ts.file.round_grace}s（${srcs[2]}）`;
  L.push(`  scope／on_end／round_grace：${ts.relay ? `relay 在用 ${rest(ts.relay)}；` : ""}設定檔 ${fileRest}`);
  if (ts.differs) L.push("  ⚠ relay 用的跟設定檔不同，/myna:relay restart 後才會照設定檔");
  const group = t.chat && (t.chat.type === "group" || t.chat.type === "supergroup");
  if (t.bot) {
    const tm = !t.bot.ok ? `查不到（${t.bot.why}）` : t.bot.has_topics_enabled === undefined ? "這版 Bot API 沒回報" : t.bot.has_topics_enabled ? "開" : "關";
    L.push(`  Threaded Mode：${tm}${group ? "（只影響私聊，跟這個群組無關）" : ""}`);
  }
  if (group && t.group) {
    const g = t.group;
    L.push(`  群組主題：${!g.chat.ok ? `查不到（${g.chat.why}）` : g.chat.type === "group" ? "沒開（一般群組沒有主題）" : g.chat.is_forum ? "有開" : "沒開"}`);
    const ROLE = { creator: "建立者", administrator: "管理員", member: "一般成員", restricted: "受限成員", left: "不在群組裡", kicked: "被踢出" };
    L.push(`  bot 在群組：${!g.member.ok ? `查不到（${g.member.why}）` : `${ROLE[g.member.status] || g.member.status}，${g.member.can_manage_topics ? "能管理主題" : "不能管理主題"}`}`);
  }
  const v = t.verdict, guess = v.guess ? "（推測）" : "";
  const V = {
    none: `topic：不會開 —— ${v.reasons.join("；")}`,
    on: `topic：會開${guess}${t.failures.gate_null || t.failures.last_log ? "；之前失敗過，下一個 gate／下一次連線會再試" : ""}`,
    off: `topic：不會開${guess} —— TELEGRAM_TOPICS=off${v.reasons.length > 1 ? `；就算改回 auto，${v.reasons.slice(1).join("、")}` : ""}${v.unknown?.length ? `（${v.unknown.join("；")}）` : ""}`,
    blocked: `topic：不會開${guess} —— ${v.reasons.join("、")}${v.unknown?.length ? `（${v.unknown.join("；")}）` : ""}`,
    unknown: `topic：沒辦法確定 —— ${v.reasons.join("；")}`,
  };
  L.push(`  ${V[v.state]}`);
  const f = t.failures;
  if (f.gate_null || f.last_log) {
    L.push(`  建 topic 失敗過：${f.gate_null ? `gate topic ${f.gate_null} 筆 thread: null${f.gate_null_latest ? `（最近 ${when(f.gate_null_latest)}）` : ""}` : "gate topic 沒有 thread: null 的紀錄"}`);
    if (f.last_log) L.push(`    relay.log ${when(f.last_log.at)}${f.last_log.kind === "chat" ? "（聊天 topic）" : ""}：${f.last_log.text}`);
  }
}
if (d.discord) L.push("", "Discord", `  bot token：${d.discord.token_set ? "有設" : "沒設"}；channel id：${d.discord.channel_id || "沒設"}`);
if (d.slack) L.push("", "Slack", `  bot／app token：${d.slack.token_set ? "有設" : "沒設齊"}；channel id：${d.slack.channel_id || "沒設"}`);

// --- switches
L.push("", "開關");
const dflt = (s) => (s.isDefault ? "（預設）" : "");
const cell = (s) => {
  if (s.key === "files") return `files 保留 ${s.days} 天${dflt(s)}${s.bad ? "（設定檔讀不懂）" : ""}`;
  if (s.key === "perm") return `perm ${s.on ? "開" : "關"}（${s.isDefault ? "預設，" : ""}${s.delay_s} 秒${s.delayDefault ? "" : "，MYNA_PERMISSION_DELAY"}）`;
  if (s.key === "hold" && s.unsupported) return "hold：這版 relay 不支援斷線排隊（0.21.0 起），主節點連不上時由這台自己的 bot 接手";
  if (s.key === "hold") return `hold ${s.on ? "開" : "關"}，上限 ${human(s.max_s)}（${s.isDefault ? "預設；" : ""}${s.from === "relay" ? "relay 在用的" : "設定檔／這個 session"}）`;
  if (s.key === "godmode" && s.on) return "⚠ godmode 開（權限確認全部自動同意）";
  return `${s.label} ${s.on ? "開" : "關"}${dflt(s)}`;
};
const cells = d.switches.map(cell);
for (let i = 0; i < cells.length; i += 4) L.push(`  ${cells.slice(i, i + 4).join("  ")}`);
const gm = d.switches.find((s) => s.key === "godmode");
if (gm?.on) L.push(`  God mode：${gm.unsent ? `這次開啟之後有 ${gm.unsent} 則通知沒送出去，記在 ${p(gm.unsent_file)}` : "這次開啟之後的通知都送出去了"}；關掉：/myna:godmode off`);
const cd = d.chat_default;
L.push(`  chat：新 session 預設${cd.value === "default" ? "開（終端機）" : cd.value === "on" ? `開（MYNA_CHAT=on，${SRC[cd.source]}）` : `關（MYNA_CHAT=off，${SRC[cd.source]}）`}；每個 session 的狀態用 /myna:chat 看`);

// --- environment
L.push("", "環境變數（.env 和這個 session 的環境變數；環境變數優先）");
const rows = [...d.credentials.map((c) => [c.key, `有設（${SRC[c.source] === p(d.env_file.path) ? ".env" : SRC[c.source]}）`]),
  ...d.env.map((e) => [e.key, `${e.value}（${e.source === ".env" ? ".env" : SRC[e.source]}）`])];
if (!rows.length) L.push("  （都沒設，全部用預設）");
const w = Math.max(0, ...rows.map(([k]) => k.length));
for (const [k, v] of rows) L.push(`  ${k.padEnd(w)}  ${v}`);

// --- next
L.push("", "建議的下一步");
if (!d.next.length) L.push("  沒有，看起來都正常。");
d.next.forEach((s, i) => L.push(`  ${i + 1}. ${s}`));

// last line of defence: the same redactor collect() used, over the whole page
const redact = makeRedactor(readEnvFile(cfg.MYNA_ENV).values, process.env, cfg);
// let stdout drain before leaving (a pipe is asynchronous); then exit, so nothing left open keeps it alive
process.stdout.write(redact(L.join("\n")) + "\n", () => process.exit(0));
