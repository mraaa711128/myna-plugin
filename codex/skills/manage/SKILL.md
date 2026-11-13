---
name: manage
description: Myna 管理（Codex 版）— 第一次設定（setup、configure、pair）、relay 啟動／停止／重啟／狀態、狀態總覽（status）、多台機器（hub、join，含 tree 模式）、已加入的機器（machines）、tree 的 IM 綁定（bind）。使用者打 $manage 或 $myna:manage 加上動作時才用。
---
Manage Myna on THIS machine. Each action below runs one of Myna's own scripts; do exactly what the action says, report in 繁體中文, and stop where the user has to act (on the phone, in BotFather, in a config file).

**Where Myna is**: the plugin root is three folders up from this `SKILL.md` (this file is `<root>/codex/skills/manage/SKILL.md`). Use that absolute path as `<root>` in every command.

**Sandbox**: these scripts write under `~/.myna`, start or stop a background relay and talk to `127.0.0.1`, so Codex asks for approval for each command. Request it the normal Codex way with a short reason (e.g. "configure Myna in ~/.myna", "start the Myna relay"). If it is declined, report that and stop — never look for another way to do it.

**Secrets**: never ask for a token or secret in the conversation, and never print or repeat one (nor `~/.myna/.env`). A token the user typed into their own `$myna:manage setup …` / `configure …` command is passed on to the script as given (as Claude Code's `/myna:setup <token>` does). To keep a token out of the conversation altogether, the user can instead run `node "<root>/scripts/configure.mjs" <token>` in their own terminal and then `$myna:manage setup` without a token. The scripts' own output is already in Traditional Chinese or plain enough to pass on; it may name Claude Code commands (`/myna:…`) — say the Codex way instead (`$myna:manage <action>`, `$myna:config <item>`).

The first word of the user's arguments picks the action:

## setup `<telegram_bot_token>` | `discord <bot_token> <channel_id>` | `slack <bot_token> <app_token> <channel_id>`
First-time setup. One IM provider per machine. Run the steps in order:
1. `node "<root>/scripts/configure.mjs" <the rest of the arguments>` — saves the credentials in `~/.myna/.env`. With no token given: ask the user whether the token is already saved (they ran `configure.mjs` in their own terminal, see **Secrets**) — if so, go on with step 2; if not, tell them to create a bot in @BotFather (`/newbot`, one bot per machine) and either run `$myna:manage setup <token>` or save it from their own terminal first, then stop. Discord / Slack need Node 22+; how to get their ids is in the README (「改用 Discord」「改用 Slack」).
2. `node "<root>/scripts/ensure-relay.mjs" --host codex` — starts the relay (with only a Telegram token it runs to take the pairing).
3. Telegram only — pair the chat: `node "<root>/scripts/pair.mjs"`. Show the one-time code and tell the user to send `!pair <code>` to the bot in Telegram (their private chat with it, or a group the bot is in — privacy mode off or the bot an admin there). Wait until they say it is done, then `node "<root>/scripts/pair.mjs" status` and confirm the bound chat. If the code expired or was mistyped 5 times, run `pair.mjs` again.
4. Report: credentials saved, chat paired (Telegram), relay running. Tell the user the relay starts by itself when a Codex session starts (after the hooks are trusted in `/hooks`), and that `$myna:manage configure | pair | relay` remain for changes. For Telegram, suggest turning on **Threaded Mode** in @BotFather (Bot Settings → Threaded Mode) so each decision gets its own topic.

## configure `<args>`
`node "<root>/scripts/configure.mjs" <args>` — forms: `<telegram_bot_token> [chat_id]`, `telegram <bot_token> [chat_id]`, `discord <bot_token> <channel_id>`, `slack <bot_token> <app_token> <channel_id>`, `provider <telegram|discord|slack|auto>`. Afterwards the relay has to restart to use it (`$myna:manage relay restart`). Without a chat id, Telegram needs `$myna:manage pair` next.

## pair [`status`]
1. `node "<root>/scripts/ensure-relay.mjs" --host codex`
2. `node "<root>/scripts/pair.mjs"` (or `pair.mjs status` to show the bound chat). Show the code; the user sends `!pair <code>` in the Telegram chat to bind (Myna takes no `/` commands on Telegram). Pairing another chat replaces the current one. Telegram only — Discord / Slack bind by the channel id given to `configure`.

## relay [`start` | `stop` | `restart` | `status`] (default `start`)
- `start` — `node "<root>/scripts/ensure-relay.mjs" --host codex` — idempotent: starts it if nothing listens; replaces an older version's relay (not one that still has an open gate it cannot hand over — the script says so); leaves a newer one running (this plugin is the stale one — update it).
- `stop` — `node "<root>/scripts/stop-relay.mjs"`
- `restart` — `node "<root>/scripts/ensure-relay.mjs" --force --host codex` — replaces whatever is on the port, the same version included (open gates carry over through the relay's journal). Use after an upgrade or after editing `~/.myna/.env`.
- `status` — fetch `http://127.0.0.1:7800/health`: JSON `{version, provider, pid, root, started_at, pending}` = running (an older `version` than this plugin's → `restart`; newer → this plugin is stale); connection refused = not running. On a machine joined to a hub (`"role":"edge"`) also report `upstream.reachable`, `upstream.active`, `upstream.reason`, `upstream.chat`, `upstream.hold` and `own_bot`. The log is `~/.myna/relay.log`.

## status
`node "<root>/scripts/status.mjs"` — read-only overview (relay, Telegram chat and topics, every switch including God mode, the main settings, suggested next steps). Show its output as is; change nothing, call no API yourself. If the user wants a suggested step done, they ask for it separately.

## hub [`status` | `on [--name <名稱>]` | `off` | `tree …`] (default `status`)
- On the machine whose bot is the phone's inbox: `node "<root>/scripts/hub.mjs" <args>`.
  - `status` (read-only) — the relay's `role` and `remote`, how many machines joined.
  - `on [--name <名稱>]` — writes `MYNA_REMOTE_PORT` (7801 unless set) and the optional machine name, restarts the relay, prints `/health`'s `remote`. Refused on an edge or without a bot (`.env` unchanged).
  - `off` — removes `MYNA_REMOTE_PORT`, restarts the relay; joined machines stay valid.
  - The tunnel (cloudflared) and Cloudflare Access are set up by hand (README「多台機器共用一支 bot」) and must point at `remote.port`, never at 7800.
- `tree [status | on [--name <名稱>] | off]` — the tree transport over Tailscale (README「不同機器的 session 互傳訊息」): `node "<root>/scripts/hub.mjs" tree …`. `tree on` exits with status **2** and prints the binding steps when this machine has a bot whose owner has not bound a Telegram account yet (send `!bind` in the bot's chat, open the link on a phone running Tailscale) — tell the user, and run `tree on` again once bound. Refused with the old multi-machine settings. Never run any `tailscale serve` command yourself.

## join `<hub URL> [--name <name>]` | `tree <parent URL> [--name <name>]`
- Hub / edge: check first that the hub runs Myna 0.20.0+ with `MYNA_REMOTE_PORT` and a tunnel, and that this machine's `~/.myna/.env` already has `MYNA_CF_ACCESS_CLIENT_ID` / `MYNA_CF_ACCESS_CLIENT_SECRET` when the hub is behind Cloudflare Access (the user puts them there themselves).
  1. `node "<root>/scripts/join.mjs" <hub URL> [--name <name>] --no-wait` — prints a confirmation code. Tell the user the phone now shows「🆕 <name> 要加入，核對碼 …」: tap **✅ 允許** only if the code is the same. They have 10 minutes.
  2. `node "<root>/scripts/join.mjs" --wait` — waits for the tap (give it a long timeout, about 10 minutes). On ✅ it saves the machine token, writes `MYNA_ROLE=edge` and `MYNA_UPSTREAM` and starts the edge relay. Report; `/health` should show `"role":"edge"` and `upstream.reachable: true`.
- Tree: `node "<root>/scripts/join.mjs" tree <parent URL> [--name <name>] --no-wait` (the parent URL is `https://<the parent's MagicDNS name>:<port>`, 8443 unless changed). Status **2** means this machine's bot owner must bind first (as in `hub tree on`). Otherwise it prints a code: the parent owner's phone shows「🆕 新節點要接到這台下面」— tap ✅ only if the code matches; or, when the parent has no bot that can confirm, run `$myna:manage machines approve <code>` on the parent. Then `node "<root>/scripts/join.mjs" tree --wait` (long timeout); on approval it writes `MYNA_TRANSPORT=tree` and restarts the relay.
- Only a human tap issues the token; autopilot never answers a join request. Denied or expired → run it again (one new request per minute).

## machines [`list` | `revoke <name>` | `approve [code]`] (default `list`)
On the hub (or a tree parent): `node "<root>/scripts/machines.mjs" <args>`. `list` — joined machines (and tree nodes); `revoke <name>` — its token stops working at once, its open questions are cancelled; `approve [code]` — only for a tree join request that could not go to a phone: without a code it lists what waits (compare the code with the joining machine's terminal first), with a code it lets that node in.

## bind [`list` | `remove <telegram:<id> | tailscale:<login> | 編號>`] (default `list`)
`node "<root>/scripts/bind.mjs" <args>` — tree mode's IM bindings (which Telegram account may press the buttons that matter for which Tailscale identity). Binding itself is only done from the phone (`!bind` in the bot's chat); there is no "add" here.

Not here in the Codex version: `godmode` (turn it on or off from Claude Code's `/myna:godmode`, or run `node "<root>/scripts/godmode.mjs" on|off` yourself in a terminal — it is the user's decision, never the AI's), `service` (the login start; set it up from Claude Code's `/myna:service on` on a machine that has Claude Code), and the chat-related commands.
