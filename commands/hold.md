---
description: Myna 子節點斷線排隊 — 主節點連不上時新題目先排著、恢復後送到手機（預設開）；設定開關和上限
argument-hint: "[status|on|off|max <30m|6h|1d|秒數|default>]"
---
Set whether this machine's Myna relay holds questions while its hub (main node) is away, and report the new state.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/hold.mjs" $ARGUMENTS`

This only matters on a machine that joined a hub (`/myna:join`, `MYNA_ROLE=edge`). The setting is **global** for this machine and takes effect without restarting the relay:

- `on` → **the default**: while the hub can't be reached, a new question gets a request id and waits (the terminal session keeps waiting too); once the hub is back it goes to the phone with a line saying it was held. Questions already sent to the hub keep waiting for their answer instead of being given up after 120 seconds. Nothing is sent on this machine's own bot.
- `off` → the 0.20.3 behaviour: new questions go to this machine's own bot (none: back to the terminal); questions already sent are given up after `MYNA_UPSTREAM_GRACE` seconds. Questions already held stay held and are sent once the hub is back.
- `max <time>` → how long a question may be held (`30m`, `6h`, `1d` or seconds, 10 minutes to 7 days; default 1 day). Past it the question goes back to the terminal. `max default` restores 1 day.
- no argument / `status` → the setting, where it comes from (default, `/myna:hold`, or an environment variable), whether the hub is reachable, and how many questions are held (and since when).

`MYNA_UPSTREAM_HOLD` / `MYNA_UPSTREAM_HOLD_MAX` (environment or `~/.myna/.env`) win over this setting; the script still writes it and says so.

After running, tell the user the result in one or two lines, in Traditional Chinese.
