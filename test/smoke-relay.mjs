#!/usr/bin/env node
// Interactive smoke test: real relay round-trip. Requires `node src/relay.mjs` running
// (reads .env) and your phone. Spawns ask-human.mjs (autopilot OFF), calls ask_human,
// which POSTs to the relay → your IM (Telegram/Discord/Slack) → you tap → discriminated result comes back and
// a human decision is logged.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const serverPath = fileURLToPath(new URL("../src/mcp/ask-human.mjs", import.meta.url));
const scratch = path.join(os.tmpdir(), "myna-relay-smoke");
fs.mkdirSync(scratch, { recursive: true });

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env: { ...process.env, MYNA_LOG_DIR: scratch, MYNA_AUTOPILOT_FILE: path.join(scratch, "no-autopilot"), MYNA_HEARTBEAT_MS: "10000" },
  stderr: "inherit",
});
const c = new Client({ name: "relay-smoke", version: "0" }, { capabilities: {} });
await c.connect(transport);

console.log("[smoke] calling ask_human → CHECK YOUR PHONE (your Myna bot)…");
const r = await c.callTool(
  { name: "ask_human", arguments: { header: "myna v1", question: "v1 relay-connected ask_human 測試 — 選一個(或 ✍️ 反問 / ⏹ 取消)", options: ["看起來不錯", "再看看"], recommendedIndex: 0 } },
  undefined,
  { timeout: 3_600_000, resetTimeoutOnProgress: true }, // MCP SDK client default is 60s; heartbeat resets it
);
const result = JSON.parse(r.content[0].text);
console.log("[smoke] result:", JSON.stringify(result));
await c.close();

try { console.log("[smoke] decision log:", fs.readFileSync(path.join(scratch, "MYNA-DECISIONS.jsonl"), "utf8").trim() || "(none)"); } catch { console.log("[smoke] decision log: (none)"); }
console.log(["selection", "message", "aborted"].includes(result.kind) ? `\n✅ RELAY ROUND-TRIP reached the phone (kind=${result.kind})` : `\n⚠️ kind=${result.kind}`);
