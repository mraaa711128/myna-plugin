#!/usr/bin/env node
// Autonomous regression test for the bounded long-poll fix (no phone / no real Telegram).
// A fake relay speaks the same /ask + /answer contract as src/relay.mjs:
//   - GET /answer/<id> holds at most HOLD ms, then returns {kind:"pending"} (client must re-poll);
//   - the "human" answers only after several pending cycles → proves the client loops instead of
//     dying at a single socket's timeout (the old unbounded-wait "fetch failed → fallback" bug).
// Drives the REAL dist/ask-human.mjs over MCP so we test the shipped client path.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const serverPath = fileURLToPath(new URL("../dist/ask-human.mjs", import.meta.url));
const HOLD = 400;            // fake relay's per-poll hold
const ANSWER_AT = 1500;      // "human" answers ~3-4 pending cycles in

// --- fake relay ---------------------------------------------------------------
const pend = new Map(); // id -> { result?, resolvedAt? }
let polls = 0, pendings = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const j = { "content-type": "application/json" };
  if (req.method === "POST" && u.pathname === "/ask") {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const id = "aaaa" + (pend.size + 1);
      pend.set(id, {});
      setTimeout(() => { const e = pend.get(id); if (e) { e.result = { kind: "selection", value: "看起來不錯" }; e.resolvedAt = Date.now(); } }, ANSWER_AT);
      res.writeHead(200, j); res.end(JSON.stringify({ request_id: id }));
    });
    return;
  }
  const m = u.pathname.match(/^\/answer\/(\w+)$/);
  if (req.method === "GET" && m) {
    polls++;
    const e = pend.get(m[1]);
    if (!e) { res.writeHead(404); res.end('{"error":"gone"}'); return; }
    if (e.result !== undefined) { pend.delete(m[1]); res.writeHead(200, j); res.end(JSON.stringify(e.result)); return; }
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (e.result !== undefined) { clearInterval(iv); pend.delete(m[1]); res.writeHead(200, j); res.end(JSON.stringify(e.result)); }
      else if (Date.now() - t0 >= HOLD) { clearInterval(iv); pendings++; res.writeHead(200, j); res.end(JSON.stringify({ kind: "pending" })); }
    }, 20);
    return;
  }
  res.writeHead(404); res.end("x"); // reachability probe hits this — any response = up
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const RELAY = `http://127.0.0.1:${srv.address().port}`;

// --- drive the real client ----------------------------------------------------
const scratch = path.join(os.tmpdir(), "myna-bounded-poll");
const transport = new StdioClientTransport({
  command: "node", args: [serverPath],
  env: { ...process.env, MYNA_RELAY_URL: RELAY, MYNA_LOG_DIR: scratch,
         MYNA_AUTOPILOT_FILE: path.join(scratch, "off"), MYNA_ANSWER_POLL_MS: "5000", MYNA_HEARTBEAT_MS: "60000" },
  stderr: "inherit",
});
const c = new Client({ name: "bounded-poll", version: "0" }, { capabilities: {} });
await c.connect(transport);

const r = await c.callTool(
  { name: "ask_human", arguments: { header: "t", question: "q", options: ["看起來不錯", "再看看"], recommendedIndex: 0 } },
  undefined, { timeout: 30_000, resetTimeoutOnProgress: true },
);
const result = JSON.parse(r.content[0].text);
await c.close(); srv.close();

let fail = 0;
const ok = (cond, m) => { console.log(`${cond ? "✅" : "❌"} ${m}`); if (!cond) fail++; };
console.log(`[bounded-poll] result=${JSON.stringify(result)}  polls=${polls} pendings=${pendings}`);
ok(result.kind === "selection" && result.value === "看起來不錯", "client returned the answer after re-polling");
ok(pendings >= 2, `client survived ${pendings} {kind:"pending"} cycles (didn't die on one socket)`);
ok(polls >= pendings + 1, "client re-polled on a fresh request each cycle");
console.log(fail ? `\n❌ ${fail} check(s) FAILED` : "\n✅ BOUNDED-POLL PASS");
process.exit(fail ? 1 : 0);
