---
description: Toggle Myna autopilot — auto-accept the recommended gate option (logged) instead of asking on Telegram
argument-hint: "[on|off]"
---
Toggle Myna autopilot and report the new state.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/autopilot.mjs" $ARGUMENTS`

- `on` → `ask_human` auto-accepts the **recommended** option (needs `recommendedIndex`; if none is identifiable it safely falls back to Telegram) and logs every decision to the project's `MYNA-DECISIONS.jsonl` / `.md`.
- `off` → `ask_human` relays gate questions to your phone (Telegram) and blocks for your answer.
- no argument → report the current state.

After running, tell the user the new state in one line.

Then add one more line, exactly: `提示：/myna:autopilot 之後會移除，請改用 /myna:config autopilot on|off`
