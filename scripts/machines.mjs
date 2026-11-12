#!/usr/bin/env node
// Machines registered with THIS hub (~/.myna/machines.json) — run on the hub itself.
//   machines.mjs list            name, id, OS, host, joined, last seen (and from where), its Myna version, revoked
//                                 (an edge older than 0.21.0 sends no version: it cannot forward chat)
//   machines.mjs revoke <name|id> the machine's token stops working at once; the running relay notices
//                                 the change within seconds, cancels that machine's open questions
//                                 (buttons retracted) and drops its approvals. No restart needed.
// A machine joins from its own terminal (/myna:join) and a human taps ✅ on the phone — there is no
// "add" here on purpose: a token is only ever issued through that tap.
// Tree transport (SPEC §5.4): the nodes joined under this one (node-children.json) are listed and revoked
// here too, and `approve <code>` lets one in from this machine's terminal when its join request could not go
// to a phone (no bot, or no Telegram account bound to the owner). `approve` alone lists what waits.
import fs from "node:fs";
import { loadEnv, machinesFile, seenFile, machineStore, mynaDir } from "../src/remote.mjs";
import { nodeFiles } from "../src/node.mjs";

const cfg = loadEnv();
const file = machinesFile(cfg);
const [cmd = "list", arg] = process.argv.slice(2);
const store = machineStore(file);
const treeFile = nodeFiles(cfg, mynaDir(cfg)).children;
const tree = fs.existsSync(treeFile) ? machineStore(treeFile) : null;
const RELAY = `http://127.0.0.1:${Number(cfg.RELAY_PORT || 7800)}`;

if (cmd === "approve") {
  let j;
  try { j = await (await fetch(`${RELAY}/node/joins`, { signal: AbortSignal.timeout(3000) })).json(); }
  catch (e) { console.error(`the local relay does not answer (${e.cause?.code || e.message}) — /myna:relay start`); process.exit(1); }
  if (!Array.isArray(j?.joins)) { console.error("this relay takes no tree nodes (/myna:hub tree on)"); process.exit(1); }
  if (!arg) {
    if (!j.joins.length) { console.log("no tree join request is waiting"); process.exit(0); }
    console.log("tree join requests waiting (compare the code with the joining machine's terminal before approving):");
    for (const x of j.joins) console.log(`  ${x.code}  ${x.name.padEnd(16)} device ${x.device}  ${x.account}  ${x.os}, host ${x.hostname}  ${x.approve === "phone" ? "(on the phone — tap ✅ there)" : "(approve here)"}  until ${x.expires_at}`);
    process.exit(0);
  }
  let secret = "";
  try { secret = fs.readFileSync(cfg.MYNA_RELAY_SECRET_FILE || `${mynaDir(cfg)}/relay-secret`, "utf8").trim(); } catch {}
  const hit = j.joins.find((x) => x.code === String(arg).toUpperCase());
  if (hit) console.log(`approving ${hit.name}: device ${hit.device}, ${hit.account}, ${hit.os}, host ${hit.hostname}`);
  const r = await fetch(`${RELAY}/node/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ code: arg }), signal: AbortSignal.timeout(5000) });
  const out = await r.json().catch(() => ({}));
  if (r.status !== 200 || !out.ok) { console.error(`not approved: ${out.error || `HTTP ${r.status}`}`); process.exit(1); }
  console.log(`approved: ${out.name} joined under this node (owner ${out.owner})`);
  process.exit(0);
}
const seen = (() => { try { return JSON.parse(fs.readFileSync(seenFile(cfg), "utf8")) || {}; } catch { return {}; } })();
// a < b for dotted versions ("0.20.4" < "0.21.0")
const older = (a, b) => { const x = String(a).split(/[.+-]/).map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };

if (cmd === "list") {
  const all = store.all();
  if (tree) {
    const kids = tree.all();
    console.log(`tree nodes joined under this one (${treeFile}):${kids.length ? "" : " none"}`);
    for (const m of kids) console.log(`  ${m.name.padEnd(16)} ${m.id}  device ${m.tailnet?.name || "?"} (${m.tailnet?.stable_id || "?"})  ${m.login ? `tailscale:${m.login}` : `tagged ${(m.tags || []).join(",")}, owner ${m.owner}`}  joined ${m.created_at || "?"}${m.revoked_at ? `  revoked ${m.revoked_at}` : ""}`);
    if (!all.length) process.exit(0);
  }
  if (!all.length) { console.log(`no machines registered (${file}) — another machine joins with /myna:join <this hub's URL> --name <name>`); process.exit(0); }
  console.log(`machines registered with this hub (${file}):`);
  for (const m of all) {
    const s = seen[m.id] || {};
    const state = m.revoked_at ? `revoked ${m.revoked_at}` : s.last_seen_at ? `last seen ${s.last_seen_at}${s.last_addr ? ` from ${s.last_addr}` : ""}` : "never seen";
    const ver = m.revoked_at || !s.last_seen_at ? "" : s.version && !older(s.version, "0.21.0") ? `  v${s.version}` : `  ${s.version ? `v${s.version}` : "older than 0.21.0"} — 不支援轉送聊天 (update its Myna to 0.21.0+)`;
    console.log(`  ${m.name.padEnd(16)} ${m.id}  ${m.os || "?"}  host ${m.hostname || "?"}  joined ${m.created_at || "?"}  ${state}${ver}`);
  }
  process.exit(0);
}
if (cmd === "revoke") {
  if (!arg) { console.error("usage: machines.mjs revoke <name|id>"); process.exit(1); }
  let hit = store.revoke(arg);
  if (!hit.length && tree) hit = tree.revoke(arg); // a tree node: its token stops working; the relay ends its link within seconds
  if (!hit.length) { console.error(`no active machine named or with id "${arg}" — see machines.mjs list`); process.exit(1); }
  for (const m of hit) console.log(`revoked ${m.name} (${m.id}) — its token no longer works; the relay cancels its open questions within a few seconds`);
  process.exit(0);
}
console.error("usage: machines.mjs list | revoke <name|id> | approve [code]");
process.exit(1);
