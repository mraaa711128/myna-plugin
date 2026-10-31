#!/usr/bin/env node
// Show the last N Myna decisions from MYNA-DECISIONS.jsonl (default: cwd, N=20).
import fs from "node:fs";
import path from "node:path";

const n = Number(process.argv[2] || 20);
const dir = process.argv[3] || process.cwd();
const file = path.join(dir, "MYNA-DECISIONS.jsonl");
if (!fs.existsSync(file)) { console.log(`no decisions log at ${file}`); process.exit(0); }

const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log(`${rows.length} decisions in ${file} — last ${Math.min(n, rows.length)}:\n`);
for (const r of rows.slice(-n)) {
  console.log(`${r.ts}  [${r.mode}]  ${r.header || ""}  "${(r.question || "").slice(0, 60)}"  -> ${JSON.stringify(r.chosen)}`);
}
const auto = rows.filter((r) => r.mode === "auto").length;
console.log(`\n(${auto} auto / ${rows.length - auto} human)`);
