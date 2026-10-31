---
description: Publish a shareable Artifact digest of this project's Myna gate decisions (review / override autopilot picks)
---
Build a review digest of Myna's gate decisions and publish it as an Artifact.

1. Read `MYNA-DECISIONS.jsonl` from the current project directory (each line is one decision: `{ts, machine, mode, header, question, options, recommendedIndex?, chosen}`). If it is missing, tell the user there are no decisions yet and stop.
2. Render a self-contained HTML page: a table of decisions newest-first, with **auto** rows visually distinct from **human** rows, showing header, question, the full options list with the chosen one highlighted, machine, and time. Add a small summary header (counts of auto vs human).
3. Publish it with the Artifact tool (favicon 🐦, title "Myna decisions"). Return the link.
4. Remind the user that any `auto` decision they disagree with can be overridden by re-running the affected step with autopilot off.

Note: publishing an Artifact sends the decision content to claude.ai (hosted). If the decisions are sensitive, offer to skip publishing and just print the digest locally instead.
