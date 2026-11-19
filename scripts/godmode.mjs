#!/usr/bin/env node
// /myna:godmode [on|off|status] — toggle God mode. Presence of the flag file (MYNA_GODMODE_FILE, else
// ~/.myna/godmode) = ON; its content is the time it was turned on. Same pattern as scripts/autopilot.mjs.
// While on, scripts/permission-request.mjs allows every permission dialog at once and sends a notice to
// the IM (relay POST /notify); notices that could not be sent go to godmode-unsent.jsonl (src/godmode.mjs).
// The relay presses the ✅ of this machine's `approves` questions (v0.26.2). on/off also bring autopilot
// along and back (src/godmode.mjs, "God mode brings autopilot along"); a flag file written any other way
// (another tool creating it) turns on God mode only.
// `session <session id> [on|off|status]` (v0.29.0, /myna:godmode-session): God mode for that one session — see sessionMode.
import fs from "node:fs";
import path from "node:path";
import { loadEnv, mynaDir, roleOf } from "../src/remote.mjs";
import { expectedProvider, tildePath } from "../src/status.mjs";
import { godmodeFile, godmodeOn, godmodeSince, unsentSince, appendUnsent,autopilotFile, autopilotState, autopilotMark, autopilotBefore, sessionGodmodeOn, sessionGodmodeFile, sessionGodmodeSince } from "../src/godmode.mjs";

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

// autopilot comes along with `on`: on when it is off, and what it was before goes in the flag file (off restores
// it). A mark left by an earlier God mode (its flag removed by hand) counts as off — it was God mode's, not the
// human's. → [the line to print, ok]
function bringAutopilot() {
  const ap = autopilotState();
  const before = ap.on && !ap.byGodmode ? "on" : "off";
  if (before === "off" && !ap.on) {
    try { fs.mkdirSync(path.dirname(AP), { recursive: true }); fs.writeFileSync(AP, autopilotMark()); }
    catch (e) { return [before, `autopilot 沒打開：${tildePath(AP)} 寫不進去（${e.message}）；修好之後再跑一次 /myna:godmode on 會重試。`, false]; }
  }
  return [before, before === "on" ? "autopilot 本來就開著，維持開著。" : "autopilot 也一起開了：帶 recommendedIndex 的題目自動選建議選項（記在 MYNA-DECISIONS）；關 God mode 時會一起關回去。", true];
}
let failed = false;
// the flag with autopilot's earlier state — written only when autopilot was brought along (ok): without the second
// line the next `on` tries again (as for a flag from before 0.26.2). The flag not written → a mark just written is
// taken back, so autopilot is never left on by a God mode that did not turn on.
function writeFlag(first, before, ok) {
  try { fs.mkdirSync(path.dirname(FLAG), { recursive: true }); fs.writeFileSync(FLAG, `${first}\n${ok ? `autopilot-before: ${before}\n` : ""}`); }
  catch (e) {
    if (before === "off" && autopilotState().byGodmode) { try { fs.rmSync(AP, { force: true }); } catch {} }
    console.log(`God mode 沒開：${tildePath(FLAG)} 寫不進去（${e.message}）。`); process.exit(1);
  }
}

// /myna:godmode-session [on|off|status] (v0.29.0) — God mode for ONE session: `session <session id> [on|off|status]`.
// commands/godmode-session.md passes ${CLAUDE_SESSION_ID} (Claude Code fills it in); the chat mod passes its own
// session id for the phone's !myna:godmode-session. The flag is a file per session (src/godmode-session.mjs):
// existing = on. The machine-wide flag and the machine-wide autopilot flag are never touched here — the MCP
// server takes the session's flag as "autopilot on" for that session's own questions. A session id that is
// missing, or still the literal placeholder, is refused: nothing is written.
function sessionMode() {
  const sid = String(process.argv[3] ?? "").trim();
  const sub = (process.argv[4] || "status").toLowerCase();
  const usage = "用法：/myna:godmode-session [on|off|status]（只管目前這個 session，不收其他參數）";
  if (!sid || sid.includes("$") || ["on", "off", "status"].includes(sid.toLowerCase())) {
    console.error(`拿不到這個 session 的 id（拿到的是「${sid}」），沒有改。這個 Claude Code 版本可能不會把指令裡的 \${CLAUDE_SESSION_ID} 換成 session id。`);
    process.exit(1);
  }
  // two forms for the chat mod only (the phone's !myna:godmode-session, hooks/chat-mod.mjs — a mod has no file
  // system calls of its own for these): `check` prints on / off; `unsent` keeps a notice the mod could not send
  // (stdin: {text, reason}) in the unsent file, as the hook and the relay keep theirs
  if (sub === "check" && process.argv.length === 5) { console.log(sessionGodmodeOn(sid) ? "on" : "off"); return; }
  if (sub === "unsent" && process.argv.length === 5) {
    let rec = {};
    try { rec = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
    if (typeof rec?.text !== "string" || !rec.text.trim()) { console.error("unsent: stdin 要是 {text, reason}"); process.exit(1); }
    const kept = appendUnsent({ at: new Date().toISOString(), session_id: sid, tool: "godmode-session", reason: String(rec.reason || "not sent").slice(0, 300), text: rec.text.slice(0, 2000) });
    if (!kept) process.exit(1);
    return;
  }
  if (!["on", "off", "status"].includes(sub) || process.argv.length > 5) {
    console.error(`godmode-session 只接受 on、off 或 status（你給的是「${process.argv.slice(4).join(" ")}」），沒有改。${usage}`);
    process.exit(1);
  }
  const f = sessionGodmodeFile(sid), short = sid.slice(0, 8);
  const whole = () => (godmodeOn() ? `整台的 God mode 也開著（${when(godmodeSince())} 開的，/myna:godmode）：這台所有 session 本來就全部自動同意，關掉這個 session 的不會改變這點。` : "");
  const out = [];
  if (sub === "on") {
    if (sessionGodmodeOn(sid)) out.push(`God mode 本來就開給這個 session（${short}）了（${when(sessionGodmodeSince(sid))} 開的），沒有改。關掉：/myna:godmode-session off。`);
    else {
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${new Date().toISOString()}\n`); }
      catch (e) { console.log(`God mode 沒開：${tildePath(f)} 寫不進去（${e.message}）。`); process.exit(1); }
      out.push(`God mode 只開給這個 session（${short}）了 —— 這個 session 和它的背景 subagent 的權限確認立刻自動允許（含護欄 hook 攔下來要問的動作），帶 ✅ 核准的 ask_human 題目由 relay 直接按 ✅，有建議選項的題目自動選（只有這個 session，整台的 autopilot 沒有動），每一筆都送一則通知到 IM 的「🔓 God mode」topic。這台其他 session 照舊問你。`,
        `session 結束（離開、/clear、/resume 換到別的 session）就自動關；手動關：/myna:godmode-session off。旗標檔：${tildePath(f)}`);
    }
    const w = whole(); if (w) out.push(w);
    const note = imNote(); if (note) out.push(note);
  } else if (sub === "off") {
    const was = sessionGodmodeOn(sid);
    try { fs.rmSync(f, { force: true }); } catch {}
    if (sessionGodmodeOn(sid)) { console.log(`God mode 沒關掉：${tildePath(f)} 刪不掉，請手動刪除。`); process.exit(1); }
    out.push(was ? `這個 session（${short}）的 God mode 關了 —— 它的權限確認和 ✅ 核准題照原本的方式處理。` : `這個 session（${short}）的 God mode 本來就沒開，沒有改。`);
    const w = whole(); if (w) out.push(w);
  } else {
    out.push(sessionGodmodeOn(sid) ? `這個 session（${short}）的 God mode 開著，${when(sessionGodmodeSince(sid))} 開的（${tildePath(f)}）；session 結束就自動關` : `這個 session（${short}）的 God mode 關著`);
    out.push(godmodeOn() ? `整台的 God mode 開著（${when(godmodeSince())} 開的）：這台所有 session 都自動同意` : "整台的 God mode 關著");
  }
  console.log(out.join("\n"));
}

if (arg === "session") sessionMode();
else if (arg === "on") {
  // already on: the file (its time) is kept, so the unsent count since it was turned on stays whole
  const already = godmodeOn();
  let out;
  if (!already) {
    const [before, apNote, ok] = bringAutopilot();
    writeFlag(new Date().toISOString(), before, ok);
    failed = !ok;
    out = [`God mode 開了 —— 這台每一個權限確認都會立刻自動允許（含護欄 hook 攔下來要問的動作），帶 ✅ 核准的 ask_human 題目由 relay 直接按 ✅，每一筆都送一則通知到 IM 的「🔓 God mode」topic。關掉：/myna:godmode off。旗標檔：${tildePath(FLAG)}`, apNote];
  } else if (!autopilotBefore()) {
    // on since before 0.26.2 (the flag holds only its time), or autopilot could not be brought along last time:
    // bring it along now, the time kept
    const first = fs.readFileSync(FLAG, "utf8").split(/\r?\n/)[0];
    const [before, apNote, ok] = bringAutopilot();
    writeFlag(first, before, ok);
    failed = !ok;
    out = [`God mode 本來就開著（${when(godmodeSince())} 開的，0.26.2 以前開的）—— 現在補上 autopilot 的連動。關掉：/myna:godmode off。`, unsentLine(), apNote];
  } else out = [`God mode 本來就開著（${when(godmodeSince())} 開的），沒有改。關掉：/myna:godmode off。`, unsentLine(), autopilotLine()];
  const note = imNote(); if (note) out.push(note);
  console.log(out.join("\n"));
  if (failed) process.exit(1);
} else if (arg === "off") {
  const was = godmodeOn(), before = autopilotBefore(), ap = autopilotState();
  try { fs.rmSync(FLAG, { force: true }); } catch {}
  if (godmodeOn()) { console.log(`God mode 沒關掉：${tildePath(FLAG)} 刪不掉，請手動刪除。`); process.exit(1); }
  const out = ["God mode 關了 —— 權限確認照原本的方式處理（終端機，沒人回答時轉到手機），✅ 核准題照舊送手機。"];
  // autopilot back to what it was: only a flag God mode wrote and nobody touched since is removed — read again
  // right before removing it (a /myna:autopilot on|off just now is the human's last word)
  if (ap.byGodmode && autopilotState().byGodmode) {
    try { fs.rmSync(AP, { force: true }); out.push("autopilot 也關回去了（回到開 God mode 之前的狀態）。"); }
    catch (e) { out.push(`autopilot 沒關掉：${tildePath(AP)} 刪不掉（${e.message}），請用 /myna:autopilot off。`); failed = true; }
  } else if (ap.byGodmode) out.push("autopilot 剛剛被手動切過，以你最後的操作為準，沒有動它。");
  else if (was && before === "off" && ap.on) out.push("autopilot 在 God mode 開著時被手動改過（現在開著），以你最後的操作為準，沒有動它；要關：/myna:autopilot off。");
  else if (was && before === "on" && !ap.on) out.push("autopilot 在 God mode 開著時被手動關掉了，以你最後的操作為準，維持關著。");
  else if (was && before === "on") out.push("autopilot 開 God mode 之前就開著，維持開著。");
  else if (was && before === "off") out.push("autopilot 已經是關的（God mode 開著時被手動關掉了）。");
  else if (was && ap.on) out.push("autopilot 開著，不知道是不是 God mode 開的（旗標檔沒有記錄），沒有動它。");
  console.log(out.join("\n"));
  if (failed) process.exit(1);
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
