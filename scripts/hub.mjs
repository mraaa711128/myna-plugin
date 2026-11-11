#!/usr/bin/env node
// Make THIS machine the Myna hub other machines join (/myna:join) — or stop being one. Run on the hub.
//   hub.mjs [status]          read-only: the relay's role and remote listener (/health), how many
//                             machines joined (machines.json), and where the tunnel must point
//   hub.mjs on [--name <n>]   ~/.myna/.env gets MYNA_REMOTE_PORT=7801 only when it has none (a port
//                             already there is kept), and MYNA_MACHINE_NAME=<n> with --name; then the
//                             relay restarts (ensure-relay --force — open gates carry over through the
//                             journal) and /health's `remote` is printed
//   hub.mjs off               MYNA_REMOTE_PORT out of .env, relay restarts. machines.json is kept, so
//                             the machines that joined work again after the next `on`
// `on` refuses — .env untouched — on an edge (MYNA_ROLE=edge) and when no bot is configured (the hub
// owns the bot). It only writes config and restarts: the tunnel and Cloudflare Access are set up by
// hand (README), and the relay's own behavior does not change.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { loadEnv, roleOf, machinesFile, NAME_RE, updateEnvFile } from "../src/remote.mjs";

const DEFAULT_REMOTE_PORT = "7801";
const cfg = loadEnv();
const envPath = cfg.MYNA_ENV;
const relayPort = Number(process.env.RELAY_PORT || 7800); // same as ensure-relay / stop-relay
const argv = process.argv.slice(2);
const cmd = String(argv[0] || "status").toLowerCase();
const USAGE = "用法：hub.mjs [status] | on [--name <名稱>] | off";
const fail = (m) => { console.error(`myna hub：${m}`); process.exit(1); };

// .env editing — the same set / unset as configure.mjs
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const fileValue = (k) => { const m = new RegExp(`^${k}=(.*)$`, "m").exec(env); return m ? m[1].trim() : ""; };
const set = (k, v) => {
  const re = new RegExp(`^${k}=.*$`, "m");
  if (re.test(env)) env = env.replace(re, `${k}=${v}`);
  else env += (env && !env.endsWith("\n") ? "\n" : "") + `${k}=${v}\n`;
};
const unset = (k) => { env = env.replace(new RegExp(`^${k}=.*\\n?`, "m"), ""); };
// a change: read .env again under its lock, decide and edit on that (change() returns whether to write),
// so a change another program makes to it at the same time is not lost
const edit = (change) => {
  try { updateEnvFile(envPath, (text) => { env = text; return change() ? env : undefined; }); }
  catch (e) { fail(`${envPath} 寫不進去（${e.message}）。`); }
};

async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${relayPort}/health`, { signal: AbortSignal.timeout(1000) });
    const j = await r.json();
    return j && j.name === "myna-relay" ? j : null;
  } catch { return null; }
}
const tunnelHint = (port) => `提醒：tunnel 要指到 http://127.0.0.1:${port}，不能指到 ${relayPort}（${relayPort} 收到帶代理標頭的請求一律回 403）。`;

// ensure-relay --force, then wait for the new relay (another pid) and — when on — its remote listener
async function restart(wantRemote) {
  const before = await health();
  const ensure = path.join(path.dirname(fileURLToPath(import.meta.url)), "ensure-relay.mjs");
  const out = spawnSync(process.execPath, [ensure, "--force"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  process.stdout.write(out.stdout || ""); process.stderr.write(out.stderr || "");
  const until = Date.now() + 10000;
  let h = null;
  while (Date.now() < until) {
    h = await health();
    const fresh = h && (!before || h.pid !== before.pid);
    if (fresh && (!wantRemote || !h.remote || h.remote.listening)) break;
    await sleep(150);
  }
  if (!h || (before && h.pid === before.pid)) fail(`relay 沒有重新啟動（127.0.0.1:${relayPort}）。看上面 ensure-relay 的訊息和 ${path.join(path.dirname(envPath), "relay.log")}。`);
  console.log(`remote: ${JSON.stringify(h.remote ?? null)}`);
  return h;
}

if (cmd === "on") {
  let name;
  const i = argv.indexOf("--name");
  if (i >= 0) {
    const raw = argv[i + 1];
    if (!raw || raw.startsWith("--")) fail(`--name 後面要接名稱。${USAGE}`);
    name = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16); // same as join.mjs
    if (!NAME_RE.test(name)) fail(`--name 要是 1–16 個 a-z 0-9 -（收到 "${raw}"）`);
  }
  // refuse before writing anything
  if (roleOf(cfg) === "edge") fail(`這台是 edge（MYNA_ROLE=edge，已加入 ${cfg.MYNA_UPSTREAM || "另一台主節點"}），不能同時當主節點。沒有改任何設定。要改回主節點，先從 ${envPath} 拿掉 MYNA_ROLE 和 MYNA_UPSTREAM。`);
  const hasBot = cfg.TELEGRAM_BOT_TOKEN ||
    (cfg.DISCORD_BOT_TOKEN && cfg.DISCORD_CHANNEL_ID) ||
    (cfg.SLACK_BOT_TOKEN && cfg.SLACK_APP_TOKEN && cfg.SLACK_CHANNEL_ID); // same test as ensure-relay
  if (!hasBot) fail(`這台沒有設定 bot，主節點一定要有 bot（其他機器的題目都送到這支 bot）。沒有改任何設定。先跑 /myna:setup。`);

  let had;
  edit(() => {
    had = fileValue("MYNA_REMOTE_PORT");
    if (!had) set("MYNA_REMOTE_PORT", DEFAULT_REMOTE_PORT);
    if (name) set("MYNA_MACHINE_NAME", name);
    return !had || !!name;
  });
  const port = had || DEFAULT_REMOTE_PORT;
  console.log(`myna hub：${envPath} — MYNA_REMOTE_PORT=${port}${had ? "（保留原本的值）" : "（新增）"}${name ? `、MYNA_MACHINE_NAME=${name}` : ""}`);
  const h = await restart(true);
  const log = path.join(path.dirname(envPath), "relay.log");
  if (!h.remote) fail(`relay 重啟了，但遠端 listener 沒有開：MYNA_REMOTE_PORT=${port} 可能不是有效的 port，或跟 RELAY_PORT 一樣。看 ${log}。`);
  if (!h.remote.listening) fail(`relay 重啟了，但遠端 listener 沒有在聽 :${h.remote.port}（port 被佔用？）。看 ${log}。`);
  console.log(tunnelHint(h.remote.port));
  console.log("其他機器用 /myna:join <這台的網址> --name <名稱> 加入；/myna:machines 看已加入的機器。");
  process.exit(0);
}

if (cmd === "off") {
  // an environment variable wins over .env (and the relay inherits it): removing the line would not help
  if (String(process.env.MYNA_REMOTE_PORT ?? "").trim()) fail(`MYNA_REMOTE_PORT=${process.env.MYNA_REMOTE_PORT} 是環境變數設定的，優先於 .env，拿掉 .env 那行也關不掉。先移除這個環境變數。沒有改任何設定。`);
  let had;
  edit(() => {
    had = fileValue("MYNA_REMOTE_PORT");
    unset("MYNA_REMOTE_PORT");
    return !!had;
  });
  console.log(`myna hub：${had ? `已從 ${envPath} 拿掉 MYNA_REMOTE_PORT=${had}` : `${envPath} 本來就沒有 MYNA_REMOTE_PORT`}。${path.basename(machinesFile(cfg))} 保留，之後再 on 時已加入的機器照舊有效。`);
  const h = await restart(false);
  if (h.remote) fail(`relay 重啟了，但遠端 listener 還開著（remote.port ${h.remote.port}）。看 ${path.join(path.dirname(envPath), "relay.log")}。`);
  process.exit(0);
}

if (cmd === "status") {
  // read-only: nothing here writes a file
  const h = await health();
  const machines = (() => { try { const j = JSON.parse(fs.readFileSync(machinesFile(cfg), "utf8")); return Array.isArray(j?.machines) ? j.machines : []; } catch { return []; } })();
  const active = machines.filter((m) => !m.revoked_at).length;
  if (!h) console.log(`relay 沒有在跑（127.0.0.1:${relayPort} 沒有回應）。/myna:relay start 啟動。`);
  else {
    console.log(`role: ${h.role || "hub"}`);
    console.log(`remote: ${JSON.stringify(h.remote ?? null)}`);
  }
  console.log(`已加入的機器：${active} 台${machines.length > active ? `（另有 ${machines.length - active} 台已撤銷）` : ""}（${machinesFile(cfg)}）`);
  const role = h?.role || roleOf(cfg);
  if (role === "edge") console.log(`這台是 edge（加入了 ${cfg.MYNA_UPSTREAM || "?"}），不是主節點。`);
  else {
    if (h && !h.remote) console.log("遠端 listener 沒有開：/myna:hub on 開啟。");
    console.log(tunnelHint(h?.remote?.port || fileValue("MYNA_REMOTE_PORT") || DEFAULT_REMOTE_PORT));
  }
  process.exit(0);
}

console.error(USAGE);
process.exit(1);
