#!/usr/bin/env node
// /myna:godmode [on|off|status] — toggle God mode. Presence of the flag file (MYNA_GODMODE_FILE, else
// ~/.myna/godmode) = ON; its content is the time it was turned on. Same pattern as scripts/autopilot.mjs.
// While on, scripts/permission-request.mjs allows every permission dialog at once and sends a notice to
// the IM (relay POST /notify); notices that could not be sent go to godmode-unsent.jsonl (src/godmode.mjs).
// The relay presses the ✅ of this machine's `approves` questions (v0.26.2). on/off also bring autopilot
// along and back (src/godmode.mjs, "God mode brings autopilot along"); a flag file written any other way
// (another tool creating it) turns on God mode only.
import fs from "node:fs";
import path from "node:path";
import { loadEnv, mynaDir, roleOf } from "../src/remote.mjs";
import { expectedProvider, tildePath } from "../src/status.mjs";
import { godmodeFile, godmodeOn, godmodeSince, unsentSince, autopilotFile, autopilotState, autopilotMark, autopilotBefore } from "../src/godmode.mjs";

const FLAG = godmodeFile();
const AP = autopilotFile();
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

// autopilot while God mode is on (v0.26.2): on because God mode turned it on / on otherwise / off
const autopilotLine = () => {
  const ap = autopilotState();
  if (ap.byGodmode) return "autopilot：開著，是 God mode 帶開的（關 God mode 時會一起關回去）";
  if (!ap.on) return autopilotBefore() ? "autopilot：關著（God mode 開著時被手動關掉了，關 God mode 時不會動它）" : "autopilot：關著";
  return autopilotBefore() === "on" ? "autopilot：開著，God mode 開之前就開著（關 God mode 時不會動它）" : "autopilot：開著，是手動開的（關 God mode 時不會動它）";
};

if (arg === "on") {
  // already on: the file (its time) is kept, so the unsent count since it was turned on stays whole
  const already = godmodeOn();
  let apNote = "";
  if (!already) {
    // autopilot comes along: on when it is off, and what it was before goes in the flag file (off restores it).
    // A mark left by an earlier God mode (its flag removed by hand) counts as off — it was God mode's, not the human's.
    const ap = autopilotState();
    const before = ap.on && !ap.byGodmode ? "on" : "off";
    fs.mkdirSync(path.dirname(FLAG), { recursive: true });
    fs.writeFileSync(FLAG, `${new Date().toISOString()}\nautopilot-before: ${before}\n`);
    if (before === "off" && !ap.on) {
      try { fs.mkdirSync(path.dirname(AP), { recursive: true }); fs.writeFileSync(AP, autopilotMark()); } catch (e) { apNote = `autopilot 沒打開：${tildePath(AP)} 寫不進去（${e.message}）。`; }
    }
    apNote ||= before === "on" ? "autopilot 本來就開著，維持開著。" : "autopilot 也一起開了：帶 recommendedIndex 的題目自動選建議選項（記在 MYNA-DECISIONS）；關 God mode 時會一起關回去。";
  }
  const out = already
    ? [`God mode 本來就開著（${when(godmodeSince())} 開的），沒有改。關掉：/myna:godmode off。`, unsentLine(), autopilotLine()]
    : [`God mode 開了 —— 這台每一個權限確認都會立刻自動允許（含護欄 hook 攔下來要問的動作），帶 ✅ 核准的 ask_human 題目由 relay 直接按 ✅，每一筆都送一則通知到 IM 的「🔓 God mode」topic。關掉：/myna:godmode off。旗標檔：${tildePath(FLAG)}`, apNote];
  const note = imNote(); if (note) out.push(note);
  console.log(out.join("\n"));
} else if (arg === "off") {
  const was = godmodeOn(), before = autopilotBefore(), ap = autopilotState();
  try { fs.rmSync(FLAG, { force: true }); } catch {}
  if (godmodeOn()) { console.log(`God mode 沒關掉：${tildePath(FLAG)} 刪不掉，請手動刪除。`); process.exit(1); }
  const out = ["God mode 關了 —— 權限確認照原本的方式處理（終端機，沒人回答時轉到手機），✅ 核准題照舊送手機。"];
  // autopilot back to what it was: only a flag God mode wrote and nobody touched since is removed
  if (ap.byGodmode) {
    try { fs.rmSync(AP, { force: true }); out.push("autopilot 也關回去了（回到開 God mode 之前的狀態）。"); }
    catch (e) { out.push(`autopilot 沒關掉：${tildePath(AP)} 刪不掉（${e.message}），請用 /myna:autopilot off。`); }
  } else if (was && before === "off" && ap.on) out.push("autopilot 在 God mode 開著時被手動改過（現在開著），以你最後的操作為準，沒有動它；要關：/myna:autopilot off。");
  else if (was && before === "on" && !ap.on) out.push("autopilot 在 God mode 開著時被手動關掉了，以你最後的操作為準，維持關著。");
  else if (was && before === "on") out.push("autopilot 開 God mode 之前就開著，維持開著。");
  else if (was && before === "off") out.push("autopilot 已經是關的（God mode 開著時被手動關掉了）。");
  else if (was && ap.on) out.push("autopilot 開著，不知道是不是 God mode 開的（旗標檔沒有記錄），沒有動它。");
  console.log(out.join("\n"));
} else if (arg === "status") {
  if (!godmodeOn()) console.log(`God mode 關著（${tildePath(FLAG)} 不存在）`);
  else {
    const out = [`God mode 開著，${when(godmodeSince())} 開的（${tildePath(FLAG)}）`, unsentLine(), autopilotLine()];
    const note = imNote(); if (note) out.push(note);
    console.log(out.join("\n"));
  }
} else {
  console.error(`godmode 只接受 on、off 或 status（你給的是「${process.argv.slice(2).join(" ")}」），沒有改。`);
  process.exit(1);
}
