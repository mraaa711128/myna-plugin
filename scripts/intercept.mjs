#!/usr/bin/env node
// Toggle the Myna AskUserQuestion-interception flag. Interception is ON BY DEFAULT — the PreToolUse
// hook (scripts/intercept-ask.mjs) redirects AskUserQuestion to ask_human (your IM) whenever the
// relay is reachable. The flag file (~/.myna/intercept) only records an explicit OFF:
//   - no file (or first line ≠ "off")  → ON  (default)
//   - first line == "off"              → OFF
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLAG = process.env.MYNA_INTERCEPT_FILE || path.join(os.homedir(), ".myna", "intercept");
const arg = (process.argv[2] || "status").toLowerCase();
const disabled = () => {
  try { return fs.existsSync(FLAG) && fs.readFileSync(FLAG, "utf8").split(/\r?\n/)[0].trim() === "off"; }
  catch { return false; }
};

if (arg === "on") {
  try { fs.rmSync(FLAG); } catch {}   // absence = default ON
  console.log(`intercept ON — AskUserQuestion is redirected to ask_human (your IM) when the relay is up. (default) flag: ${FLAG}`);
} else if (arg === "off") {
  fs.mkdirSync(path.dirname(FLAG), { recursive: true });
  fs.writeFileSync(FLAG, `off\n${new Date().toISOString()}`);
  console.log(`intercept OFF — AskUserQuestion uses the local terminal picker. flag: ${FLAG}`);
} else {
  console.log(`intercept is ${disabled() ? "OFF" : "ON"} (default ON)  (${FLAG})`);
}
