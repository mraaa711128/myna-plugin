---
description: Myna 常駐 — 登入後自動啟動 relay，不用開 Claude Code（on / off / status；macOS launchd、Windows 工作排程器、Linux systemd --user）
argument-hint: "[on|off|status]"
---
Turn the login start of this machine's Myna relay on or off, or show its state, and report the result.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/service.mjs" $ARGUMENTS`

The same script is the CLI for machines without Claude Code: `node <myna>/scripts/service.mjs on|off|status` (plain node, no npm install).

- `on` → writes `~/.myna/service/start.mjs` (a fixed small file) and `~/.myna/service/service.json` (`root` = this myna, `version`, `node` = this node's absolute path, `env` = `MYNA_ENV` when set), registers "run start.mjs at login" with the OS (macOS `~/Library/LaunchAgents/com.myna.relay.plist` via `launchctl bootstrap`; Windows `schtasks /Create /TN "Myna relay" /SC ONLOGON … /F`; Linux `~/.config/systemd/user/myna-relay.service` + `systemctl --user enable`), and makes sure the relay runs now. At login, start.mjs runs this myna's `ensure-relay` — the same start as a SessionStart hook. Running `on` again re-registers (also how to switch node or checkout).
- `off` → takes the OS registration away, then deletes `~/.myna/service/`. **The running relay is not stopped** (it may be serving sessions): to stop it, `/myna:relay stop`. If the OS refuses, nothing is deleted and the OS error is shown.
- no argument / `status` → registered or not, where service.json points (and whether those paths still exist), whether the relay answers `/health` (version, pid, started_at), and where to look when the login start fails.

After a plugin upgrade, the next SessionStart points service.json at the newer plugin by itself (never back to an older one); the OS registration is not touched.

Show the script's output to the user in a few lines, in Traditional Chinese. If `on` fails with an OS error (for example access denied on Windows), show the error and stop; do not retry another way.
