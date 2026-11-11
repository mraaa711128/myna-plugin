#!/usr/bin/env node
// MANUAL live test — not part of the automated suite: it reaches your phone through the running relay.
// Runs only with MYNA_RELAY_URL set explicitly: MYNA_RELAY_URL=http://127.0.0.1:7800 node test/smoke-relay-multiround.mjs
// Interactive multi-round + abort live-test. The harness plays the ORCHESTRATOR: it drives
// the conversational loop THROUGH the ask_human MCP tool. Requires `node src/relay.mjs` + phone.
//   tap a number  -> selection (ends)
//   tap ✍️ + type -> {kind:message} -> harness re-asks with preamble (same thread_id)
//   tap ⏹         -> {kind:aborted} (ends)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveTestOptedIn, liveTestRefusal } from "./helpers/live-guard.mjs";

// before anything touches the network or spawns the MCP server
if (!liveTestOptedIn(process.env)) { console.error(liveTestRefusal("smoke-relay-multiround.mjs")); process.exit(2); }

const serverPath = fileURLToPath(new URL("../src/mcp/ask-human.mjs", import.meta.url));
const scratch = path.join(os.tmpdir(), "myna-multiround");
fs.mkdirSync(scratch, { recursive: true });

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env: { ...process.env, MYNA_LOG_DIR: scratch, MYNA_AUTOPILOT_FILE: path.join(scratch, "off"), MYNA_HEARTBEAT_MS: "10000" },
  stderr: "inherit",
});
const c = new Client({ name: "multiround", version: "0" }, { capabilities: {} });
await c.connect(transport);
// client-side timeout must be large (MCP SDK default is 60s); heartbeat resets it.
// In real use, Claude Code's client timeout comes from .mcp.json "timeout": 86400000.
const ask = (args) =>
  c.callTool({ name: "ask_human", arguments: args }, undefined, { timeout: 3_600_000, resetTimeoutOnProgress: true })
    .then((r) => JSON.parse(r.content[0].text));

const thread_id = "live-multiround";
let preamble = null;
let result;
for (let round = 1; round <= 6; round++) {
  console.log(`[round ${round}] asking → CHECK PHONE…`);
  result = await ask({ header: "myna 多輪", question: "選一個(或 ✍️ 反問 / ⏹ 取消)", options: ["採用建議 A", "改用 B"], recommendedIndex: 0, thread_id, preamble });
  console.log(`[round ${round}] ->`, JSON.stringify(result));
  if (result.kind === "message") {
    preamble = `(示範回覆)你問:「${result.text}」。真實 /feature 會由 Claude 給實質回答;先請你決定:`;
    continue;
  }
  break;
}
await c.close();
const label = { selection: "多輪→selection ✅", aborted: "abort ✅", unreachable: "unreachable (relay down?)", message: "message (loop maxed)" }[result.kind] || result.kind;
console.log(`\n✅ MULTI-ROUND live-test done — final kind=${result.kind} (${label})`);
