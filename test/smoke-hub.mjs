#!/usr/bin/env node
// /myna:hub (scripts/hub.mjs) against a real relay. Everything lives in a temp dir (HOME, MYNA_ENV,
// machines.json) and on random ports — never ~/.myna, never :7800. A fake bot token whose API base
// points nowhere: the relay starts and answers /health, nothing reaches a real IM.
//   - on: MYNA_REMOTE_PORT=7801 + MYNA_MACHINE_NAME written, relay restarted, /health has `remote`
//   - on with a port already in .env keeps it
//   - off: MYNA_REMOTE_PORT gone, `remote` null, machines.json untouched
//   - on is refused on an edge and without a bot — .env byte for byte the same, relay not restarted
//   - status writes nothing (relay up and down)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const HUB = path.join(ROOT, "scripts", "hub.mjs");
const STOP = path.join(ROOT, "scripts", "stop-relay.mjs");
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-hub-"));
const used = new Set([7800, 7801]);
const freePort = () => { for (;;) { const p = 20000 + Math.floor(Math.random() * 20000); if (!used.has(p)) { used.add(p); return p; } } };
// a clean env: nothing of the developer's own myna setup leaks into the children
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|CLAUDE_CODE_SESSION_ID$)/.test(k)) delete e[k];
  e.HOME = e.USERPROFILE = path.join(TMP, "home");
  fs.mkdirSync(e.HOME, { recursive: true });
  return e;
})();
const RP = freePort();
const BOT = "TELEGRAM_BOT_TOKEN=123456:FAKE\nTELEGRAM_CHAT_ID=1\nTELEGRAM_API_BASE=http://127.0.0.1:9\n";

const dir = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
const hub = (envFile, args = [], port = RP, extra = {}) => {
  const r = spawnSync(process.execPath, [HUB, ...args], { env: { ...baseEnv, MYNA_ENV: envFile, RELAY_PORT: String(port), ...extra }, encoding: "utf8", timeout: 45000 });
  return { out: ((r.stdout || "") + (r.stderr || "")).trim(), status: r.status };
};
const stop = (envFile, port = RP) => spawnSync(process.execPath, [STOP], { env: { ...baseEnv, MYNA_ENV: envFile, RELAY_PORT: String(port) }, encoding: "utf8", timeout: 10000 });
// a few tries: fetch's keep-alive pool may still hold a socket to the relay that was just replaced
const health = async (port = RP) => {
  for (let i = 0; i < 3; i++) {
    try { return await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).json(); } catch {}
    await sleep(100);
  }
  return null;
};
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
// every file under a dir: path → size, mtime and content (to prove a command wrote nothing)
const snapshot = (d) => {
  const out = {};
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { const s = fs.statSync(f); out[f] = `${s.size}:${s.mtimeMs}:${fs.readFileSync(f, "base64")}`; } } };
  walk(d);
  return JSON.stringify(out);
};
const show = (label, r) => console.log(`[${label}] rc=${r.status}\n${r.out.split("\n").map((l) => `    ${l}`).join("\n")}`);

const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 150s"); process.exit(1); }, 150000);
const H = dir("hub"), ENV = path.join(H, ".env"), MACHINES = path.join(H, "machines.json");
process.on("exit", () => { try { stop(ENV); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

try {
  // the hub's .env: a bot, no remote yet; machines.json: one machine joined, one revoked
  fs.writeFileSync(ENV, BOT);
  fs.writeFileSync(MACHINES, JSON.stringify({ version: 1, machines: [
    { id: "aaaaaaaaaaaa", name: "mbp", sha256: "0".repeat(64), os: "macOS", hostname: "mbp", created_at: "2026-11-01T00:00:00.000Z" },
    { id: "bbbbbbbbbbbb", name: "old", sha256: "1".repeat(64), os: "Linux", hostname: "old", created_at: "2026-11-01T00:00:00.000Z", revoked_at: "2026-11-01T01:00:00.000Z" },
  ] }, null, 2) + "\n");
  const machinesBefore = read(MACHINES);

  // --- status with no relay running: read-only --------------------------------------------------
  let snap = snapshot(TMP), r = hub(ENV);
  show("status, relay down", r);
  ok(r.status === 0 && /relay 沒有在跑/.test(r.out) && /已加入的機器：1 台/.test(r.out) && /另有 1 台已撤銷/.test(r.out), "status with the relay down: says so, counts 1 machine joined (+1 revoked)");
  ok(/tunnel 要指到 http:\/\/127\.0\.0\.1:7801/.test(r.out) && new RegExp(`不能指到 ${RP}`).test(r.out), "status reminds the tunnel goes to 7801, never the local relay port");
  ok(snapshot(TMP) === snap, "status (relay down) wrote no file");

  // --- on --name: MYNA_REMOTE_PORT=7801 written, relay restarted with `remote` ----------------
  r = hub(ENV, ["on", "--name", "HubTest"]);
  show("on --name HubTest", r);
  let env = read(ENV), h = await health();
  ok(r.status === 0 && /^MYNA_REMOTE_PORT=7801$/m.test(env) && /^MYNA_MACHINE_NAME=hubtest$/m.test(env), "on: .env has MYNA_REMOTE_PORT=7801 and MYNA_MACHINE_NAME=hubtest");
  ok(env.startsWith(BOT), "on: the bot settings already in .env are kept as they were");
  ok(h?.role === "hub" && h?.remote?.port === 7801 && h?.machine === "hubtest" && h?.remote?.machines === 1, `on: relay /health has remote ${JSON.stringify(h?.remote)}, machine ${h?.machine}`);
  ok(/remote: \{"port":7801/.test(r.out) && /tunnel 要指到 http:\/\/127\.0\.0\.1:7801/.test(r.out), "on prints /health's remote and the tunnel reminder with 7801");
  const pidOn = h?.pid;

  // --- status with the hub running: read-only, shows role / remote / machines ----------------
  snap = snapshot(TMP); r = hub(ENV, ["status"]);
  show("status, hub up", r);
  ok(r.status === 0 && /^role: hub$/m.test(r.out) && /^remote: \{"port":7801/m.test(r.out) && /已加入的機器：1 台/.test(r.out), "status: role hub, remote port 7801, 1 machine");
  ok(snapshot(TMP).replace(/"[^"]*relay\.log":"[^"]*",?/g, "") === snap.replace(/"[^"]*relay\.log":"[^"]*",?/g, ""), "status (relay up) wrote no file (only the running relay's own log may grow)");
  ok((await health())?.pid === pidOn, "status did not restart the relay");

  // --- on with a port already in .env keeps it ---------------------------------------------------
  const CUSTOM = freePort();
  fs.writeFileSync(ENV, read(ENV).replace(/^MYNA_REMOTE_PORT=.*$/m, `MYNA_REMOTE_PORT=${CUSTOM}`));
  r = hub(ENV, ["on"]);
  show("on (custom port)", r);
  env = read(ENV); h = await health();
  ok(r.status === 0 && new RegExp(`^MYNA_REMOTE_PORT=${CUSTOM}$`, "m").test(env) && !/^MYNA_REMOTE_PORT=7801$/m.test(env), `on keeps MYNA_REMOTE_PORT=${CUSTOM} already in .env (does not write 7801)`);
  ok(/^MYNA_MACHINE_NAME=hubtest$/m.test(env), "on without --name keeps MYNA_MACHINE_NAME");
  ok(h?.remote?.port === CUSTOM && h?.remote?.listening === true && h?.pid !== pidOn, `on restarted the relay, remote listening on :${CUSTOM} (pid ${pidOn} → ${h?.pid}, remote ${JSON.stringify(h?.remote)})`);
  ok(new RegExp(`tunnel 要指到 http://127\\.0\\.0\\.1:${CUSTOM}`).test(r.out) && /保留原本的值/.test(r.out), "on reports the port actually used (custom) in the tunnel reminder");
  const pidCustom = h?.pid;

  // --- on is refused on an edge / without a bot — .env unchanged, relay not restarted -------------
  const E = path.join(dir("edge"), ".env");
  const edgeEnv = BOT + "MYNA_ROLE=edge\nMYNA_UPSTREAM=http://127.0.0.1:9\n";
  fs.writeFileSync(E, edgeEnv);
  r = hub(E, ["on", "--name", "x"]);
  show("on (edge)", r);
  ok(r.status !== 0 && /edge/.test(r.out) && /沒有改任何設定/.test(r.out), "on refused on an edge (MYNA_ROLE=edge), with the reason");
  ok(read(E) === edgeEnv, "edge: .env byte for byte the same");

  const N = path.join(dir("nobot"), ".env");
  const noBotEnv = "MYNA_MACHINE_NAME=solo\n";
  fs.writeFileSync(N, noBotEnv);
  r = hub(N, ["on"]);
  show("on (no bot)", r);
  ok(r.status !== 0 && /沒有設定 bot/.test(r.out), "on refused without a bot, with the reason");
  ok(read(N) === noBotEnv, "no bot: .env byte for byte the same");

  const N2 = path.join(dir("noenv"), ".env");
  r = hub(N2, ["on", "--name", "x"]);
  ok(r.status !== 0 && read(N2) === null, "no .env at all: on refused, no .env created");

  r = hub(ENV, ["on", "--name", "!!!"]);
  ok(r.status !== 0 && read(ENV) === env, "on --name with no usable character is refused, .env unchanged");
  h = await health();
  ok(h?.pid === pidCustom, `the refused runs did not restart the relay (pid ${pidCustom} → ${h?.pid})`);

  // --- off refuses while MYNA_REMOTE_PORT comes from the environment (it wins over .env) -----------
  const envBefore = read(ENV);
  r = hub(ENV, ["off"], RP, { MYNA_REMOTE_PORT: String(CUSTOM) });
  show("off (env override)", r);
  h = await health();
  ok(r.status !== 0 && /環境變數/.test(r.out) && read(ENV) === envBefore && h?.pid === pidCustom, "off with MYNA_REMOTE_PORT set in the environment: refused, .env unchanged, relay not restarted");

  // --- on fails (exit ≠ 0) when the remote port is taken — the listener did not come up -----------
  const BUSY = freePort();
  const blocker = net.createServer().listen(BUSY, "127.0.0.1");
  await new Promise((res) => blocker.once("listening", res));
  fs.writeFileSync(ENV, envBefore.replace(/^MYNA_REMOTE_PORT=.*$/m, `MYNA_REMOTE_PORT=${BUSY}`));
  r = hub(ENV, ["on"]);
  show("on (port taken)", r);
  h = await health();
  ok(r.status !== 0 && /沒有在聽/.test(r.out) && h?.remote?.port === BUSY && h?.remote?.listening === false, `on with :${BUSY} already taken: fails and says the listener is not listening`);
  await new Promise((res) => blocker.close(res));

  // --- off: MYNA_REMOTE_PORT gone, remote null, machines.json kept ------------------------------
  r = hub(ENV, ["off"]);
  show("off", r);
  env = read(ENV); h = await health();
  ok(r.status === 0 && !/^MYNA_REMOTE_PORT=/m.test(env) && /^MYNA_MACHINE_NAME=hubtest$/m.test(env) && env.startsWith(BOT), "off: MYNA_REMOTE_PORT removed, the rest of .env kept");
  ok(h && h.remote === null && h.pid !== pidCustom, "off: relay restarted, /health remote is null");  ok(read(MACHINES) === machinesBefore, "off: machines.json kept as it was");

  snap = snapshot(TMP); r = hub(ENV);
  show("status, hub off", r);
  ok(r.status === 0 && /^remote: null$/m.test(r.out) && /\/myna:hub on 開啟/.test(r.out) && /已加入的機器：1 台/.test(r.out), "status after off: remote null, says how to turn it on, machines still counted");
  ok(snapshot(TMP).replace(/"[^"]*relay\.log":"[^"]*",?/g, "") === snap.replace(/"[^"]*relay\.log":"[^"]*",?/g, ""), "status (hub off) wrote no file");

  // --- on again: the machines that joined are back -------------------------------------------------
  r = hub(ENV, ["on"]);
  h = await health();
  ok(r.status === 0 && h?.remote?.port === 7801 && h?.remote?.machines === 1, "on again after off: 7801 written again, the joined machine is still there");

  ok(hub(ENV, ["bogus"]).status !== 0, "an unknown subcommand prints usage and fails");
} catch (e) {
  ok(false, `threw: ${e?.stack || e}`);
}

stop(ENV);
await sleep(200);
ok(!(await health()), "relay stopped at the end");
clearTimeout(watchdog);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
