---
description: One-shot Myna setup — save IM credentials (Telegram/Discord/Slack) and start the relay in one flow
argument-hint: "<telegram_bot_token> | discord <bot_token> <channel_id> | slack <bot_token> <app_token> <channel_id>"
---
Guided first-time Myna setup for THIS machine. Myna supports one IM provider per machine:
**telegram** (default), **discord**, or **slack**. Run the steps in order; pause where the user must act.

**Telegram** (`/myna:setup <bot_token>`):

1. **Save the token** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure.mjs" $ARGUMENTS`
   If no token was given, tell the user to create one in @BotFather (`/newbot`, one bot per machine) and re-run `/myna:setup <token>`, then stop.
2. **Start the relay** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-relay.mjs"` (with only a token it runs to take the pairing).
3. **Pair the chat** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.mjs"`. Show the user the one-time code and tell them to open Telegram and send `!pair <code>` to their new bot (or, to use a group, send it in that group — the bot must have privacy mode off or be an admin there). Wait for them to say it is done, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.mjs" status` and confirm the bound chat. If the code expired or was mistyped 5 times, run `pair.mjs` again for a new one.
4. **Confirm** — report: token saved, chat paired, relay running. Tell the user the relay now **auto-starts on every session** (SessionStart hook), and that the individual commands (`/myna:configure`, `/myna:pair`, `/myna:relay`) remain available for changing the token, pairing a different chat, or restarting the relay.
5. **Check Threaded Mode** — call `https://api.telegram.org/bot<token>/getMe` (token from `~/.myna/.env`; never print the token) and read `has_topics_enabled`. If it is not `true`, tell the user to enable it in @BotFather (`/mybots` → the bot → Bot Settings → **Threaded Mode** → Enable; or BotFather → Open App → the bot → Settings → Threaded Mode) so every Claude session gets its own Telegram topic (named `<ticket> · <project dir> <time>`); without it all sessions share one flat chat. No Myna config change or relay restart is needed once enabled. If it is already `true`, just confirm that per-session topics are active.

**Discord** (`/myna:setup discord <bot_token> <channel_id>`) — needs Node 22+:

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure.mjs" $ARGUMENTS` (writes `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`; no pairing step — the channel id IS the pairing). If arguments are missing, point the user to the README「改用 Discord」 section (create the bot in the Developer Portal, invite it to a server, copy the channel id) and stop.
2. Start the relay and confirm as in Telegram steps 2 and 4 (no pairing step).

**Slack** (`/myna:setup slack <bot_token> <app_token> <channel_id>`) — needs Node 22+:

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure.mjs" $ARGUMENTS` (writes `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` + `SLACK_CHANNEL_ID`). If arguments are missing, point the user to the README「改用 Slack」 section (create the app, enable Socket Mode, invite the bot to a channel) and stop.
2. Start the relay and confirm as in Telegram steps 2 and 4 (no pairing step).

If several providers end up configured, `MYNA_PROVIDER` picks the active one — `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure.mjs" provider <telegram|discord|slack|auto>`, then restart the relay.
