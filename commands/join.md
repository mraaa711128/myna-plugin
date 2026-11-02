---
description: Join this machine to a Myna hub (another machine's relay owns the bot) — confirmation code here, one ✅ tap on the phone
argument-hint: "<hub URL> [--name <name>]"
---
Make THIS machine an **edge** of a Myna hub: its relay forwards every question to the hub (another machine, whose bot becomes the one inbox), so `ask_human`, the hooks and any guard here keep working unchanged on `127.0.0.1:7800`. A bot this machine already has stays configured and becomes the fallback while the hub is away — unless it is the hub's own bot (same bot id), then it is not used at all.

Before you start, check (and tell the user in 繁體中文 if something is missing):
- The hub runs myna 0.20.0+ with `MYNA_REMOTE_PORT` set and a tunnel (Cloudflare Tunnel + Access) pointing its public HTTPS URL at that port.
- Behind Cloudflare Access, this machine's `~/.myna/.env` already has `MYNA_CF_ACCESS_CLIENT_ID` and `MYNA_CF_ACCESS_CLIENT_SECRET` (ask the user to put them there themselves — never ask them to paste a secret into the chat).

Steps:
1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/join.mjs" $ARGUMENTS --no-wait`. It prints a confirmation code like `4F7-K92`. Show the code to the user and tell them, in 繁體中文, that the phone now shows「🆕 <name> 要加入，核對碼 …」: tap **✅ 允許** only if the code is the same, otherwise **❌ 拒絕**. They have 10 minutes.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/join.mjs" --wait` (it waits for the tap — give the Bash call a long timeout, e.g. 600000 ms, or run it in the background). On ✅ it saves the token to `~/.myna/machine-token`, writes `MYNA_ROLE=edge` and `MYNA_UPSTREAM` into `~/.myna/.env`, and starts the edge relay.
3. Report the result in 繁體中文. On success, `curl -s http://127.0.0.1:7800/health` should show `"role":"edge"`, `upstream.reachable: true` and `upstream.active: true`; `own_bot.on` says whether this machine's own bot is the fallback (if `false`, `own_bot.reason` says why).

Only a human tap issues the token — autopilot never answers a join request. If it was denied or expired, run the command again (the hub accepts one new join request per minute).
