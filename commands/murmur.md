---
description: Myna chat progress style — on lists every tool call in the progress message, off keeps the remarks but shows only the latest tool
argument-hint: "[on|off]"
---
Set how a chat session's progress message looks on Telegram and report the new state.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/murmur.mjs" $ARGUMENTS`

During each turn of a chat session (`/myna:chat`), Myna keeps one silent progress message in the session's Telegram topic. This setting is **global** (every session) and takes effect from the next progress update:

- `on` → **the default**: every tool call (and the AI's in-between remarks 💭) is added as a new line; once another message lands below it, a new progress message continues at the bottom.
- `off` → no tool list: the `🖥` prompt line (for turns started at the terminal), every in-between remark of the AI (`💭`), and only the latest tool with its count, e.g. `🔧 Read: src/chat.mjs(第 3 個工具)`; when another message lands below it, the progress message moves to the bottom and the old one is deleted; near Telegram's length limit the oldest remarks are folded into "…(前面 N 句省略)".
- no argument → report the current setting.

After running, tell the user the new state in one line, in Traditional Chinese.
