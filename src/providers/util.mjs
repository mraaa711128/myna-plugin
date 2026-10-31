// Shared bits for IM providers. Every provider renders the SAME numbered body
// (options listed in the text, buttons carry only the number) so the phone UX is
// identical no matter which IM carries the gate.
import crypto from "node:crypto";

// questionNumber/questionTotal: the caller's "question x of y" for related questions asked together —
// shown only when both are given. approves: the one command a ✅ option lets run, shown
// verbatim as the last line — callers must pass it raw (never through markdown → plain conversion).
export function questionLines({ header, question, options = [], questionNumber, questionTotal, approves } = {}) {
  const lines = [];
  if (questionNumber && questionTotal) lines.push(`第 ${questionNumber}/${questionTotal} 題`);
  if (header) lines.push(`[${header}]`);
  lines.push(question || "(no question)");
  options.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
  if (typeof approves === "string" && approves) lines.push(`${APPROVES_LABEL}${approves}`);
  return lines;
}
export const APPROVES_LABEL = "核准後執行：";

// Approval attestation: an ask_human carrying `approves` (the exact command to run once
// approved) records an approval at the relay when the human taps an option starting with ✅.
export const APPROVES_MAX = 2000;
export const APPROVE_MARK = "✅";
export const isApproveOption = (v) => typeof v === "string" && v.startsWith(APPROVE_MARK);
// The ONE option that approves — exactly one option may start with ✅ (with two, e.g. "✅ 執行" and
// "✅ 先不要", a tap on either would approve). undefined when there is none or more than one.
export function approveOptionOf(options) {
  const marked = Array.isArray(options) ? options.filter(isApproveOption) : [];
  return marked.length === 1 ? marked[0] : undefined;
}
// Characters that would make the command on the phone read differently from the one that runs:
// C0 controls except \n (a tab cannot be told from spaces on a phone; \r can hide what precedes it),
// DEL + C1, zero-width / bidi marks (U+200B-U+200F), bidi embeddings and overrides (U+202A-U+202E),
// word joiner + invisible operators + bidi isolates (U+2060-U+2069), BOM / zero-width no-break space
// (U+FEFF); also soft hyphen, Arabic letter mark, Mongolian vowel separator, line/paragraph separator
// and the invisible tag characters (U+E0000-U+E007F). Code point ranges (inclusive) rather than a regex
// literal, so the source itself never carries an invisible character.
export const APPROVES_HIDDEN_RANGES = [
  [0x0000, 0x0009], [0x000B, 0x001F], [0x007F, 0x009F], [0x00AD, 0x00AD], [0x061C, 0x061C], [0x180E, 0x180E],
  [0x200B, 0x200F], [0x2028, 0x2029], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF], [0xE0000, 0xE007F],
];
// the first such character of s as { cp: "U+202E", index } (index in UTF-16 units), or null
export function hiddenCharIn(s) {
  let index = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (APPROVES_HIDDEN_RANGES.some(([lo, hi]) => c >= lo && c <= hi)) return { cp: `U+${c.toString(16).toUpperCase().padStart(4, "0")}`, index };
    index += ch.length;
  }
  return null;
}
// the only normalization a command gets before comparing: trim the ends, squeeze runs of spaces/tabs
// into one space. Newlines are kept — in a shell a newline separates commands.
export const normalizeCommand = (s) => String(s).trim().replace(/[ \t]+/g, " ");

// short opaque callback token — full state lives server-side (token -> {request_id, kind, value})
export const newToken = () => crypto.randomBytes(4).toString("hex");

// one line of text, at most n chars (chat progress lines: a long command must not flood the message)
export const oneLine = (s, n = 160) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
// an error for the log, with what lies under it: fetch() only says "fetch failed" — the reason
// (ETIMEDOUT, ENETUNREACH, ECONNREFUSED…; with Happy Eyeballs one error per address tried) is in
// err.cause (without it, a relay that cannot reach Telegram logs nothing but "fetch failed", for hours)
export function errText(e) {
  if (e == null || typeof e !== "object") return String(e);
  const msg = e.message || String(e);
  const c = e.cause;
  if (c == null) return msg;
  if (typeof c !== "object") return `${msg} (cause: ${c})`;
  const cm = c.message || "";
  const head = c.code && !cm.includes(c.code) ? [c.code, cm].filter(Boolean).join(" ") : cm || String(c);
  const subs = Array.isArray(c.errors) ? [...new Set(c.errors.map((x) => x?.message || String(x)).filter((s) => s && s !== cm))] : [];
  return `${msg} (cause: ${[head, ...subs].filter(Boolean).join("; ")})`;
}
// chat progress: one tool call as a line — the tool and what it acts on (paths relative to the session's cwd)
export function toolLine(name, input = {}, cwd = "") {
  const tool = String(name || "?").startsWith("mcp__") ? String(name).split("__").slice(2).join("__") || name : String(name || "?");
  const rel = (p) => { p = String(p ?? ""); return cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p; };
  const i = input && typeof input === "object" ? input : {};
  let what;
  if (tool === "Bash" || tool === "PowerShell") what = i.command;
  else if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) what = rel(i.file_path || i.notebook_path);
  else if (tool === "Grep" || tool === "Glob") what = [i.pattern, i.path && rel(i.path)].filter(Boolean).join(" in ");
  else if (tool === "WebFetch") what = i.url;
  else if (tool === "WebSearch") what = i.query;
  else if (tool === "Agent" || tool === "Task") what = i.description || i.subagent_type;
  else if (tool === "Skill") what = i.skill;
  else if (tool === "TodoWrite") what = Array.isArray(i.todos) ? `${i.todos.length} 項` : "";
  // a question to the human shows up in full right below — only name it here
  else if (tool === "ask_human") what = i.header || i.gate || "";
  else if (tool === "AskUserQuestion") {
    const qs = Array.isArray(i.questions) ? i.questions : [];
    what = qs.map((q) => q?.header).filter(Boolean).join(" / ") || (qs.length ? `${qs.length} 題` : "");
  }
  else { const j = JSON.stringify(i); what = j === "{}" ? "" : j; }
  what = oneLine(what, 160);
  return `🔧 ${tool}${what ? `: ${what}` : ""}`;
}

// Shared argument validation for ask_human (MCP side) and the relay's POST /ask.
// The model occasionally emits malformed tool-call markup (wrong closing tag / dropped namespace
// prefix), which absorbs the whole `options` JSON into the `question` string — the phone then
// shows a menu with NO buttons and raw <tag> residue in the body, and the human can only answer
// via ✍️ free text. Reject loudly so the caller re-issues a clean call instead of silently
// shipping a broken menu (observed: relay.log "sent question … (0 options)" streaks).
// tag vocabulary seen (or plausible) in mangled calls: </question>, <parameter name="options">,
// <option>/<options> pseudo-markup, antml namespace fragments, <invoke>/<function> wrappers.
const MARKUP_RESIDUE = /<\/?(?:question|parameter\b|antml|invoke\b|function|options?\b)/i;
export function validateAskArgs(a = {}) {
  const problems = [];
  if (typeof a.question !== "string" || !a.question.trim()) {
    problems.push("`question` must be a non-empty string");
  }
  if (!Array.isArray(a.options) || a.options.length === 0) {
    problems.push("`options` is missing or empty — the choices MUST be a structured JSON array of short label strings; never embed them as text/markup inside `question`");
  } else if (a.options.some((o) => typeof o !== "string" || !o.trim())) {
    problems.push("every `options` entry must be a non-empty string");
  }
  for (const k of ["questionNumber", "questionTotal"]) {
    if (a[k] !== undefined && !(Number.isInteger(a[k]) && a[k] >= 1)) problems.push(`\`${k}\` must be a positive integer`);
  }
  if (Number.isInteger(a.questionNumber) && Number.isInteger(a.questionTotal) && a.questionNumber > a.questionTotal) {
    problems.push("`questionNumber` cannot be larger than `questionTotal`");
  }
  if (a.approves !== undefined) {
    if (typeof a.approves !== "string" || !a.approves.trim()) {
      problems.push("`approves` must be a non-empty string — the one full command line a ✅ option approves");
    } else {
      if (a.approves.length > APPROVES_MAX) {
        problems.push(`\`approves\` is too long (${a.approves.length} chars, max ${APPROVES_MAX})`);
      }
      const hidden = hiddenCharIn(a.approves);
      if (hidden) {
        problems.push(`\`approves\` contains an invisible or control character (${hidden.cp} at index ${hidden.index}) — the phone would show a command different from the one that runs; only printable characters and \\n are allowed (no tabs)`);
      }
      const marked = Array.isArray(a.options) ? a.options.filter(isApproveOption).length : 0;
      if (Array.isArray(a.options) && marked === 0) {
        problems.push(`\`approves\` is set but no option starts with "${APPROVE_MARK}" — exactly one option (the approving one) must start with ${APPROVE_MARK}, otherwise the human cannot approve the command`);
      } else if (marked > 1) {
        problems.push(`\`approves\` is set but ${marked} options start with "${APPROVE_MARK}" — exactly one option (the approving one) may start with ${APPROVE_MARK}, otherwise every one of them would approve the command`);
      }
    }
  }
  const fields = { question: a.question, preamble: a.preamble };
  if (Array.isArray(a.options)) a.options.forEach((o, i) => (fields[`options[${i}]`] = o));
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" && MARKUP_RESIDUE.test(v)) {
      problems.push(`\`${k}\` contains tool-call markup residue (e.g. </question>, <parameter …>) — this call's parameters were serialized wrong`);
    }
  }
  return problems;
}
