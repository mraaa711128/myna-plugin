#!/usr/bin/env node
// Several machines, one relay (0.20.0) — everything on this one machine, no real bot, no real tunnel:
//   Telegram API stub ← HUB relay (src/relay.mjs: local port + MYNA_REMOTE_PORT)
//                       ← "Cloudflare Access" stub (a reverse proxy that wants the CF-Access-Client-*
//                          headers, adds Cf-Connecting-Ip / X-Forwarded-For like cloudflared, and can
//                          go down with a 530 like a dead tunnel)
//                       ← EDGE relays (src/relay.mjs, MYNA_ROLE=edge): "mbp" without a bot of its
//                          own, "pc2" with its own bot (a second Telegram stub) as the fallback
//                       ← the real MCP server (dist/ask-human.mjs) on mbp
// Covers: joining by a ✅ tap (rate limits, expiry, wrong enroll secret, ❌/⏹ issue nothing, token
// handed out once), the remote port's token check on every endpoint (none / wrong / revoked → 401),
// endpoints that do not exist there (404), per-machine isolation of answers / cancels / session ids,
// topic names with the machine, an edge whose bot is the hub's never polls it, the edge when the hub is
// away (no bot: connections dropped, grace for open questions, give-up cancelled once back; own bot:
// failover of new questions, /attest of its own approvals once, recovery after good checks in a row,
// questions open on its bot answered in place), body caps, protocol mismatch, the local port's guards,
// machines.mjs revoke.
// MYNA_TEST_ROOT=<another checkout> runs the same checks against that code (e.g. 0.19.2 → must fail).
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const src = (...p) => path.join(ROOT, ...p);
const serverPath = path.join(HERE, "dist", "ask-human.mjs");
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}${process.env.SMOKE_TS ? `  [${new Date().toISOString()}]` : ""}`); if (!c) failed++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } };
const children = [];
const cleanup = () => { for (const c of children) { try { c.kill(); } catch {} } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 120s"); cleanup(); process.exit(1); }, 120000);
process.on("exit", cleanup);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-remote-"));
const used = new Set([7800, 7801]);
const freePort = () => { for (;;) { const p = 20000 + Math.floor(Math.random() * 20000); if (!used.has(p)) { used.add(p); return p; } } };
// a clean env: nothing of the developer's own myna setup leaks into the children
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|CLAUDE_CODE_SESSION_ID$)/.test(k)) delete e[k];
  return e;
})();
const CF = { "CF-Access-Client-Id": "test-client.access", "CF-Access-Client-Secret": "test-secret-value" };
const CF_ENV = { MYNA_CF_ACCESS_CLIENT_ID: CF["CF-Access-Client-Id"], MYNA_CF_ACCESS_CLIENT_SECRET: CF["CF-Access-Client-Secret"] };

// --- Telegram API stub (the "human") -----------------------------------------------------------
const sent = [], topicsCreated = [], markupEdits = [];
let updates = [], nextUpdateId = 1, mid = 100, thread = 500;
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
    if (/\/getUpdates$/.test(u.pathname)) { const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); }; updates.length ? deliver() : setTimeout(deliver, 100); return; }
    if (/\/sendMessage$/.test(u.pathname)) { b.message_id = ++mid; sent.push(b); json({ ok: true, result: { message_id: b.message_id } }); return; }
    if (/\/createForumTopic$/.test(u.pathname)) { b.message_thread_id = ++thread; topicsCreated.push(b); json({ ok: true, result: { message_thread_id: b.message_thread_id } }); return; }
    if (/\/editMessageReplyMarkup$/.test(u.pathname)) { markupEdits.push(b); json({ ok: true, result: true }); return; }
    json({ ok: true, result: true });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const keyboardWith = (re) => until(() => [...sent].reverse().find((s) => s.reply_markup?.inline_keyboard && re.test(s.text || "")));
const tap = (msg, row, idx) => updates.push({ update_id: nextUpdateId++, callback_query: { id: `cq${nextUpdateId}`, data: msg.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 }, message_id: msg.message_id } } });
// an edge machine's OWN bot (another Telegram stub)
async function botStub() {
  const s = { sent: [], updates: [], polls: 0, n: 1, mid: 9000 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
      if (/\/getUpdates$/.test(u.pathname)) { s.polls++; const deliver = () => { const out = s.updates; s.updates = []; json({ ok: true, result: out }); }; s.updates.length ? deliver() : setTimeout(deliver, 100); return; }
      if (/\/sendMessage$/.test(u.pathname)) { b.message_id = ++s.mid; s.sent.push(b); json({ ok: true, result: { message_id: b.message_id } }); return; }
      if (/\/createForumTopic$/.test(u.pathname)) { json({ ok: true, result: { message_thread_id: 77 } }); return; }
      json({ ok: true, result: true });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${srv.address().port}`;
  s.close = () => srv.close();
  s.keyboardWith = (re) => until(() => [...s.sent].reverse().find((m) => m.reply_markup?.inline_keyboard && re.test(m.text || "")));
  s.tap = (msg, row, idx) => s.updates.push({ update_id: s.n++, callback_query: { id: `cq${s.n}`, data: msg.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 }, message_id: msg.message_id } } });
  return s;
}
const HUB_BOT = "111111:HUB-SECRET"; // bot id 111111 (Telegram: the token's part before ":")

// --- hub relay -----------------------------------------------------------------------------------
const H = freePort(), R = freePort();
const HUB = `http://127.0.0.1:${H}`, REMOTE = `http://127.0.0.1:${R}`;
const MACHINES = path.join(TMP, "hub", "machines.json");
fs.mkdirSync(path.join(TMP, "hub"), { recursive: true });
const hubLog = [];
const hub = spawn(process.execPath, [src("src", "relay.mjs")], {
  env: {
    ...baseEnv, MYNA_ENV: path.join(TMP, "hub", ".env"), MYNA_PROVIDER: "telegram",
    TELEGRAM_BOT_TOKEN: HUB_BOT, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
    RELAY_PORT: String(H), MYNA_REMOTE_PORT: String(R), MYNA_MACHINES_FILE: MACHINES, MYNA_MACHINE_NAME: "win",
    MYNA_ANSWER_HOLD_MS: "1500", TELEGRAM_TOPIC_ROUND_GRACE: "0",
    MYNA_JOIN_TTL_MS: "6000", MYNA_JOIN_INTERVAL_MS: "1500", MYNA_JOIN_MAX_OPEN: "2", MYNA_REMOTE_ASK_MAX: "6",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
children.push(hub);
hub.stderr.on("data", (d) => hubLog.push(String(d)));
const up = (url) => until(async () => { try { await fetch(url, { signal: AbortSignal.timeout(400) }); return true; } catch { return false; } }, 8000);
if (!(await up(`${HUB}/health`))) { console.error("❌ hub relay never came up"); process.exit(1); }

// --- "Cloudflare Access" + tunnel stub in front of a port -----------------------------------------
function accessProxy(target, { requireCf = true } = {}) {
  const st = { down: false, seen: [] };
  const srv = http.createServer((req, res) => {
    if (st.down) { res.writeHead(530, { "content-type": "text/html" }); res.end("<html>error 1033: tunnel down</html>"); return; }
    if (requireCf && (req.headers["cf-access-client-id"] !== CF["CF-Access-Client-Id"] || req.headers["cf-access-client-secret"] !== CF["CF-Access-Client-Secret"])) {
      res.writeHead(403, { "content-type": "text/html" }); res.end("<html>Forbidden — Cloudflare Access</html>"); return;
    }
    st.seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || "" });
    const headers = { ...req.headers, "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7", "cf-ray": "0000-TEST" };
    delete headers["cf-access-client-id"]; delete headers["cf-access-client-secret"];
    const up = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end("bad gateway"); });
    req.pipe(up);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}
const tunnel = await accessProxy(R);
const misTunnel = await accessProxy(H, { requireCf: false }); // a tunnel pointed at the LOCAL port by mistake

const req = async (url, { method = "GET", headers = {}, body } = {}) => {
  try {
    const r = await fetch(url, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e) { return { status: 0, error: e.cause?.code || e.message }; }
};

// === 1. the hub's local port: guards, body cap, health =============================================
let r = await req(`${HUB}/health`);
ok(r.status === 200 && r.json?.role === "hub" && r.json?.protocol === 1 && r.json?.remote?.port === R, `hub local /health: role=hub, protocol=1, remote port ${r.json?.remote?.port}`);
r = await req(`${HUB}/health`, { headers: { "x-forwarded-for": "198.51.100.9" } });
ok(r.status === 403, `local port + X-Forwarded-For → 403 (${r.status})`);
r = await req(`${HUB}/ask`, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.9" }, body: { question: "q", options: ["a"] } });
ok(r.status === 403, `local port + Cf-Connecting-Ip → 403 (${r.status})`);
r = await req(`${misTunnel.url}/shutdown`, { method: "POST" });
ok(r.status === 403, `a tunnel pointed at the local port by mistake: /shutdown → 403 (${r.status})`);
r = await req(`${HUB}/pair/start`, { method: "POST", headers: { origin: "https://evil.example.com" } });
ok(r.status === 403, `local port + Origin (browser) → 403 (${r.status})`);
const rawStatus = (port, p, headers) => new Promise((resolve) => { const x = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => { res.resume(); resolve(res.statusCode); }); x.on("error", () => resolve(0)); x.end(); });
r = { status: await rawStatus(H, "/health", { host: "evil.example.com:7800" }) };
ok(r.status === 403, `local port + non-loopback Host (DNS rebinding) → 403 (${r.status})`);
r = { status: await rawStatus(H, "/health", { host: `localhost:${H}` }) };
ok(r.status === 200, `local port + Host localhost → 200 (${r.status})`);
r = await req(`${HUB}/ask`, { method: "POST", body: JSON.stringify({ question: "x".repeat(300 * 1024), options: ["a"] }) });
ok(r.status === 413, `local /ask over 256 KB → 413 (${r.status})`);

// === 2. joining: mbp through scripts/join.mjs, by a ✅ tap ==========================================
const A_DIR = path.join(TMP, "mbp");
fs.mkdirSync(A_DIR, { recursive: true });
const A_ENV = path.join(A_DIR, ".env");
fs.writeFileSync(A_ENV, `MYNA_CF_ACCESS_CLIENT_ID=${CF_ENV.MYNA_CF_ACCESS_CLIENT_ID}\nMYNA_CF_ACCESS_CLIENT_SECRET=${CF_ENV.MYNA_CF_ACCESS_CLIENT_SECRET}\n`);
const join = spawn(process.execPath, [src("scripts", "join.mjs"), tunnel.url, "--name", "mbp", "--no-start"], { env: { ...baseEnv, MYNA_ENV: A_ENV, MYNA_ANSWER_HOLD_MS: "1500" }, stdio: ["ignore", "pipe", "pipe"] });
children.push(join);
let joinOut = ""; join.stdout.on("data", (d) => (joinOut += d)); join.stderr.on("data", (d) => (joinOut += d));
const joinDone = new Promise((r) => join.on("exit", r));
const code = (await until(() => /([A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3})/.exec(joinOut)?.[1], 8000));
ok(!!code, `join.mjs shows a confirmation code in the terminal → ${code}`);
let jm = code && await keyboardWith(new RegExp(`mbp[\\s\\S]*${code}`));
ok(!!jm && /🆕/.test(jm.text) && jm.reply_markup.inline_keyboard[0].map((b) => b.text).join("|") === "1|2" && /✅ 允許/.test(jm.text) && /❌ 拒絕/.test(jm.text),
  "the phone shows 「🆕 … mbp … 核對碼」 with ✅ 允許 / ❌ 拒絕");
r = await req(`${HUB}/requests`);
ok(r.status === 200 && !(r.json?.requests || []).length, "a join request is not a session question (not in /requests — nothing local can answer it)");
if (jm) tap(jm, 0, 0);
const joinRc = await Promise.race([joinDone, sleep(10000).then(() => "timeout")]);
const A_TOKEN_FILE = path.join(A_DIR, "machine-token");
const aToken = fs.existsSync(A_TOKEN_FILE) ? fs.readFileSync(A_TOKEN_FILE, "utf8").trim() : "";
ok(joinRc === 0 && /^myna_m_[a-f0-9]{12}_/.test(aToken), `✅ tapped → join.mjs exits 0 and saves the token (rc=${joinRc})`);
ok(process.platform === "win32" || (fs.statSync(A_TOKEN_FILE).mode & 0o777) === 0o600, "machine-token is 0600");
const aEnv = fs.readFileSync(A_ENV, "utf8");
ok(/^MYNA_ROLE=edge$/m.test(aEnv) && new RegExp(`^MYNA_UPSTREAM=${tunnel.url}$`, "m").test(aEnv), ".env now has MYNA_ROLE=edge and MYNA_UPSTREAM=<hub URL>");
const machinesText = fs.existsSync(MACHINES) ? fs.readFileSync(MACHINES, "utf8") : "";
const A_ID = /^myna_m_([a-f0-9]{12})_/.exec(aToken)?.[1];
ok(machinesText.includes('"name": "mbp"') && !machinesText.includes(aToken) && machinesText.includes(crypto.createHash("sha256").update(aToken).digest("hex")),
  "machines.json holds mbp's token hash only, never the token");
ok(tunnel.st.seen.some((s) => s.url === "/machines/join"), "the join went through the Access stub (CF-Access-Client-* headers sent)");

// --- joining by hand: rate limits, wrong secret, ❌ / ⏹, token once, expiry, duplicate name
const newCode = () => { const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.randomBytes(6); const c = [...b].map((x) => abc[x % abc.length]).join(""); return `${c.slice(0, 3)}-${c.slice(3)}`; };
async function rawJoin(name) {
  const secret = crypto.randomBytes(32).toString("base64url"), c = newCode();
  const res = await req(`${tunnel.url}/machines/join`, { method: "POST", headers: { ...CF, "content-type": "application/json" }, body: { name, os: "Linux", hostname: `host-${name}`, code: c, enroll_secret_hash: crypto.createHash("sha256").update(secret).digest("hex") } });
  return { ...res, secret, code: c, id: res.json?.enroll_id };
}
const pollJoin = (id, secret) => req(`${tunnel.url}/machines/join/${id}`, { headers: { ...CF, "x-myna-enroll-secret": secret } });
await sleep(1600);
const jB = await rawJoin("pc2");
ok(jB.status === 202 && /^[a-f0-9]{16}$/.test(jB.id || ""), `join request for pc2 → 202 (${jB.status})`);
r = (await rawJoin("pc3"));
ok(r.status === 429 && r.json?.retry_after_s > 0, `a second join within the interval → 429 (${r.status}, retry after ${r.json?.retry_after_s}s)`);
r = await pollJoin(jB.id, "not-the-secret");
ok(r.status === 404 && !r.json?.token, `poll with a wrong enroll secret → 404, no token (${r.status})`);
r = await pollJoin(jB.id, jB.secret);
ok(r.status === 200 && r.json?.status === "pending" && !r.json?.token, `poll before the tap → pending, no token`);
await sleep(1600);
const jC = await rawJoin("pc3");
ok(jC.status === 202, `join request for pc3 → 202 (${jC.status})`);
await sleep(1600);
r = await rawJoin("pc4");
ok(r.status === 429 && /waiting/.test(r.json?.error || ""), `a third join while two wait (MYNA_JOIN_MAX_OPEN=2) → 429 (${r.status} ${r.json?.error})`);
const mC = await keyboardWith(new RegExp(jC.code));
if (mC) tap(mC, 0, 1); // ❌ 拒絕
r = await until(async () => { const x = await pollJoin(jC.id, jC.secret); return x.json?.status !== "pending" ? x : null; });
ok(r?.json?.status === "denied" && !r.json.token, `❌ tapped → denied, no token (${r?.json?.status})`);
const mB = await keyboardWith(new RegExp(jB.code));
if (mB) tap(mB, 0, 0); // ✅ 允許
r = await until(async () => { const x = await pollJoin(jB.id, jB.secret); return x.json?.status !== "pending" ? x : null; });
const bToken = r?.json?.token || "";
ok(r?.json?.status === "approved" && /^myna_m_[a-f0-9]{12}_/.test(bToken) && r.json.name === "pc2", `✅ tapped → approved, token handed out (${r?.json?.status})`);
r = await pollJoin(jB.id, jB.secret);
ok(r.status === 404 && !r.json?.token, `the token is handed out only once — a second poll → 404 (${r.status})`);
const B_ID = /^myna_m_([a-f0-9]{12})_/.exec(bToken)?.[1];
// ⏹ on the phone also issues nothing
const jE = await rawJoin("pc5");
const mE = jE.code && await keyboardWith(new RegExp(jE.code));
if (mE) tap(mE, 1, 1); // ⏹
r = await until(async () => { const x = await pollJoin(jE.id, jE.secret); return x.json?.status !== "pending" ? x : null; });
ok(r?.json?.status === "denied" && !r.json.token, `⏹ tapped → denied, no token (${r?.json?.status})`);
// expiry: nobody answers
await sleep(1600);
const jD = await rawJoin("pc4");
ok(jD.status === 202, `join request for pc4 → 202 (${jD.status})`);
const mD = jD.code && await keyboardWith(new RegExp(jD.code));
r = await until(async () => { const x = await pollJoin(jD.id, jD.secret); return x.json?.status !== "pending" ? x : null; }, 12000);
ok(r?.json?.status === "expired" && !r.json.token, `nobody answers within MYNA_JOIN_TTL_MS → expired, no token (${r?.json?.status})`);
ok(!!mD && !!(await until(() => markupEdits.some((e) => e.message_id === mD.message_id) && sent.some((s) => /加入要求逾時/.test(s.text || "")), 3000)), "expired join: the phone's buttons are retracted and it says so");
if (mD) tap(mD, 0, 0); // a late tap on the retracted message
await sleep(400);
ok(!fs.readFileSync(MACHINES, "utf8").includes('"name": "pc4"'), "a late ✅ on an expired join adds no machine");
await sleep(1600);
r = await rawJoin("mbp");
ok(r.status === 409, `joining with a name already registered → 409 (${r.status})`);

// === 3. the remote port: token on every endpoint, only phase-1 endpoints ===========================
const ENDPOINTS = [["GET", "/health"], ["POST", "/ask"], ["GET", "/answer/abcdef0123"], ["POST", "/cancel/abcdef0123"], ["POST", "/session/close"], ["POST", "/session/round-end"],
  ["POST", "/attest"], ["POST", "/detach/abcdef0123"], ["POST", "/reattach/abcdef0123"], ["GET", "/requests"], ["POST", "/pair/start"], ["GET", "/pair/status"], ["POST", "/shutdown"],
  ["POST", "/chat/register"], ["GET", "/chat/session"], ["GET", "/"], ["GET", "/no/such/path"]];
const all401 = async (label, auth) => {
  const bad = [];
  for (const [m, p] of ENDPOINTS) {
    const x = await req(`${REMOTE}${p}`, { method: m, headers: auth ? { authorization: auth } : {}, ...(m === "POST" ? { body: { question: "q", options: ["a"], session_id: "s" } } : {}) });
    if (x.status !== 401) bad.push(`${m} ${p} → ${x.status}`);
  }
  ok(!bad.length, `remote port, ${label}: all ${ENDPOINTS.length} endpoints → 401${bad.length ? ` — but ${bad.join(", ")}` : ""}`);
};
await all401("no token", "");
await all401("wrong token", `Bearer myna_m_${A_ID}_${crypto.randomBytes(32).toString("base64url")}`);
await all401("not a machine token", "Bearer hunter2");
const authA = { authorization: `Bearer ${aToken}` }, authB = { authorization: `Bearer ${bToken}` };
r = await req(`${REMOTE}/health`, { headers: authA });
ok(r.status === 200 && r.json?.protocol === 1 && r.json?.machine?.name === "mbp" && r.json.root === undefined && r.json.journal === undefined, `remote /health with mbp's token → protocol 1, machine mbp, no local paths`);
for (const [m, p] of [["POST", "/pair/start"], ["GET", "/pair/status"], ["POST", "/shutdown"], ["POST", "/attest"], ["GET", "/requests"], ["POST", "/detach/abcdef0123"], ["POST", "/chat/register"]]) {
  r = await req(`${REMOTE}${p}`, { method: m, headers: authA, ...(m === "POST" ? { body: {} } : {}) });
  ok(r.status === 404, `remote ${m} ${p} with a valid token → 404 (does not exist there) (${r.status})`);
}
r = await req(`${HUB}/health`);
ok(r.status === 200 && r.json?.pid, "…and the hub is still running after the remote /shutdown");
r = await req(`${REMOTE}/health`, { headers: { ...authA, "x-myna-protocol": "2" } });
ok(r.status === 426 && r.json?.protocol === 1, `a client speaking remote protocol 2 → 426 (${r.status})`);
r = await req(`${REMOTE}/ask`, { method: "POST", headers: authA, body: JSON.stringify({ question: "x".repeat(300 * 1024), options: ["a"] }) });
ok(r.status === 413, `remote /ask over 256 KB → 413 (${r.status})`);

// === 4. edge relays ===================================================================================
const edgeLogs = [];
const EDGE_TIMING = { MYNA_UPSTREAM_CHECK_MS: "300", MYNA_UPSTREAM_GRACE: "3", MYNA_UPSTREAM_RECOVER: "3", MYNA_ANSWER_HOLD_MS: "1500" };
const startEdge = (port, env) => {
  const c = spawn(process.execPath, [src("src", "relay.mjs")], { env: { ...baseEnv, RELAY_PORT: String(port), ...EDGE_TIMING, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(c); const out = []; edgeLogs.push([port, out]); c.stderr.on("data", (d) => out.push(String(d)));
  c.on("exit", (rc) => out.push(`(exited rc=${rc})\n`));
  return c;
};
// mbp: what join.mjs wrote (.env + machine-token file), started by ensure-relay like SessionStart does
const EA = freePort(), EDGE_A = `http://127.0.0.1:${EA}`;
const ens = spawnSync(process.execPath, [src("scripts", "ensure-relay.mjs")], { env: { ...baseEnv, MYNA_ENV: A_ENV, RELAY_PORT: String(EA), ...EDGE_TIMING }, encoding: "utf8", timeout: 10000 });
ok(/started relay \(edge\)/.test(ens.stdout), `ensure-relay with MYNA_ROLE=edge (no bot of its own) starts the relay as an edge → ${ens.stdout.trim().split("\n").pop()}`);
const edgePid = Number(/pid (\d+)/.exec(ens.stdout)?.[1]);
process.on("exit", () => { try { process.kill(edgePid); } catch {} });
await up(`${EDGE_A}/health`);
r = await until(async () => { const x = await req(`${EDGE_A}/health`); return x.json?.upstream?.active ? x : null; });
ok(r?.json?.role === "edge" && r.json.upstream.machine === "mbp" && r.json.upstream.cf_access === true && r.json.upstream.protocol === 1 && r.json.upstream.bot_id === "telegram:111111" && r.json.own_bot?.on === false,
  `edge /health: role=edge, hub reachable, machine=mbp, CF Access headers on, hub bot id telegram:111111 (no token), no own bot`);
// pc2: its OWN bot (id 222222) as the fallback; config from the environment (MYNA_MACHINE_TOKEN), no .env file
const botB = await botStub();
const EB = freePort(), EDGE_B = `http://127.0.0.1:${EB}`;
fs.mkdirSync(path.join(TMP, "pc2"), { recursive: true });
startEdge(EB, { MYNA_ENV: path.join(TMP, "pc2", ".env"), MYNA_ROLE: "edge", MYNA_UPSTREAM: tunnel.url, MYNA_MACHINE_TOKEN: bToken, ...CF_ENV,
  TELEGRAM_BOT_TOKEN: "222222:PC2-SECRET", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: botB.url, TELEGRAM_TOPIC_ROUND_GRACE: "0" });
r = await until(async () => { const x = await req(`${EDGE_B}/health`); return x.json?.upstream?.active ? x : null; });
ok(r?.json?.own_bot?.on === true && r.json.own_bot.id === "telegram:222222" && !!(await until(() => botB.polls > 0, 3000)), `pc2's edge keeps its own bot (telegram:222222) polling as the fallback`);
// pc9: its bot IS the hub's (same id 111111, another token string) → never polls it, forwards only
const botC = await botStub();
const EC = freePort();
fs.mkdirSync(path.join(TMP, "pc9"), { recursive: true });
startEdge(EC, { MYNA_ENV: path.join(TMP, "pc9", ".env"), MYNA_ROLE: "edge", MYNA_UPSTREAM: tunnel.url, MYNA_MACHINE_TOKEN: aToken, ...CF_ENV,
  TELEGRAM_BOT_TOKEN: "111111:SAME-BOT-OTHER-STRING", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: botC.url });
r = await until(async () => { const x = await req(`http://127.0.0.1:${EC}/health`); return x.json?.upstream?.active ? x : null; });
await sleep(800);
ok(r?.json?.own_bot?.on === false && /same bot as the hub/.test(r.json.own_bot.reason || "") && botC.polls === 0, `an edge whose bot is the hub's (same id) never polls it — "${r?.json?.own_bot?.reason}" (polls=${botC.polls})`);
r = await req(`${EDGE_A}/attest`, { method: "POST", body: { command: "git push origin main", session_id: "same-sid" } });
ok(r.status === 200 && r.json?.approved === false, `edge /attest with no local approval → approved:false (a hub approval is never asked for: fail closed) (${JSON.stringify(r.json)})`);
r = await req(`${EDGE_A}/pair/start`, { method: "POST" });
ok(r.status === 400 && /hub/.test(r.json?.error || ""), `edge without its own bot: /pair/start → 400, pairing is done on the hub`);
r = await req(`${EDGE_A}/health`, { headers: { "x-forwarded-for": "198.51.100.9" } });
ok(r.status === 403, `edge local port + X-Forwarded-For → 403 (${r.status})`);
// wrong CF Access secret: stopped before the hub
const ED = freePort();
startEdge(ED, { MYNA_ENV: path.join(TMP, "pc8.env"), MYNA_ROLE: "edge", MYNA_UPSTREAM: tunnel.url, MYNA_MACHINE_TOKEN: aToken, MYNA_CF_ACCESS_CLIENT_ID: CF_ENV.MYNA_CF_ACCESS_CLIENT_ID, MYNA_CF_ACCESS_CLIENT_SECRET: "wrong" });
const EC_URL = `http://127.0.0.1:${ED}`;
r = await until(async () => { const x = await req(`${EC_URL}/health`); return x.json?.upstream?.reason ? x : null; });
ok(r?.json?.upstream?.reachable === false && /Cloudflare Access/.test(r.json.upstream.reason), `edge with a wrong CF Access secret: hub not reachable — "${r?.json?.upstream?.reason}"`);
r = await req(`${EC_URL}/ask`, { method: "POST", body: { question: "q", options: ["a"] } });
ok(r.status === 0, `…and its /ask connection is dropped (client falls back) (${r.status || r.error})`);

// === 5. the real MCP server on mbp → edge → hub → phone → back ===================================
const scratch = path.join(TMP, "mcp"); fs.mkdirSync(scratch, { recursive: true });
const transport = new StdioClientTransport({
  command: process.execPath, args: [serverPath],
  env: { ...baseEnv, MYNA_RELAY_URL: EDGE_A, MYNA_LOG_DIR: scratch, MYNA_AUTOPILOT_FILE: path.join(scratch, "no-autopilot"), MYNA_HEARTBEAT_MS: "5000", MYNA_ANSWER_POLL_MS: "5000", MYNA_SESSION_NAME: "remote session", MYNA_TICKET: "", MYNA_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "same-sid" },
  stderr: "ignore",
});
const mcp = new Client({ name: "smoke-remote", version: "0" }, { capabilities: {} });
await mcp.connect(transport);
const call = (args) => mcp.callTool({ name: "ask_human", arguments: args }, undefined, { timeout: 30000, resetTimeoutOnProgress: true }).then((x) => JSON.parse(x.content[0].text));
const q1 = call({ header: "remote", question: "從 mbp 問的?", options: ["好 (Recommended)", "不好"], logDir: scratch });
const k1 = await keyboardWith(/從 mbp 問的/);
ok(!!k1 && topicsCreated.some((t) => t.name === "mbp · remote session") && k1.message_thread_id === topicsCreated.find((t) => t.name === "mbp · remote session")?.message_thread_id,
  `topic name carries the machine → "${topicsCreated.map((t) => t.name).join('", "')}"`);
if (k1) tap(k1, 0, 0);
const a1 = await Promise.race([q1, sleep(15000).then(() => ({ kind: "timeout" }))]);
ok(a1.kind === "selection" && a1.value === "好 (Recommended)", `ask_human on mbp (MCP → edge → hub → phone tap) → ${JSON.stringify(a1)}`);
ok(hubLog.join("").includes("machine=mbp"), "hub relay.log names the asking machine (machine=mbp)");

// === 6. isolation between machines ====================================================================
const ask = (base, body) => req(`${base}/ask`, { method: "POST", body: { question: "q?", options: ["a", "b"], ...body } });
const bQ = await ask(EDGE_B, { question: "pc2 問的", session_id: "same-sid", session_name: "b session" });
ok(bQ.status === 200 && !!bQ.json?.request_id, `pc2 asks through its edge with the same session id → ${bQ.json?.request_id}`);
await keyboardWith(/pc2 問的/);
ok(topicsCreated.some((t) => t.name === "pc2 · b session"), "pc2's question opens its own topic \"pc2 · b session\"");
ok(!botB.sent.some((m) => m.reply_markup), "hub up: pc2's own bot sends no question (it went to the hub)");
r = await req(`${EDGE_A}/session/round-end`, { method: "POST", body: { session_id: "same-sid" } });
ok(r.json?.ended === true, `mbp's round-end for "same-sid" is not held up by pc2's open question in its "same-sid" (ended=${r.json?.ended})`);
const aQ = await ask(EDGE_A, { question: "mbp 第二題", session_id: "same-sid" });
const AQ = aQ.json?.request_id, BQ = bQ.json?.request_id;
r = await req(`${HUB}/requests`);
const sids = (r.json?.requests || []).map((x) => x.session_id);
ok(sids.includes(`m:${A_ID}:same-sid`) && sids.includes(`m:${B_ID}:same-sid`), `same session id on two machines → two sessions at the hub (${sids.join(", ")})`);
r = await req(`${tunnel.url}/answer/${AQ}`, { headers: { ...CF, ...authB } });
ok(r.status === 404, `pc2's token cannot read mbp's /answer → 404 (${r.status})`);
r = await req(`${tunnel.url}/cancel/${AQ}`, { method: "POST", headers: { ...CF, ...authB } });
ok(r.status === 404, `pc2's token cannot cancel mbp's question → 404 (${r.status})`);
r = await req(`${EDGE_B}/answer/${AQ}`);
ok(r.status === 404, `…nor through pc2's edge (${r.status})`);
r = await req(`${EDGE_A}/answer/${AQ}`);
ok(r.json?.kind === "pending", `mbp's question is still open for mbp (${r.json?.kind})`);
r = await req(`${HUB}/attest`, { method: "POST", body: { command: "x", session_id: `m:${A_ID}:same-sid` } });
ok(r.json?.approved === false, "the hub's local /attest never matches another machine's session");

// === 7. the hub goes away ===========================================================================
tunnel.st.down = true;
r = await until(async () => { const x = await req(`${EDGE_A}/health`); return x.json?.upstream?.reachable === false ? x : null; }, 5000);
ok(!!r && /530/.test(r.json.upstream.reason), `edge notices the hub is gone → "${r?.json?.upstream?.reason}"`);
// mbp has no bot of its own → as if no relay ran: the terminal takes over
r = await req(`${EDGE_A}/`);
ok(r.status === 0, `hub away, no own bot: edge GET / → connection dropped (${r.error})`);
r = await req(`${EDGE_A}/ask`, { method: "POST", body: { question: "q", options: ["a"] } });
ok(r.status === 0, `hub away, no own bot: edge POST /ask → connection dropped (${r.error})`);
const down = await call({ question: "hub 不在時問的?", options: ["a", "b"], logDir: scratch });
ok(down.kind === "unreachable", `hub away, no own bot: ask_human → unreachable (terminal picker takes over) → ${JSON.stringify(down)}`);
r = await req(`${EDGE_A}/answer/${AQ}`);
ok(r.status === 200 && r.json?.kind === "pending", `hub away, within the grace: an already-forwarded question's /answer → pending (${r.status} ${r.json?.kind})`);
// pc2 has its own bot → new questions fail over to it at once
await until(async () => (await req(`${EDGE_B}/health`)).json?.upstream?.reachable === false, 5000);
const fo = await ask(EDGE_B, { question: "備援:可以 push 嗎?", options: ["✅ 核准", "❌ 不要"], approves: "git push origin GH-1", session_id: "bsid", session_name: "b session" });
const kfo = await botB.keyboardWith(/備援:可以 push 嗎/);
ok(fo.status === 200 && !!kfo && !sent.some((s) => /備援/.test(s.text || "")), `hub away: pc2's new question goes to its OWN bot, not the hub's (${fo.status})`);
r = await req(`${EDGE_B}/attest`, { method: "POST", body: { command: "git push origin GH-1", session_id: "bsid" } });
ok(r.json?.approved === false, "before the ✅ tap: edge /attest → false");
if (kfo) botB.tap(kfo, 0, 0);
r = await req(`${EDGE_B}/answer/${fo.json?.request_id}`);
ok(r.json?.kind === "selection" && r.json.value === "✅ 核准", `answered on pc2's own bot → ${JSON.stringify(r.json)}`);
r = await req(`${EDGE_B}/attest`, { method: "POST", body: { command: "git push origin GH-1", session_id: "bsid" } });
ok(r.json?.approved === true && r.json.request_id === fo.json?.request_id, `✅ on pc2's own bot → edge /attest approves it, locally (${JSON.stringify(r.json)})`);
r = await req(`${EDGE_B}/attest`, { method: "POST", body: { command: "git push origin GH-1", session_id: "bsid" } });
ok(r.json?.approved === false && r.json.reason === "already_used", `…exactly once (${JSON.stringify(r.json)})`);
const stay = await ask(EDGE_B, { question: "留在 pc2 的題", session_id: "bsid", session_name: "b session" });
const kstay = await botB.keyboardWith(/留在 pc2 的題/);
ok(!!kstay, "another question while the hub is away → pc2's own bot too (left open across the recovery)");
await sleep(3600);
r = await req(`${EDGE_A}/answer/${AQ}`);
ok(r.status === 200 && r.json?.kind === "unreachable", `hub away past MYNA_UPSTREAM_GRACE: the forwarded question's /answer → unreachable, the client falls back — not re-sent on another bot (${JSON.stringify(r.json)})`);
tunnel.st.down = false;
const tUp = Date.now(); let bReach = 0, bActive = 0;
const watchB = (async () => { while (!bActive && Date.now() - tUp < 8000) { const x = await req(`${EDGE_B}/health`); if (x.json?.upstream?.reachable && !bReach) bReach = Date.now(); if (x.json?.upstream?.active) bActive = Date.now(); await sleep(40); } })();
r = await until(async () => { const x = await req(`${HUB}/answer/${AQ}`); return x.json?.kind && x.json.kind !== "pending" ? x : null; }, 8000);
ok(r?.json?.kind === "cancelled", `hub back: the edge cancels the question it gave up → ${JSON.stringify(r?.json)}`);
r = await req(`${EDGE_A}/health`);
ok(r.json?.upstream?.active === true && r.json.upstream.abandoned === 0, "edge (no own bot) forwards again as soon as the hub is back");
// pc2: back to the hub only after MYNA_UPSTREAM_RECOVER good checks in a row
await watchB;
ok(bReach > 0 && bActive > 0 && bActive - bReach >= 500, `pc2's edge: hub reachable again, but new questions return to it only after 3 good checks in a row (${bActive - bReach} ms later, checks every 300 ms)`);
const back = await ask(EDGE_B, { question: "主節點回來後的題", session_id: "bsid", session_name: "b session" });
ok(back.status === 200 && !!(await keyboardWith(/主節點回來後的題/)) && !botB.sent.some((m) => /主節點回來後的題/.test(m.text || "")), "hub back: pc2's new question goes to the hub again");
if (kstay) botB.tap(kstay, 0, 1);
r = await req(`${EDGE_B}/answer/${stay.json?.request_id}`);
ok(r.json?.kind === "selection" && r.json.value === "b", `the question left on pc2's own bot is answered there, in place (${JSON.stringify(r.json)})`);

// === 8. per-machine ask rate limit ===================================================================
// pc2 asked the hub twice so far (its first question, and the one after the recovery)
let codes = [], bOpen = null;
for (let i = 0; i < 5; i++) { const x = await ask(EDGE_B, { question: `rate ${i}`, session_id: "rate" }); codes.push(x.status); bOpen ||= x.json?.request_id; }
ok(codes.join(",") === "200,200,200,200,429", `pc2: asks beyond MYNA_REMOTE_ASK_MAX=6 per window → 429 (${codes.join(",")})`);
r = await ask(EDGE_A, { question: "mbp still fine", session_id: "rate" });
ok(r.status === 200, "…another machine's budget is its own");

// === 9. revoke ==========================================================================================
const rev = spawnSync(process.execPath, [src("scripts", "machines.mjs"), "revoke", "pc2"], { env: { ...baseEnv, MYNA_MACHINES_FILE: MACHINES }, encoding: "utf8" });
ok(rev.status === 0 && /revoked pc2/.test(rev.stdout), `machines.mjs revoke pc2 → ${rev.stdout.trim()}`);
await all401("revoked token", `Bearer ${bToken}`);
r = await until(async () => { const x = await req(`${HUB}/answer/${bOpen}`); return x.json?.kind === "cancelled" ? x : null; }, 8000);
ok(r?.json?.reason === "machine revoked" && sent.some((s) => /已被撤銷/.test(s.text || "")), `the revoked machine's open question is cancelled, the phone told → ${JSON.stringify(r?.json)}`);
r = await until(async () => { const x = await req(`${EDGE_B}/health`); return x.json?.upstream?.reachable === false ? x : null; }, 5000);
ok(/token refused/.test(r?.json?.upstream?.reason || ""), `pc2's edge stops forwarding — "${r?.json?.upstream?.reason}"`);
const lst = spawnSync(process.execPath, [src("scripts", "machines.mjs"), "list"], { env: { ...baseEnv, MYNA_MACHINES_FILE: MACHINES }, encoding: "utf8" });
ok(/mbp/.test(lst.stdout) && /pc2.*revoked/.test(lst.stdout), "machines.mjs list shows mbp and pc2 (revoked)");
r = await req(`${REMOTE}/health`, { headers: authA });
ok(r.status === 200, "mbp's token still works");

await mcp.close().catch(() => {});
try { process.kill(edgePid); } catch {}
if (failed) {
  for (const [port, out] of edgeLogs) console.log(`--- edge :${port} log ---\n${out.join("").split("\n").slice(-15).join("\n")}`);
  console.log(`--- hub log (tail) ---\n${hubLog.join("").split("\n").slice(-30).join("\n")}`);
}
cleanup(); stub.close(); botB.close(); botC.close(); tunnel.close(); misTunnel.close(); clearTimeout(watchdog);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ REMOTE (hub + edge + join) PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
