#!/usr/bin/env node
// Machines registered with THIS hub (~/.myna/machines.json) — run on the hub itself.
//   machines.mjs list            name, id, OS, host, joined, last seen (and from where), revoked
//   machines.mjs revoke <name|id> the machine's token stops working at once; the running relay notices
//                                 the change within seconds, cancels that machine's open questions
//                                 (buttons retracted) and drops its approvals. No restart needed.
// A machine joins from its own terminal (/myna:join) and a human taps ✅ on the phone — there is no
// "add" here on purpose: a token is only ever issued through that tap.
import fs from "node:fs";
import { loadEnv, machinesFile, seenFile, machineStore } from "../src/remote.mjs";

const cfg = loadEnv();
const file = machinesFile(cfg);
const [cmd = "list", arg] = process.argv.slice(2);
const store = machineStore(file);
const seen = (() => { try { return JSON.parse(fs.readFileSync(seenFile(cfg), "utf8")) || {}; } catch { return {}; } })();

if (cmd === "list") {
  const all = store.all();
  if (!all.length) { console.log(`no machines registered (${file}) — another machine joins with /myna:join <this hub's URL> --name <name>`); process.exit(0); }
  console.log(`machines registered with this hub (${file}):`);
  for (const m of all) {
    const s = seen[m.id] || {};
    const state = m.revoked_at ? `revoked ${m.revoked_at}` : s.last_seen_at ? `last seen ${s.last_seen_at}${s.last_addr ? ` from ${s.last_addr}` : ""}` : "never seen";
    console.log(`  ${m.name.padEnd(16)} ${m.id}  ${m.os || "?"}  host ${m.hostname || "?"}  joined ${m.created_at || "?"}  ${state}`);
  }
  process.exit(0);
}
if (cmd === "revoke") {
  if (!arg) { console.error("usage: machines.mjs revoke <name|id>"); process.exit(1); }
  const hit = store.revoke(arg);
  if (!hit.length) { console.error(`no active machine named or with id "${arg}" — see machines.mjs list`); process.exit(1); }
  for (const m of hit) console.log(`revoked ${m.name} (${m.id}) — its token no longer works; the relay cancels its open questions within a few seconds`);
  process.exit(0);
}
console.error("usage: machines.mjs list | revoke <name|id>");
process.exit(1);
