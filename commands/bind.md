---
description: Myna tree 模式的 IM 綁定 — 列出或移除「哪個 Telegram 帳號可以替哪個 Tailscale 身分按要緊的鈕」
argument-hint: "[list | remove <telegram:<id> | tailscale:<login> | 編號>]"
---
執行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/bind.mjs" $ARGUMENTS`（沒有參數時是 `list`）。

- **list** — 這台 `~/.myna/bindings.json` 的每一筆：Telegram 帳號 → `tailscale:<login>`、綁定時間。
- **remove <…>** — 移除一個 Telegram 帳號的綁定（`telegram:<id>`）、一個身分的所有綁定（`tailscale:<login>`），或 list 的第幾筆。下一次按鈕就生效，不用重啟 relay。

綁定只能從手機做：在 bot 的聊天室傳 `!bind`，用開著 Tailscale 的手機打開 bot 回的連結、按「確認綁定」。這裡沒有「新增」。只有 tree 模式（`/myna:hub tree`、`/myna:join tree`）會用到綁定：要緊的鈕（帶 `approves` 的 ✅、權限轉手機的允許、新節點加入）只認綁到這台 owner 的帳號。

用繁體中文回報結果。
