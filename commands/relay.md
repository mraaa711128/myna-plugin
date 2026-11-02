---
description: Manage the Myna relay daemon — start / stop / restart / status (auto-starts on SessionStart, this is manual control)
argument-hint: "[start|stop|restart|status]"
---
Manage this machine's Myna relay daemon (owns the single IM connection — Telegram getUpdates / Discord Gateway / Slack Socket Mode). It auto-starts on
SessionStart; use this for manual control. Read `$ARGUMENTS` (default: `start`):

- **start** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-relay.mjs"` — idempotent; starts it detached if nothing is listening. If a relay of an **older plugin version** is on the port (left over from before an upgrade), it is shut down and replaced with this version — unless it still has an open gate, in which case the script says so and leaves it (use `restart` once the gate is answered). A relay **newer** than this plugin is left running (another session uses a newer plugin; this one should `/plugin update`) — the script says so.
- **stop** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-relay.mjs"` — asks the relay to shut down via its local `/shutdown` endpoint.
- **restart** — `node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-relay.mjs" --force` — replaces whatever is on the port with this plugin version's relay — **including a relay of the same version** — even if it has an open gate (a 0.7.2+ relay hands open gates over through its journal; only an older one's gate falls back to the terminal picker). Use after a plugin upgrade or after editing `~/.myna/.env`.
- **status** — `curl -s http://127.0.0.1:7800/health` (or a quick fetch): JSON `{version, provider, pid, root, started_at, pending}` = running (compare `version` with this plugin's version — older means a stale relay, run `restart`; newer means this plugin is the stale one, run `/plugin update`); a non-JSON response = a pre-0.7.2 relay (stale, run `restart`); connection refused = not running. Also mention `~/.myna/relay.log`.

On a machine joined to a hub (`MYNA_ROLE=edge` in `~/.myna/.env`, see `/myna:join`) the same commands manage its relay running as an **edge** (forwards to the hub, its own bot — if any — is the fallback; `/health` shows `"role":"edge"`, `upstream.reachable` / `upstream.active` / `upstream.reason` and `own_bot` — report those too).

The relay must be running whenever a pipeline might fire a gate; if it is down, `ask_human` returns `unreachable` and the orchestrator falls back to the local terminal gate. Report the resulting state, in 繁體中文.
