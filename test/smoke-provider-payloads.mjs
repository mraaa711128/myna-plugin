#!/usr/bin/env node
// Autonomous checks of the Discord/Slack providers' pure payload builders + interaction parsers
// (no network, no WebSocket). The wire loops are thin and mirror the Telegram provider; the shape
// logic tested here is where regressions would actually bite (button/token wiring, modal parsing).
import { questionLines, toolLine } from "../src/providers/util.mjs";
import * as discord from "../src/providers/discord.mjs";
import * as slack from "../src/providers/slack.mjs";

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const mkReg = () => { const reg = (kind, value) => { const tk = `tk${reg.all.length}`; reg.all.push({ tk, kind, value }); return tk; }; reg.all = []; return reg; };

// --- shared body ---------------------------------------------------------------
const lines = questionLines({ header: "AC scope", question: "要包含 X 嗎?", options: ["要", "不要"] });
ok(lines.join("\n") === "[AC scope]\n要包含 X 嗎?\n1. 要\n2. 不要", "questionLines renders header + numbered options");

// --- chat progress lines: a question to the human is only named (it shows in full right below) ----
{
  const ask = toolLine("mcp__plugin_myna_myna__ask_human", { header: "murmur on/off", question: "改成 on/off 後…", options: ["a", "b"], gate: "murmur 參數" });
  ok(ask === "🔧 ask_human: murmur on/off", `ask_human → header only: ${JSON.stringify(ask)}`);
  ok(toolLine("mcp__plugin_myna_myna__ask_human", { question: "q", options: ["a"], gate: "G" }) === "🔧 ask_human: G", "ask_human without a header → the gate");
  const auq = toolLine("AskUserQuestion", { questions: [{ header: "範圍", question: "q1", options: [] }, { header: "預設", question: "q2", options: [] }] });
  ok(auq === "🔧 AskUserQuestion: 範圍 / 預設", `AskUserQuestion → headers only: ${JSON.stringify(auq)}`);
  ok(toolLine("AskUserQuestion", { questions: [0, 0, 0] }) === "🔧 AskUserQuestion: 3 題", "AskUserQuestion slimmed by the mod → the count");
  ok(toolLine("mcp__x__other", { a: 1 }) === '🔧 other: {"a":1}', "other MCP tools still show their input");
}

// --- discord -------------------------------------------------------------------
{
  const reg = mkReg();
  const seven = ["a", "b", "c", "d", "e", "f", "g"];
  const msg = discord.buildQuestion({ header: "h", question: "q", options: seven }, reg);
  ok(msg.content.includes("7. g"), "discord: all options numbered in content");
  ok(msg.components.length === 3 && msg.components[0].components.length === 5 && msg.components[1].components.length === 2,
    "discord: 7 options chunk into rows of ≤5 + control row");
  const btns = msg.components.flatMap((r) => r.components);
  const sel = reg.all.filter((t) => t.kind === "selection");
  ok(sel.length === 7 && sel.every((t, i) => t.value === seven[i] && btns.some((b) => b.custom_id === t.tk)),
    "discord: every numbered button carries its registered selection token");
  ok(reg.all.some((t) => t.kind === "ask") && reg.all.some((t) => t.kind === "abort"), "discord: ✍️ + ⏹ tokens registered");

  ok(discord.askModal("MT").custom_id === "MT", "discord: modal round-trips the token via custom_id");
  const text = discord.modalText({ custom_id: "MT", components: [{ type: 1, components: [{ type: 4, custom_id: "text", value: "先解釋" }] }] });
  ok(text === "先解釋", "discord: modalText extracts the typed value");
}

// --- slack ---------------------------------------------------------------------
{
  const reg = mkReg();
  const msg = slack.buildQuestion({ header: "h", question: "q", options: ["要", "不要"] }, reg);
  ok(msg.blocks[0].type === "section" && msg.blocks[0].text.text.includes("2. 不要"), "slack: section carries the numbered body");
  const opts = msg.blocks.find((b) => b.block_id === "myna_opts");
  const sel = reg.all.filter((t) => t.kind === "selection");
  ok(opts.elements.length === 2 && opts.elements.every((b, i) => b.value === sel[i].tk && b.text.text === String(i + 1)),
    "slack: numbered buttons carry registered selection tokens");
  const ctl = msg.blocks.find((b) => b.block_id === "myna_ctl");
  ok(ctl.elements.some((b) => b.action_id === "ask") && ctl.elements.some((b) => b.action_id === "abort"), "slack: ✍️ + ⏹ buttons present");

  const modal = slack.askModal("MT2");
  ok(modal.private_metadata === "MT2" && modal.title.text.length <= 24, "slack: modal round-trips token, title within 24-char cap");
  ok(slack.submittedText({ state: { values: { myna_q: { text: { value: "先解釋" } } } } }) === "先解釋", "slack: submittedText extracts the typed value");
}

// --- approves: the approved command is shown as the last line, as it will run ----------------------
{
  const cmd = 'git commit -m "a *b* _c_" && git push origin main';
  const s = slack.buildQuestion({ question: "q", options: ["✅ 核准", "不要"], approves: cmd }, mkReg());
  ok(s.text.split("\n").at(-1) === `核准後執行：${cmd}`, "slack: plain_text body ends with 核准後執行：<command> verbatim");
  // emoji:true would turn ":x:" into an emoji — the command gets a plain_text section of its own with emoji:false
  const ecmd = "echo :x: :tada: && git push origin main";
  const es = slack.buildQuestion({ question: "q", options: ["✅ 核准", "不要"], approves: ecmd }, mkReg());
  const ab = es.blocks.find((b) => b.block_id === "myna_approves");
  ok(ab?.type === "section" && ab.text.type === "plain_text" && ab.text.emoji === false && ab.text.text === `核准後執行：${ecmd}`
    && !es.blocks[0].text.text.includes("核准後執行") && es.blocks.indexOf(ab) === 1, "slack: the command line is its own plain_text section, emoji:false, verbatim, right after the question");
  ok(!slack.buildQuestion({ question: "q", options: ["a"] }, mkReg()).blocks.some((b) => b.block_id === "myna_approves"), "slack: no approves → no command section");
  const d = discord.buildQuestion({ question: "q", options: ["✅ 核准", "不要"], approves: cmd }, mkReg());
  const dl = d.content.split("\n").at(-1);
  // Discord renders markdown — every ASCII punctuation character is backslash-escaped so it displays verbatim
  ok(dl === `核准後執行：${cmd.replace(/[!-/:-@[-`{-~]/g, "\\$&")}` && dl.replace(/\\(.)/g, "$1") === `核准後執行：${cmd}`, `discord: command line markdown-escaped → ${JSON.stringify(dl)}`);
  // mentions / channels / timestamps and line-start list / heading / quote markers of a multi-line command
  const mcmd = "echo <@123> <#456> <t:1700000000> <:e:789>\n1. git push\n- x\n# y\n> z\n-# w";
  const md = discord.buildQuestion({ question: "q", options: ["✅ 核准", "不要"], approves: mcmd }, mkReg()).content;
  const mshown = md.slice(md.indexOf("核准後執行："));
  ok(!/[<#>.:@-]/.test(mshown.slice("核准後執行：".length).replace(/\\./g, "")) && mshown.replace(/\\(.)/g, "$1") === `核准後執行：${mcmd}`,
    `discord: <@…> / <#…> / <t:…> / <:e:…> and "1." / "-" / "#" / ">" / "-#" line starts are all escaped → ${JSON.stringify(mshown)}`);
  ok(!discord.buildQuestion({ question: "q", options: ["a"] }, mkReg()).content.includes("核准後執行"), "no approves → no command line");
}

// --- provider selection contract ----------------------------------------------
ok(discord.configured({ DISCORD_BOT_TOKEN: "x", DISCORD_CHANNEL_ID: "1" }) && !discord.configured({ DISCORD_BOT_TOKEN: "x" }),
  "discord: configured() needs token + channel");
ok(slack.configured({ SLACK_BOT_TOKEN: "x", SLACK_APP_TOKEN: "y", SLACK_CHANNEL_ID: "C" }) && !slack.configured({ SLACK_BOT_TOKEN: "x", SLACK_CHANNEL_ID: "C" }),
  "slack: configured() needs bot + app token + channel");

console.log(failed === 0 ? "\n✅ PROVIDER-PAYLOADS PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
