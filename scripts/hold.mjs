#!/usr/bin/env node
// /myna:hold — whether an EDGE relay holds questions while its hub is away (SPEC §5.2). Global flag file
// ~/.myna/upstream-hold (MYNA_UPSTREAM_HOLD_FILE); the relay reads it whenever it needs it, so a change
// applies without a restart. ON BY DEFAULT; the file records an explicit choice and the cap:
//   line 1 "on" | "off", then optionally "max=<seconds>", last line when it was changed
//   hold.mjs [status]      the setting, where it comes from, and (from the relay) what is held now
//   hold.mjs on            hold (the default): new questions wait for the hub, nothing goes to the own bot
//   hold.mjs off           0.20.3's way: the own bot takes new questions (none: the terminal), forwarded
//                          ones are given up after MYNA_UPSTREAM_GRACE
//   hold.mjs max <time>    the cap — 30m, 6h, 1d or seconds, between 10 minutes and 7 days; "max default" drops it
// MYNA_UPSTREAM_HOLD (on|off) and MYNA_UPSTREAM_HOLD_MAX (seconds) — in the environment or ~/.myna/.env —
// win over the file: it is still written (it applies once they are gone) and this says so.
import fs from "node:fs";
import path from "node:path";
import { loadEnv, roleOf, holdFile, readHoldFile, holdSettings, HOLD_MAX_DEFAULT_S, HOLD_MAX_MIN_S, HOLD_MAX_MAX_S } from "../src/remote.mjs";

const cfg = loadEnv();
const FILE = holdFile(cfg);
const [cmd0 = "status", arg] = process.argv.slice(2);
const cmd = cmd0.toLowerCase();
const edge = roleOf(cfg) === "edge";
const PORT = Number(cfg.RELAY_PORT || 7800);

const human = (s) => (s % 86400 === 0 ? `${s / 86400} 天` : s % 3600 === 0 ? `${s / 3600} 小時` : s % 60 === 0 ? `${s / 60} 分鐘` : `${s} 秒`);
const parseTime = (t) => {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(String(t ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
};
const write = (on, max) => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${on ? "on" : "off"}\n${max ? `max=${max}\n` : ""}${new Date().toISOString()}\n`);
};
const envNote = () => {
  const s = holdSettings(cfg), out = [];
  if (s.env.hold) out.push(`環境變數 MYNA_UPSTREAM_HOLD=${s.env.hold} 有設，現在用的是它的值`);
  if (s.env.max) out.push(`環境變數 MYNA_UPSTREAM_HOLD_MAX=${s.env.max} 有設，現在的上限用它`);
  return out.length ? `${out.join("；")}；要讓這個設定生效，先拿掉那個環境變數。` : "";
};
const roleNote = () => (edge ? "" : "這台不是子節點（沒有加入主節點），斷線排隊只在加入主節點後才有作用。");

if (cmd === "on" || cmd === "off") {
  const cur = readHoldFile(FILE);
  write(cmd === "on", cur.bad ? undefined : cur.max_s);
  console.log([`斷線排隊：${cmd === "on" ? "開（預設）— 主節點連不上時新題目先排著，恢復後送到手機" : "關 — 主節點連不上時新題目改發這台自己的 bot（沒有就回終端機），已轉出的過了 MYNA_UPSTREAM_GRACE 就放棄"}。檔案：${FILE}`, envNote(), roleNote()].filter(Boolean).join("\n"));
  process.exit(0);
}
if (cmd === "max") {
  const cur = readHoldFile(FILE);
  const on = cur.bad ? true : cur.on ?? true;
  if (String(arg ?? "").toLowerCase() === "default") {
    write(on, undefined);
    console.log([`排隊上限改回預設 ${human(HOLD_MAX_DEFAULT_S)}。檔案：${FILE}`, envNote(), roleNote()].filter(Boolean).join("\n"));
    process.exit(0);
  }
  const s = parseTime(arg);
  if (s === null) { console.error(`看不懂「${arg ?? ""}」：用 30m、6h、1d 或秒數，或 max default 回到預設 ${human(HOLD_MAX_DEFAULT_S)}`); process.exit(1); }
  if (s < HOLD_MAX_MIN_S || s > HOLD_MAX_MAX_S) { console.error(`上限要在 ${human(HOLD_MAX_MIN_S)} 到 ${human(HOLD_MAX_MAX_S)} 之間（你給的是 ${human(s)}），沒有改`); process.exit(1); }
  write(on, s);
  console.log([`排隊上限：${human(s)}（排超過這麼久還沒送出的題目才回終端機）。檔案：${FILE}`, envNote(), roleNote()].filter(Boolean).join("\n"));
  process.exit(0);
}
if (cmd !== "status") { console.error("usage: hold.mjs [status | on | off | max <30m|6h|1d|秒數|default>]"); process.exit(1); }

// status: read only — the file, then the local relay's /health
const s = holdSettings(cfg);
const src = { default: "預設", file: `/myna:hold ${FILE}`, env: "環境變數" }[s.source];
const lines = [`斷線排隊：${s.on ? "開" : "關"}，上限 ${human(s.max_s)}（設定來自${src}）`];
if (s.bad) lines.push(`注意：${FILE} 讀不懂（${s.bad}），當成預設`);
const env = envNote(); if (env) lines.push(env);
lines.push(edge ? "這台是子節點（edge）。" : roleNote());
const fmt = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
  const j = await r.json();
  if (j?.role === "edge" && !j.upstream?.hold) lines.push(`這台的 relay 是 ${j.version}，不支援斷線排隊（要 0.21.0 以上），目前是舊做法；設定在升版後生效。`);
  else if (j?.role === "edge") {
    const u = j.upstream, h = u.hold;
    lines.push(u.reachable ? "主節點：連得上。" : `主節點：連不上（${u.reason || "?"}），從 ${fmt(u.since)} 起。`);
    lines.push(h.queued ? `排著 ${h.queued} 題，最早 ${fmt(h.oldest_at)} 問的${h.waiting ? `；另有 ${h.waiting} 題已送出、在等你回答` : ""}。` : `沒有排著的題目${h.waiting ? `；有 ${h.waiting} 題已送出、在等你回答` : ""}。`);
  }
} catch { if (edge) lines.push("relay 沒在跑，看不到排隊的題目。"); }
console.log(lines.filter(Boolean).join("\n"));
