---
description: Toggle Myna stop-catch — bounce plain-text question endings (no tool used) to your phone via ask_human
argument-hint: "[on|off]"
---
Toggle Myna stop-catch and report the new state.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/stopcatch.mjs" $ARGUMENTS`

Stop-catch is **ON by default**: a Stop hook watches every turn ending. If the final assistant message ends with a **plain-text question addressed to the user**(e.g. 「要我現在就開 PR 嗎?」)— which no PreToolUse hook can see because no tool was used — the hook blocks once and instructs the model to route the question through `ask_human`(your IM), or to end the turn cleanly if the question was rhetorical. **If the relay is unreachable it does nothing**(the terminal is the channel then), and it never blocks the same stop twice(`stop_hook_active`).

The same Stop hook also reports **round end** to the relay (`POST /session/round-end`) whenever it lets the turn end, so Telegram can clean up the current gate's topic. That part runs **regardless of this toggle** — `off` only stops the question bouncing. It is withheld while background work the AI started after its last `ask_human` is still running (the AI ended its reply only to wait for it), and the relay waits a grace period (default 10 min) before ending the topic.

- `on` → (re)enable stop-catch — the default.
- `off` → disable it; turns may end with unrouted plain-text questions.
- no argument → report the current state.

After running, tell the user the new state in one line.

Then add one more line, exactly: `提示：/myna:stopcatch 之後會移除，請改用 /myna:config stopcatch on|off`
