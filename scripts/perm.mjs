#!/usr/bin/env node
// Toggle Myna's permission forwarding. ON BY DEFAULT — the PermissionRequest hook
// (scripts/permission-request.mjs) sends a permission dialog nobody answered at the terminal within
// MYNA_PERMISSION_DELAY seconds (default 30) to the phone. The flag file (~/.myna/permission) only
// records an explicit OFF:
//   - no file (or first line ≠ "off")  → ON  (default)
//   - first line == "off"              → OFF
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLAG = process.env.MYNA_PERMISSION_FILE || path.join(os.homedir(), ".myna", "permission");
const arg = (process.argv[2] || "status").toLowerCase();
const disabled = () => {
  try { return fs.existsSync(FLAG) && fs.readFileSync(FLAG, "utf8").split(/\r?\n/)[0].trim() === "off"; }
  catch { return false; }
};

if (arg === "on") {
  try { fs.rmSync(FLAG); } catch {}   // absence = default ON
  console.log(`permission forwarding ON — a permission dialog unanswered at the terminal for ${process.env.MYNA_PERMISSION_DELAY ?? 30}s goes to your IM. (default) flag: ${FLAG}`);
} else if (arg === "off") {
  fs.mkdirSync(path.dirname(FLAG), { recursive: true });
  fs.writeFileSync(FLAG, `off\n${new Date().toISOString()}`);
  console.log(`permission forwarding OFF — permission dialogs are answered at the terminal only. flag: ${FLAG}`);
} else {
  console.log(`permission forwarding is ${disabled() ? "OFF" : "ON"} (default ON)  (${FLAG})`);
}
