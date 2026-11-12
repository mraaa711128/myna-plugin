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
//    --no-start, and join.mjs exits 0 only once the port answers as an edge of that hub. The token is
//    kept in join-pending.json until it is saved, so a failed write is finished by --wait.
// Refused on a hub with its remote listener on (MYNA_REMOTE_PORT): /myna:hub off first.
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
  PROTOCOL, PROTOCOL_HEADER, ENROLL_SECRET_HEADER, NAME_RE, loadEnv, mynaDir, roleOf, cfHeaders, upstreamUrl, tokenFile,
  newJoinCode, sha256hex, writePrivate, updateEnvFile,
} from "../src/remote.mjs";

const argv = process.argv.slice(2);
// /myna:join tree …: the tree transport (scripts/tree.mjs) — everything below is the old join, unchanged
if (argv[0] === "tree") await (await import("./tree.mjs")).joinTree(argv.slice(1));
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const USAGE = "usage: join.mjs <hub URL> [--name <name>] [--no-wait] [--no-start]   |   join.mjs --wait [--no-start]";
const cfg = loadEnv();
const STATE = path.join(mynaDir(cfg), "join-pending.json");
const fail = (m) => { console.error(`myna join: ${m}`); process.exit(1); };
const headers = (extra = {}) => ({ [PROTOCOL_HEADER]: String(PROTOCOL), ...cfHeaders(cfg), ...extra });
const RELAY_PORT = Number(cfg.RELAY_PORT || 7800);

// a hub with its remote listener on would turn into an edge and cut off every machine that joined it —
// the mirror of /myna:hub on refusing an edge. Turn the listener off first (/myna:hub off).
function refuseOnHub() {
  if (roleOf(cfg) !== "edge" && String(cfg.MYNA_REMOTE_PORT ?? "").trim())
    fail(`this machine is a hub with its remote listener on (MYNA_REMOTE_PORT=${String(cfg.MYNA_REMOTE_PORT).trim()}) — joining another hub would cut off the machines that joined this one. Run /myna:hub off first (and revoke or move those machines).`);
}

async function start() {
  refuseOnHub();
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
  refuseOnHub();
  // approved earlier, but saving it here failed: the hub hands the token out only once — finish with the kept one
  if (st.token) return finish(st);
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
    if (j?.status !== "approved" || !j.token) { fs.rmSync(STATE, { force: true }); fail(j?.status === "expired" ? "nobody answered on the phone in time — run join again" : `denied on the phone${j?.reason ? ` (${j.reason})` : ""}`); }
    // the hub hands the token out exactly once: keep it (0600, like machine-token) before anything else
    // can fail, so join.mjs --wait can finish the job
    st = { ...st, token: j.token, machine_id: j.machine_id, name: j.name };
    writePrivate(STATE, JSON.stringify(st, null, 2) + "\n");
    return finish(st);
  }
}

// approved: save the token and the .env, drop what an earlier hub left, then start the edge relay
async function finish(st) {
  try {
    writePrivate(tokenFile(cfg), st.token + "\n");
    // .env: this machine is an edge now, forwarding to that hub
    // read again and written under the file's lock (updateEnvFile): another program's change at the same time is kept
    updateEnvFile(cfg.MYNA_ENV, (text) => {
      let env = text;
      const set = (k, v) => { const re = new RegExp(`^${k}=.*$`, "m"); env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + (env && !env.endsWith("\n") ? "\n" : "") + `${k}=${v}\n`; };
      set("MYNA_ROLE", "edge"); set("MYNA_UPSTREAM", st.upstream);
      return env;
    });
    // an earlier hub's bot id and question ids mean nothing to this one (the relay also ignores files
    // written for another hub — this covers files from before they said which hub)
    for (const f of [path.join(mynaDir(cfg), "upstream.json"), cfg.MYNA_EDGE_STATE_FILE || path.join(mynaDir(cfg), "edge-state.json")]) fs.rmSync(f, { force: true });
  } catch (e) {
    fail(`approved as "${st.name}" (${st.machine_id}), but saving it here failed: ${e.message}. Fix that and run join.mjs --wait — the token is kept in ${STATE} (the hub hands it out only once).`);
  }
  fs.rmSync(STATE, { force: true });
  console.log(`myna join: approved — this machine is "${st.name}" (${st.machine_id}) on ${st.upstream}. Token saved to ${tokenFile(cfg)}; ${cfg.MYNA_ENV} now has MYNA_ROLE=edge and MYNA_UPSTREAM.`);
  if (flag("--no-start")) return;
  const ensure = path.join(path.dirname(fileURLToPath(import.meta.url)), "ensure-relay.mjs");
  // --force: a relay already running (same version, maybe already an edge of another hub) must
  // restart to read the new hub URL, token and CF headers
  const out = spawnSync(process.execPath, [ensure, "--force"], { encoding: "utf8", windowsHide: true });
  process.stdout.write(out.stdout || ""); process.stderr.write(out.stderr || "");
  const again = "the token and .env are saved — fix the cause and run /myna:relay restart";
  if (out.error || out.status !== 0) fail(`ensure-relay failed (${out.error?.message || `exit ${out.status ?? out.signal}`}) — ${again}`);
  // ensure-relay may leave another relay on the port, and an edge needs a few seconds (its first look
  // at the hub) before it listens: wait until the port answers as an edge of THIS hub
  const until = Date.now() + 20000;
  let last = "nothing answers";
  while (Date.now() < until) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`, { signal: AbortSignal.timeout(1500) })).json();
      if (h?.role === "edge" && h.upstream?.url === st.upstream) { console.log(`myna join: the edge relay is up on :${RELAY_PORT} (hub ${h.upstream.reachable ? "reachable" : `not reachable yet: ${h.upstream.reason}`})`); return; }
      last = `a relay answers as ${h?.role || "?"}${h?.upstream?.url ? ` of ${h.upstream.url}` : ""}`;
    } catch (e) { last = e.name === "SyntaxError" ? "something that is not a myna relay answers" : "nothing answers"; }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  fail(`no edge relay of ${st.upstream} on :${RELAY_PORT} (${last}) — ${again}`);
}

if (flag("--wait")) await wait();
else { await start(); if (!flag("--no-wait")) await wait(); else console.log("  然後執行 join.mjs --wait 等手機上的回覆。"); }
