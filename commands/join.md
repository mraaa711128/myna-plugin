---
description: Join this machine to a Myna hub (another machine's relay owns the bot) — confirmation code here, one ✅ tap on the phone; `tree <parent URL>` joins a tree-mode parent instead
argument-hint: "<hub URL> [--name <name>]  |  tree <parent URL> [--name <name>]"
---
**When the first argument is `tree`** (the new tree transport over Tailscale — README「不同機器的 session 互傳訊息」), the rest of this page does not apply:
1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/join.mjs" $ARGUMENTS --no-wait`. The parent URL is `https://<the parent's MagicDNS name>:<port>` (8443 unless the parent changed it). If this machine has a Telegram bot and its owner has not bound a Telegram account yet, it exits with status **2** and prints how (send `!bind` in the bot's chat, open the link on a phone running Tailscale): tell the user in 繁體中文, then run step 1 again. Otherwise it prints a confirmation code and how the parent approves: the parent owner's phone shows「🆕 新節點要接到這台下面」with this device and its Tailscale account — tap ✅ only if the code matches (a Telegram account bound to the parent's owner); or, when the parent has no bot that can confirm, run `/myna:machines approve <code>` on the parent.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/join.mjs" tree --wait` (long timeout, e.g. 600000 ms, or in the background). On approval it saves the node token and `node-parent.json`, writes `MYNA_TRANSPORT=tree` and restarts the relay.
3. Report in 繁體中文. Refused on a machine with the old multi-machine settings (`MYNA_ROLE=edge`, `MYNA_REMOTE_PORT`).

Without `tree`:

Make THIS machine an **edge** of a Myna hub: its relay forwards every question to the hub (another machine, whose bot becomes the one inbox), so `ask_human`, the hooks and any guard here keep working unchanged on `127.0.0.1:7800`. A bot this machine already has stays configured and becomes the fallback while the hub is away — unless it is the hub's own bot (same bot id), then it is not used at all.

Before you start, check (and tell the user in 繁體中文 if something is missing):
- The hub runs myna 0.20.0+ with `MYNA_REMOTE_PORT` set and a tunnel (Cloudflare Tunnel + Access) pointing its public HTTPS URL at that port.
- Behind Cloudflare Access, this machine's `~/.myna/.env` already has `MYNA_CF_ACCESS_CLIENT_ID` and `MYNA_CF_ACCESS_CLIENT_SECRET` (ask the user to put them there themselves — never ask them to paste a secret into the chat).

Steps:
1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/join.mjs" $ARGUMENTS --no-wait`. It prints a confirmation code like `4F7-K92`. Show the code to the user and tell them, in 繁體中文, that the phone now shows「🆕 <name> 要加入，核對碼 …」: tap **✅ 允許** only if the code is the same, otherwise **❌ 拒絕**. They have 10 minutes.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/join.mjs" --wait` (it waits for the tap — give the Bash call a long timeout, e.g. 600000 ms, or run it in the background). On ✅ it saves the token to `~/.myna/machine-token`, writes `MYNA_ROLE=edge` and `MYNA_UPSTREAM` into `~/.myna/.env`, and starts the edge relay.
3. Report the result in 繁體中文. On success, `curl -s http://127.0.0.1:7800/health` should show `"role":"edge"`, `upstream.reachable: true` and `upstream.active: true`; `own_bot.on` says whether this machine's own bot is the fallback (if `false`, `own_bot.reason` says why).

Only a human tap issues the token — autopilot never answers a join request. If it was denied or expired, run the command again (the hub accepts one new join request per minute).
