---
name: config
description: Myna 設定（Codex 版）— 看或改這台機器的 autopilot、stopcatch、hold、topics。使用者打 $config 或 $myna:config 時才用；不要自己決定改設定。
---
Show or change a Myna setting on this machine and report the result.

**Where Myna is**: the plugin root is three folders up from this `SKILL.md` (this file is `<root>/codex/skills/config/SKILL.md`). Use that absolute path below as `<root>`.

Run: `node "<root>/scripts/config.mjs" --host codex <the user's arguments>`

- no argument → the 4 items Codex has, each with its value, where it comes from and the values it takes (`可設：…`), then one line on what it is for.
- `<item>` → that item only, in full (`用途`, `可設`, `存放`).
- `<item> <value>` → change it:

| item | values | stored in | takes effect |
|---|---|---|---|
| `autopilot` | `on` / `off` | `~/.myna/autopilot` | at once |
| `stopcatch` | `on` / `off` | `~/.myna/stopcatch` | at once |
| `hold` | `on` / `off` / `max <30m\|6h\|1d\|秒數\|default>` / `status` | `~/.myna/upstream-hold` | at once |
| `topics` | `auto` / `off` | `TELEGRAM_TOPICS` in `~/.myna/.env` | after the relay restarts (`$myna:manage relay restart`) |

These are per-machine settings: a Claude Code session on the same machine sees the same change.

Rules:
- Change a setting only when the user has just asked for that change in this conversation — never on your own. Turning `autopilot` on makes Myna answer the user's questions by itself; that is the user's decision.
- The script writes under `~/.myna` (outside the workspace), so Codex's sandbox asks for approval. Request it the normal Codex way, with a short reason such as "write Myna settings in ~/.myna". If the approval is declined, report that and stop — do not try another way to write the file.
- Other items (`godmode`, `intercept`, `brief`, `perm`, `perm-delay`, `murmur`, `chat`) are not in the Codex version yet; the script refuses them and changes nothing. Pass that on as is; do not run another script to get around it.
- If the script refused a value, say what it accepts; do not retry with another value.

Show the script's output to the user, in Traditional Chinese, in one or two lines (the whole list, or the single item's lines, as is when no value was given). When `topics` changed, say the relay has to be restarted for it to apply — do not restart it yourself.
