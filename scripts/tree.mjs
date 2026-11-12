#!/usr/bin/env node
// The tree transport's setup (SPEC §5.4) — reached through the explicit subcommands of the old commands,
// which keep their meaning without them:
//   hub.mjs tree [status]            read-only: this relay's tree state (/health `node`)
//   hub.mjs tree on [--name <n>]     this node takes children: MYNA_NODE_PORT (7802 unless set) in .env,
//                                    (--name: MYNA_MACHINE_NAME, its name in addresses nick@<n>; a top node only),
//                                    `tailscale serve --bg --proxy-protocol=1 --tls-terminated-tcp=<serve>
//                                    tcp://127.0.0.1:<port>`, relay restarted. With a bot, the owner binds a
//                                    Telegram account first (exit 2 with how, run it again after); then
//                                    MYNA_TRANSPORT=tree and a restart.
//   hub.mjs tree off                 MYNA_TRANSPORT and MYNA_NODE_PORT out of .env, that one serve entry off
//                                    (never `serve reset`), relay restarted. node-children.json and the
//                                    bindings stay.
//   join.mjs tree <parent URL> [--name <n>] [--no-wait]   ask the parent (https://<its MagicDNS name>:<port>)
//   join.mjs tree --wait             wait for its ✅ (or /myna:machines approve <code> there); then the node
//                                    token (~/.myna/node-token), node-parent.json, MYNA_TRANSPORT=tree, restart
// Refused — .env untouched — where the old multi-machine settings are on (MYNA_ROLE=edge, MYNA_REMOTE_PORT):
// one machine runs the old hub/edge or the tree. Every tailscale call goes through src/tailscale.mjs
// (MYNA_TAILSCALE_CLI); the only setting changed there is this node's own serve entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { loadEnv, mynaDir, roleOf, NAME_RE, ENROLL_SECRET_HEADER, newJoinCode, sha256hex, writePrivate, updateEnvFile, botIdentity } from "../src/remote.mjs";
import { createTailscale } from "../src/tailscale.mjs";
import { nodeFiles, treeSettings, readJson, DEFAULT_NODE_PORT, NODE_PROTOCOL } from "../src/node.mjs";

const cfg = loadEnv();
const envPath = cfg.MYNA_ENV;
const dir = mynaDir(cfg);
const F = nodeFiles(cfg, dir);
const S = treeSettings(cfg);
const relayPort = Number(cfg.RELAY_PORT || 7800);
const ts = createTailscale(cfg, { timeoutMs: 15000 });
const STATE = path.join(dir, "node-join-pending.json");
const fail = (m, code = 1) => { console.error(`myna tree：${m}`); process.exit(code); };
const say = (m) => console.log(`myna tree：${m}`);
// which bot the relay will run — its own rule: MYNA_PROVIDER when set (null if its keys are missing), else the
// first configured in the order telegram → discord → slack
const KEYS = { telegram: () => !!cfg.TELEGRAM_BOT_TOKEN, discord: () => !!(cfg.DISCORD_BOT_TOKEN && cfg.DISCORD_CHANNEL_ID), slack: () => !!(cfg.SLACK_BOT_TOKEN && cfg.SLACK_APP_TOKEN && cfg.SLACK_CHANNEL_ID) };
const botKind = () => {
  const want = String(cfg.MYNA_PROVIDER || "").trim().toLowerCase();
  if (want) return KEYS[want]?.() ? want : null;
  return Object.keys(KEYS).find((k) => KEYS[k]()) || null;
};
function refuseOld() {
  if (roleOf(cfg) === "edge") fail(`這台是舊的 edge（MYNA_ROLE=edge，加入了 ${cfg.MYNA_UPSTREAM || "?"}），同一台只能用舊的 hub/edge 或 tree 其中一種。沒有改任何設定。`);
  if (String(cfg.MYNA_REMOTE_PORT ?? "").trim()) fail(`這台開著舊的主節點遠端 listener（MYNA_REMOTE_PORT=${String(cfg.MYNA_REMOTE_PORT).trim()}），同一台只能用舊的 hub/edge 或 tree 其中一種。先 /myna:hub off。沒有改任何設定。`);
}
function editEnv(set = {}, unset = []) {
  updateEnvFile(envPath, (text) => {
    let env = text;
    for (const k of unset) env = env.replace(new RegExp(`^${k}=.*\\n?`, "m"), "");
    for (const [k, v] of Object.entries(set)) { const re = new RegExp(`^${k}=.*$`, "m"); env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + (env && !env.endsWith("\n") ? "\n" : "") + `${k}=${v}\n`; }
    return env;
  });
}
async function health() {
  try { const j = await (await fetch(`http://127.0.0.1:${relayPort}/health`, { signal: AbortSignal.timeout(1500) })).json(); return j?.name === "myna-relay" ? j : null; } catch { return null; }
}
// ensure-relay --force, then wait for a new relay whose /health satisfies ok()
async function restart(ok, what) {
  const before = await health();
  const ensure = path.join(path.dirname(fileURLToPath(import.meta.url)), "ensure-relay.mjs");
  const out = spawnSync(process.execPath, [ensure, "--force"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  process.stdout.write(out.stdout || ""); process.stderr.write(out.stderr || "");
  const until = Date.now() + 20000;
  let h = null;
  while (Date.now() < until) {
    h = await health();
    if (h && (!before || h.pid !== before.pid) && ok(h)) return h;
    await sleep(200);
  }
  fail(`relay 重啟後沒有${what}（127.0.0.1:${relayPort}）。看上面的訊息和 ${path.join(dir, "relay.log")}。${h?.node ? `\nnode: ${JSON.stringify(h.node)}` : ""}`);
}
async function me() {
  const s = await ts.self();
  if (!s) fail(`問不到這台的 Tailscale（${ts.lastError() || "?"}）。確認 Tailscale 已安裝、登入、在線；CLI：${ts.cli()}（找不到時設 MYNA_TAILSCALE_CLI）。沒有改任何設定。`);
  return s;
}
// the serve entry on <serve port>, from `tailscale serve status --json` (TCP.<port>: {TCPForward, TerminateTLS,
// ProxyProtocol}) → null (none) | the entry; status failing or not JSON stops the command (fail closed)
async function serveEntry(servePort) {
  const st = await ts.run(["serve", "status", "--json"]);
  let cur;
  try { cur = st.ok ? JSON.parse(st.out || "{}")?.TCP?.[String(servePort)] ?? null : undefined; } catch { cur = undefined; }
  if (cur === undefined) fail(`讀不到 tailscale serve status（${(st.err || st.out).trim() || "not JSON"}），沒有改任何設定。`);
  return cur;
}
// exactly this node's: TLS terminated, PROXY v1, forwarded to this very listener
const ours = (cur, port) => !!cur && cur.TCPForward === `127.0.0.1:${port}` && Number(cur.ProxyProtocol) === 1 && !!cur.TerminateTLS;
// this node's own `tailscale serve` entry: <serve port> (TLS) → PROXY v1 → 127.0.0.1:<port>. A port already
// serving something else is refused (never overwritten); already ours → nothing to do.
async function serveOn(port, servePort) {
  const cur = await serveEntry(servePort);
  if (cur) {
    if (ours(cur, port)) { say(`tailscale serve :${servePort} → 127.0.0.1:${port} 已經在了`); return; }
    fail(`tailscale serve 的 :${servePort} 已經被別的設定用了（${JSON.stringify(cur)}）。換一個 port：在 ${envPath} 設 MYNA_NODE_SERVE_PORT。`);
  }
  const args = ["serve", "--bg", "--proxy-protocol=1", `--tls-terminated-tcp=${servePort}`, `tcp://127.0.0.1:${port}`];
  const r = await ts.run(args);
  if (!r.ok) fail(`tailscale ${args.join(" ")} 失敗：${(r.err || r.out).trim()}\n（Windows 可能要先開 unattended mode；tailnet 要開 HTTPS 憑證。）`);
  say(`tailscale serve：tailnet :${servePort}（TLS）→ PROXY v1 → 127.0.0.1:${port}`);
}
// turn off this node's own serve entry — only when it still is ours (the port may have been given to something
// else since); a failure stops the command before any setting changes
async function serveOff(port, servePort) {
  const cur = await serveEntry(servePort);
  if (!cur) { say(`tailscale serve :${servePort} 本來就沒有設定`); return; }
  if (!ours(cur, port)) { say(`tailscale serve :${servePort} 現在指到別的地方（${JSON.stringify(cur)}），不是這個節點的，不動它`); return; }
  const r = await ts.run(["serve", `--tls-terminated-tcp=${servePort}`, "off"]);
  if (!r.ok) fail(`tailscale serve :${servePort} 關不掉（${(r.err || r.out).trim()}），沒有改任何設定。用 tailscale serve status 看一下。`);
  say(`tailscale serve :${servePort} 已關掉`);
}
// with a bot: the owner binds a Telegram account before tree mode turns on (M4) — needs the listener (the
// bind link opens through it). Exit 2 with how; the same command again continues.
async function ensureListenerAndBinding(self, { requireBinding }) {
  const port = S.port || DEFAULT_NODE_PORT;
  // without a bot there is nothing to bind and nothing else would start the relay: the mode goes on at once
  if (!S.port || !botKind()) editEnv({ MYNA_NODE_PORT: String(port), ...(botKind() ? {} : { MYNA_TRANSPORT: "tree" }) });
  // the listener first — only once Myna itself holds the port does tailscale serve point the tailnet at it
  // (a port another program holds would otherwise be opened to the tailnet)
  let h = await health();
  if (!h?.node?.listener?.listening || h.node.listener.port !== port) {
    h = await restart((x) => x.node?.listener && (x.node.listener.listening || x.node.listener.error), " 開 tree 的 listener");
    if (!h.node.listener.listening) fail(`這台的 node listener 開不起來（127.0.0.1:${port}：${h.node.listener.error}）— port 被別的程式佔用？在 ${envPath} 換 MYNA_NODE_PORT。tailscale serve 沒有動。`);
  }
  await serveOn(port, S.servePort);
  if (!requireBinding || !botKind()) return h;
  if (botKind() !== "telegram") { say(`這台的 bot 是 ${botKind()}：第 0 批只有 Telegram 能綁定，要緊的鈕（✅ 核准、權限、加入）會退回終端機。`); return h; }
  if (h.node.owner_bound) return h;
  console.log(`\n要先把你的 Telegram 帳號綁到這台的 owner（${h.node.owner || `tailscale:${self.login}`}）：`);
  console.log(`  1. 在 bot 的聊天室傳 !bind`);
  console.log(`  2. 用開著 Tailscale、登入 ${self.login} 的手機打開 bot 回的連結，按「確認綁定」`);
  console.log(`  3. 再跑一次這個指令`);
  process.exit(2);
}

export async function hubTree(argv) {
  const sub = String(argv[0] || "status").toLowerCase();
  if (sub === "status") {
    const h = await health();
    if (!h) { say(`relay 沒有在跑（127.0.0.1:${relayPort}）。`); process.exit(0); }
    if (!h.node) { say("這台沒有設定 tree。/myna:hub tree on 讓這台收下層；/myna:join tree <上層網址> 接到上層。"); process.exit(0); }
    const n = h.node;
    console.log(`tree 模式：${n.tree ? "開" : `關${n.off ? `（${n.off}）` : ""}`}`);
    console.log(`節點名稱：${n.name}　owner：${n.owner || "（查不到）"}`);
    console.log(`Tailscale：${n.tailscale?.error ? `錯誤：${n.tailscale.error}` : `${n.tailscale.dns_name}（${n.tailscale.tagged ? "tagged" : "使用者裝置"}）`}`);
    console.log(`listener：${n.listener ? `127.0.0.1:${n.listener.port} ← tailnet :${n.listener.serve_port}，${n.listener.listening ? "在聽" : `沒在聽${n.listener.error ? `（${n.listener.error}）` : ""}`}` : "沒開"}`);
    console.log(`上層：${n.parent ? `${n.parent.name}（${n.parent.url || "?"}）${n.parent.reachable ? "連得上" : `連不上：${n.parent.reason || "?"}`}` : "沒有"}`);
    console.log(`下層：${n.children} 台${n.joining ? `，${n.joining} 台在等核准（/myna:machines approve）` : ""}`);
    console.log(`IM 綁定：${n.bindings} 筆，owner ${n.owner_bound ? "已綁定" : "還沒綁定（傳 !bind）"}；先給你看才送出：${n.show_first ? "開" : "關"}${n.display_failed ? `；貼不出去而沒交付：${n.display_failed} 則` : ""}`);
    process.exit(0);
  }
  if (sub === "on") {
    refuseOld();
    // --name: this node's name in addresses (nick@<name>) — a top node's own; a joined node's comes from its parent
    const i = argv.indexOf("--name");
    if (i >= 0) {
      const name = String(argv[i + 1] || "").toLowerCase();
      if (!NAME_RE.test(name)) fail(`--name 要是 1–16 個 a-z 0-9 -（收到 "${argv[i + 1] ?? ""}"）`);
      if (readJson(F.parent)) fail("這台已經接在上層下面，名稱是上層核發的（node-parent.json），不能用 --name 改。");
      editEnv({ MYNA_MACHINE_NAME: name });
    }
    const self = await me();
    if (!self.login && !readJson(F.parent)?.owner) fail("這台是 tagged 裝置（沒有使用者帳號），owner 要由上層在加入時指派：先 /myna:join tree <上層網址>。沒有改任何設定。");
    await ensureListenerAndBinding(self, { requireBinding: !!self.login });
    if (i < 0) { const h = await health(); if (h?.node?.tree) { say(`tree 模式已經開著（${h.node.name}，owner ${h.node.owner}）。下層用 /myna:join tree https://${self.dns_name}:${S.servePort} --name <名稱> 加入。`); process.exit(0); } }
    editEnv({ MYNA_TRANSPORT: "tree" });
    const h = await restart((x) => x.node?.tree && x.node?.listener?.listening, " 進入 tree 模式");
    say(`tree 模式開了：這台是 ${h.node.name}，owner ${h.node.owner}。`);
    console.log(`下層用 /myna:join tree https://${self.dns_name}:${S.servePort} --name <名稱> 加入（${h.node.owner_bound ? "手機上按 ✅" : "在這台跑 /myna:machines approve <核對碼>"}）。`);
    process.exit(0);
  }
  if (sub === "off") {
    for (const k of ["MYNA_TRANSPORT", "MYNA_NODE_PORT"]) if (String(process.env[k] ?? "").trim()) fail(`${k} 是環境變數設定的，優先於 .env，關不掉。先移除這個環境變數。沒有改任何設定。`);
    if (S.port) await serveOff(S.port, S.servePort);
    editEnv({}, ["MYNA_TRANSPORT", "MYNA_NODE_PORT"]);
    if (botKind()) await restart((x) => !x.node?.tree, " 離開 tree 模式");
    else {
      // no bot: without the tree this relay has nothing to run (ensure-relay would not start it) — stop it
      try { await fetch(`http://127.0.0.1:${relayPort}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1500) }); } catch {}
      const until = Date.now() + 5000;
      while (Date.now() < until && (await health())) await sleep(150);
      say((await health()) ? "relay 還在跑，用 /myna:relay stop 停掉" : "這台沒有 bot，relay 已停止（tree 模式關掉後它沒有事做）");
    }
    say(`tree 模式關了。${path.basename(F.children)}、綁定檔留著，之後再開照舊有效。${readJson(F.parent) ? "這台接上層的設定（node-parent.json）也留著，tree 模式關著時不會用。" : ""}`);
    process.exit(0);
  }
  fail("用法：hub.mjs tree [status | on | off]");
}

export async function joinTree(argv) {
  const flag = (f) => argv.includes(f);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (flag("--wait")) return waitJoin();
  refuseOld();
  const raw = argv.find((a) => !a.startsWith("--") && a !== opt("--name"));
  if (!raw) fail("用法：join.mjs tree <上層網址> [--name <名稱>] [--no-wait]   |   join.mjs tree --wait");
  let u; try { u = new URL(raw); } catch { fail(`上層網址看不懂：${raw}`); }
  const self = await me();
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  // the parent is its MagicDNS name: the HTTPS certificate Tailscale issued for it proves the other end
  if (!(u.protocol === "http:" && loop)) {
    if (u.protocol !== "https:") fail(`上層網址要是 https://<上層的 MagicDNS 名稱>:<port>（收到 ${u.protocol}//）`);
    if (!self.suffix || !u.hostname.toLowerCase().endsWith(`.${self.suffix.toLowerCase()}`)) fail(`上層網址的主機要在這個 tailnet 的 MagicDNS 網域底下（*.${self.suffix || "?"}），收到 ${u.hostname}`);
  }
  if (u.username || u.password) fail("上層網址不能帶帳號密碼");
  const url = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  const name = String(opt("--name") || os.hostname().split(".")[0]).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
  if (!NAME_RE.test(name)) fail(`--name 要是 1–16 個 a-z 0-9 -（收到 "${opt("--name") ?? os.hostname()}"）`);
  // a bot here: its owner binds a Telegram account before the tree mode turns on (M4; exit 2 with how).
  // A tagged device learns its owner only from the parent — it binds after joining.
  if (self.login && botKind()) await ensureListenerAndBinding(self, { requireBinding: true });
  const secret = crypto.randomBytes(32).toString("base64url"), code = newJoinCode();
  const osName = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform;
  const bk = botKind();
  let r, j;
  try {
    r = await fetch(`${url}/node/join`, { method: "POST", headers: { "content-type": "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ name, os: osName, hostname: os.hostname(), code, enroll_secret_hash: sha256hex(secret), ...(bk ? { bot_id: botIdentity(bk, cfg) } : {}) }) });
    j = await r.json().catch(() => null);
  } catch (e) { fail(`連不到上層 ${url}（${e.cause?.code || e.message}）`); }
  if (r.status !== 202 || !j?.enroll_id) fail(`上層拒絕了：HTTP ${r.status} ${j?.error || ""}`);
  writePrivate(STATE, JSON.stringify({ url, name, enroll_id: j.enroll_id, secret, code, expires_at: j.expires_at }, null, 2) + "\n");
  say(`已請 ${url} 讓「${name}」接到它下面。`);
  console.log(`  核對碼：${code}`);
  console.log(j.approve === "phone" ? `  上層 owner 的手機會出現「🆕 新節點要接到這台下面 … 核對碼 ${code}」— 核對碼一樣再按 ✅ 允許（要用綁定過的 Telegram 帳號；${j.expires_at} 前）。`
    : `  上層沒有能確認的 bot：在上層那台跑 /myna:machines approve ${code}（${j.expires_at} 前）。`);
  if (flag("--no-wait")) { console.log("  然後執行 join.mjs tree --wait 等核准。"); process.exit(0); }
  return waitJoin();
}

async function waitJoin() {
  let st = readJson(STATE);
  if (!st?.enroll_id) fail(`沒有進行中的加入（${STATE}）— 先跑 join.mjs tree <上層網址> --name <名稱>`);
  refuseOld();
  if (!st.token) {
    const expires = Date.parse(st.expires_at) || Date.now() + 600000;
    for (;;) {
      if (Date.now() > expires + 30000) { fs.rmSync(STATE, { force: true }); fail("加入要求逾時，沒有人核准 — 再跑一次"); }
      let r, j;
      try { r = await fetch(`${st.url}/node/join/${st.enroll_id}`, { headers: { [ENROLL_SECRET_HEADER]: st.secret }, redirect: "manual", signal: AbortSignal.timeout(40000) }); j = await r.json().catch(() => null); }
      catch { await sleep(2000); continue; }
      if (r.status === 404) { fs.rmSync(STATE, { force: true }); fail("上層已經不認得這個加入要求（重啟過，或結果已經拿走）— 再跑一次"); }
      if (r.status !== 200 || j?.status === "pending") { if (r.status !== 200) await sleep(2000); continue; }
      if (j?.status !== "approved" || !j.token) { fs.rmSync(STATE, { force: true }); fail(j?.status === "expired" ? "沒有人及時核准 — 再跑一次" : `被拒絕了${j?.reason ? `（${j.reason}）` : ""}`); }
      // the token is handed out once: keep it before anything else can fail
      st = { ...st, token: j.token, name: j.name, owner: j.owner, parent: j.parent };
      writePrivate(STATE, JSON.stringify(st, null, 2) + "\n");
      break;
    }
  }
  try {
    writePrivate(F.token, `${st.token}\n`);
    writePrivate(F.parent, JSON.stringify({ url: st.url, name: st.name, owner: st.owner, parent: st.parent, node_protocol: NODE_PROTOCOL, joined_at: new Date().toISOString() }, null, 2) + "\n");
    editEnv({ MYNA_TRANSPORT: "tree" });
  } catch (e) { fail(`核准了，但存檔失敗：${e.message}。修好後再跑 join.mjs tree --wait（token 留在 ${STATE}，上層只給一次）。`); }
  fs.rmSync(STATE, { force: true });
  say(`核准了：這台是「${st.name}」，接在 ${st.parent?.name}（${st.url}）下面，owner ${st.owner}。`);
  const h = await restart((x) => x.node?.tree && x.node?.parent?.reachable, " 連上上層");
  say(`relay 已經用 tree 模式連上上層 ${h.node.parent.name}。`);
  const self = await ts.self();
  if (botKind() === "telegram" && !h.node.owner_bound) console.log(`這台的 bot 還沒有綁定 owner（${h.node.owner}）的帳號${self?.login ? "" : "（tagged：owner 是上層指派的）"}：要讓這台的要緊按鈕能按，先 /myna:hub tree on（開 listener 和綁定連結），在 bot 聊天室傳 !bind。`);
  process.exit(0);
}
