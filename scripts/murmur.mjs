#!/usr/bin/env node
// /myna:murmur — how a chat session's progress message looks on Telegram. Global (every session);
// the relay reads the flag file (~/.myna/chat-progress) at every progress update, so a switch shows
// from the next update on. ON BY DEFAULT; the file only records an explicit OFF:
//   - no file (or first line ≠ "off") → ON  (default): every tool call is a new line
//   - first line == "off"             → OFF: the 🖥 prompt line + every 💭 remark + only the newest tool, with its count
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLAG = process.env.MYNA_PROGRESS_FILE || path.join(os.homedir(), ".myna", "chat-progress");
const arg = (process.argv[2] || "status").toLowerCase();
const off = () => {
  try { return fs.readFileSync(FLAG, "utf8").split(/\r?\n/)[0].trim() === "off"; }
  catch { return false; }
};

if (arg === "on") {
  try { fs.rmSync(FLAG); } catch {}   // absence = default ON
  console.log(`murmur ON — every tool call is added as a new line to the turn's progress message. (default) flag: ${FLAG}`);
} else if (arg === "off") {
  fs.mkdirSync(path.dirname(FLAG), { recursive: true });
  fs.writeFileSync(FLAG, `off\n${new Date().toISOString()}`);
  console.log(`murmur OFF — the progress message keeps every remark but only the newest tool (with its count) under the prompt line, and stays at the bottom. flag: ${FLAG}`);
} else {
  console.log(`murmur is ${off() ? "OFF" : "ON"} (default ON)  (${FLAG})`);
}
