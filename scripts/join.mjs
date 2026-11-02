#!/usr/bin/env node
// Join this machine to a hub (another machine's relay owns the bot) — run on the JOINING machine.
//   join.mjs <hub URL> [--name <name>] [--no-wait] [--no-start]
//   join.mjs --wait [--no-start]          (resume waiting for the tap, after --no-wait)
// 1. Asks the hub (POST <hub>/machines/join) with a fresh enroll secret (only its hash is sent) and a
//    6-character confirmation code, printed here. The phone gets "🆕 <name> 要加入，核對碼 <code>
//    [✅ 允許] [❌ 拒絕]" — compare the codes before tapping.
// 2. Waits (GET <hub>/machines/join/<id>, secret in X-Myna-Enroll-Secret) until the tap. Only ✅ issues
//    the machine token, exactly once: it goes to ~/.myna/machine-token (0600), and ~/.myna/.env gets
//    MYNA_ROLE=edge + MYNA_UPSTREAM=<hub URL>. Then the edge relay is started (ensure-relay) unless
//    --no-start.
// Behind Cloudflare Access, put MYNA_CF_ACCESS_CLIENT_ID / MYNA_CF_ACCESS_CLIENT_SECRET in ~/.myna/.env
// first — the join endpoint is behind Access too. A bot this machine already has stays configured: it
// becomes the fallback while the hub is away (never used when it is the hub's own bot).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL, PROTOCOL_HEADER, ENROLL_SECRET_HEADER, NAME_RE, loadEnv, mynaDir, cfHeaders, upstreamUrl, tokenFile,
  newJoinCode, sha256hex, writePrivate,
} from "../src/remote.mjs";

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const USAGE = "usage: join.mjs <hub URL> [--name <name>] [--no-wait] [--no-start]   |   join.mjs --wait [--no-start]";
const cfg = loadEnv();
const STATE = path.join(mynaDir(cfg), "join-pending.json");
const fail = (m) => { console.error(`myna join: ${m}`); process.exit(1); };
const headers = (extra = {}) => ({ [PROTOCOL_HEADER]: String(PROTOCOL), ...cfHeaders(cfg), ...extra });

async function start() {
  const url = argv.find((a) => !a.startsWith("--") && a !== opt("--name"));
  if (!url) fail(USAGE);
  const up = upstreamUrl(url);
  if (up.error) fail(up.error.replace("MYNA_UPSTREAM", "the hub URL"));
  const name = String(opt("--name") || os.hostname().split(".")[0]).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
  if (!NAME_RE.test(name)) fail(`--name must be 1–16 of a-z 0-9 - (got "${opt("--name") ?? os.hostname()}")`);
  const secret = crypto.randomBytes(32).toString("base64url"), code = newJoinCode();
  const osName = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform;
  let r, j;
  try {
    r = await fetch(`${up.url}/machines/join`, {
      method: "POST", headers: headers({ "content-type": "application/json" }), redirect: "manual", signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ name, os: osName, hostname: os.hostname(), code, enroll_secret_hash: sha256hex(secret) }),
    });
    j = await r.json().catch(() => null);
  } catch (e) { fail(`cannot reach ${up.url} (${e.cause?.code || e.message})`); }
  if (r.status === 403 || (r.status >= 300 && r.status < 400)) fail(`HTTP ${r.status} before the hub — behind Cloudflare Access? set MYNA_CF_ACCESS_CLIENT_ID / MYNA_CF_ACCESS_CLIENT_SECRET in ${cfg.MYNA_ENV}`);
  if (r.status !== 202 || !j?.enroll_id) fail(`the hub refused: HTTP ${r.status} ${j?.error || ""}${j?.retry_after_s ? ` (try again in ${j.retry_after_s}s)` : ""}`);
  writePrivate(STATE, JSON.stringify({ upstream: up.url, name, enroll_id: j.enroll_id, secret, code, expires_at: j.expires_at }, null, 2) + "\n");
  console.log(`myna join: asked ${up.url} to let "${name}" join.`);
  console.log(`  核對碼 / confirmation code:  ${code}`);
  console.log(`  手機上會出現「🆕 ${name} 要加入，核對碼 ${code}」— 核對碼一樣再按 ✅ 允許（${j.expires_at} 前）。`);
}

async function wait() {
  let st;
  try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { fail(`no join in progress (${STATE}) — run: join.mjs <hub URL> --name <name>`); }
  const expires = Date.parse(st.expires_at) || Date.now() + 600000;
  let backoff = 1000;
  for (;;) {
    if (Date.now() > expires + 30000) { fs.rmSync(STATE, { force: true }); fail("the join request expired without an answer — run join again"); }
    let r, j;
    try {
      r = await fetch(`${st.upstream}/machines/join/${st.enroll_id}`, { headers: headers({ [ENROLL_SECRET_HEADER]: st.secret }), redirect: "manual", signal: AbortSignal.timeout(40000) });
      j = await r.json().catch(() => null);
    } catch (e) { await new Promise((ok) => setTimeout(ok, backoff)); backoff = Math.min(15000, backoff * 2); continue; }
    backoff = 1000;
    if (r.status === 404) { fs.rmSync(STATE, { force: true }); fail("the hub no longer knows this join request (it restarted, or the answer was already collected) — run join again"); }
    if (r.status !== 200) { await new Promise((ok) => setTimeout(ok, 3000)); continue; }
    if (j?.status === "pending") continue;
    fs.rmSync(STATE, { force: true });
    if (j?.status !== "approved" || !j.token) fail(j?.status === "expired" ? "nobody answered on the phone in time — run join again" : `denied on the phone${j?.reason ? ` (${j.reason})` : ""}`);
    writePrivate(tokenFile(cfg), j.token + "\n");
    // .env: this machine is an edge now, forwarding to that hub
    let env = fs.existsSync(cfg.MYNA_ENV) ? fs.readFileSync(cfg.MYNA_ENV, "utf8") : "";
    const set = (k, v) => { const re = new RegExp(`^${k}=.*$`, "m"); env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + (env && !env.endsWith("\n") ? "\n" : "") + `${k}=${v}\n`; };
    set("MYNA_ROLE", "edge"); set("MYNA_UPSTREAM", st.upstream);
    fs.mkdirSync(path.dirname(cfg.MYNA_ENV), { recursive: true });
    fs.writeFileSync(cfg.MYNA_ENV, env);
    console.log(`myna join: approved — this machine is "${j.name}" (${j.machine_id}) on ${st.upstream}. Token saved to ${tokenFile(cfg)}; ${cfg.MYNA_ENV} now has MYNA_ROLE=edge and MYNA_UPSTREAM.`);
    if (!flag("--no-start")) {
      const ensure = path.join(path.dirname(fileURLToPath(import.meta.url)), "ensure-relay.mjs");
      const out = spawnSync(process.execPath, [ensure], { encoding: "utf8", windowsHide: true });
      process.stdout.write(out.stdout || ""); process.stderr.write(out.stderr || "");
    }
    return;
  }
}

if (flag("--wait")) await wait();
else { await start(); if (!flag("--no-wait")) await wait(); else console.log("  然後執行 join.mjs --wait 等手機上的回覆。"); }
