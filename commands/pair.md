---
description: Bind the Telegram chat Myna uses — one-time pairing code, sent from the chat to bind (private or group)
argument-hint: "[status]"
---
Pair (or re-pair) the Telegram chat that Myna sends questions to and accepts answers from.

1. Make sure the relay is running: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-relay.mjs"`
2. Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.mjs" $ARGUMENTS`

- **No argument** → the relay issues a one-time 6-digit code (valid 10 minutes, voided after 5 wrong tries). Show the user the code and tell them, in Traditional Chinese, to send `!pair <code>` in the Telegram chat they want to bind — their private chat with the bot, or a group the bot is in (in a group the bot must have privacy mode off or be an admin, or it never sees the message). Myna takes no `/` commands on Telegram; a `/pair <code>` only gets a hint to type `!pair` instead. The bot replies ✅ there once bound. Pairing another chat replaces the current one; questions already waiting in the old chat stay answerable there.
- **`status`** → report which chat is bound.

Only the bound chat can answer; every member of a bound group is trusted to answer. Telegram only — Discord/Slack bind by the channel id given to `/myna:configure`.
