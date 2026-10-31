#!/usr/bin/env node
// Toggle the Myna autopilot flag. Presence of the flag file (~/.myna/autopilot) = ON.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLAG = process.env.MYNA_AUTOPILOT_FILE || path.join(os.homedir(), ".myna", "autopilot");
const arg = (process.argv[2] || "status").toLowerCase();
const on = () => fs.existsSync(FLAG);

if (arg === "on") {
  fs.mkdirSync(path.dirname(FLAG), { recursive: true });
  fs.writeFileSync(FLAG, new Date().toISOString());
  console.log(`autopilot ON — ask_human auto-accepts the recommended option (logged). flag: ${FLAG}`);
} else if (arg === "off") {
  try { fs.rmSync(FLAG); } catch {}
  console.log("autopilot OFF — ask_human relays gate questions to Telegram and waits for you.");
} else {
  console.log(`autopilot is ${on() ? "ON" : "OFF"}  (${FLAG})`);
}
