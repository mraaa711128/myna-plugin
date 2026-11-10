#!/usr/bin/env node
// Files sent from the phone to a chat session on ANOTHER machine (SPEC §5.3) — everything on this machine,
// no real bot, no real tunnel, temp dirs, random ports (never :7800 / :7801):
//   Telegram API stub (getFile + file URL) ← HUB relay (local port + remote port)
//     ← a tunnel stub in front of the remote port (can go down, can break GET /chat/file/<fid>)
//     ← EDGE "mbp" (MYNA_ROLE=edge, no bot of its own, chat forwarded)
//   EDGE "pc4": its own bot, MYNA_CHAT_FORWARD=off — chat (and files) on that bot, like one machine
// Proves: the hub downloads, the edge fetches its own copy (machine token + chat token) and its session
// gets a path on ITS machine, byte for byte, the hub's path nowhere in it; a fetch that fails is retried
// and delivered once, in order (only the messages before it are acked); a file the hub keeps handing out
// wrong is given up after 3 tries and the rest flows; a file gone at the hub → "unavailable"; the hub
// away or restarted loses nothing; GET /chat/file is scoped to the machine and the session; an edge that
// does not fetch (take without files:true) gets a line saying so; MYNA_CHAT_FORWARD=off keeps files local.
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as inbox from "../src/inbox.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const src = (...p) => path.join(ROOT, ...p);
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } };
const children = [];
const cleanup = () => { for (const c of children) { try { c.kill(); } catch {} } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 180s"); cleanup(); process.exit(1); }, 180000);
process.on("exit", cleanup);

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myna-edge-files-")));
const used = new Set([7800, 7801]);
const freePort = () => { for (;;) { const p = 20000 + Math.floor(Math.random() * 20000); if (!used.has(p)) { used.add(p); return p; } } };
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|CLAUDE_CODE_SESSION_ID$)/.test(k)) delete e[k];
  return e;
})();
const dirOf = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };

// --- Telegram API stubs (with files) -------------------------------------------------------------
function tgStub(token) {
  const s = { calls: [], updates: [], n: 1, mid: 100, thread: 900, files: new Map(), seq: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "GET" && u.pathname.startsWith("/file/")) {
      const f = [...s.files.values()].find((x) => u.pathname === `/file/bot${token}/${x.file_path}`);
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-length": String(f.bytes.length) }); return res.end(f.bytes);
    }
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
      const method = u.pathname.split("/").pop();
      if (method === "getUpdates") { const deliver = () => { const out = s.updates; s.updates = []; json({ ok: true, result: out }); }; return s.updates.length ? deliver() : setTimeout(deliver, 100); }
      s.calls.push({ method, b, at: Date.now() });
      if (method === "sendMessage") { b._id = ++s.mid; return json({ ok: true, result: { message_id: b._id } }); }
      if (method === "getMe") return json({ ok: true, result: { id: 1, is_bot: true, username: "MynaTestBot", has_topics_enabled: true } });
      if (method === "createForumTopic") { b._thread = ++s.thread; return json({ ok: true, result: { message_thread_id: b._thread, name: b.name } }); }
      if (method === "getFile") { const f = s.files.get(b.file_id); return f ? json({ ok: true, result: { file_id: b.file_id, file_path: f.file_path, file_size: f.bytes.length } }) : json({ ok: false, description: "no" }); }
      json({ ok: true, result: true });
    });
  });
  s.ready = new Promise((r) => srv.listen(0, "127.0.0.1", () => { s.url = `http://127.0.0.1:${srv.address().port}`; r(); }));
  s.of = (m) => s.calls.filter((c) => c.method === m).map((c) => c.b);
  s.push = (m) => { const id = ++s.mid; s.updates.push({ update_id: s.n++, message: { message_id: id, chat: { id: 42, type: "private" }, from: { id: 7, first_name: "Alice" }, ...m } }); return id; };
  s.doc = (thread, name, bytes = crypto.randomBytes(3000), caption) => {
    const file_id = `F${++s.seq}`; s.files.set(file_id, { file_path: `documents/f${s.seq}.bin`, bytes });
    s.push({ message_thread_id: thread, document: { file_id, file_unique_id: `u${file_id}`, file_name: name, mime_type: "application/pdf", file_size: bytes.length }, ...(caption ? { caption } : {}) });
    return bytes;
  };
  s.say = (thread, text) => s.push({ message_thread_id: thread, text });
  return s;
}
const HUB_TOKEN = "111111:HUBSECRETTOKEN", PC4_TOKEN = "444444:PC4SECRETTOKEN";
const hubTg = tgStub(HUB_TOKEN), pc4Tg = tgStub(PC4_TOKEN);
await Promise.all([hubTg.ready, pc4Tg.ready]);

// --- machines -----------------------------------------------------------------------------------------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const machine = (name) => { const id = crypto.randomBytes(6).toString("hex"); return { id, name, token: `myna_m_${id}_${crypto.randomBytes(32).toString("base64url")}` }; };
const MBP = machine("mbp"), PC2 = machine("pc2"), PC4 = machine("pc4");
const HUB_DIR = dirOf("hub"), MACHINES = path.join(HUB_DIR, "machines.json");
fs.writeFileSync(MACHINES, JSON.stringify({ version: 1, machines: [MBP, PC2, PC4].map((m) => ({ id: m.id, name: m.name, sha256: sha(m.token), os: "test", hostname: m.name, created_at: new Date().toISOString() })) }, null, 2));

// --- hub relay ----------------------------------------------------------------------------------------
const H = freePort(), R = freePort(), HUB = `http://127.0.0.1:${H}`, REMOTE = `http://127.0.0.1:${R}`;
const hubLog = [];
let hub;
const up = (url) => until(async () => { try { await fetch(url, { signal: AbortSignal.timeout(400) }); return true; } catch { return false; } }, 10000);
async function startHub() {
  hub = spawn(process.execPath, [src("src", "relay.mjs")], {
    env: {
      ...baseEnv, MYNA_ENV: path.join(HUB_DIR, ".env"), MYNA_PROVIDER: "telegram", TELEGRAM_BOT_TOKEN: HUB_TOKEN, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: hubTg.url,
      RELAY_PORT: String(H), MYNA_REMOTE_PORT: String(R), MYNA_MACHINES_FILE: MACHINES, MYNA_MACHINE_NAME: "win", MYNA_ANSWER_HOLD_MS: "1000",
      TELEGRAM_TOPIC_ROUND_GRACE: "0", MYNA_CHAT_PROGRESS_MS: "200", MYNA_PROGRESS_FILE: path.join(HUB_DIR, "chat-progress"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(hub); hub.stderr.on("data", (d) => hubLog.push(String(d)));
  if (!(await up(`${HUB}/health`))) { console.error("❌ hub relay never came up"); process.exit(1); }
}
await startHub();

// --- the tunnel: can go down; can break GET /chat/file/<fid> (status, cut, wrong bytes) --------------------
const open = new Set();
const tunnel = { _down: false, log: [], breakFile: new Map(), get down() { return this._down; }, set down(v) { this._down = v; if (v) for (const s of open) s.destroy(); } };
const tsrv = http.createServer((req, res) => {
  if (tunnel.down) { res.writeHead(530); res.end("tunnel down"); return; }
  open.add(req.socket); res.on("close", () => open.delete(req.socket));
  const entry = { method: req.method, url: req.url, at: Date.now() }; tunnel.log.push(entry);
  const fm = /^\/chat\/file\/([a-f0-9]+)$/.exec(req.url);
  const brk = fm && (tunnel.breakFile.get(fm[1]) || (tunnel.breakAll?.n > 0 ? tunnel.breakAll : null));
  if (brk && brk.n > 0) {
    brk.n--;
    if (brk.how === "500") { res.writeHead(500); return res.end("boom"); }
    if (brk.how === "cut") { res.writeHead(200, { "content-length": "100000" }); res.write("partial"); return setTimeout(() => req.socket.destroy(), 30); }
    if (brk.how === "wrong") { const b = Buffer.from("not the file"); res.writeHead(200, { "content-length": String(b.length) }); return res.end(b); }
  }
  const delay = fm && tunnel.slowFile ? tunnel.slowFile : 0;
  const fwd = http.request({ host: "127.0.0.1", port: R, method: req.method, path: req.url, headers: req.headers }, (r) => {
    const go = () => { if (res.destroyed || res.headersSent) return r.resume(); res.writeHead(r.statusCode, r.headers); r.pipe(res); };
    delay ? setTimeout(go, delay) : go();
  });
  fwd.on("error", () => { if (res.headersSent) return res.destroy(); res.writeHead(502); res.end("bad gateway"); });
  req.pipe(fwd);
});
await new Promise((r) => tsrv.listen(0, "127.0.0.1", r));
const TUNNEL = `http://127.0.0.1:${tsrv.address().port}`;

// --- edges --------------------------------------------------------------------------------------------
const TIMING = { MYNA_UPSTREAM_CHECK_MS: "250", MYNA_UPSTREAM_GRACE: "2", MYNA_UPSTREAM_RECOVER: "2", MYNA_ANSWER_HOLD_MS: "1000" };
const edgeLogs = {};
function startEdge(name, port, env) {
  const d = dirOf(name);
  const c = spawn(process.execPath, [src("src", "relay.mjs")], { env: { ...baseEnv, MYNA_ENV: path.join(d, ".env"), MYNA_ROLE: "edge", RELAY_PORT: String(port), MYNA_PROGRESS_FILE: path.join(d, "chat-progress"), ...TIMING, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(c); edgeLogs[name] = edgeLogs[name] || []; c.stderr.on("data", (d2) => edgeLogs[name].push(String(d2)));
  return c;
}
const health = async (base) => { try { return await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })).json(); } catch { return null; } };
const EM = freePort(), EDGE = `http://127.0.0.1:${EM}`, MBP_DIR = dirOf("mbp");
const mbpEnv = { MYNA_UPSTREAM: TUNNEL, MYNA_MACHINE_TOKEN: MBP.token };
let mbp = startEdge("mbp", EM, mbpEnv);
if (!(await up(`${EDGE}/health`))) { console.error("❌ edge never came up"); process.exit(1); }
await until(async () => (await health(EDGE))?.upstream?.active);

const req = async (url, { method = "GET", headers = {}, body, timeout = 8000, raw = false } = {}) => {
  try {
    const r = await fetch(url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e) { return { status: 0, error: e.cause?.code || e.message }; }
};
const secretOf = (dir) => { try { return fs.readFileSync(path.join(dir, "relay-secret"), "utf8").trim(); } catch { return ""; } };
const chatApi = (base, secretDir) => ({
  register: (body) => req(`${base}/chat/register`, { method: "POST", headers: { authorization: `Bearer ${secretOf(secretDir)}` }, body }),
  take: (token, max = 20) => req(`${base}/chat/take`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: { max } }),
});
const mbpChat = chatApi(EDGE, MBP_DIR);
const takeN = async (api, token, n, ms = 10000) => { const got = []; await until(async () => { const r = await api.take(token); got.push(...(r.json?.messages || [])); return got.length >= n; }, ms); return got; };
const hubInbox = () => { try { return JSON.parse(fs.readFileSync(path.join(HUB_DIR, "chat-sessions.json"), "utf8")).sessions || {}; } catch { return {}; } };

let A = await mbpChat.register({ session_id: "s-1", nick: "egret", label: "mbp-app" });
const topicA = A.json?.topic;
const sidHub = `m:${MBP.id}:s-1`;
const edgeDir = path.dirname(inbox.sessionDir(MBP_DIR, "s-1"));
ok(A.status === 200 && !!topicA, `setup: the edge's session chats through the hub (topic ${topicA})`);

// === 11. a file for the other machine's session: its own copy, its own path ===============================
let fidFirst;
{
  const bytes = hubTg.doc(topicA, "plan.pdf", undefined, "看計畫");
  const [m] = await takeN(mbpChat, A.json.token, 1);
  ok(m?.file_path && path.dirname(path.dirname(m.file_path)) === edgeDir && fs.readFileSync(m.file_path).equals(bytes),
    `11: the edge's session gets a path in the EDGE's inbox, byte for byte (${m?.file_path})`);
  ok(m?.text.startsWith(inbox.UNTRUSTED) && m.text.endsWith("看計畫") && !m.text.includes(HUB_DIR), "11: …the untrusted line and the caption; the hub's path is nowhere in it");
  const hubFiles = fs.readdirSync(path.join(HUB_DIR, "inbox")).flatMap((d) => fs.readdirSync(path.join(HUB_DIR, "inbox", d)));
  ok(hubFiles.length === 1, `11: the hub keeps its own copy (${hubFiles.length} file)`);
  fidFirst = /-([a-f0-9]{16})\./.exec(path.basename(m?.file_path || ""))?.[1];
  ok(tunnel.log.some((e) => e.url === `/chat/file/${fidFirst}`), "11: …fetched with GET /chat/file/<fid> through the tunnel");
}

// === 12. a fetch cut mid-way / a 500 once → retried, delivered once ===========================================
{
  // the next fetch through the tunnel is cut mid-way, the one after answers 500
  tunnel.breakAll = { how: "cut", n: 1 };
  hubTg.doc(topicA, "cut.pdf");
  const g1 = await takeN(mbpChat, A.json.token, 1, 15000);
  tunnel.breakAll = { how: "500", n: 1 };
  hubTg.doc(topicA, "e500.pdf");
  const got = [...g1, ...(await takeN(mbpChat, A.json.token, 1, 15000))];
  await sleep(1500);
  const again = await mbpChat.take(A.json.token);
  ok(got.length === 2 && got.every((m) => m.file_path && fs.existsSync(m.file_path)) && !(again.json?.messages || []).length,
    `12: a fetch cut mid-way and a 500 once → both retried and delivered, each once (${got.map((m) => m.text.match(/原檔名：(\S+?)，/)?.[1]).join(", ")})`);
  ok(got[0]?.text.includes("cut.pdf") && got[1]?.text.includes("e500.pdf"), "12: …in the order they were sent");
  ok(!fs.readdirSync(path.dirname(got[0].file_path)).some((f) => f.endsWith(".part")), "12: …no .part left on the edge");
}

// === 13. a file the hub keeps handing out wrong → given up after 3; what comes after still flows ===============
{
  tunnel.breakAll = { how: "wrong", n: 99 };
  hubTg.doc(topicA, "bad.pdf");
  await sleep(300);
  hubTg.say(topicA, "壞檔之後的字");
  const got = await takeN(mbpChat, A.json.token, 2, 20000);
  tunnel.breakAll = null;
  const bad = got.find((m) => m.text.includes("bad.pdf")), after = got.find((m) => m.text === "壞檔之後的字");
  ok(bad && !bad.file_path && bad.text.includes(inbox.UNAVAILABLE), `13: wrong bytes every time → after 3 tries "${bad?.text.split("\n")[1]}", no file_path`);
  ok(after && got.indexOf(bad) < got.indexOf(after), "13: …the text sent after it arrives, after it");
  ok(edgeLogs.mbp.join("").includes("(3/3)"), "13: …the edge logged the 3 tries");
}

// === 13b. a file the hub answers 500 for every time → given up after 3 as well ====================================
{
  tunnel.breakAll = { how: "500", n: 99 };
  hubTg.doc(topicA, "always500.pdf");
  await sleep(300);
  hubTg.say(topicA, "500 之後的字");
  const got = await takeN(mbpChat, A.json.token, 2, 20000);
  tunnel.breakAll = null;
  const b = got.find((m) => m.text.includes("always500.pdf"));
  ok(b && !b.file_path && b.text.includes(inbox.UNAVAILABLE) && got.some((m) => m.text === "500 之後的字"), `13b: 500 every time → given up after 3, "${b?.text.split("\n")[1]}"; the next message arrives`);
}

// === 13c. the edge restarts while a file is on its way → delivered once ==========================================
{
  tunnel.slowFile = 2500;
  const seen0 = tunnel.log.length;
  const bytes = hubTg.doc(topicA, "edge-restart.pdf");
  await until(() => tunnel.log.slice(seen0).some((e) => /^\/chat\/file\//.test(e.url)), 8000);
  mbp.kill(); await until(async () => !(await health(EDGE)), 5000);
  tunnel.slowFile = 0;
  mbp = startEdge("mbp", EM, mbpEnv);
  await up(`${EDGE}/health`);
  await until(async () => (await health(EDGE))?.upstream?.active, 10000);
  A = await mbpChat.register({ session_id: "s-1", nick: "egret", label: "mbp-app" });
  const got = await takeN(mbpChat, A.json.token, 1, 20000);
  await sleep(1500);
  const more = await mbpChat.take(A.json.token);
  ok(got.length === 1 && got[0].text.includes("edge-restart.pdf") && fs.readFileSync(got[0].file_path).equals(bytes) && !(more.json?.messages || []).length, "13c: the edge restarted mid-fetch → the file arrives once, whole");
}

// === 13d. a file already on the edge (saved before a restart, not yet acked) is not fetched again ====================
{
  tunnel.down = true;
  await until(async () => (await health(EDGE))?.upstream?.reachable === false);
  const bytes = hubTg.doc(topicA, "already.pdf");
  const hm = await until(() => [...(hubInbox()[sidHub]?.inbox || []), ...(hubInbox()[sidHub]?.unacked || [])].find((x) => x.file?.name === "already.pdf"));
  const name = inbox.fileName({ fid: hm.file.fid, original: hm.file.name, mime: hm.file.mime, at: hm.at });
  const sdir = inbox.sessionDir(MBP_DIR, "s-1"); fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, name), bytes);
  const before = tunnel.log.length;
  tunnel.down = false;
  const [m] = await takeN(mbpChat, A.json.token, 1, 20000);
  ok(m?.file_path && fs.readFileSync(m.file_path).equals(bytes) && !tunnel.log.slice(before).some((e) => e.url === `/chat/file/${hm.file.fid}`), "13d: the file already there (same size and sha256) → used, no second GET");
}

// === 14. the hub away, then restarted: the file sent meanwhile still arrives ================================
{
  tunnel.down = true;
  await until(async () => (await health(EDGE))?.upstream?.reachable === false);
  const bytes = hubTg.doc(topicA, "while-away.pdf");
  await until(() => [...(hubInbox()[sidHub]?.inbox || []), ...(hubInbox()[sidHub]?.unacked || [])].some((m) => m.file?.name === "while-away.pdf"));
  hub.kill(); await until(async () => !(await health(HUB)), 5000);
  await startHub();
  tunnel.down = false;
  const [m] = await takeN(mbpChat, A.json.token, 1, 20000);
  ok(m?.file_path && fs.readFileSync(m.file_path).equals(bytes), `14: a file sent while the hub was unreachable and then restarted arrives once both are back (${m?.text.match(/原檔名：(\S+?)，/)?.[1]})`);
}

// === 15. a file gone at the hub before the edge fetched it → "unavailable", and the rest flows =================
{
  tunnel.down = true;
  await until(async () => (await health(EDGE))?.upstream?.reachable === false);
  hubTg.doc(topicA, "gone.pdf");
  const m = await until(() => [...(hubInbox()[sidHub]?.inbox || []), ...(hubInbox()[sidHub]?.unacked || [])].find((x) => x.file?.name === "gone.pdf"));
  fs.rmSync(m.file.path);
  hubTg.say(topicA, "gone 之後");
  await sleep(500);
  tunnel.down = false;
  const got = await takeN(mbpChat, A.json.token, 2, 20000);
  const g = got.find((x) => x.text.includes("gone.pdf"));
  ok(g && !g.file_path && g.text.includes(inbox.UNAVAILABLE) && got.some((x) => x.text === "gone 之後"), `15: gone at the hub → "${g?.text.split("\n")[1]}"; the next message still arrives`);
}

// === 16. GET /chat/file is scoped to the machine and the session ============================================
{
  const mt = (m) => ({ authorization: `Bearer ${m.token}`, "x-myna-protocol": "1" });
  const X = await req(`${REMOTE}/chat/register`, { method: "POST", headers: mt(MBP), body: { session_id: "x-direct", nick: "probe" } });
  const XT = X.json?.token;
  hubTg.doc(X.json?.topic, "x.pdf");
  const xm = await until(() => Object.values(hubInbox()[`m:${MBP.id}:x-direct`]?.inbox || []).find((m) => m.file?.name === "x.pdf"));
  const fidX = xm?.file?.fid;
  const good = await req(`${REMOTE}/chat/file/${fidX}`, { headers: { ...mt(MBP), "x-myna-chat-token": XT }, raw: true });
  ok(good.status === 200 && good.buf.equals(fs.readFileSync(xm.file.path)), "16: machine token + the session's chat token → the file");
  const otherMachine = await req(`${REMOTE}/chat/file/${fidX}`, { headers: { ...mt(PC2), "x-myna-chat-token": XT } });
  const noToken = await req(`${REMOTE}/chat/file/${fidX}`, { headers: { "x-myna-chat-token": XT } });
  const wrongChat = await req(`${REMOTE}/chat/file/${fidX}`, { headers: { ...mt(MBP), "x-myna-chat-token": "nope" } });
  ok(otherMachine.status === 401 && noToken.status === 401 && wrongChat.status === 401, `16: another machine's token / no machine token / a wrong chat token → 401 (${otherMachine.status}, ${noToken.status}, ${wrongChat.status})`);
  const otherSession = await req(`${REMOTE}/chat/file/${fidFirst}`, { headers: { ...mt(MBP), "x-myna-chat-token": XT } });
  const badFid = await req(`${REMOTE}/chat/file/..%2F..%2Fmachines.json`, { headers: { ...mt(MBP), "x-myna-chat-token": XT } });
  ok(otherSession.status === 404 && badFid.status === 404, `16: another session's file / a fid that is no fid → 404 (${otherSession.status}, ${badFid.status})`);
  const local = await req(`${HUB}/chat/file/${fidX}`, { headers: { "x-myna-chat-token": XT } });
  ok(local.status !== 200, `16: no GET /chat/file on the local port (${local.status})`);

  // === 17. an edge that does not fetch (take without files:true) → told; with it → the description, no path
  const old = await req(`${REMOTE}/chat/take`, { method: "POST", headers: { ...mt(MBP), "x-myna-chat-token": XT }, body: { max: 5 } });
  const om = old.json?.messages?.find((m) => /x\.pdf|附檔/.test(m.text || "") || m.file);
  ok(om && !om.file && om.text.startsWith("📎 有附檔沒有送到") && /0\.22\.0/.test(om.text), `17: take without files:true → "${om?.text}", no file`);
  const nw = await req(`${REMOTE}/chat/take`, { method: "POST", headers: { ...mt(MBP), "x-myna-chat-token": XT }, body: { max: 5, files: true } });
  const nm = nw.json?.messages?.[0];
  ok(nm?.file?.fid === fidX && nm.file.sha256 === xm.file.sha256 && !("path" in nm.file) && !JSON.stringify(nw.json).includes(HUB_DIR.replace(/\\/g, "\\\\")), "17: with files:true → {fid, name, mime, size, sha256}, never the hub's path");
}

// === 18. an edge whose chat stays on its own bot (MYNA_CHAT_FORWARD=off) keeps files local ==================
{
  const P4 = freePort(), E4 = `http://127.0.0.1:${P4}`, D4 = dirOf("pc4");
  startEdge("pc4", P4, { MYNA_UPSTREAM: TUNNEL, MYNA_MACHINE_TOKEN: PC4.token, TELEGRAM_BOT_TOKEN: PC4_TOKEN, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: pc4Tg.url, MYNA_CHAT_FORWARD: "off" });
  await up(`${E4}/health`);
  await until(async () => (await health(E4))?.upstream?.reachable);
  const api4 = chatApi(E4, D4);
  const r4 = await api4.register({ session_id: "p4", nick: "heron" });
  const t4 = r4.json?.topic;
  const bytes = pc4Tg.doc(t4, "own.pdf");
  const [m] = await takeN(api4, r4.json?.token, 1);
  ok(m?.file_path && m.file_path.startsWith(fs.realpathSync.native(D4)) && fs.readFileSync(m.file_path).equals(bytes),
    `18: MYNA_CHAT_FORWARD=off → the file comes on this machine's own bot and stays here (${m?.file_path})`);
}

// the bot tokens: in no log line
{
  const logs = hubLog.join("") + Object.values(edgeLogs).flat().join("");
  ok(!logs.includes("HUBSECRETTOKEN") && !logs.includes("PC4SECRETTOKEN") && !logs.includes(MBP.token), "the bot tokens and the machine token are in no relay log line");
  const edgeState = fs.readFileSync(path.join(MBP_DIR, "edge-state.json"), "utf8");
  ok(!edgeState.includes(HUB_DIR.replace(/\\/g, "\\\\")), "the edge's state keeps only its own paths");
}

clearTimeout(watchdog);
if (failed) { console.log(`\n❌ ${failed} check(s) FAILED`); if (process.env.MYNA_TEST_VERBOSE) { console.log(hubLog.join("")); for (const [k, v] of Object.entries(edgeLogs)) console.log(`--- ${k}\n${v.join("")}`); } }
else console.log("\n✅ all edge-file checks passed");
cleanup();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
