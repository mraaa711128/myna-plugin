---
description: Myna 狀態總覽（只讀）— relay、Telegram 聊天室和 topic、各開關、主要設定，以及建議的下一步
---
Show a read-only overview of this machine's Myna and what to do next.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"`

The script changes nothing. It reads `~/.myna/.env` (merged with this session's environment), the switch files, the pairing record, `telegram-topics.json` and the end of `relay.log`, asks the local relay `GET /health` and `GET /pair/status`, and — for Telegram — asks the Bot API `getMe` (plus `getChat` / `getChatMember` when the paired chat is a group). It never prints a token.

Show the script's output to the user as is (it is already in Traditional Chinese). Do not call any API yourself, do not read or print `~/.myna/.env` or any token, and do not change any setting — if the user wants to apply a suggested step, they ask for it separately. If there are suggested next steps, you may add one short line pointing at the first one.
