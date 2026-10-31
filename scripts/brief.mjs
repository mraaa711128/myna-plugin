#!/usr/bin/env node
// Toggle the Myna gate-brief flag. Brief is ON BY DEFAULT: when an AskUserQuestion is intercepted,
// the hook (scripts/intercept-ask.mjs) also asks the model to publish a rich decision-support
// Artifact (per-option context) and link it in the IM question. Requires interception on and
// the relay up. The flag file (~/.myna/brief) only records an explicit OFF:
//   - no file (or first line ≠ "off")  → ON  (default)
//   - first line == "off"              → OFF
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLAG = process.env.MYNA_BRIEF_FILE || path.join(os.homedir(), ".myna", "brief");
const arg = (process.argv[2] || "status").toLowerCase();
const disabled = () => {
  try { return fs.existsSync(FLAG) && fs.readFileSync(FLAG, "utf8").split(/\r?\n/)[0].trim() === "off"; }
  catch { return false; }
};

if (arg === "on") {
  try { fs.rmSync(FLAG); } catch {}   // absence = default ON
  console.log(`gate-brief ON — intercepted gates also publish a per-option context Artifact and link it on your IM. (default) flag: ${FLAG}`);
} else if (arg === "off") {
  fs.mkdirSync(path.dirname(FLAG), { recursive: true });
  fs.writeFileSync(FLAG, `off\n${new Date().toISOString()}`);
  console.log(`gate-brief OFF — intercepted gates send fuller option text to the IM, no Artifact. flag: ${FLAG}`);
} else {
  console.log(`gate-brief is ${disabled() ? "OFF" : "ON"} (default ON)  (${FLAG})`);
}
