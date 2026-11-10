---
description: Myna 附檔 — 手機傳給 chat session 的檔案在這台保留幾天（預設 7 天）；看狀態或調整天數
argument-hint: "[status|keep <天數>|keep default]"
---
Show or change how long this machine keeps the files the human sends to chat sessions from Telegram, and report the result.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/files.mjs" $ARGUMENTS`

A document or photo sent in a chat session's Telegram topic (`/myna:chat`) is saved under `~/.myna/inbox/` and its local path is given to the session. The setting is **global** for this machine (each machine keeps its own inbox) and takes effect without restarting the relay — the next time a file comes in, files received longer ago are removed:

- `keep <days>` → keep files for that many days after they were received (1 to 90).
- `keep default` → back to the default, 7 days.
- no argument / `status` → the setting, where it comes from, and how many files this machine's inbox holds.

After running, tell the user the result in one or two lines, in Traditional Chinese.
