#!/usr/bin/env node
// Autonomous e2e of APPROVAL ATTESTATION: ask_human with `approves` → real relay → real
// telegram provider → local Telegram API stub; a guard's POST /attest {command, session_id} gets
// approved:true exactly once, and only for a ✅ tap by the human on the phone — never for a ✍️ reply,
// an option without ✅, a cancel, another session, a different command, or after the TTL. Approvals
// live in the relay's memory only: a restart drops them, and nothing planted in the (agent-writable)
// journal — an `approvals` field, a swapped `approves` — ever attests. The MCP side rejects
// a malformed `approves`, shows the command verbatim on the phone and logs answered_at.
// Exactly one ✅ option, and no invisible/control characters in `approves` (\n allowed) — both
// checked by the MCP server and again by the relay's /ask.
// Isolated: random port, fake MYNA_ENV, own journal + topics file, stubbed Telegram on 127.0.0.1.
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
const serverPath = fileURLToPath(new URL(process.env.MYNA_SERVER ? `../${process.env.MYNA_SERVER}` : "../dist/ask-human.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return undefined; await sleep(50); } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 90s"); process.exit(1); }, 90000);

// --- Telegram API stub (the "human") -------------------------------------------
const sent = [];
let updates = [], nextUpdateId = 1, mid = 100;
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    if (/\/getUpdates$/.test(u.pathname)) {
      // a poll from a relay that was just killed must not absorb the updates meant for its successor
      const deliver = () => { if (req.socket.destroyed) return; const out = updates; updates = []; json({ ok: true, result: out }); };
      if (updates.length) deliver();
      else { const t = setTimeout(deliver, 100); res.on("close", () => clearTimeout(t)); }
      return;
    }
    if (/\/sendMessage$/.test(u.pathname)) { const m = ++mid; sent.push({ ...b, _mid: m }); json({ ok: true, result: { message_id: m } }); return; }
    json({ ok: true, result: true });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const push = (u) => updates.push({ update_id: nextUpdateId++, ...u });
const keyboardFor = (question) => until(() => [...sent].reverse().find((s) => s.reply_markup?.inline_keyboard && s.text.includes(question)));
const tap = (kb, row, idx) => push({ callback_query: { id: `cq${nextUpdateId}`, data: kb.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 } } } });

// --- real relay (restartable: same journal) ---------------------------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "myna-attest-"));
const PENDING = path.join(scratch, "pending.json");
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
let relay;
async function startRelay(extra = {}) {
  relay = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env,
      MYNA_ENV: path.join(scratch, "no-such.env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42",
      TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      RELAY_PORT: String(RELAY_PORT), MYNA_ANSWER_HOLD_MS: "1000", TELEGRAM_TOPICS: "off",
      MYNA_TOPICS_FILE: path.join(scratch, "topics.json"), MYNA_PENDING_FILE: PENDING,
      MYNA_APPROVAL_TTL_MS: "60000",
      // God mode off whatever the developer's own ~/.myna/godmode says (it would press every ✅ here)
      MYNA_GODMODE_FILE: path.join(scratch, "no-godmode"), ...extra,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const up = await until(() => fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false), 8000);
  if (!up) { console.error("❌ relay never came up"); process.exit(1); }
}
async function stopRelay() {
  const gone = new Promise((r) => relay.once("exit", r));
  relay.kill(); await gone;
}
const post = (p, body) => fetch(`${RELAY}${p}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const attest = (command, session_id) => post("/attest", { command, session_id });
const ask = (args) => post("/ask", args);
async function answer(id) { // loop over bounded-poll {kind:"pending"}
  for (;;) {
    const j = await (await fetch(`${RELAY}/answer/${id}`, { signal: AbortSignal.timeout(5000) })).json();
    if (j.kind !== "pending") return j;
  }
}
// ask straight at the relay (what the MCP server does), the human taps option `idx` → the answer
async function approveVia(session_id, approves, question, idx = 0, options = ["✅ 核准執行", "先不要"]) {
  const { request_id } = await ask({ question, options, approves, session_id });
  const kb = await keyboardFor(question);
  tap(kb, 0, idx);
  return { request_id, result: await answer(request_id) };
}
await startRelay();

const h = await fetch(`${RELAY}/health`).then((r) => r.json());
ok(h.attest === true && h.approval_ttl_ms === 60000, `/health advertises attest (ttl ${h.approval_ttl_ms}ms)`);

// --- a "Claude session" = one MCP server process (bundled dist) ------------------------------
async function session(sid, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath],
    env: { ...process.env, MYNA_RELAY_URL: RELAY, MYNA_LOG_DIR: scratch, MYNA_AUTOPILOT_FILE: path.join(scratch, "no-autopilot"), MYNA_HEARTBEAT_MS: "5000", MYNA_ANSWER_POLL_MS: "5000", MYNA_SESSION_NAME: sid, MYNA_TICKET: "", MYNA_SESSION_ID: sid, ...extraEnv },
    stderr: "ignore",
  });
  const c = new Client({ name: `attest-${sid}`, version: "0" }, { capabilities: {} });
  await c.connect(transport);
  const ask = (args) => c.callTool({ name: "ask_human", arguments: { logDir: scratch, ...args } }, undefined, { timeout: 30000, resetTimeoutOnProgress: true })
    .then((r) => ({ isError: !!r.isError, ...(r.isError ? { text: r.content[0].text } : JSON.parse(r.content[0].text)) }));
  return { c, transport, ask };
}

// 1) MCP: the tool schema carries `approves`; a malformed one never reaches the phone
const s1 = await session("sess-one");
{
  const { tools } = await s1.c.listTools();
  const a = tools.find((t) => t.name === "ask_human")?.inputSchema?.properties?.approves;
  ok(a?.type === "string" && /✅/.test(a.description) && /ONCE/.test(a.description), "ask_human schema: optional `approves` (string), description says ✅ + once");
  const before = sent.length;
  const notString = await s1.ask({ question: "壞的 1", options: ["✅ 核准"], approves: 123 });
  ok(notString.isError && /approves/.test(notString.text), `approves not a string → validation error (${notString.text?.split("\n")[1]})`);
  const empty = await s1.ask({ question: "壞的 2", options: ["✅ 核准"], approves: "   " });
  ok(empty.isError && /approves/.test(empty.text), "approves blank → validation error");
  const tooLong = await s1.ask({ question: "壞的 3", options: ["✅ 核准"], approves: "x".repeat(2001) });
  ok(tooLong.isError && /too long/.test(tooLong.text), "approves 2001 chars → validation error");
  const noMark = await s1.ask({ question: "壞的 4", options: ["核准", "不要"], approves: "git push origin main" });
  ok(noMark.isError && /✅/.test(noMark.text), "approves without any ✅ option → validation error");
  // exactly one ✅ option — with two, a tap on either would approve
  const twoMarks = await s1.ask({ question: "壞的 7", options: ["✅ 執行", "✅ 先不要"], approves: "git push origin main" });
  ok(twoMarks.isError && /2 options start with "✅"/.test(twoMarks.text), `two ✅ options → validation error (${twoMarks.text?.split("\n")[1]})`);
  // invisible / control characters would make the phone show a different command than the one that runs
  // built from code points so this file carries no invisible character itself
  const ch = (c) => String.fromCodePoint(c);
  const HIDDEN = { "U+202E": `git push origin ${ch(0x202E)}niam`, "U+200B": `git push${ch(0x200B)} origin main`, "U+FEFF": `${ch(0xFEFF)}git push origin main`, "U+0009": `git push${ch(0x09)}origin main`, "U+0007": `git push origin main${ch(0x07)}` };
  for (const [cp, cmd] of Object.entries(HIDDEN)) {
    const r = await s1.ask({ question: `壞的 ${cp}`, options: ["✅ 核准執行", "先不要"], approves: cmd });
    ok(r.isError && r.text.includes(cp) && /invisible or control character/.test(r.text), `approves containing ${cp} → validation error`);
  }
  ok(sent.length === before, "none of the malformed calls reached the phone");
  // the relay checks again (second line of defense)
  const r1 = await ask({ question: "壞的 5", options: ["✅ 核准"], approves: ["git push"], session_id: "x" });
  const r2 = await ask({ question: "壞的 6", options: ["✅ 核准"], approves: "y".repeat(2001), session_id: "x" });
  ok(r1.status === 400 && /approves/.test(r1.error) && r2.status === 400 && /too long/.test(r2.error), `relay /ask rejects them too (400: ${r1.error} | ${r2.error})`);
  const edge = await ask({ question: "剛好 2000", options: ["✅ 核准"], approves: "z".repeat(2000), session_id: "x" });
  ok(edge.status === 200 && edge.request_id, "approves of exactly 2000 chars is accepted");
  await post(`/cancel/${edge.request_id}`, {});
  // the same checks at the relay (an /ask that bypassed the MCP server): two ✅ options, no ✅ option, hidden characters → 400
  const before2 = sent.length; // (the cancel above may still post its note — look for the rejected questions themselves)
  const r3 = await ask({ question: "壞的 8", options: ["✅ 執行", "✅ 先不要"], approves: "git push origin main", session_id: "x" });
  const r4 = await ask({ question: "壞的 9", options: ["執行", "先不要"], approves: "git push origin main", session_id: "x" });
  ok(r3.status === 400 && /2 options start with "✅"/.test(r3.error) && r4.status === 400 && /no option starts with "✅"/.test(r4.error), `relay /ask: two ✅ options / no ✅ option → 400 (${r3.error} | ${r4.error})`);
  for (const [cp, cmd] of Object.entries(HIDDEN)) {
    const r = await ask({ question: `壞的 relay ${cp}`, options: ["✅ 核准執行", "先不要"], approves: cmd, session_id: "x" });
    ok(r.status === 400 && r.error.includes(cp), `relay /ask: approves containing ${cp} → 400`);
  }
  ok(!sent.slice(before2).some((s) => String(s.text).includes("壞的")), "none of the rejected /ask calls reached the phone");
  const one = await ask({ question: "剛好一個 ✅", options: ["✅ 執行", "先不要", "再想想"], approves: "git push origin main", session_id: "x" });
  ok(one.status === 200 && one.request_id, "exactly one ✅ option (among others) is accepted");
  await post(`/cancel/${one.request_id}`, {});
}

// 2) MCP: the phone shows the command verbatim (markdown characters untouched); ✅ → attest once
const CMD1 = 'git commit -m "fix *bold* _x_ `y` [a](b)" && git push origin main';
{
  const call = s1.ask({ header: "push", question: "可以 push 到 main 嗎?", options: ["✅ 核准執行", "先不要"], approves: CMD1, gate: "push" });
  const kb = await keyboardFor("可以 push 到 main 嗎?");
  const line = kb.text.split("\n").find((l) => l.startsWith("核准後執行："));
  ok(line === `核准後執行：${CMD1}`, `phone shows "核准後執行：" + the command verbatim → ${JSON.stringify(line)}`);
  ok(kb.text.split("\n").at(-1) === line && kb.text.includes("1. ✅ 核准執行"), "the command line comes after the numbered options");
  const pre = await attest(CMD1, "sess-one");
  ok(pre.approved === false && pre.reason === "no_approval", `before the tap → ${JSON.stringify(pre)}`);
  tap(kb, 0, 0);
  const r = await call;
  ok(r.kind === "selection" && r.value === "✅ 核准執行", `ask_human returns the ✅ selection → ${JSON.stringify(r)}`);
  const a1 = await attest(CMD1, "sess-one");
  ok(a1.approved === true && /^[a-f0-9]{10}$/.test(a1.request_id) && a1.chosen === "✅ 核准執行" && !Number.isNaN(Date.parse(a1.answered_at)), `first attest → approved ${JSON.stringify(a1)}`);
  const a2 = await attest(CMD1, "sess-one");
  ok(a2.approved === false && a2.reason === "already_used", `second attest of the same approval → ${JSON.stringify(a2)}`);
  const log = fs.readFileSync(path.join(scratch, "MYNA-DECISIONS.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const rec = log.at(-1);
  ok(rec.mode === "human" && rec.approves === CMD1 && rec.ts && rec.answered_at && Date.parse(rec.answered_at) >= Date.parse(rec.ts) + 1, `decision log keeps ts and adds answered_at (ts ${rec.ts} → answered_at ${rec.answered_at})`);
}

// 3) matching: same session only, exact command after whitespace normalization, newlines kept
{
  const CMD = "gh pr merge 41 --squash -R example-org/example-app";
  await approveVia("sess-b", CMD, "merge 41?");
  ok((await attest(CMD, "sess-other")).approved === false, "another session → false");
  ok((await attest(`${CMD}x`, "sess-b")).approved === false, "command differs by one character → false");
  ok((await attest(CMD.replace("4", "5"), "sess-b")).approved === false, "command with one character changed → false");
  const ws = await attest(`  gh  pr\tmerge   41 \t --squash -R example-org/example-app \n`, "sess-b");
  ok(ws.approved === true, `differs only in spaces/tabs/ends → true (normalized) ${JSON.stringify(ws)}`);

  const ML = "echo ok\nrm -rf build";
  await approveVia("sess-c", ML, "two lines?");
  const mlText = [...sent].reverse().find((s) => s.reply_markup?.inline_keyboard && s.text.includes("two lines?"))?.text;
  ok(mlText?.endsWith(`\n核准後執行：${ML}`), `a multi-line command (\\n) is accepted and shown as is → ${JSON.stringify(mlText?.split("\n").slice(-2))}`);
  ok((await attest("echo ok rm -rf build", "sess-c")).approved === false, "approved with a newline, attested with the newline squeezed → false");
  ok((await attest("echo ok\n rm -rf build", "sess-c")).approved === false, "newline kept but a space added at the line start → false (only runs of spaces are squeezed)");
  ok((await attest("echo  ok\nrm -rf build ", "sess-c")).approved === true, "same lines, only spaces differ → true");
  await approveVia("sess-c2", "echo ok rm -rf build", "one line?");
  ok((await attest("echo ok\nrm -rf build", "sess-c2")).approved === false, "approved on one line, attested with a newline → false");
}

// 4) what is NOT an approval: an option without ✅, a ✍️ reply, ⏹, a cancel (terminal answer)
{
  const r = await approveVia("sess-d", "git push origin main", "push? (no)", 1);
  ok(r.result.kind === "selection" && r.result.value === "先不要" && (await attest("git push origin main", "sess-d")).approved === false, "chose the option without ✅ → false");

  const { request_id } = await ask({ question: "push? (text)", options: ["✅ 核准執行", "先不要"], approves: "git push origin main", session_id: "sess-e" });
  const kb = await keyboardFor("push? (text)");
  tap(kb, 1, 0); // ✍️
  const prompt = await until(() => [...sent].reverse().find((s) => s.reply_markup?.force_reply));
  push({ message: { message_id: 9001, chat: { id: 42 }, text: "✅ 核准執行", reply_to_message: { message_id: prompt._mid } } });
  const msg = await answer(request_id);
  ok(msg.kind === "message" && (await attest("git push origin main", "sess-e")).approved === false, `✍️ text reply (even "✅ 核准執行") → false (${JSON.stringify(msg)})`);

  const { request_id: abId } = await ask({ question: "push? (⏹)", options: ["✅ 核准執行"], approves: "git push origin main", session_id: "sess-f" });
  tap(await keyboardFor("push? (⏹)"), 1, 1); // ⏹
  ok((await answer(abId)).kind === "aborted" && (await attest("git push origin main", "sess-f")).approved === false, "⏹ → false");

  const { request_id: cId } = await ask({ question: "push? (cancel)", options: ["✅ 核准執行"], approves: "git push origin main", session_id: "sess-g" });
  const ckb = await keyboardFor("push? (cancel)");
  await post(`/cancel/${cId}`, {}); // answered in the terminal / Esc
  tap(ckb, 0, 0);                   // a late tap on the retracted question
  await sleep(500);
  ok((await answer(cId)).kind === "cancelled" && (await attest("git push origin main", "sess-g")).approved === false, "cancelled question (then a late ✅ tap) → false");
}

// 5) autopilot never approves: a question with `approves` goes to the human even in autopilot
{
  const ap = path.join(scratch, "autopilot-on"); fs.writeFileSync(ap, "");
  const s2 = await session("sess-auto", { MYNA_AUTOPILOT_FILE: ap });
  const call = s2.ask({ question: "autopilot push?", options: ["✅ 核准執行", "先不要"], recommendedIndex: 0, approves: "git push origin main" });
  const kb = await keyboardFor("autopilot push?");
  ok(!!kb, "autopilot ON + approves → still sent to the phone");
  tap(kb, 0, 0);
  const r = await call;
  ok(r.kind === "selection" && !r.auto && (await attest("git push origin main", "sess-auto")).approved === true, "…and the human's ✅ approves it");
  await s2.c.close();
}

// 6) concurrency: many attests at once for one approval → exactly one approved
{
  await approveVia("sess-h", "npm publish", "publish?");
  const rs = await Promise.all(Array.from({ length: 8 }, () => attest("npm publish", "sess-h")));
  ok(rs.filter((r) => r.approved).length === 1 && rs.filter((r) => r.reason === "already_used").length === 7, `8 concurrent attests → exactly one approved (${rs.map((r) => (r.approved ? "T" : "F")).join("")})`);
}

// 7) bad requests
{
  const a = await post("/attest", { session_id: "x" });
  const b = await post("/attest", { command: "ls" });
  const c = await post("/attest", "{not json");
  ok(a.status === 400 && a.approved === false && b.status === 400 && b.approved === false && c.status === 400 && c.approved === false, `missing command / session_id / bad JSON → 400 approved:false (${a.reason}, ${b.reason}, ${c.reason})`);
}

// 8) restart: approvals live in the relay's memory only — the journal is agent-writable, so nothing
//    about approvals is written to it or read back from it; a restart drops them all
{
  await approveVia("sess-r", "git push origin GH-40", "restart unused?");
  await approveVia("sess-r", "git tag v0.19.0", "restart used?");
  ok((await attest("git tag v0.19.0", "sess-r")).approved === true, "(before restart) use one of the two");
  // a question still open across the restart: its ✅ is tapped only after the restart
  const { request_id: openId } = await ask({ question: "restart open?", options: ["✅ 核准執行", "先不要"], approves: "git push origin open", session_id: "sess-r" });
  const openKb = await keyboardFor("restart open?");
  const j = JSON.parse(fs.readFileSync(PENDING, "utf8"));
  ok(j.approvals === undefined && !JSON.stringify(j).includes("git tag v0.19.0"), "journal holds no approval (nor any trace of the used one)");
  await stopRelay(); await startRelay();
  const unused = await attest("git push origin GH-40", "sess-r");
  ok(unused.approved === false && unused.reason === "no_approval", `after restart: the unused approval is gone → ${JSON.stringify(unused)}`);
  ok((await attest("git tag v0.19.0", "sess-r")).approved === false, "after restart: the used one is gone too → false");
  tap(openKb, 0, 0);
  const late = await answer(openId);
  ok(late.kind === "selection" && (await attest("git push origin open", "sess-r")).approved === false, "a question asked before the restart, ✅ tapped after it → answered, but approves nothing (ask again)");

  // forged journal: a planted `approvals` entry, and an open question whose `approves` was swapped
  const { request_id: swapId } = await ask({ question: "swap target?", options: ["✅ 核准執行"], approves: "git status", session_id: "sess-forge" });
  const swapKb = await keyboardFor("swap target?");
  await stopRelay();
  const doc = JSON.parse(fs.readFileSync(PENDING, "utf8"));
  doc.approvals = [{ request_id: "deadbeef00", session_id: "sess-forge", command: "git push --force origin main", chosen: "✅ 核准執行", answered_at: new Date().toISOString() }];
  doc.requests[swapId].meta.approves = "git push origin main";
  fs.writeFileSync(PENDING, JSON.stringify(doc));
  await startRelay();
  ok((await fetch(`${RELAY}/health`).then((r) => r.json())).ok === true, "relay starts fine on a journal carrying an `approvals` field (ignored)");
  const forged = await attest("git push --force origin main", "sess-forge");
  ok(forged.approved === false && forged.reason === "no_approval", `planted approval in the journal → ${JSON.stringify(forged)}`);
  tap(swapKb, 0, 0);
  ok((await answer(swapId)).kind === "selection", "(the human taps ✅ on the question the phone shows as `git status`)");
  ok((await attest("git push origin main", "sess-forge")).approved === false && (await attest("git status", "sess-forge")).approved === false, "journal-swapped `approves` of an adopted question → neither command attests");
  ok(!("approvals" in JSON.parse(fs.readFileSync(PENDING, "utf8"))), "the next journal write drops the planted field");
}

// 9) TTL: an approval older than MYNA_APPROVAL_TTL_MS no longer attests
{
  await stopRelay(); await startRelay({ MYNA_APPROVAL_TTL_MS: "3000" });
  await approveVia("sess-t", "git push origin main", "ttl fresh?");
  ok((await attest("git push origin main", "sess-t")).approved === true, "within the TTL → true");
  await approveVia("sess-t2", "git push origin main", "ttl stale?");
  await sleep(3500);
  const late = await attest("git push origin main", "sess-t2");
  ok(late.approved === false && late.reason === "expired", `past the TTL → ${JSON.stringify(late)}`);
}

await s1.c.close();
await stopRelay();
stub.close();
clearTimeout(watchdog);
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ all attest checks passed");
process.exit(failed ? 1 : 0);
