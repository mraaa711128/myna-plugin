---
description: Toggle Myna AskUserQuestion interception — route the terminal picker to your phone (Telegram) via ask_human
argument-hint: "[on|off]"
---
Toggle Myna AskUserQuestion interception and report the new state.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/intercept.mjs" $ARGUMENTS`

Interception is **ON by default**: a PreToolUse hook redirects **every** `AskUserQuestion` (even ones outside a patched workflow) to the Myna `ask_human` tool, so gate questions reach your phone (Telegram). A multi-question ask is split into one `ask_human` call per question, grouped into one thread. **If the relay is unreachable it safely falls back to the local terminal picker** — so un-configured installs are unaffected.

- `on` → (re)enable interception — the default.
- `off` → disable it; `AskUserQuestion` uses the local terminal picker.
- no argument → report the current state.

Note: interception is independent of `/myna:autopilot`. With autopilot also ON, the redirected `ask_human` calls auto-accept the recommended option (and log it) instead of buzzing your phone.

After running, tell the user the new state in one line.

Then add one more line, exactly: `提示：/myna:intercept 之後會移除，請改用 /myna:config intercept on|off`
