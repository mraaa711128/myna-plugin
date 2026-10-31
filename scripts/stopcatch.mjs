#!/usr/bin/env node
// Toggle the Myna stop-catch flag. Stop-catch is ON BY DEFAULT — the Stop hook
// (scripts/stop-catch-question.mjs) blocks a turn that ends with a plain-text question to the
// user (no AskUserQuestion / ask_human) and instructs the model to route it to the phone.
// The flag file (~/.myna/stopcatch) only records an explicit OFF:
//   - no file (or first line ≠ "off")  → ON  (default)
//   - first line == "off"              → OFF
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLAG = process.env.MYNA_STOPCATCH_FILE || path.join(os.homedir(), ".myna", "stopcatch");
const arg = (process.argv[2] || "status").toLowerCase();
const disabled = () => {
  try { return fs.existsSync(FLAG) && fs.readFileSync(FLAG, "utf8").split(/\r?\n/)[0].trim() === "off"; }
  catch { return false; }
};

if (arg === "on") {
  try { fs.rmSync(FLAG); } catch {}   // absence = default ON
  console.log(`stop-catch ON — plain-text question endings are bounced to ask_human (your IM) when the relay is up. (default) flag: ${FLAG}`);
} else if (arg === "off") {
  fs.mkdirSync(path.dirname(FLAG), { recursive: true });
  fs.writeFileSync(FLAG, `off\n${new Date().toISOString()}`);
  console.log(`stop-catch OFF — turns may end with unrouted plain-text questions. flag: ${FLAG}`);
} else {
  console.log(`stop-catch is ${disabled() ? "OFF" : "ON"} (default ON)  (${FLAG})`);
}
