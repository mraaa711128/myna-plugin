#!/usr/bin/env node
// Smoke test for the AskUserQuestion interception hook (scripts/intercept-ask.mjs) + gate-brief +
// the render script (scripts/render-gate.mjs). No Telegram: a tiny HTTP stub stands in for the relay
// (any response = "up"). Verifies: disabled/relay-down → abstain; brief OFF → verbose options, no
// artifact steps; brief ON (default) → terse options + STEP 1–4 + skeleton; render-gate → HTML.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../scripts/intercept-ask.mjs", import.meta.url));
const RENDER = fileURLToPath(new URL("../scripts/render-gate.mjs", import.meta.url));
const scratch = path.join(os.tmpdir(), "myna-intercept-" + process.pid);
fs.mkdirSync(scratch, { recursive: true });
const FLAG = path.join(scratch, "intercept");     // intercept toggle
const BRIEF = path.join(scratch, "brief");        // gate-brief toggle
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };

const stub = http.createServer((req, res) => { res.writeHead(404); res.end("stub"); });
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const RELAY_UP = `http://127.0.0.1:${stub.address().port}`;
const RELAY_DOWN = "http://127.0.0.1:59999";

function runHook(payload, env) {
  return new Promise((resolve) => {
    const child = spawn("node", [HOOK], { env: { ...process.env, MYNA_INTERCEPT_FILE: FLAG, MYNA_BRIEF_FILE: BRIEF, ...env } });
    let out = ""; child.stdout.on("data", (d) => (out += d));
    child.stdin.on("error", () => {});
    child.on("close", () => resolve(out));
    try { child.stdin.end(JSON.stringify(payload)); } catch {}
  });
}
const reasonOf = (out) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
const between = (s, a, b) => { const i = s.indexOf(a) + a.length; return s.slice(i, s.indexOf(b, i)); };
const briefOff = () => fs.writeFileSync(BRIEF, `off\n${new Date().toISOString()}`);
const briefOn = () => { try { fs.rmSync(BRIEF); } catch {} };

const single = { cwd: scratch, session_id: "sess-ABC", tool_name: "AskUserQuestion", tool_input: { questions: [
  { header: "Auth", question: "Which auth?", multiSelect: false,
    options: [{ label: "OAuth (Recommended)", description: "open standard" }, { label: "JWT", description: "tokens" }] },
] } };
const multi = { cwd: scratch, session_id: "sess-XYZ", tool_name: "AskUserQuestion", tool_input: { questions: [
  { header: "Auth", question: "Which auth?", multiSelect: false, options: [{ label: "OAuth" }, { label: "JWT" }] },
  { header: "DB", question: "Which database?", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] },
] } };
const multiSel = { cwd: scratch, session_id: "s1", tool_name: "AskUserQuestion", tool_input: { questions: [
  { header: "Feat", question: "Enable which features?", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
] } };

// 1) intercept explicitly OFF → abstain
fs.writeFileSync(FLAG, `off\n${new Date().toISOString()}`);
ok((await runHook(single, { MYNA_RELAY_URL: RELAY_UP })) === "", "intercept flag=off → hook abstains");
try { fs.rmSync(FLAG); } catch {}   // intercept default ON for the rest

// 2) relay DOWN → abstain (fallback + loop-break)
ok((await runHook(single, { MYNA_RELAY_URL: RELAY_DOWN })) === "", "relay down → hook abstains (fallback)");

// ---- brief OFF: verbose options, no artifact steps ----
briefOff();
{
  const reason = reasonOf(await runHook(single, { MYNA_RELAY_URL: RELAY_UP }));
  const calls = JSON.parse(between(reason, "in order:\n", "\n\nEach call returns"));
  ok(!reason.includes("STEP 1"), "brief off: no artifact steps in reason");
  ok(calls[0].options[0] === "OAuth (Recommended) — open standard", `brief off: verbose option → ${calls[0].options[0]}`);
  ok(calls[0].recommendedIndex === 0, "brief off: recommendedIndex parsed");
}
{
  const reason = reasonOf(await runHook(multi, { MYNA_RELAY_URL: RELAY_UP }));
  const calls = JSON.parse(between(reason, "in order:\n", "\n\nEach call returns"));
  ok(calls.length === 2 && calls[0].thread_id && calls[0].thread_id === calls[1].thread_id, "brief off: multi shares one thread_id");
  ok(calls[0].gate === "Auth / DB" && calls[1].gate === calls[0].gate, `one AskUserQuestion = one gate (named after the headers) → ${JSON.stringify(calls[0].gate)}`);
}

// ---- brief ON (default): terse options + STEP 1–4 + skeleton ----
briefOn();
{
  const reason = reasonOf(await runHook(single, { MYNA_RELAY_URL: RELAY_UP }));
  ok(reason.includes("STEP 1") && reason.includes("STEP 4"), "brief on: reason has STEP 1..4");
  ok(reason.includes("render-gate.mjs"), "brief on: reason invokes render-gate.mjs");
  ok(/Mermaid `diagram`/.test(reason) && reason.includes("flowchart TD") && /never replace text/.test(reason),
    "brief on: reason documents the optional Mermaid diagram (flowchart TD, prose stays)");
  ok(/gate-sess-ABC\.(json|html)/.test(reason), "brief on: per-session path keyed by session_id");
  const skeleton = JSON.parse(between(reason, "Skeleton to fill:\n", "\n\nSTEP 2"));
  ok(skeleton.questions.length === 1, "brief on: skeleton has the question");
  ok(skeleton.questions[0].options[0].label === "OAuth (Recommended)", "brief on: skeleton seeds option label");
  ok(skeleton.questions[0].options[0].pros.length === 0 && skeleton.questions[0].context === "", "brief on: rich fields left blank for the model");
  ok(skeleton.questions[0].recommendedIndex === 0, "brief on: skeleton recommendedIndex seeded");
  const calls = JSON.parse(between(reason, "links to the brief.\n", "\n\nIf you cannot"));
  ok(calls[0].options[0] === "OAuth (Recommended)", `brief on: terse option (no description) → ${calls[0].options[0]}`);
  ok(calls[0].gate === "Auth", `brief on: single question → gate "${calls[0].gate}"`);
}
{
  const reason = reasonOf(await runHook(multi, { MYNA_RELAY_URL: RELAY_UP }));
  const skeleton = JSON.parse(between(reason, "Skeleton to fill:\n", "\n\nSTEP 2"));
  ok(skeleton.questions.length === 2 && skeleton.title === "Myna gate", "brief on: multi-question batch → one skeleton, generic title");
  const calls = JSON.parse(between(reason, "links to the brief.\n", "\n\nIf you cannot"));
  ok(calls.length === 2 && calls[0].thread_id === calls[1].thread_id, "brief on: multi shares one thread_id");
}
{
  const reason = reasonOf(await runHook(multiSel, { MYNA_RELAY_URL: RELAY_UP }));
  const calls = JSON.parse(between(reason, "links to the brief.\n", "\n\nIf you cannot"));
  const skeleton = JSON.parse(between(reason, "Skeleton to fill:\n", "\n\nSTEP 2"));
  ok(calls[0].multiSelect === true && /可複選/.test(calls[0].question), "brief on: multiSelect flag + Telegram hint on the call");
  ok(!/可複選/.test(skeleton.questions[0].question), "brief on: skeleton question stays clean (no Telegram hint)");
}

// ---- render-gate.mjs turns a brief into HTML ----
{
  const jf = path.join(scratch, "b.json"), hf = path.join(scratch, "b.html");
  fs.writeFileSync(jf, JSON.stringify({ title: "T", questions: [
    { header: "Auth", question: "Q?", context: "why", recommendedIndex: 0, options: [
      { label: "OAuth", detail: "d", pros: ["p1"], cons: ["c1"], when_to_pick: "w", risks: "r", cost: "中" },
      { label: "JWT", detail: "d2" }] }] }));
  const r = spawn("node", [RENDER, jf, hf]);
  await new Promise((res) => r.on("close", res));
  const html = fs.existsSync(hf) ? fs.readFileSync(hf, "utf8") : "";
  ok(html.startsWith("<title>"), "render: body-level output starts with <title>");
  ok(html.includes("OAuth") && html.includes("建議") && html.includes("何時選它") && html.includes("prefers-color-scheme"),
    "render: HTML has options, recommended badge, fields, theme CSS");
}

stub.close();
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ SMOKE (intercept + brief + render) PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
