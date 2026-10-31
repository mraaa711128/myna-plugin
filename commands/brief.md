---
description: Toggle Myna gate-brief — publish a per-option decision-context Artifact for intercepted gates
argument-hint: "[on|off]"
---
Toggle Myna gate-brief and report the new state.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/brief.mjs" $ARGUMENTS`

Gate-brief is **ON by default**. When an `AskUserQuestion` is intercepted (needs `/myna:intercept` on + relay up), the hook also asks the model to:
1. author a decision brief — for the question and **each option**: context, pros/cons, when-to-pick, risks (+ optional cost / reversibility / impact / example), plus an optional Mermaid `diagram` (see below);
2. render it (`scripts/render-gate.mjs`) into one self-contained HTML page (all questions of a batch on one page);
3. publish it as an **Artifact** — one rolling URL per session (updates in place); and
4. link that URL in the Telegram question's `preamble`, so **Telegram carries only the terse question + short labels** while the depth lives in the artifact.

**選配 Mermaid 流程圖(v0.9.0):** brief JSON 可帶 `diagram`(Mermaid 原始碼字串)——頂層 `diagram` = 整頁總覽(標題列下方的「流程總覽」),每題的 `diagram` = 顯示在該題 `context` 之後。撰寫原則:用 `flowchart TD`、**≤15 個節點**、每個決策標在**它實際發生的那一步**(例:`F{決策 1：發版方式}`);**圖是補充、不是取代**——文字欄位照樣要寫滿。沒有 `diagram`(或空字串)就不出圖,頁面也不帶任何 script。圖由頁面從 jsDelivr 載入 Mermaid 11 在瀏覽器端畫(`securityLevel: strict`,跟隨淺色/深色);某張圖語法錯誤、或 CDN 載不到(離線/CSP)時,該區塊改顯示「圖表無法渲染，以下為 Mermaid 原始碼」+ 錯誤訊息 + 原始碼,其餘內容照常。

- `on` → (re)enable — the default.
- `off` → disable; intercepted gates send the fuller option text to Telegram and publish no artifact.
- no argument → report the current state.

Note: brief only fires while interception is on (`/myna:intercept`). Publishing an Artifact sends the brief content to claude.ai; turn brief `off` for sensitive gates. If the model can't publish, it safely skips the artifact and still asks on Telegram.

After running, tell the user the new state in one line.
