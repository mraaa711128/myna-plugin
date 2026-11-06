---
description: On the Myna hub — list the machines that joined, or revoke one (its token stops working at once)
argument-hint: "[list | revoke <name>]"
---
Run on the **hub** (the machine whose relay owns the bot): `node "${CLAUDE_PLUGIN_ROOT}/scripts/machines.mjs" $ARGUMENTS` (default `list`).

- **list** — every machine in `~/.myna/machines.json`: name, id, OS, host name, when it joined, when it was last seen and from where (behind Cloudflare: the client IP Cloudflare reports), its Myna version (an edge older than 0.21.0 sends none and is marked as not able to forward chat — it should update), or when it was revoked.
- **revoke <name>** — the machine's token stops working on its next request; within a few seconds the running relay also cancels that machine's open questions (the phone's buttons are retracted), drops its approvals and closes its chat sessions (their topics become 🔒). No relay restart. To bring the machine back, run `/myna:join` on it again.

Machines are only ever added by `/myna:join` on the joining machine plus a ✅ tap on the phone — there is no "add" here. Report the output in 繁體中文.
