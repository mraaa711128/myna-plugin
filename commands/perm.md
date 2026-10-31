---
description: Toggle Myna permission forwarding — a permission dialog nobody answers at the terminal goes to your phone
argument-hint: "[on|off]"
---
Toggle Myna permission forwarding and report the new state.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/perm.mjs" $ARGUMENTS`

Permission forwarding is **ON by default**: when Claude Code shows a permission dialog (e.g. "Allow Bash: npm test?") and nobody answers it at the terminal within 30 seconds (`MYNA_PERMISSION_DELAY`), the same question goes to the phone with ✅ allow / ❌ deny. Both stay live — whichever is answered first wins, and the other side is withdrawn (the phone's buttons are retracted when the terminal answers). ✍️ on the phone denies with the typed text as the reason; ⏹ denies and stops the turn. In auto mode or with an allow rule no dialog appears, so nothing is sent. If the relay is unreachable the hook does nothing and the terminal dialog works as usual.

- `on` → (re)enable — the default.
- `off` → permission dialogs are answered at the terminal only.
- no argument → report the current state.

After running, tell the user the new state in one line, in Traditional Chinese.
