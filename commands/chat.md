---
description: Toggle Myna chat for this session — talk to this Claude Code session from its own Telegram topic
argument-hint: "[on|off]"
---
This command is normally answered by Myna's chat mod (`hooks/chat-mod.mjs`) before this text is ever used. If you are reading this, the mod is not loaded in this session: it needs Claude Code **2.1.287 or newer** (check with `claude --version`), and loads only in sessions that support plugin hook modules.

Tell the user, in Traditional Chinese and in two or three lines: Myna 聊天功能需要 Claude Code 2.1.287 以上版本,這個 session 沒有載入聊天模組;升級後重開 session 就會自動啟用(終端機 session 預設開啟)。Do not run anything else.
