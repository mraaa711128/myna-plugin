#!/usr/bin/env node
// A stand-in for launchctl / schtasks / systemctl in test/smoke-service.mjs — scripts/service.mjs runs it
// through MYNA_SERVICE_LAUNCHCTL / _SCHTASKS / _SYSTEMCTL, so nothing is ever registered with the real OS.
// Which tool it plays is read from the arguments. State and a log of every call live in MYNA_FAKE_OS_DIR:
//   calls.jsonl          one {tool, args} line per call
//   registered-<tool>    present = "registered" (loaded agent, existing task, enabled unit)
// MYNA_FAKE_OS_FAIL=<word>[,<word>…]   those subcommands (print, bootout, bootstrap, /Query, /Create, /Delete,
//                            enable, disable, daemon-reload, …) fail with exit 1 "Access is denied."
// MYNA_FAKE_OS_NORUN=1       launchctl bootstrap does not run the plist's program (no RunAtLoad effect)
// launchctl bootstrap reads the plist and, like RunAtLoad, starts its ProgramArguments (detached).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = process.env.MYNA_FAKE_OS_DIR;
if (!dir) { console.error("fake-service-os: MYNA_FAKE_OS_DIR not set"); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const tool = args[0] === "--user" ? "systemctl" : /^\//.test(args[0] || "") ? "schtasks" : "launchctl";
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ tool, args }) + "\n");
const verb = tool === "systemctl" ? args[1] : args[0];
const flag = path.join(dir, `registered-${tool}`);
const isOn = () => fs.existsSync(flag);
const set = (on) => { if (on) fs.writeFileSync(flag, JSON.stringify(args)); else fs.rmSync(flag, { force: true }); };
const failWords = String(process.env.MYNA_FAKE_OS_FAIL || "").toLowerCase().split(",").filter(Boolean);
if (failWords.includes(String(verb).toLowerCase())) { console.error(`fake ${tool}: ${verb} failed (Access is denied.)`); process.exit(1); }

const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

if (tool === "launchctl") {
  if (verb === "print") { if (isOn()) { console.log(`${args[1]} = {\n\tstate = not running\n}`); process.exit(0); } console.error(`Could not find service "${args[1]}"`); process.exit(113); }
  if (verb === "bootout") { if (!isOn()) { console.error("Boot-out failed: 3: No such process"); process.exit(3); } set(false); process.exit(0); }
  if (verb === "bootstrap") {
    if (isOn()) { console.error("Bootstrap failed: 5: Input/output error"); process.exit(5); }
    const plist = fs.readFileSync(args[2], "utf8");
    set(true);
    const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
    const prog = arr ? [...arr[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1])) : [];
    if (/<key>RunAtLoad<\/key>\s*<true\/>/.test(plist) && prog.length && process.env.MYNA_FAKE_OS_NORUN !== "1") {
      const c = spawn(prog[0], prog.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
      c.unref();
      fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ tool: "launchd-run", args: prog }) + "\n");
    }
    process.exit(0);
  }
}
if (tool === "schtasks") {
  // the whole list as CSV (what service.mjs asks): a few other tasks, ours when registered
  if (verb === "/Query" && args.includes("/FO")) {
    console.log('"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready"');
    console.log('"\\Myna relay helper","N/A","Ready"');
    if (isOn()) console.log('"\\Myna relay","N/A","Ready"');
    process.exit(0);
  }
  if (verb === "/Query") { if (isOn()) { console.log("TaskName: \\Myna relay"); process.exit(0); } console.error("ERROR: The system cannot find the file specified."); process.exit(1); }
  if (verb === "/Create") { set(true); console.log('SUCCESS: The scheduled task "Myna relay" has successfully been created.'); process.exit(0); }
  if (verb === "/Delete") { if (!isOn()) { console.error("ERROR: The system cannot find the file specified."); process.exit(1); } set(false); console.log("SUCCESS"); process.exit(0); }
}
if (tool === "systemctl") {
  if (verb === "daemon-reload") process.exit(0);
  if (verb === "is-enabled") { if (isOn()) { console.log("enabled"); process.exit(0); } console.log(process.env.MYNA_FAKE_OS_BUS === "down" ? "" : "disabled"); if (process.env.MYNA_FAKE_OS_BUS === "down") console.error("Failed to connect to bus: No medium found"); process.exit(1); }
  if (verb === "enable") { set(true); process.exit(0); }
  if (verb === "disable") { set(false); process.exit(0); }
}
console.error(`fake ${tool}: unknown call ${args.join(" ")}`);
process.exit(2);
