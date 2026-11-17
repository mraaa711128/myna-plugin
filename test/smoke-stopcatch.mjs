#!/usr/bin/env node
// Smoke test for the stop-catch Stop hook (scripts/stop-catch-question.mjs).
// No Telegram: an HTTP stub stands in for the relay; fake transcripts stand in for sessions.
// Verifies: plain-text question ending + relay up → block; stop_hook_active / non-question /
// tool_use ending / flag off / relay down → allow (empty output). Round end: every allow path
// POSTs /session/round-end {session_id} (the gate's topic can go); the block path does not.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../scripts/stop-catch-question.mjs", import.meta.url));
const scratch = path.join(os.tmpdir(), "myna-stopcatch-" + process.pid);
fs.mkdirSync(scratch, { recursive: true });
const FLAG = path.join(scratch, "stopcatch");
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };

const roundEnds = []; // session ids the hook reported as "reply finished"
const stub = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/session/round-end") {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { try { roundEnds.push(JSON.parse(b).session_id); } catch {} res.writeHead(200); res.end("{}"); });
    return;
  }
  // a session registered as a chatbot (relay /chat/session); everything else answers 404, like a relay
  // too old to know the endpoint
  if (req.method === "GET" && req.url.startsWith("/chat/session?")) {
    const sid = new URL(req.url, "http://x").searchParams.get("session_id");
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ chat: sid === "sid-chat" }));
    return;
  }
  res.writeHead(404); res.end("stub");
});
const roundEnded = (sid) => roundEnds.includes(sid);
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const RELAY_UP = `http://127.0.0.1:${stub.address().port}`;
const RELAY_DOWN = "http://127.0.0.1:59999";

function transcript(name, contentItems) {
  const p = path.join(scratch, name + ".jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "做點事" }] } }),
    JSON.stringify({ type: "assistant", message: { content: contentItems } }),
  ];
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function runHook(payload, env) {
  return new Promise((resolve) => {
    const child = spawn("node", [HOOK], { env: { ...process.env, MYNA_STOPCATCH_FILE: FLAG, ...env } });
    let out = ""; child.stdout.on("data", (d) => (out += d));
    child.stdin.on("error", () => {});
    child.on("close", () => resolve(out));
    try { child.stdin.end(JSON.stringify(payload)); } catch {}
  });
}

const Q_END = [{ type: "text", text: "都收好了。要不要我順手把 PROJ-1670 archive→Done?或直接接著開 Dashboard(PROJ-1675)?" }];
const REPORT_END = [{ type: "text", text: "全部完成:build 綠、tests 3192 pass、PR #276 已 merge。" }];
const TOOL_END = [{ type: "text", text: "接著跑 build。" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }];

// 1) question ending + relay up → block with ask_human instructions
let out = await runHook({ session_id: "sid-1", transcript_path: transcript("q", Q_END) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), "plain-text question ending + relay up → block");
ok(out.includes("ask_human"), "block reason instructs ask_human routing");
ok(!roundEnded("sid-1"), "block → no round-end (the reply goes on, the gate is still live)");

// 1b) a chat session: its reply already goes to the phone and the human writes back in its topic →
//     no bounce, and the reply ends (round end)
out = await runHook({ session_id: "sid-chat", transcript_path: transcript("qc", Q_END) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "" && roundEnded("sid-chat"), "chat session ending on a question → allow (no bounce), round-end sent");

// 2) stop_hook_active → allow (never loop)
out = await runHook({ session_id: "sid-2", transcript_path: transcript("q2", Q_END), stop_hook_active: true }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "", "stop_hook_active → allow (no loop)");
ok(roundEnded("sid-2"), "…and the reply really ends → round-end sent");

// 3) report-only ending → allow
out = await runHook({ session_id: "sid-3", transcript_path: transcript("r", REPORT_END) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "", "report-only ending → allow");
ok(roundEnded("sid-3"), "report-only ending → round-end sent with the session id");

// 4) ends on tool_use → allow
out = await runHook({ transcript_path: transcript("t", TOOL_END) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "", "tool_use ending → allow");

// 5) relay down → allow (terminal IS the channel)
out = await runHook({ transcript_path: transcript("q3", Q_END) }, { MYNA_RELAY_URL: RELAY_DOWN });
ok(out === "", "relay down → allow");

// 6) flag off → allow
fs.writeFileSync(FLAG, "off\n");
out = await runHook({ session_id: "sid-4", transcript_path: transcript("q4", Q_END) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "", "flag off → allow");
ok(roundEnded("sid-4"), "stopcatch off still reports round-end (topic cleanup is independent)");
fs.rmSync(FLAG);

// 7) English direct-address question → block
const EN_END = [{ type: "text", text: "Both fixes are in. Should I open the PR now, or do you want another review pass?" }];
out = await runHook({ transcript_path: transcript("en", EN_END) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), "English question ending → block");

// 9) background work launched AFTER the last ask_human and still running → the AI ended its reply
//    only to wait for it (it is woken by the task-notification and may ask the same gate again) →
//    no round-end. Once the work's terminal notification is in, the next stop reports it.
const lines = (name, entries) => { const p = path.join(scratch, name + ".jsonl"); fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n"); return p; };
const A = (content) => ({ type: "assistant", message: { content } });
const U = (content) => ({ type: "user", message: { content } });
const ASK = [A([{ type: "tool_use", id: "toolu_ask", name: "mcp__plugin_myna_myna__ask_human", input: { question: "q", options: ["a"], gate: "G1" } }]),
  U([{ type: "tool_result", tool_use_id: "toolu_ask", content: [{ type: "text", text: '{"kind":"selection","value":"a"}' }] }])];
const BG = [A([{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "sleep 20", run_in_background: true } }]),
  U([{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: b35lvc8z3. Output is being written to: /tmp/x" }])];
const DONE = [U("<task-notification>\n<task-id>b35lvc8z3</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>")];
const WAIT_END = [A([{ type: "text", text: "sleep 在背景跑,跑完我再問第二題。" }])];

out = await runHook({ session_id: "sid-bg1", transcript_path: lines("bg1", [...ASK, ...BG, ...WAIT_END]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "" && !roundEnded("sid-bg1"), "background work started after the last ask_human, still running → no round-end");
out = await runHook({ session_id: "sid-bg2", transcript_path: lines("bg2", [...ASK, ...BG, ...WAIT_END, ...DONE, A([{ type: "text", text: "兩題都答完了。" }])]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "" && roundEnded("sid-bg2"), "…its completion notification is in → round-end sent");
out = await runHook({ session_id: "sid-bg3", transcript_path: lines("bg3", [...BG, ...ASK, ...WAIT_END]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(roundEnded("sid-bg3"), "background work started BEFORE the last ask_human (e.g. a dev server) → doesn't hold the round-end");
const AGENT = [A([{ type: "tool_use", id: "toolu_ag", name: "Agent", input: { prompt: "x" } }]),
  U([{ type: "tool_result", tool_use_id: "toolu_ag", content: [{ type: "text", text: "Async agent launched successfully. agentId: a123" }] }])];
out = await runHook({ session_id: "sid-bg4", transcript_path: lines("bg4", [...ASK, ...AGENT, ...WAIT_END]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(!roundEnded("sid-bg4"), "async subagent launched after the question, not finished → no round-end");

// 10) false positives (found in code review): ordinary tool output that merely CONTAINS launch-like
//     text (reading this very script, a log, a README) is not background work, and a rejected
//     background launch (is_error) never started — neither may hold the round-end forever.
const READ_LAUNCH_TEXT = [A([{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/x/stop-catch-question.mjs" } }]),
  U([{ type: "tool_result", tool_use_id: "toolu_read", content: "const BG_LAUNCH = /running in background|Async agent launched|Monitor started/i;" }])];
out = await runHook({ session_id: "sid-fp1", transcript_path: lines("fp1", [...ASK, ...READ_LAUNCH_TEXT, ...WAIT_END]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(roundEnded("sid-fp1"), "a synchronous tool's output that merely mentions 'running in background' / 'Monitor started' → still round-end");
const SH_ECHO = [A([{ type: "tool_use", id: "toolu_sh", name: "Bash", input: { command: "tail relay.log" } }]),
  U([{ type: "tool_result", tool_use_id: "toolu_sh", content: "Command running in background with ID: zz (old log line)" }])];
out = await runHook({ session_id: "sid-fp2", transcript_path: lines("fp2", [...ASK, ...SH_ECHO, ...WAIT_END]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(roundEnded("sid-fp2"), "a foreground Bash whose output echoes a launch line → still round-end");
const BG_REJECTED = [A([{ type: "tool_use", id: "toolu_rej", name: "Bash", input: { command: "sleep 20", run_in_background: true } }]),
  U([{ type: "tool_result", tool_use_id: "toolu_rej", is_error: true, content: "Permission to use Bash has been denied." }])];
out = await runHook({ session_id: "sid-fp3", transcript_path: lines("fp3", [...ASK, ...BG_REJECTED, ...WAIT_END]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(roundEnded("sid-fp3"), "a rejected background launch (is_error) never ran → round-end");

// 11) full-width question mark (what models usually write in Chinese) → block. Built from the code
//     point so this test cannot be normalized into its half-width twin (that is how the hook's own
//     character class once ended up as [??]).
const FQ = String.fromCodePoint(0xff1f);
out = await runHook({ transcript_path: transcript("fw", [{ type: "text", text: `都收好了。要不要我順手把 PROJ-1670 archive→Done${FQ}` }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), "full-width question mark ending → block");
out = await runHook({ transcript_path: transcript("fw2", [{ type: "text", text: `改好了,這個方向對嗎${FQ}` }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), "嗎 + full-width question mark as the only cue → block");

// 12) headless (`claude -p`): when Stop fires the turn's last message is not in the transcript yet —
//     the hook input carries it as last_assistant_message, and that is what gets judged.
const NO_ASSISTANT_YET = lines("headless", [U([{ type: "text", text: "做點事" }])]);
out = await runHook({ session_id: "sid-h1", transcript_path: NO_ASSISTANT_YET, last_assistant_message: `你想要圓形還是方形${FQ}` }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"') && !roundEnded("sid-h1"), "last_assistant_message is a question, transcript has no assistant entry yet → block, no round-end");
out = await runHook({ session_id: "sid-h2", transcript_path: NO_ASSISTANT_YET, last_assistant_message: "全部完成:build 綠、PR 已 merge。" }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "" && roundEnded("sid-h2"), "last_assistant_message is a report → allow, round-end sent");
out = await runHook({ last_assistant_message: "Both fixes are in. Should I open the PR now?" }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), "last_assistant_message alone (no transcript_path) → still judged");

// 13) a choice put as a question is addressed to the user even without a direct-address cue
out = await runHook({ transcript_path: transcript("ch1", [{ type: "text", text: "Which should the project logo be: a **Circle** or a **Square**?" }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), '"Which … A or B?" → block');
out = await runHook({ transcript_path: transcript("ch2", [{ type: "text", text: `專案 logo 要用圓形還是方形${FQ}` }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), '"A 還是 B?" → block');

// 14) the question may be followed by a short "I'll wait for your answer" remark — nothing else
out = await runHook({ transcript_path: transcript("w1", [{ type: "text", text: `請問專案 logo 要用**圓形**還是**方形**${FQ}\n\n我會等你回答後,再依照你的指示只回覆一行 \`FINAL: <你的選擇>\`。` }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), "question + 「我會等你回答…」 → block");
out = await runHook({ transcript_path: transcript("w2", [{ type: "text", text: "Which logo color should the project use: **Red** or **Blue**?  I'll wait for your answer, then reply with `FINAL: <your choice>`." }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out.includes('"block"'), `question + "I'll wait for your answer…" → block`);
out = await runHook({ transcript_path: transcript("w3", [{ type: "text", text: "還有哪個沒測到的?沒有了,全部覆蓋,PR 已開。" }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "", "a question the reply goes on to answer itself → allow");
out = await runHook({ transcript_path: transcript("w4", [{ type: "text", text: "修好了。為什麼之前會壞?" }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "", "question ending with no cue and no choice → allow");
out = await runHook({ transcript_path: transcript("w5", [{ type: "text", text: "報告在 https://example.com/r?id=3 ,等你有空再看。" }]) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "", 'a "?" inside a URL is not a question → allow');

// 8) no session id in the hook input → nothing to report
const n = roundEnds.length;
out = await runHook({ transcript_path: transcript("r2", REPORT_END) }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "" && roundEnds.length === n, "no session_id → allow, no round-end call");

// 15) --host codex (codex/hooks.json, PR 2): the same decisions, the block worded for Codex (no
//     AskUserQuestion, no mcp__ name); a Codex transcript (not Claude's format) → round-end still sent
function runCodex(payload, env) {
  return new Promise((resolve) => {
    const child = spawn("node", [HOOK, "--host", "codex"], { env: { ...process.env, MYNA_STOPCATCH_FILE: FLAG, ...env } });
    let out = ""; child.stdout.on("data", (d) => (out += d));
    child.stdin.on("error", () => {});
    child.on("close", () => resolve(out));
    try { child.stdin.end(JSON.stringify(payload)); } catch {}
  });
}
out = await runCodex({ session_id: "cx-1", last_assistant_message: "Both fixes are in. Should I open the PR now?", stop_hook_active: false }, { MYNA_RELAY_URL: RELAY_UP });
let blk = null; try { blk = JSON.parse(out); } catch {}
ok(blk?.decision === "block" && /ask_human/.test(blk.reason) && !/AskUserQuestion|mcp__myna__/.test(blk.reason) && !roundEnded("cx-1"), "--host codex question ending → block, the reason names ask_human but no AskUserQuestion / mcp__ name; no round-end");
const codexTranscript = path.join(scratch, "codex-rollout.jsonl");
fs.writeFileSync(codexTranscript, [
  { timestamp: "2026-11-13T00:00:00Z", type: "session_meta", payload: { id: "cx-2" } },
  { timestamp: "2026-11-13T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "mcp__myna__ask_human", arguments: "{}" } },
  { timestamp: "2026-11-13T00:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "全部完成。" }] } },
].map((e) => JSON.stringify(e)).join("\n") + "\n");
out = await runCodex({ session_id: "cx-2", transcript_path: codexTranscript, last_assistant_message: "全部完成。", stop_hook_active: false }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "" && roundEnded("cx-2"), "--host codex, a Codex-format transcript, a report ending → allow, round-end sent");
out = await runCodex({ session_id: "cx-3", transcript_path: codexTranscript, last_assistant_message: "Should I deploy Alpha or Beta?", stop_hook_active: true }, { MYNA_RELAY_URL: RELAY_UP });
ok(out === "" && roundEnded("cx-3"), "--host codex, stop_hook_active → allow (no loop), round-end sent");

stub.close();
process.exit(failed ? 1 : 0);
