#!/usr/bin/env node
// Myna — PreToolUse hook on the built-in AskUserQuestion tool.
//
// Interception is ON BY DEFAULT: unless explicitly disabled (~/.myna/intercept first line = "off",
// via /myna:intercept off) AND the local relay is reachable, DENY the built-in AskUserQuestion and
// hand the model a ready-to-run list of Myna ask_human calls (→ the configured IM).
// This closes the gap in SPEC §2 Non-goals ("不攔截 built-in AskUserQuestion"): gates that were NOT
// routed through a patched workflow now still reach the phone.
//
// Gate-brief (ON by default, ~/.myna/brief): the hook can't manufacture rich per-option context —
// it only sees terse labels in tool_input — so it instructs the model to author a decision "brief"
// (context + pros/cons/when-to-pick/risks per option), render it via scripts/render-gate.mjs into a
// self-contained HTML page, publish it as an Artifact (one rolling URL per session, all questions of
// a batch on one page), and link that URL in the first ask_human `preamble`. The brief may also carry an
// optional Mermaid `diagram` (top-level and/or per question); render-gate.mjs draws it client-side. The IM then carries
// only the terse question + short option labels — the depth lives in the artifact.
//
// Hooks cannot return a synthetic tool result, so the only way to redirect is deny + instruct the
// model. A multi-question AskUserQuestion (1–4 questions) is split into one ask_human call per
// question, sharing one thread_id so they group into a single IM thread.
//
// Safety / fallback (mirrors ask_human's G5 — never hang, never wrong answer):
//   - interception disabled (flag=off) → emit nothing, exit 0 → local terminal picker.
//   - relay unreachable                → emit nothing, exit 0 → local picker fallback. This also
//     breaks the loop where ask_human returns {kind:'unreachable'} and the orchestrator falls back
//     to AskUserQuestion (relay is down → hook allows → picker runs → done). Un-configured installs
//     (no IM/relay) never have a reachable relay, so default-ON is a no-op for them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const FLAG = process.env.MYNA_INTERCEPT_FILE || path.join(os.homedir(), ".myna", "intercept");
const BRIEF_FLAG = process.env.MYNA_BRIEF_FILE || path.join(os.homedir(), ".myna", "brief");
const PORT = Number(process.env.RELAY_PORT || 7800);
const RELAY = process.env.MYNA_RELAY_URL || `http://127.0.0.1:${PORT}`;
const RENDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "render-gate.mjs");

// exit 0 with NO output → hook abstains → normal permission flow → local AskUserQuestion picker.
const allow = () => process.exit(0);

// a flag is ON by default; disabled only when its file's first line is exactly "off".
const flagDisabled = (file) => {
  try { return fs.existsSync(file) && fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim() === "off"; }
  catch { return false; }
};
// fast path: interception explicitly disabled → do nothing, don't even read stdin.
if (flagDisabled(FLAG)) allow();

async function readStdin() {
  const chunks = [];
  try { for await (const c of process.stdin) chunks.push(c); } catch { /* no stdin */ }
  return Buffer.concat(chunks).toString("utf8");
}

const input = await readStdin().then((s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } });
const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
if (questions.length === 0) allow();

// relay reachable? any response (even a 404 on "/") = up — same probe as ensure-relay.mjs.
// retry once with a roomier timeout: a momentarily busy relay must not force a silent fallback
// to the local picker (that path is the "IM got nothing" symptom).
const probe = () => fetch(`${RELAY}/`, { signal: AbortSignal.timeout(3000) }).then(() => true).catch(() => false);
const reachable = (await probe()) || (await probe());
if (!reachable) allow();

const briefOn = !flagDisabled(BRIEF_FLAG);
const label = (o) => (o && typeof o === "object" ? o.label : String(o));

// one shared thread_id groups a multi-question batch into a single IM thread.
const thread_id = questions.length > 1
  ? `askq-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`
  : undefined;

// one AskUserQuestion = one gate: every call carries the same `gate` so the IM groups them into one
// topic named after it (the question headers, else the first question's opening words); the next
// AskUserQuestion — a different gate — ends this topic and opens its own.
const headers = [...new Set(questions.map((q) => String(q.header || "").trim()).filter(Boolean))];
const gate = (headers.join(" / ") || String(questions[0].question || "").trim().slice(0, 30) || "AskUserQuestion").slice(0, 60);

// map each AskUserQuestion question → an ask_human argument object.
// brief ON → terse options (short label only; the depth is in the artifact).
// brief OFF → options carry the description too, since there is no artifact to hold it.
const calls = questions.map((q) => {
  const options = (q.options || []).map((o) =>
    briefOn ? label(o) : (o && typeof o === "object" && o.description ? `${o.label} — ${o.description}` : label(o)));
  const recommendedIndex = options.findIndex((s) => /\(recommended\)/i.test(s)); // -1 if none
  // relay renders single-select buttons; let multi-select be expressed via ✍️ free text.
  const question = q.multiSelect ? `${q.question}\n(可複選:點 ✍️ 輸入多個編號,例如 1,3)` : q.question;
  const call = { header: q.header, question, options, multiSelect: !!q.multiSelect, gate };
  if (recommendedIndex >= 0) call.recommendedIndex = recommendedIndex;
  if (thread_id) call.thread_id = thread_id;
  if (input.cwd) call.logDir = input.cwd; // decisions log into the run's cwd, like ask_human expects.
  return call;
});

const RESULTS = [
  "Each call returns a discriminated JSON result:",
  "- {kind:'selection', value} → that question is answered; go to the next.",
  "- {kind:'message', text} → the human sent free text (a clarifying question, or comma-separated numbers for a multi-select question). Respond to it: if it settles the answer use it, otherwise reply and call ask_human again with the SAME thread_id and gate, and your reply in `preamble`. Loop until you get a selection.",
  "- {kind:'aborted'} → the human cancelled; abort this run.",
  "- {kind:'unreachable'} → the relay went down; fall back to a normal AskUserQuestion (local picker) for the remaining questions.",
  "",
  "After every question has an answer, continue exactly as if AskUserQuestion had returned them (the Nth result answers the Nth question).",
];

let reason;
if (!briefOn) {
  reason = [
    "Myna async-gate interception is ON and the relay is reachable — this decision must be answered on the phone (via the configured IM), not the local picker.",
    "",
    "Do NOT use AskUserQuestion. Instead call the Myna ask_human MCP tool (its name ends with `__ask_human`) once per question below, IN ORDER, passing each argument object EXACTLY as given. Do not merge questions into one call.",
    "",
    "ask_human calls to make, in order:",
    JSON.stringify(calls, null, 2),
    "",
    ...RESULTS,
  ].join("\n");
} else {
  // per-session rolling paths: same session → same file → same Artifact URL (updates in place).
  const sid = String(input.session_id || "session").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "session";
  const base = path.join(os.tmpdir(), "myna-gates");
  try { fs.mkdirSync(base, { recursive: true }); } catch {}
  const jsonPath = path.join(base, `gate-${sid}.json`);
  const htmlPath = path.join(base, `gate-${sid}.html`);

  // skeleton for the model to fill: known fields seeded, rich fields blank.
  const firstHeader = questions[0].header ? String(questions[0].header) : "";
  const briefSkeleton = {
    title: questions.length === 1 && firstHeader ? `Myna gate — ${firstHeader}` : "Myna gate",
    questions: questions.map((q) => {
      const b = {
        header: q.header, question: q.question, context: "",
        options: (q.options || []).map((o) => ({ label: label(o), detail: "", pros: [], cons: [], when_to_pick: "", risks: "" })),
      };
      const ri = (q.options || []).findIndex((o) => /\(recommended\)/i.test(label(o)));
      if (ri >= 0) b.recommendedIndex = ri;
      return b;
    }),
  };

  reason = [
    "Myna async-gate interception + gate-brief are ON and the relay is reachable — this decision must be answered on the phone (via the configured IM). Do NOT use AskUserQuestion. First build a decision-support artifact, then ask via the Myna ask_human MCP tool (name ends with `__ask_human`). Steps, in order:",
    "",
    "STEP 1 — Author a decision brief. Take the skeleton below and, from your CURRENT reasoning, fill the blank rich fields for the question(s) and EACH option: `context` (why this decision matters), and per option `detail` (what it concretely is), `pros`, `cons`, `when_to_pick`, `risks`, plus optional `cost` / `reversibility` / `impact` / `example` when relevant. Make it genuinely useful for choosing — go well beyond the short labels. Keep option order and labels unchanged (they map to the IM button numbers).",
    "Optional diagram: when the decision sits inside a flow (a pipeline, a state machine, branching steps), you MAY add a Mermaid `diagram` string — top-level `diagram` = page overview shown under the header, per-question `diagram` = shown after that question's context. Use `flowchart TD`, at most ~15 nodes, label each decision node at the step where it actually happens (e.g. `F{決策 1：發版方式}`), one statement per line (JSON-escaped newlines inside the string). The diagram complements the prose — still fill every text field; never replace text with a diagram. Omit `diagram` (or leave it \"\") when a picture adds nothing; a diagram that fails to parse just shows its source.",
    "Write the completed JSON to this exact path:",
    `  ${jsonPath}`,
    "Skeleton to fill:",
    JSON.stringify(briefSkeleton, null, 2),
    "",
    "STEP 2 — Render it to HTML by running this command:",
    `  node "${RENDER}" "${jsonPath}" "${htmlPath}"`,
    "",
    `STEP 3 — Publish the HTML with the Artifact tool: file_path = ${htmlPath}, favicon 🐦, title "${briefSkeleton.title}". Reuse this EXACT file_path so it redeploys to the SAME URL for this session (one rolling page). Capture the returned artifact URL.`,
    "",
    "STEP 4 — Ask on the phone: call ask_human once per question, IN ORDER, with these terse args (options are short labels — the full context is in the artifact). Add to the FIRST call a `preamble` of `📄 詳細說明（每個選項的 context）：<artifact URL from step 3>` so the phone links to the brief.",
    JSON.stringify(calls, null, 2),
    "",
    "If you cannot render or publish the artifact for any reason, skip STEP 1–3 and just make the ask_human calls (fold the important context into each option label/preamble instead). Never block the gate on the artifact.",
    "",
    ...RESULTS,
  ].join("\n");
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
}));
process.exit(0);
