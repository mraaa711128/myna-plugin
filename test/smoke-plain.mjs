#!/usr/bin/env node
// markdown → plain text for Telegram (src/providers/plain.mjs). Pure function, no relay.
// Proves: bold / backticks / # headings / tables / lists / links lose their markup; code blocks, inline
// code, URLs, Windows paths (backslashes) and snake_case come through as written; a URL touching 中文 or
// a full-width bracket gets a space so Telegram's autolinker (which takes CJK into the link) stops at it.
import { mdToPlain } from "../src/providers/plain.mjs";

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const is = (input, want, m) => {
  const got = mdToPlain(input);
  ok(got === want, `${m}${got === want ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

// --- inline ---
is("**建議選 A**,因為比較快", "建議選 A,因為比較快", "**bold** loses its stars");
is("改 `src/relay.mjs` 的 `ask_human`", "改 src/relay.mjs 的 ask_human", "`inline code` loses its backticks, content kept");
is("用 ``a `b` c`` 包起來", "用 a `b` c 包起來", "a double-backtick span keeps the backticks inside it");
is("`**不是粗體**`", "**不是粗體**", "markup inside inline code is kept as written");
is("這很 *重要* 喔", "這很 重要 喔", "*italic* loses its stars");
is("~~舊做法~~ 新做法", "舊做法 新做法", "~~strike~~ loses its tildes");
is("2*3*4 與 a * b * c", "2*3*4 與 a * b * c", "stars between words / spaced stars are not italic");
is("ask_human、__init__、snake_case_name", "ask_human、__init__、snake_case_name", "underscores are left alone (snake_case, dunder)");
is(String.raw`路徑 C:\Users\alice\.myna\relay-pending.json 與 D:\a_b\*.txt`, String.raw`路徑 C:\Users\alice\.myna\relay-pending.json 與 D:\a_b\*.txt`, "Windows paths keep every backslash");
is("`C:\\Program Files\\Myna\\`", "C:\\Program Files\\Myna\\", "a Windows path in backticks keeps its backslashes");
is("見 PR #28 與 issue #30", "見 PR #28 與 issue #30", "a # inside a line is not a heading");

// --- links / URLs ---
is("看 [PR #28](https://github.com/example-org/example-app/pull/28) 就知道", "看 PR #28 https://github.com/example-org/example-app/pull/28 就知道", "[text](url) → text url");
is("[https://x.io/a](https://x.io/a)", "https://x.io/a", "[url](url) → the url once");
is("<https://x.io/a_b*c*>", "https://x.io/a_b*c*", "<autolink> → url, its * and _ kept");
is("網址 https://x.io/a_b/**c**/d 結束", "網址 https://x.io/a_b/**c**/d 結束", "a bare URL keeps its * and _");
is("見https://x.io/a。下一句", "見 https://x.io/a 。下一句", "URL touching 中文 on both sides gets a space each side");
is("連結 https://x.io/a?b=1（說明）", "連結 https://x.io/a?b=1 （說明）", "URL before a full-width bracket gets a space");
is("詳見 [文件](https://x.io/d)。", "詳見 文件 https://x.io/d 。", "a converted link before 。 gets a space");
is("(see https://x.io/a).", "(see https://x.io/a).", "ASCII punctuation after a URL is left alone (Telegram trims it)");
is("![圖](https://x.io/p.png)", "圖 https://x.io/p.png", "image → alt url");

// --- blocks ---
is("# 結論\n內容", "結論\n內容", "# heading → its text on its own line");
is("### 下一步 ###", "下一步", "closing #s go too");
is("- 甲\n- 乙\n  - 乙之一\n* 丙\n+ 丁", "・甲\n・乙\n　・乙之一\n・丙\n・丁", "- * + bullets → ・ (nested ones indented)");
is("1. 一\n2) 二\n   1. 二之一", "1. 一\n2. 二\n　1. 二之一", "numbered lists → 1. (nested ones indented)");
is("- [ ] 待辦\n- [x] 完成", "☐ 待辦\n☑ 完成", "task list → ☐ / ☑ (in place of the bullet)");
is("> 引用 **重點**\n> > 二層", "引用 重點\n二層", "> quote marks go");
is("上\n\n---\n\n下", "上\n\n——\n\n下", "--- rule → ——");
is("| 項目 | 說明 |\n|---|:---:|\n| A | **快** |\n| B | 慢 \\| 穩 |", "項目：A\n說明：快\n\n項目：B\n說明：慢 | 穩", "table → one block of 「欄位：值」 lines per row (\\| kept as |)");
is("項目 | 說明\n--- | ---\nA | 快", "項目：A\n說明：快", "a table without outer pipes too");
is("| 欄 | 空 |\n|---|---|\n| x |  |", "欄：x", "empty cells are skipped");
is("a | b 不是表格", "a | b 不是表格", "a pipe in prose is not a table");
is("```js\nconst x = **y**; // `保留`\n  - 縮排\n```\n後面 **粗**", "const x = **y**; // `保留`\n  - 縮排\n後面 粗", "```code block``` content kept as written, fences dropped");
is("~~~\n# 不是標題\n~~~", "# 不是標題", "~~~ fences too");
is("```\n未關閉的 **code**", "未關閉的 **code**", "an unclosed fence keeps the rest as code");
is("段一\n\n\n\n段二\n", "段一\n\n段二", "runs of blank lines collapse to one, ends trimmed");
is("a\r\nb", "a\nb", "CRLF → LF");
is("", "", "empty stays empty");
is("純文字,沒有任何 markdown。\n第二行。", "純文字,沒有任何 markdown。\n第二行。", "plain text passes through unchanged");

// --- the before/after sample for the PR ---
const before = [
  "## 結論",
  "",
  "**建議選 A**：改 `src/providers/telegram.mjs`，設定檔在 `C:\\Users\\me\\.myna\\.env`。",
  "",
  "| 選項 | 優點 | 缺點 |",
  "|---|---|---|",
  "| A | 程式少 | 沒有粗體 |",
  "| B | 好看 | 要跳脫、要退回 |",
  "",
  "- 細節見 [issue #30](https://github.com/example-org/example-app/issues/30)。",
  "  - 測試：`node test/smoke-plain.mjs`",
].join("\n");
const after = [
  "結論",
  "",
  "建議選 A：改 src/providers/telegram.mjs，設定檔在 C:\\Users\\me\\.myna\\.env。",
  "",
  "選項：A",
  "優點：程式少",
  "缺點：沒有粗體",
  "",
  "選項：B",
  "優點：好看",
  "缺點：要跳脫、要退回",
  "",
  "・細節見 issue #30 https://github.com/example-org/example-app/issues/30 。",
  "　・測試：node test/smoke-plain.mjs",
].join("\n");
is(before, after, "the PR's before/after sample");

console.log(failed === 0 ? "\n✅ PLAIN-TEXT PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
