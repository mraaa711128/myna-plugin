---
description: Myna 設定 — 一個指令看和改所有開關（autopilot、intercept、stopcatch、brief、perm、murmur、hold、chat）和常用的 .env 設定（topics、perm-delay）
argument-hint: "[項目] [值]"
---
Show or change a Myna setting and report the result.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" $ARGUMENTS`

- no argument → every item in two lines: its value, where it comes from (預設, the setting's file, `~/.myna/.env`, or an environment variable) and the values it takes (`可設：…`), then one line on what it is for; under `chat`, one line per Claude Code session on this machine with its chat on/off, this session marked.
- `<item>` → that item only, in full: its value, then `用途`, `可設` (for `hold`, the forms and range of `max`) and `存放` (where it is kept, and when a change takes effect).
- `<item> <value>` → change it:

| item | values | stored in | takes effect |
|---|---|---|---|
| `autopilot` | `on` / `off` | `~/.myna/autopilot` | at once |
| `intercept` | `on` / `off` | `~/.myna/intercept` | at once |
| `stopcatch` | `on` / `off` | `~/.myna/stopcatch` | at once |
| `brief` | `on` / `off` | `~/.myna/brief` | at once |
| `perm` | `on` / `off` | `~/.myna/permission` | at once |
| `murmur` | `on` / `off` | `~/.myna/chat-progress` | the next progress update |
| `hold` | `on` / `off` / `max <30m\|6h\|1d\|秒數\|default>` / `status` | `~/.myna/upstream-hold` | at once |
| `chat` | `on` / `off` | this session (the chat mod) | at once |
| `topics` | `auto` / `off` | `TELEGRAM_TOPICS` in `~/.myna/.env` | after `/myna:relay restart` |
| `perm-delay` | seconds (0 or more) | `MYNA_PERMISSION_DELAY` in `~/.myna/.env` | the next permission dialog |

A switch is changed by the same script as its own command (`/myna:autopilot` and so on), so both read and write the same setting. `chat` is answered by Myna's chat mod before this text is used; if the script says the chat mod is not loaded, pass that on as is.

Show the script's output to the user, in Traditional Chinese, in one or two lines (the whole list, or the single item's lines, as is when no value was given). When `topics` changed, say the relay has to be restarted for it to apply (`/myna:relay restart`) — do not restart it yourself. If the script refused the value, say what it accepts; do not retry with another value.
