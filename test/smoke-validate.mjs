#!/usr/bin/env node
// Smoke test for validateAskArgs — the guard that stops malformed tool calls
// (markup residue absorbing the options array) from shipping a button-less menu to the phone.
import { validateAskArgs } from "../src/providers/util.mjs";

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };

// clean calls pass
ok(validateAskArgs({ question: "背景圖要鎖 page 還是視窗?", options: ["A:page-lock", "B:視窗"] }).length === 0,
  "clean 2-option call → no problems");
ok(validateAskArgs({ question: "Q", options: ["只有一個選項"], preamble: "回覆你上一則" }).length === 0,
  "1-option + preamble → no problems");

// the observed failure: options absorbed into question as markup residue
const mangled = {
  question: '收尾嗎?</question>\n<parameter name="options">["Approve — 開 PR", "退回並附註"]',
};
const p1 = validateAskArgs(mangled);
ok(p1.some((s) => s.includes("options")), "absorbed options → missing-options problem reported");
ok(p1.some((s) => s.includes("residue")), "absorbed options → markup-residue problem reported");

// missing / empty / non-string options
ok(validateAskArgs({ question: "Q" }).length > 0, "missing options → rejected");
ok(validateAskArgs({ question: "Q", options: [] }).length > 0, "empty options → rejected");
ok(validateAskArgs({ question: "Q", options: ["A", ""] }).length > 0, "blank option entry → rejected");
ok(validateAskArgs({ question: "", options: ["A", "B"] }).length > 0, "empty question → rejected");

// residue in preamble or an option is also caught
ok(validateAskArgs({ question: "Q", options: ["A", "B"], preamble: "x <parameter name=\"y\">" }).length > 0,
  "residue in preamble → rejected");
ok(validateAskArgs({ question: "Q", options: ["A</question>", "B"] }).length > 0,
  "residue in option → rejected");

// <option>/<options> pseudo-markup mixed into the body (user-reported shape) — with or without
// a surviving options array, the inline tags must be rejected
ok(validateAskArgs({ question: "選 A 還是 B?\n<options><option>A</option><option>B</option></options>" }).length > 0,
  "inline <option> markup + missing options → rejected");
ok(validateAskArgs({ question: "選一個:<option>A</option> <option>B</option>", options: ["A", "B"] }).length > 0,
  "inline <option> markup despite valid options array → rejected");

// legit angle brackets that are NOT tool markup must pass (code/XAML quotes in questions)
ok(validateAskArgs({ question: "PackageReference 是 <PackageReference Include=\"X\"/> 這樣嗎?", options: ["是", "否"] }).length === 0,
  "XAML/XML quote in question → allowed");
ok(validateAskArgs({ question: "型別是 List<string> 對吧?", options: ["對", "不對"] }).length === 0,
  "generic type in question → allowed");

process.exit(failed ? 1 : 0);
