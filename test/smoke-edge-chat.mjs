#!/usr/bin/env node
// Chat through the hub and questions held for it (0.21.0, SPEC §5.2) — everything on this machine, no real
// bot, no real tunnel:
//   Telegram API stub ← HUB relay (local port + MYNA_REMOTE_PORT; machines.json written here, no join)
//                       ← a tunnel stub in front of the remote port (can go down with a 530; logs each request)
//                       ← EDGE "mbp" (src/relay.mjs, MYNA_ROLE=edge) with a bot of its own (another stub)
//   a fake 0.20 hub (no `features`) ← EDGE "pc2" (own bot) and "pc3" (none);  "pc5": MYNA_UPSTREAM_HOLD=off
// The test plays the chat mod (register / take / progress / nick / close on the edge's local port) and the
// human (getUpdates updates on the hub's stub). Numbers are the SPEC §5.2 test plan:
//   1 chat mode off: questions forwarded, no chat session at the hub   3 chat mode on: everything through the
//   hub (topic "mbp · 💬 …", progress, the human's words incl. reply_to, "!cmd" alone, a nick taken → egret2;
//   nothing on the edge's own bot)   4 a hub older than 0.21.0: own bot (with a note) / 501 with a hint,
//   questions still forwarded   5 (MYNA_OLD_ROOT=<0.20.x checkout>) an old edge is not affected
//   6 the hub away: register "down", only the turn's latest state kept and sent once it is back, words typed
//   meanwhile arrive, an edge restart mid-outage loses nothing   7 a hub restart: 401 → registered again,
//   same topic, the post resent   8 revoke: the machine's chat topics 🔒, then 401   9 a burst of progress: at
//   most 5 posts a second reach the hub, the last state right   10 questions held while the hub is away
//   (pending+queued, nothing on the phone or the own bot, sent with the "held" line once back, the answer
//   back; a forwarded one waits past the grace; an edge restart keeps them; over the cap → unreachable;
//   MYNA_UPSTREAM_HOLD=off → the old way; env wins over the file; an unreadable file is the default;
//   /myna:hold status counts them)
// MYNA_TEST_ROOT=<another checkout> runs the same checks against that code (0.20.4 → 3, 6, 7, 10 must fail).
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const src = (...p) => path.join(ROOT, ...p);
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } };
const children = [];
const cleanup = () => { for (const c of children) { try { c.kill(); } catch {} } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 240s"); cleanup(); process.exit(1); }, 240000);
process.on("exit", cleanup);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-edge-chat-"));
const used = new Set([7800, 7801]);
const freePort = () => { for (;;) { const p = 20000 + Math.floor(Math.random() * 20000); if (!used.has(p)) { used.add(p); return p; } } };
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|CLAUDE_CODE_SESSION_ID$)/.test(k)) delete e[k];
  return e;
})();
// each relay's own ~/.myna (HOME = <TMP>/<name>), the layout of a real machine: on Windows its files are private
// through the folder (src/private-file.mjs), not by an icacls run per write
const dirOf = (name) => { const d = path.join(TMP, name, ".myna"); fs.mkdirSync(d, { recursive: true }); return d; };
const homeOf = (d) => ({ HOME: path.dirname(d), USERPROFILE: path.dirname(d) });

// --- Telegram API stubs ----------------------------------------------------------------------------
function tgStub() {
  const s = { calls: [], updates: [], n: 1, mid: 100, thread: 900 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
      const method = u.pathname.split("/").pop();
      if (method === "getUpdates") { const deliver = () => { const out = s.updates; s.updates = []; json({ ok: true, result: out }); }; return s.updates.length ? deliver() : setTimeout(deliver, 100); }
      s.calls.push({ method, b, at: Date.now() });
      if (method === "sendMessage") { b._id = ++s.mid; return json({ ok: true, result: { message_id: b._id } }); }
      if (method === "getMe") return json({ ok: true, result: { id: 1, is_bot: true, username: "MynaTestBot", has_topics_enabled: true } });
      if (method === "createForumTopic") { b._thread = ++s.thread; return json({ ok: true, result: { message_thread_id: b._thread, name: b.name } }); }
      json({ ok: true, result: true });
    });
  });
  s.ready = new Promise((r) => srv.listen(0, "127.0.0.1", () => { s.url = `http://127.0.0.1:${srv.address().port}`; r(); }));
  s.of = (m) => s.calls.filter((c) => c.method === m).map((c) => c.b);
  s.texts = (thread) => s.calls.filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && (thread === undefined || c.b.message_thread_id === thread || c.method === "editMessageText")).map((c) => c.b.text || "");
  s.keyboardWith = (re) => until(() => [...s.of("sendMessage")].reverse().find((m) => m.reply_markup?.inline_keyboard && re.test(m.text || "")));
  s.tap = (msg, row, idx) => s.updates.push({ update_id: s.n++, callback_query: { id: `cq${s.n}`, data: msg.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 }, message_id: msg.message_id } } });
  s.say = (text, { thread, replyTo, replyText } = {}) => { const id = ++s.mid; s.updates.push({ update_id: s.n++, message: { message_id: id, chat: { id: 42, type: "private" }, from: { id: 7, first_name: "Alice" }, text, ...(thread ? { message_thread_id: thread } : {}), ...(replyTo ? { reply_to_message: { message_id: replyTo, ...(replyText !== undefined ? { text: replyText } : {}) } } : {}) } }); return id; };
  return s;
}
const hubTg = tgStub(), mbpTg = tgStub(), pc2Tg = tgStub();
await Promise.all([hubTg.ready, mbpTg.ready, pc2Tg.ready]);

// --- machines (written here: joining is test/smoke-remote.mjs) ------------------------------------------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const machine = (name) => { const id = crypto.randomBytes(6).toString("hex"); return { id, name, token: `myna_m_${id}_${crypto.randomBytes(32).toString("base64url")}` }; };
const MBP = machine("mbp"), PC2 = machine("pc2");
const HUB_DIR = dirOf("hub"), MACHINES = path.join(HUB_DIR, "machines.json");
fs.writeFileSync(MACHINES, JSON.stringify({ version: 1, machines: [MBP, PC2].map((m) => ({ id: m.id, name: m.name, sha256: sha(m.token), os: "test", hostname: m.name, created_at: new Date().toISOString() })) }, null, 2));

// --- hub relay -----------------------------------------------------------------------------------------
const H = freePort(), R = freePort(), HUB = `http://127.0.0.1:${H}`;
const hubLog = [];
let hub;
const up = (url) => until(async () => { try { await fetch(url, { signal: AbortSignal.timeout(400) }); return true; } catch { return false; } }, 10000);
async function startHub() {
  hub = spawn(process.execPath, [src("src", "relay.mjs")], {
    env: {
      ...baseEnv, ...homeOf(HUB_DIR), MYNA_ENV: path.join(HUB_DIR, ".env"), MYNA_PROVIDER: "telegram", TELEGRAM_BOT_TOKEN: "111111:HUB", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: hubTg.url,
      RELAY_PORT: String(H), MYNA_REMOTE_PORT: String(R), MYNA_MACHINES_FILE: MACHINES, MYNA_MACHINE_NAME: "win", MYNA_ANSWER_HOLD_MS: "1000",
      TELEGRAM_TOPIC_ROUND_GRACE: "0", MYNA_CHAT_PROGRESS_MS: "200", MYNA_PROGRESS_FILE: path.join(HUB_DIR, "chat-progress"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(hub); hub.stderr.on("data", (d) => hubLog.push(String(d)));
  if (!(await up(`${HUB}/health`))) { console.error("❌ hub relay never came up"); process.exit(1); }
}
await startHub();

// --- the tunnel in front of the remote port (down → 530; every request logged with its status) --------------
// going down cuts what is in flight too (a held /chat/take long-poll), like a tunnel that dies
const open = new Set();
const tunnel = { _down: false, log: [], get down() { return this._down; }, set down(v) { this._down = v; if (v) for (const s of open) s.destroy(); } };
const tsrv = http.createServer((req, res) => {
  if (tunnel.down) { res.writeHead(530, { "content-type": "text/html" }); res.end("<html>tunnel down</html>"); return; }
  open.add(req.socket); res.on("close", () => open.delete(req.socket));
  const entry = { method: req.method, url: req.url, at: Date.now(), status: 0 }; tunnel.log.push(entry);
  // dropReply: the hub answers this request, the reply is lost on the way back (a broken link)
  // (judged when the reply comes: a long-poll already held at the hub counts)
  const drop = () => tunnel.dropReply && tunnel.dropReply.test(req.url) && ((tunnel.dropReply = null), true);
  const fwd = http.request({ host: "127.0.0.1", port: R, method: req.method, path: req.url, headers: req.headers }, (r) => {
    entry.status = r.statusCode;
    if (drop()) { entry.dropped = true; r.resume(); req.socket.destroy(); return; }
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  fwd.on("error", () => { entry.status = 502; res.writeHead(502); res.end("bad gateway"); });
  req.pipe(fwd);
});
await new Promise((r) => tsrv.listen(0, "127.0.0.1", r));
const TUNNEL = `http://127.0.0.1:${tsrv.address().port}`;

// --- edges ---------------------------------------------------------------------------------------------
const TIMING = { MYNA_UPSTREAM_CHECK_MS: "250", MYNA_UPSTREAM_GRACE: "2", MYNA_UPSTREAM_RECOVER: "2", MYNA_ANSWER_HOLD_MS: "1000" };
const edgeLogs = {};
function startEdge(name, port, env) {
  const d = dirOf(name);
  const c = spawn(process.execPath, [src("src", "relay.mjs")], { env: { ...baseEnv, ...homeOf(d), MYNA_ENV: path.join(d, ".env"), MYNA_ROLE: "edge", RELAY_PORT: String(port), MYNA_PROGRESS_FILE: path.join(d, "chat-progress"), ...TIMING, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(c); edgeLogs[name] = edgeLogs[name] || []; c.stderr.on("data", (d2) => edgeLogs[name].push(String(d2)));
  return c;
}
const EM = freePort(), EDGE = `http://127.0.0.1:${EM}`;
const mbpEnv = { MYNA_UPSTREAM: TUNNEL, MYNA_MACHINE_TOKEN: MBP.token, TELEGRAM_BOT_TOKEN: "222222:MBP-OWN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: mbpTg.url };
let mbp = startEdge("mbp", EM, mbpEnv);
if (!(await up(`${EDGE}/health`))) { console.error("❌ edge mbp never came up"); process.exit(1); }
const health = async (base) => { try { return await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })).json(); } catch { return null; } };
await until(async () => (await health(EDGE))?.upstream?.active);

const req = async (url, { method = "GET", headers = {}, body, timeout = 8000 } = {}) => {
  try {
    const r = await fetch(url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e) { return { status: 0, error: e.cause?.code || e.message }; }
};
const secretOf = (dir) => { try { return fs.readFileSync(path.join(dir, "relay-secret"), "utf8").trim(); } catch { return ""; } };
const chatApi = (base, secretDir) => ({
  register: (body) => req(`${base}/chat/register`, { method: "POST", headers: { authorization: `Bearer ${secretOf(secretDir)}` }, body }),
  call: (p, token, body = {}) => req(`${base}/chat/${p}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body }),
});
const mbpChat = chatApi(EDGE, dirOf("mbp"));
const ask = (base, body) => req(`${base}/ask`, { method: "POST", body });
const answerOf = async (base, id, ms = 15000) => { const t0 = Date.now(); for (;;) { const r = await req(`${base}/answer/${id}`, { timeout: 10000 }); if (r.status !== 200 || r.json?.kind !== "pending" || Date.now() - t0 > ms) return r; } };
const hubChatFile = () => { try { return JSON.parse(fs.readFileSync(path.join(HUB_DIR, "chat-sessions.json"), "utf8")).sessions || {}; } catch { return {}; } };

// === 1. chat mode off: a question is forwarded, the hub gets no chat session =============================
{
  const r = await ask(EDGE, { question: "要部署嗎?(組合 1)", options: ["好", "先不要"], session_id: "plain-1" });
  const kb = await hubTg.keyboardWith(/組合 1/);
  ok(r.status === 200 && !!r.json?.request_id && !!kb, `1: a question on an edge without chat mode reaches the hub's phone (request ${r.json?.request_id})`);
  hubTg.tap(kb, 0, 0);
  const a = await answerOf(EDGE, r.json?.request_id);
  ok(a.json?.kind === "selection" && a.json.value === "好", `1: …and its answer comes back through the edge (${JSON.stringify(a.json)})`);
  ok(Object.keys(hubChatFile()).length === 0 && (await health(HUB))?.chat_sessions === 0, "1: the hub has no chat session (nothing called /chat/*)");
}

// === 3. chat mode on: everything through the hub ========================================================
const hubChat = chatApi(HUB, HUB_DIR);
const local = await hubChat.register({ session_id: "hub-own", nick: "egret", label: "hub-app" });
ok(local.status === 200 && local.json?.nick === "egret", `3: the hub's own chat session takes the nick "egret" first (${local.json?.nick})`);
const ownTopics0 = mbpTg.of("createForumTopic").length;
let A = await mbpChat.register({ session_id: "s-1", nick: "egret", label: "mbp-app", cwd: "/Users/x/mbp-app" });
const sidAtHub = `m:${MBP.id}:s-1`;
const topicA = A.json?.topic;
{
  const eh = await health(EDGE);
  ok(eh?.upstream?.chat === "forwarded" && Array.isArray(eh?.upstream?.features) && eh.upstream.features.includes("chat"), `3: the edge's /health → upstream.chat "${eh?.upstream?.chat}", features ${JSON.stringify(eh?.upstream?.features)}`);
  ok(A.status === 200 && !!A.json?.token && A.json.nick === "egret2", `3: register on the edge → through the hub, the nick taken there becomes "${A.json?.nick}"`);
  ok(!!hubChatFile()[sidAtHub], `3: the hub keeps the session as ${sidAtHub}`);
  const t = hubTg.of("createForumTopic").find((x) => x._thread === topicA);
  ok(!!t && t.name === "mbp · 💬 egret2 · mbp-app", `3: the topic is on the hub's bot, named with the machine: "${t?.name}"`);
  ok(mbpTg.of("createForumTopic").length === ownTopics0 && !mbpTg.of("sendMessage").some((m) => /egret/.test(m.text || "")), "3: nothing of it on the edge's own bot (chat always goes through the hub)");
  const ownTopic = hubTg.of("createForumTopic").find((x) => /hub-app/.test(x.name));
  ok(ownTopic?.name === "win · 💬 egret · hub-app", `3: the hub's own chat topic carries its machine name too once machines have joined: "${ownTopic?.name}"`);
}
{
  const T = A.json.token;
  await mbpChat.call("progress", T, { event: "start", origin: "terminal", prompt: "整理 README ALPHA-START" });
  await mbpChat.call("progress", T, { event: "step", text: "先讀一下 ALPHA-STEP", tools: [{ name: "Read", input: { file_path: "/x/README.md" } }] });
  await mbpChat.call("progress", T, { event: "done", text: "README 整理好了 ALPHA-DONE" });
  const shown = await until(() => { const all = hubTg.texts().join("\n"); return /ALPHA-START/.test(all) && /ALPHA-STEP/.test(all) && /ALPHA-DONE/.test(all); });
  ok(!!shown, "3: progress start / step / done show on the hub's bot");
  const m1 = hubTg.say("幫我跑一下測試", { thread: topicA });
  const got = await until(async () => { const r = await mbpChat.call("take", T, { max: 5 }); return r.json?.messages?.length ? r : null; }, 10000);
  ok(got?.json?.messages?.[0]?.text === "幫我跑一下測試", `3: what the human types in that topic reaches the edge's session (${JSON.stringify(got?.json?.messages?.[0]?.text)})`);
  const anchor = hubTg.of("sendMessage").filter((m) => m.message_thread_id === topicA).pop();
  hubTg.say("好", { thread: topicA, replyTo: anchor?._id, replyText: "我要做:① 跑測試" });
  const rep = await until(async () => { const r = await mbpChat.call("take", T, { max: 5 }); return r.json?.messages?.length ? r : null; }, 10000);
  ok(rep?.json?.messages?.[0]?.reply_to?.message_id === anchor?._id && rep.json.messages[0].reply_to.text === "我要做:① 跑測試", `3: …a reply carries reply_to (${JSON.stringify(rep?.json?.messages?.[0]?.reply_to)})`);
  hubTg.say("先看 log", { thread: topicA }); hubTg.say("!compact", { thread: topicA }); hubTg.say("然後再說", { thread: topicA });
  await until(async () => hubChatFile()[sidAtHub] && (await sleep(1500), true), 3000);
  const b1 = await mbpChat.call("take", T, { max: 10 }), b2 = await mbpChat.call("take", T, { max: 10 }), b3 = await mbpChat.call("take", T, { max: 10 });
  ok(b1.json?.messages?.map((m) => m.text).join("|") === "先看 log" && b2.json?.messages?.map((m) => m.text).join("|") === "!compact" && b3.json?.messages?.map((m) => m.text).join("|") === "然後再說",
    `3: a "!command" is taken on its own (${[b1, b2, b3].map((b) => JSON.stringify(b.json?.messages?.map((m) => m.text))).join(" ")})`);
  const s = await req(`${EDGE}/chat/session?session_id=s-1`);
  ok(s.json?.chat === true && s.json?.nick === "egret2", `3: GET /chat/session on the edge → ${JSON.stringify(s.json)}`);
  void m1;
}

// === 4. a hub older than 0.21.0 (no features) ===========================================================
{
  const fake = { asks: [] };
  const fsrv = http.createServer((q, res) => {
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let body = ""; q.on("data", (c) => (body += c));
    q.on("end", () => {
      if (q.url === "/health") return json(200, { ok: true, name: "myna-relay", version: "0.20.4", protocol: 1, role: "hub", machine: { id: PC2.id, name: "pc2" }, bot_id: "telegram:999999" });
      if (q.url === "/ask") { const id = q.headers["x-myna-request-id"]; fake.asks.push(id); return json(200, { request_id: id }); }
      if (q.url.startsWith("/answer/")) return json(200, { kind: "pending" });
      json(404, { error: "no" });
    });
  });
  await new Promise((r) => fsrv.listen(0, "127.0.0.1", r));
  const FAKE = `http://127.0.0.1:${fsrv.address().port}`;
  const P2 = freePort(), P3 = freePort(), E2 = `http://127.0.0.1:${P2}`, E3 = `http://127.0.0.1:${P3}`;
  startEdge("pc2", P2, { MYNA_UPSTREAM: FAKE, MYNA_MACHINE_TOKEN: PC2.token, TELEGRAM_BOT_TOKEN: "333333:PC2-OWN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: pc2Tg.url });
  startEdge("pc3", P3, { MYNA_UPSTREAM: FAKE, MYNA_MACHINE_TOKEN: PC2.token });
  await up(`${E2}/health`); await up(`${E3}/health`);
  await until(async () => (await health(E2))?.upstream?.reachable && (await health(E3))?.upstream?.reachable);
  const r2 = await chatApi(E2, dirOf("pc2")).register({ session_id: "p2", nick: "heron", label: "pc2-app" });
  ok(r2.status === 200 && /不支援轉送聊天/.test(r2.json?.note || "") && /自己的 bot/.test(r2.json?.note || "") && pc2Tg.of("createForumTopic").some((t) => /heron/.test(t.name)),
    `4: an old hub + an own bot → chat on this machine's own bot, the mod is told: "${r2.json?.note}"`);
  ok((await health(E2))?.upstream?.chat === "own-bot", "4: …upstream.chat \"own-bot\"");
  const r3 = await chatApi(E3, dirOf("pc3")).register({ session_id: "p3", nick: "ibis" });
  ok(r3.status === 501 && /不支援轉送聊天/.test(r3.json?.hint || ""), `4: an old hub, no own bot → register 501 with a hint for the mod: "${r3.json?.hint}"`);
  const q3 = await ask(E3, { question: "舊主節點也照樣轉送題目?", options: ["是", "否"], session_id: "p3" });
  ok(q3.status === 200 && fake.asks.includes(q3.json?.request_id), "4: …its questions are still forwarded to that hub");
  ok((await health(E3))?.upstream?.chat === "unsupported", "4: …upstream.chat \"unsupported\"");
}

// === 5. an old edge against this hub (optional: MYNA_OLD_ROOT=<a 0.20.x checkout>) ==========================
if (process.env.MYNA_OLD_ROOT) {
  const P = freePort(), E = `http://127.0.0.1:${P}`, d = dirOf("old");
  const c = spawn(process.execPath, [path.join(path.resolve(process.env.MYNA_OLD_ROOT), "src", "relay.mjs")], { env: { ...baseEnv, ...homeOf(d), MYNA_ENV: path.join(d, ".env"), MYNA_ROLE: "edge", RELAY_PORT: String(P), MYNA_UPSTREAM: TUNNEL, MYNA_MACHINE_TOKEN: PC2.token, ...TIMING }, stdio: ["ignore", "ignore", "ignore"] });
  children.push(c);
  await up(`${E}/health`); await until(async () => (await health(E))?.upstream?.active);
  const reg = await chatApi(E, d).register({ session_id: "o1", nick: "old" });
  const q = await ask(E, { question: "舊 edge 的題目(組合 5)", options: ["A", "B"], session_id: "o1" });
  ok(reg.status === 501 && q.status === 200 && !!(await hubTg.keyboardWith(/組合 5/)), `5: an old edge (${(await health(E))?.version}) with this hub: chat 501 as before, questions forwarded`);
  c.kill();
} else console.log("ℹ️  5: skipped (set MYNA_OLD_ROOT=<a 0.20.x checkout> to run an old edge against this hub)");

// === 6. the hub away while a session chats ================================================================
{
  tunnel.down = true;
  await until(async () => (await health(EDGE))?.upstream?.reachable === false);
  const reg = await mbpChat.register({ session_id: "s-down", nick: "kite", label: "down-app" });
  ok(reg.status === 200 && !!reg.json?.token && reg.json.topic === null && reg.json.upstream === "down", `6: register while the hub is away → token, topic null, upstream "down" (${JSON.stringify({ ...reg.json, token: !!reg.json?.token })})`);
  ok((await health(EDGE))?.upstream?.chat === "down", "6: …upstream.chat \"down\"");
  const T = reg.json.token, TA = A.json.token;
  await mbpChat.call("progress", TA, { event: "start", origin: "terminal", prompt: "斷線中的一輪 BETA-START" });
  for (const k of ["B1", "B2", "B3"]) await mbpChat.call("progress", TA, { event: "step", text: `做 BETA-${k}`, tools: [{ name: "Bash", input: { command: `echo ${k}` } }] });
  await mbpChat.call("progress", T, { event: "start", origin: "terminal", prompt: "還沒註冊上的 GAMMA-START" });
  const ownBefore = mbpTg.calls.length;
  hubTg.say("斷線時打的字", { thread: topicA });
  await sleep(800);
  const tk = await mbpChat.call("take", TA, { max: 5 });
  ok(tk.status === 200 && tk.json?.upstream === "down" && !tk.json.messages?.length, `6: take while away → nothing yet, upstream "down" (${tk.status} ${JSON.stringify(tk.json)})`);
  // restart the edge mid-outage: what it holds is in edge-state.json
  mbp.kill(); await until(async () => !(await health(EDGE)), 5000);
  mbp = startEdge("mbp", EM, mbpEnv);
  await up(`${EDGE}/health`);
  const state = JSON.parse(fs.readFileSync(path.join(dirOf("mbp"), "edge-state.json"), "utf8"));
  ok(Array.isArray(state.chat) && state.chat.some(([sid, v]) => sid === "s-1" && v.queue?.length === 2), `6: edge-state.json keeps s-1's unsent progress cut to the turn's latest state (${JSON.stringify(state.chat?.find(([sid]) => sid === "s-1")?.[1]?.queue?.map((e) => e.event))})`);
  const sentBefore = tunnel.log.length;
  tunnel.down = false;
  await until(async () => (await health(EDGE))?.upstream?.reachable);
  // the mod re-registers after the restart (its token is gone) — the same session, the same topic
  const A2 = await mbpChat.register({ session_id: "s-1", nick: "egret2", label: "mbp-app" });
  ok(A2.json?.topic === topicA, `6: after the restart the session registers again → the same topic (${A2.json?.topic} = ${topicA})`);
  A = A2;
  const caught = await until(() => { const all = hubTg.texts().join("\n"); return /BETA-START/.test(all) && /BETA-B3/.test(all); }, 10000);
  const all = hubTg.texts().join("\n");
  ok(!!caught && !/BETA-B1/.test(all) && !/BETA-B2/.test(all), "6: once the hub is back: the turn's start and its LAST step are sent, the steps in between are not");
  const posts = tunnel.log.slice(sentBefore).filter((e) => e.url === "/chat/progress").length;
  ok(posts >= 2 && posts <= 3, `6: …${posts} progress post(s) for it after the outage (start + the last step, + the other session's start)`);
  const words = await until(async () => { const r = await mbpChat.call("take", A.json.token, { max: 5 }); return r.json?.messages?.length ? r : null; }, 10000);
  ok(words?.json?.messages?.[0]?.text === "斷線時打的字", "6: what the human typed during the outage arrives once the hub is back");
  const kite = await until(() => hubTg.of("createForumTopic").find((t) => /kite/.test(t.name)), 8000);
  ok(!!kite && kite.name === "mbp · 💬 kite · down-app" && !!(await until(() => /GAMMA-START/.test(hubTg.texts().join("\n")), 8000)), `6: the session that registered while away gets its topic and its held progress once the hub is back ("${kite?.name}")`);
  ok(mbpTg.calls.slice(ownBefore).every((c) => c.method !== "sendMessage" && c.method !== "createForumTopic"), "6: nothing went to the edge's own bot meanwhile");
}

// === 6b. a batch of the human's words whose reply is lost on the way back is handed out again, once ============
{
  const T = A.json.token;
  await mbpChat.call("take", T, { max: 50 }); // the session is idle, its long-poll at the hub is open
  await sleep(400);
  tunnel.dropReply = /^\/chat\/take$/;
  hubTg.say("回程掉了的那句 LOST-1", { thread: topicA });
  const got = await until(async () => { const r = await mbpChat.call("take", T, { max: 50 }); return r.json?.messages?.length ? r : null; }, 12000);
  await sleep(1500);
  const again = await mbpChat.call("take", T, { max: 50 });
  ok(tunnel.log.some((e) => e.dropped) && got?.json?.messages?.map((m) => m.text).join("|") === "回程掉了的那句 LOST-1" && !again.json?.messages?.length,
    `6b: a take reply lost on the way back → the hub hands that batch out again, the session gets it exactly once (${JSON.stringify(got?.json?.messages?.map((m) => m.text))}, then ${JSON.stringify(again.json?.messages)})`);
}

// === 7. a hub restart: 401 → registered again, same topic, the post resent =====================================
{
  const topicsBefore = hubTg.of("createForumTopic").length;
  hub.kill(); await until(async () => !(await health(HUB)), 5000);
  await startHub();
  await until(async () => (await health(EDGE))?.upstream?.reachable);
  const T = A.json.token;
  const r = await mbpChat.call("progress", T, { event: "step", text: "重啟後 DELTA-STEP", tools: [{ name: "Read", input: { file_path: "/y" } }] });
  const shown = await until(() => /DELTA-STEP/.test(hubTg.texts().join("\n")), 12000);
  ok(r.status === 200 && !!shown, "7: after a hub restart the edge registers the session again and the post goes through");
  ok(hubTg.of("createForumTopic").length === topicsBefore, "7: …into the same topic (no new one)");
  ok(tunnel.log.some((e) => e.status === 401 && /^\/chat\//.test(e.url)) && tunnel.log.filter((e) => e.url === "/chat/register").length >= 3, "7: …it took a 401 and a new registration (seen on the tunnel)");
}

// === 9. a burst of progress: at most 5 posts a second reach the hub ============================================
{
  const T = A.json.token, from = tunnel.log.length;
  await mbpChat.call("progress", T, { event: "start", origin: "terminal", prompt: "一口氣很多步 EPS-START" });
  for (let i = 1; i <= 19; i++) mbpChat.call("progress", T, i < 19 ? { event: "step", text: `EPS-${i}`, tools: [{ name: "Read", input: { file_path: `/f${i}` } }] } : { event: "done", text: "全部完成 EPS-DONE" });
  const done = await until(() => /EPS-DONE/.test(hubTg.texts().join("\n")), 20000);
  const ok200 = tunnel.log.slice(from).filter((e) => e.url === "/chat/progress" && e.status === 200).map((e) => e.at).sort((a, b) => a - b);
  let worst = 0;
  for (let i = 0; i < ok200.length; i++) { let n = 0; for (let j = i; j < ok200.length && ok200[j] - ok200[i] < 1000; j++) n++; worst = Math.max(worst, n); }
  ok(!!done && worst <= 5, `9: 20 posts in a burst → the hub took at most ${worst} in any second (limit 5), ${ok200.length} in all, and the turn's final answer arrived`);
  // the hub's own limit, without an edge in between: 8 posts at once from one remote session → some 429
  const RP = `http://127.0.0.1:${R}`, auth = { authorization: `Bearer ${PC2.token}` };
  const reg = await req(`${RP}/chat/register`, { method: "POST", headers: auth, body: { session_id: "burst", nick: "burst" } });
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => req(`${RP}/chat/progress`, { method: "POST", headers: { ...auth, "x-myna-chat-token": reg.json?.token }, body: { event: "step", text: `b${i}`, tools: [{ name: "Read", input: {} }] } }).then((x) => x.status)));
  ok(reg.status === 200 && codes.filter((c) => c === 200).length === 5 && codes.filter((c) => c === 429).length === 3, `9: the hub itself takes 5 posts a second from a remote session and answers 429 to the rest (${codes.join(",")})`);
  const cross = await req(`${RP}/chat/take`, { method: "POST", headers: { authorization: `Bearer ${MBP.token}`, "x-myna-chat-token": reg.json?.token }, body: {} });
  ok(cross.status === 401, `9: another machine's token cannot use that session's chat token (${cross.status})`);
}

// === 8. revoke: the machine's chat topics 🔒, then 401 =====================================================
{
  const rv = spawnSync(process.execPath, [src("scripts", "machines.mjs"), "revoke", "mbp"], { env: { ...baseEnv, ...homeOf(HUB_DIR), MYNA_ENV: path.join(HUB_DIR, ".env"), MYNA_MACHINES_FILE: MACHINES }, encoding: "utf8" });
  const locked = await until(() => hubTg.of("editForumTopic").find((e) => e.message_thread_id === topicA && /^mbp · 🔒/.test(e.name || "")), 12000);
  ok(rv.status === 0 && !!locked, `8: machines.mjs revoke mbp → its chat topic is closed: "${locked?.name}"`);
  const sess = hubChatFile()[sidAtHub];
  ok(!!sess?.closed && (sess.inbox || []).length === 0, "8: …the hub's session is closed, its inbox cleared");
  const r = await req(`http://127.0.0.1:${R}/chat/take`, { method: "POST", headers: { authorization: `Bearer ${MBP.token}` }, body: {} });
  ok(r.status === 401, `8: …and its token gets 401 from then on (${r.status})`);
  ok(!!hubChatFile()["hub-own"] && !hubChatFile()["hub-own"].closed, "8: the hub's own chat session is untouched");
}

// === 10. questions held while the hub is away (chat mode off) — a second machine, "pc7" ========================
const PC7 = machine("pc7");
{
  const m = JSON.parse(fs.readFileSync(MACHINES, "utf8"));
  m.machines.push({ id: PC7.id, name: "pc7", sha256: sha(PC7.token), os: "test", hostname: "pc7", created_at: new Date().toISOString() });
  fs.writeFileSync(MACHINES, JSON.stringify(m, null, 2));
}
const pc7Tg = tgStub(); await pc7Tg.ready;
const E7 = freePort(), EDGE7 = `http://127.0.0.1:${E7}`;
const pc7Env = { MYNA_UPSTREAM: TUNNEL, MYNA_MACHINE_TOKEN: PC7.token, TELEGRAM_BOT_TOKEN: "777777:PC7-OWN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: pc7Tg.url };
let pc7 = startEdge("pc7", E7, pc7Env);
await up(`${EDGE7}/health`); await until(async () => (await health(EDGE7))?.upstream?.active);
const HOLD_FILE = path.join(dirOf("pc7"), "upstream-hold");
const holdStatus = () => spawnSync(process.execPath, [src("scripts", "hold.mjs"), "status"], { env: { ...baseEnv, ...homeOf(dirOf("pc7")), MYNA_ENV: path.join(dirOf("pc7"), ".env"), MYNA_ROLE: "edge", RELAY_PORT: String(E7) }, encoding: "utf8" }).stdout || "";
{
  // a question forwarded before the outage waits past the grace (2 s here) instead of being given up
  const f = await ask(EDGE7, { question: "斷線前就送出的題(第 10 項)", options: ["一", "二"], session_id: "q-1" });
  const fkb = await hubTg.keyboardWith(/斷線前就送出的題/);
  tunnel.down = true;
  await until(async () => (await health(EDGE7))?.upstream?.reachable === false);
  const ownBefore = pc7Tg.of("sendMessage").length, phoneBefore = hubTg.of("sendMessage").length;
  const h1 = await ask(EDGE7, { question: "斷線時問的第一題 HELD-1", options: ["好", "不要"], session_id: "q-1" });
  const p1 = await req(`${EDGE7}/answer/${h1.json?.request_id}`, { timeout: 10000 });
  ok(h1.status === 200 && !!h1.json?.request_id && p1.json?.kind === "pending" && p1.json?.queued === true, `10: a question while the hub is away → request id, /answer {kind:"pending", queued:true} (${JSON.stringify(p1.json)})`);
  ok(pc7Tg.of("sendMessage").length === ownBefore && hubTg.of("sendMessage").length === phoneBefore, "10: …nothing on the phone yet, nothing on the edge's own bot");
  const st = holdStatus();
  ok(/排著 1 題/.test(st) && /最早 \d\d:\d\d 問的/.test(st) && /另有 1 題已送出、在等你回答/.test(st), `10: /myna:hold status: ${st.split("\n").filter((l) => /排著/.test(l)).join(" ")}`);
  await sleep(2600);
  const pf = await req(`${EDGE7}/answer/${f.json?.request_id}`, { timeout: 10000 });
  ok(pf.json?.kind === "pending", `10: the question forwarded before the outage is still waiting past the 2 s grace (${JSON.stringify(pf.json)})`);
  // restart the edge while holding: the held question survives
  pc7.kill(); await until(async () => !(await health(EDGE7)), 5000);
  pc7 = startEdge("pc7", E7, pc7Env);
  await up(`${EDGE7}/health`);
  ok((await health(EDGE7))?.upstream?.hold?.queued === 1, "10: an edge restart keeps the held question (edge-state.json)");
  tunnel.down = false;
  const kb = await hubTg.keyboardWith(/HELD-1/);
  const pre = hubTg.of("sendMessage").find((x) => /斷線時排著/.test(x.text || ""));
  ok(!!kb && /（這題在主節點斷線時排著，\d\d:\d\d 問的，\d\d:\d\d 送出）/.test(pre?.text || ""), `10: once the hub is back it goes to the phone with the held line: "${pre?.text}"`);
  hubTg.tap(kb, 0, 1);
  const a = await answerOf(EDGE7, h1.json.request_id);
  ok(a.json?.kind === "selection" && a.json.value === "不要", `10: …and the answer comes back to the client (${JSON.stringify(a.json)})`);
  hubTg.tap(fkb, 0, 1);
  const fa = await answerOf(EDGE7, f.json.request_id);
  ok(fa.json?.kind === "selection" && fa.json.value === "二", "10: the one forwarded before the outage gets its answer too");
}
{
  // over the cap: a question held for 2 hours, with max=1h → unreachable
  pc7.kill(); await until(async () => !(await health(EDGE7)), 5000);
  tunnel.down = true;
  const sf = path.join(dirOf("pc7"), "edge-state.json"), s = JSON.parse(fs.readFileSync(sf, "utf8"));
  s.queued = [["abcdef0123", { body: JSON.stringify({ question: "排太久的題", options: ["A", "B"], session_id: "q-old" }), at: Date.now() - 2 * 3600 * 1000 }]];
  fs.writeFileSync(sf, JSON.stringify(s));
  fs.writeFileSync(HOLD_FILE, `on\nmax=3600\n${new Date().toISOString()}\n`);
  pc7 = startEdge("pc7", E7, pc7Env);
  await up(`${EDGE7}/health`);
  const r = await answerOf(EDGE7, "abcdef0123", 8000);
  ok(r.json?.kind === "unreachable", `10: held longer than max (1 h) → {kind:"unreachable"} (${JSON.stringify(r.json)})`);
  // an unreadable file counts as the default
  fs.writeFileSync(HOLD_FILE, "maybe\n");
  const h = (await health(EDGE7))?.upstream?.hold;
  ok(h?.on === true && h.max_s === 86400 && !!h.bad, `10: an unreadable /myna:hold file → the default (on, 1 day) and says why (${h?.bad})`);
  // off → the old way: no own bot here would mean the terminal; pc7 has one → the question goes to it
  fs.writeFileSync(HOLD_FILE, `off\n${new Date().toISOString()}\n`);
  const o = await ask(EDGE7, { question: "關掉排隊後的題 OFF-1", options: ["是", "否"], session_id: "q-2" });
  ok(o.status === 200 && !!(await pc7Tg.keyboardWith(/OFF-1/)), "10: /myna:hold off → a new question goes to the edge's own bot again (0.20.3's way)");
  fs.rmSync(HOLD_FILE);
  tunnel.down = false;
}
{
  // MYNA_UPSTREAM_HOLD=off wins over the file's on; no own bot → the connection is dropped (the terminal takes it)
  const P5 = freePort(), E5 = `http://127.0.0.1:${P5}`, d5 = dirOf("pc5");
  fs.writeFileSync(path.join(d5, "upstream-hold"), "on\n");
  startEdge("pc5", P5, { MYNA_UPSTREAM: "http://127.0.0.1:9", MYNA_MACHINE_TOKEN: PC7.token, MYNA_UPSTREAM_HOLD: "off" });
  await up(`${E5}/health`);
  const h = (await health(E5))?.upstream?.hold;
  const r = await ask(E5, { question: "env off", options: ["a"], session_id: "q-5" });
  ok(h?.on === false && h.source === "env" && r.status === 0, `10: MYNA_UPSTREAM_HOLD=off over the file's on (source ${h?.source}) → no own bot: the connection is dropped (${r.status || r.error})`);
}

clearTimeout(watchdog);
if (failed) { console.log(`\n❌ ${failed} check(s) FAILED`); if (process.env.MYNA_TEST_VERBOSE) { console.log(hubLog.join("")); for (const [k, v] of Object.entries(edgeLogs)) console.log(`--- ${k}\n${v.join("")}`); } }
else console.log("\n✅ all edge-chat checks passed");
cleanup();
process.exit(failed ? 1 : 0);
