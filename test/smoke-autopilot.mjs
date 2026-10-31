#!/usr/bin/env node
// Autonomous smoke test (NO Telegram): validates the new ask-human.mjs glue —
// autopilot auto-accept + decision logging, "(Recommended)" parsing, and the
// safety fallback (autopilot with no recommended, and relay-down) → unreachable.
// Points the server at a dead relay port so any fallback path resolves fast.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const serverPath = process.env.MYNA_SERVER || fileURLToPath(new URL("../src/mcp/ask-human.mjs", import.meta.url));
const scratch = path.join(os.tmpdir(), "myna-smoke-" + process.pid);
fs.mkdirSync(scratch, { recursive: true });
const flag = path.join(scratch, "autopilot");
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };

async function newClient(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: { ...process.env, MYNA_LOG_DIR: scratch, MYNA_AUTOPILOT_FILE: flag, MYNA_RELAY_URL: "http://127.0.0.1:59999", ...extraEnv },
    stderr: "ignore",
  });
  const c = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
  await c.connect(transport);
  return c;
}
const call = (c, args) => c.callTool({ name: "ask_human", arguments: args }).then((r) => JSON.parse(r.content[0].text));

// 0) tool is listed
let c = await newClient();
ok((await c.listTools()).tools.some((t) => t.name === "ask_human"), "ask_human tool is listed");
await c.close();

// 1) autopilot ON + recommendedIndex → auto-select, no relay
fs.writeFileSync(flag, "");
c = await newClient();
let r = await call(c, { header: "space-time", question: "v1 支援 multiSelect?", options: ["採用 A", "採用 B"], recommendedIndex: 0 });
ok(r.kind === "selection" && r.value === "採用 A" && r.auto === true, `autopilot auto-accepts recommendedIndex → ${JSON.stringify(r)}`);
await c.close();

// 1b) "(Recommended)" marker parsing when no recommendedIndex given
c = await newClient();
r = await call(c, { header: "h", question: "q", options: ["B option", "A option (Recommended)"] });
ok(r.kind === "selection" && r.value === "A option (Recommended)" && r.auto === true, `autopilot parses (Recommended) marker → ${JSON.stringify(r)}`);
await c.close();

// log written (2 auto decisions)
const jsonl = fs.readFileSync(path.join(scratch, "MYNA-DECISIONS.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(jsonl.length === 2 && jsonl.every((d) => d.mode === "auto"), `2 auto decisions in jsonl (got ${jsonl.length})`);
ok(fs.existsSync(path.join(scratch, "MYNA-DECISIONS.md")), "MYNA-DECISIONS.md rendered");

// 2) autopilot ON but NO recommended → must NOT guess → falls back to relay (dead) → unreachable
c = await newClient();
r = await call(c, { header: "h", question: "no recommended", options: ["X", "Y"] });
ok(r.kind === "unreachable", `autopilot + no-recommended does NOT guess, falls back to relay → ${JSON.stringify(r)}`);
await c.close();

// 3) autopilot OFF → relay (dead) → unreachable fallback (never hangs, never wrong answer)
fs.rmSync(flag);
c = await newClient();
r = await call(c, { header: "h", question: "q", options: ["X", "Y"], recommendedIndex: 0 });
ok(r.kind === "unreachable", `relay-down fallback → unreachable → ${JSON.stringify(r)}`);
await c.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ SMOKE (autopilot + fallback) PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
