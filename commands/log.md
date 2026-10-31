---
description: Show or clean this project's Myna gate-decision log (MYNA-DECISIONS.jsonl/.md)
argument-hint: "[count] | clean [dir]"
---
Manage this project's Myna decision log. Read `$ARGUMENTS` and branch:

- **`clean [dir]`** — run `node "${CLAUDE_PLUGIN_ROOT}/scripts/clean-log.mjs" <dir>` to delete `MYNA-DECISIONS.jsonl`/`.md` from `<dir>` (default: current project). Use at pipeline closeout to drop a run's decision audit trail before merge.
- **otherwise** (empty or a count) — run `node "${CLAUDE_PLUGIN_ROOT}/scripts/log-tail.mjs" $ARGUMENTS` to show the last N decisions (default 20), summarizing auto vs human. Point out any autopilot (`auto`) picks the user may want to override.

The log lives in the project where the pipeline ran — run this from that directory (or pass the dir to `clean`).
