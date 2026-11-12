#!/usr/bin/env node
// /myna:godmode [on|off|status] — toggle God mode. Presence of the flag file (MYNA_GODMODE_FILE, else
// ~/.myna/godmode) = ON; its content is the time it was turned on. Same pattern as scripts/autopilot.mjs.
// While on, scripts/permission-request.mjs allows every permission dialog at once and sends a notice to
// the IM (relay POST /notify); notices that could not be sent go to godmode-unsent.jsonl (src/godmode.mjs).
import fs from "node:fs";
import path from "node:path";
import { loadEnv, mynaDir, roleOf } from "../src/remote.mjs";
import { expectedProvider, tildePath } from "../src/status.mjs";
import { godmodeFile, godmodeOn, godmodeSince, unsentSince } from "../src/godmode.mjs";

const FLAG = godmodeFile();
const arg = (process.argv[2] || "status").toLowerCase();
const pad = (n) => String(n).padStart(2, "0");
const when = (ms) => { const t = new Date(ms); return Number.isNaN(t.getTime()) ? "?" : `${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`; };

// which IM the notices would go to (the relay's own choice is not asked here: this only warns)
function imNote() {
  let cfg;
  try { cfg = loadEnv(); } catch { cfg = { ...process.env }; }
  // an edge sends its notices through the hub's bot (its own only while the hub is away): nothing to say here
  if (roleOf(cfg) === "edge") return "";
  let paired = false;
  try { paired = JSON.parse(fs.readFileSync(cfg.MYNA_TELEGRAM_CHAT_FILE || path.join(mynaDir(cfg), "telegram-chat.json"), "utf8"))?.chat_id != null; } catch {}
  const p = expectedProvider(cfg, { paired });
  if (!p) return "注意：這台沒有設定 IM，通知送不出去，每一筆都只記在漏送紀錄裡。";
  if (p !== "telegram") return `注意：這個 IM（${p}）還不支援 God mode 的通知，照樣自動同意，但每一筆都只記在漏送紀錄裡。`;
  return "";
}
const unsentLine = () => {
  const u = unsentSince(godmodeSince());
  return u.count ? `這次開啟之後有 ${u.count} 則通知沒送出去，記在 ${tildePath(u.file)}` : "這次開啟之後的通知都送出去了（沒有漏送）";
};

if (arg === "on") {
  fs.mkdirSync(path.dirname(FLAG), { recursive: true });
  fs.writeFileSync(FLAG, new Date().toISOString());
  const out = [
    `God mode 開了 —— 這台每一個權限確認都會立刻自動允許（含護欄 hook 攔下來要問的動作），每允許一筆就送一則通知到 IM。關掉：/myna:godmode off。旗標檔：${tildePath(FLAG)}`,
  ];
  const note = imNote(); if (note) out.push(note);
  console.log(out.join("\n"));
} else if (arg === "off") {
  try { fs.rmSync(FLAG, { force: true }); } catch {}
  console.log(godmodeOn() ? `God mode 沒關掉：${tildePath(FLAG)} 刪不掉，請手動刪除。` : "God mode 關了 —— 權限確認照原本的方式處理（終端機，沒人回答時轉到手機）。");
  if (godmodeOn()) process.exit(1);
} else if (arg === "status") {
  if (!godmodeOn()) console.log(`God mode 關著（${tildePath(FLAG)} 不存在）`);
  else {
    const out = [`God mode 開著，${when(godmodeSince())} 開的（${tildePath(FLAG)}）`, unsentLine()];
    const note = imNote(); if (note) out.push(note);
    console.log(out.join("\n"));
  }
} else {
  console.error(`godmode 只接受 on、off 或 status（你給的是「${process.argv.slice(2).join(" ")}」），沒有改。`);
  process.exit(1);
}
