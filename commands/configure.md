---
description: Set Myna IM credentials — Telegram bot token, Discord bot+channel, Slack tokens+channel, or force the active provider
argument-hint: "<telegram_bot_token> [chat_id] | telegram|discord|slack … | provider <name|auto>"
---
Configure Myna's IM provider for THIS machine.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure.mjs" $ARGUMENTS`

Accepted forms (all write the gitignored `~/.myna/.env`):

- `<telegram_bot_token> [chat_id]` — legacy shorthand, same as `telegram …`. One bot per machine — create it in @BotFather with `/newbot`. If no chat id was passed, tell the user to run `/myna:pair` next (it binds the chat with a one-time code). Passing a chat id here replaces a chat bound by `/myna:pair`.
- `telegram <bot_token> [chat_id]`
- `discord <bot_token> <channel_id>` — bot token from the Discord Developer Portal; channel id via Developer Mode → right-click channel → Copy Channel ID. Needs Node 22+.
- `slack <bot_token> <app_token> <channel_id>` — `xoxb-…` bot token (scope `chat:write`) + `xapp-…` Socket-Mode app token (`connections:write`). Needs Node 22+.
- `provider <telegram|discord|slack|auto>` — force which configured provider the relay uses (`auto` = first configured).

After changing credentials or provider, restart the relay (`/myna:relay stop` then `start`) to apply. Full per-platform walkthroughs live in the README.
