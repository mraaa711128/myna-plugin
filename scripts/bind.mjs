#!/usr/bin/env node
// IM bindings of this relay (tree transport, SPEC §5.4): which Telegram account may press the important
// buttons (✅ approvals, permission allow, a node's join) for which Tailscale identity.
//   bind.mjs [list]                 every binding: Telegram account → tailscale:<login>, when
//   bind.mjs remove <what>          drop the bindings of a Telegram account (telegram:<id>), of an identity
//                                   (tailscale:<login>), or number <n> of the list. Takes effect on the next tap.
// A binding is only ever made from the phone: "!bind" in the bot's chat, then the link opened on a device
// in the tailnet — there is no "add" here.
import { loadEnv, mynaDir } from "../src/remote.mjs";
import { nodeFiles, readBindings, saveBindings } from "../src/node.mjs";

const cfg = loadEnv();
const file = nodeFiles(cfg, mynaDir(cfg)).bindings;
const [cmd = "list", arg] = process.argv.slice(2);
const list = readBindings(file);

if (cmd === "list") {
  if (!list.length) { console.log(`沒有任何綁定（${file}）。在 bot 的聊天室傳 !bind，用開著 Tailscale 的手機打開回來的連結。`); process.exit(0); }
  console.log(`IM 綁定（${file}）：`);
  list.forEach((b, i) => console.log(`  ${i + 1}. ${b.im}（${b.name || "?"}）→ ${b.identity}　${b.at || ""}`));
  process.exit(0);
}
if (cmd === "remove") {
  if (!arg) { console.error("用法：bind.mjs remove <telegram:<id> | tailscale:<login> | 編號>"); process.exit(1); }
  const key = String(arg).trim().toLowerCase();
  const n = /^\d+$/.test(key) ? Number(key) : 0;
  const keep = list.filter((b, i) => !(n ? i + 1 === n : b.im.toLowerCase() === key || b.identity.toLowerCase() === key));
  if (keep.length === list.length) { console.error(`沒有符合「${arg}」的綁定 — 用 bind.mjs list 看`); process.exit(1); }
  saveBindings(file, keep);
  console.log(`已移除 ${list.length - keep.length} 筆綁定；之後那個帳號按要緊的鈕不算，要再傳 !bind 重新綁定。`);
  process.exit(0);
}
console.error("用法：bind.mjs [list] | remove <telegram:<id> | tailscale:<login> | 編號>");
process.exit(1);
