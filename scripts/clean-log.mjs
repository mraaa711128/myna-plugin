#!/usr/bin/env node
// Remove this project's Myna decision log (MYNA-DECISIONS.jsonl/.md) from a dir (default cwd).
// Used at pipeline closeout to drop a run's audit trail before merge. Myna owns which files exist.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || process.cwd();
let removed = 0;
for (const f of ["MYNA-DECISIONS.jsonl", "MYNA-DECISIONS.md"]) {
  const p = path.join(dir, f);
  if (fs.existsSync(p)) { fs.rmSync(p); console.log(`removed ${p}`); removed++; }
}
if (!removed) console.log(`no decision log in ${dir}`);
