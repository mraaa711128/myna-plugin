#!/usr/bin/env node
// Several machines, one relay — regressions for the fixes of issue #5 (0.20.2). Everything on this one
// machine: temp HOME and MYNA_ENV, random ports (never :7800 / :7801), Telegram API stubs, no real bot.
//   machines.json: add (hub) and revoke (machines.mjs) in two processes at once lose nothing; a half-written
//     file is never read as "no machines" (no mass revoke, no overwrite)
//   remote port: an oversized /machines/join body that never ends gets 413 at once
//   hub restart: a machine revoked while the hub was down → its journaled questions are cancelled at start
//   join.mjs: refuses on a hub with the remote listener on; a failed local write keeps the token for
//     --wait; a relay that does not come up as an edge fails the join; stale edge files are removed
//   edge: MYNA_PROVIDER without keys still forwards; a restart mid-outage still needs MYNA_UPSTREAM_RECOVER
//     good checks; questions on its own bot are given back when that bot turns out to be the hub's, and
//     stop() cuts the poll at once even without AbortSignal.any; edge files of another hub are ignored
//   a reply lost on the way back (0.20.3): the answer of a remote question (given before the poll, or while
//     it is held) and an approved join's token are handed out again to the same machine / enroll secret
//     within their window — another machine, a wrong secret, a denied join, the local port, or past the
//     window → 404; a collected join is not revoked when its record expires, an uncollected one still is
// MYNA_TEST_ROOT=<another checkout> runs the same checks against that code (0.20.1 → must fail; 0.20.2 →
// the section "a reply lost on the way back" must fail).
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const relayPids = new Set(); // relays started detached by ensure-relay (join without --no-start)
const cleanup = () => { for (const c of children) { try { c.kill(); } catch {} } for (const p of relayPids) { try { process.kill(p); } catch {} } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 300s"); cleanup(); process.exit(1); }, 300000);
process.on("exit", cleanup);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-fixes-"));
const used = new Set([7800, 7801]);
const freePort = () => { for (;;) { const p = 20000 + Math.floor(Math.random() * 20000); if (!used.has(p)) { used.add(p); return p; } } };
// a clean env: nothing of the developer's own myna setup leaks into the children; HOME is a temp dir
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|CLAUDE_CODE_SESSION_ID$)/.test(k)) delete e[k];
  e.HOME = e.USERPROFILE = path.join(TMP, "home");
  fs.mkdirSync(e.HOME, { recursive: true });
  return e;
})();
const dir = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newMachine = (name) => { const id = crypto.randomBytes(6).toString("hex"); const token = `myna_m_${id}_${crypto.randomBytes(32).toString("base64url")}`; return { id, name, token, rec: { id, name, sha256: sha(token), os: "Linux", hostname: `host-${name}`, created_at: new Date().toISOString() } }; };
const req = async (url, { method = "GET", headers = {}, body } = {}) => {
  try {
    const r = await fetch(url, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e) { return { status: 0, error: e.cause?.code || e.message }; }
};

// === 1. machines.json: two writers in two processes ====================================================
{
  const file = path.join(dir("store"), "machines.json");
  const seeded = Array.from({ length: 150 }, (_, i) => newMachine(`r${i}`).rec);
  fs.writeFileSync(file, JSON.stringify({ version: 1, machines: seeded }, null, 2));
  const worker = path.join(TMP, "store-worker.mjs");
  fs.writeFileSync(worker, `import { machineStore } from ${JSON.stringify(pathToFileURL(src("src", "remote.mjs")).href)};
const [mode, file, list] = process.argv.slice(2);
const store = machineStore(file);
for (const x of JSON.parse(list)) { if (mode === "add") store.add(x); else store.revoke(x); }
`);
  const adds = Array.from({ length: 150 }, (_, i) => newMachine(`a${i}`).rec);
  const run = (mode, list) => new Promise((resolve) => { const c = spawn(process.execPath, [worker, mode, file, JSON.stringify(list)], { env: baseEnv, stdio: ["ignore", "ignore", "pipe"] }); let err = ""; c.stderr.on("data", (d) => (err += d)); c.on("exit", (rc) => resolve({ rc, err })); });
  const [ra, rr] = await Promise.all([run("add", adds), run("revoke", seeded.map((m) => m.id))]);
  let final = [];
  try { final = JSON.parse(fs.readFileSync(file, "utf8")).machines; } catch {}
  const byId = new Map(final.map((m) => [m.id, m]));
  const lostAdds = adds.filter((m) => !byId.has(m.id)).length;
  const unrevoked = seeded.filter((m) => !byId.get(m.id)?.revoked_at).length;
  ok(ra.rc === 0 && rr.rc === 0 && lostAdds === 0 && unrevoked === 0,
    `machines.json: 150 joins (hub) and 150 revokes (machines.mjs) in two processes at once → no join lost, no revoke undone (lost joins ${lostAdds}, revoked machines back to active ${unrevoked}, rc ${ra.rc}/${rr.rc}${ra.err || rr.err ? ` — ${(ra.err || rr.err).trim().split("\n").pop()}` : ""})`);

  // a lock left by a holder that died (older than 30 s): both writers take it over, still one at a time
  {
    const f3 = path.join(dir("store3"), "machines.json");
    const seeded3 = Array.from({ length: 100 }, (_, i) => newMachine(`s${i}`).rec), adds3 = Array.from({ length: 100 }, (_, i) => newMachine(`t${i}`).rec);
    fs.writeFileSync(f3, JSON.stringify({ version: 1, machines: seeded3 }));
    fs.writeFileSync(`${f3}.lock`, "2147483646 deadbeef\n");
    const old = new Date(Date.now() - 120000); fs.utimesSync(`${f3}.lock`, old, old);
    const [x, y] = await Promise.all([
      new Promise((resolve) => { const c = spawn(process.execPath, [worker, "add", f3, JSON.stringify(adds3)], { env: baseEnv, stdio: "ignore" }); c.on("exit", resolve); }),
      new Promise((resolve) => { const c = spawn(process.execPath, [worker, "revoke", f3, JSON.stringify(seeded3.map((m) => m.id))], { env: baseEnv, stdio: "ignore" }); c.on("exit", resolve); }),
    ]);
    let fin = []; try { fin = JSON.parse(fs.readFileSync(f3, "utf8")).machines; } catch {}
    const ids = new Map(fin.map((m) => [m.id, m]));
    ok(x === 0 && y === 0 && adds3.every((m) => ids.has(m.id)) && seeded3.every((m) => ids.get(m.id)?.revoked_at) && !fs.existsSync(`${f3}.lock`),
      `a stale machines.json.lock (dead holder) is taken over safely by two writers at once: nothing lost, no lock left behind (rc ${x}/${y}, lost joins ${adds3.filter((m) => !ids.has(m.id)).length}, unrevoked ${seeded3.filter((m) => !ids.get(m.id)?.revoked_at).length})`);
  }

  // a half-written file (another process mid-write) is not "no machines"
  const { machineStore } = await import(pathToFileURL(src("src", "remote.mjs")).href);
  const f2 = path.join(dir("store2"), "machines.json"), keep = newMachine("keep");
  fs.writeFileSync(f2, JSON.stringify({ version: 1, machines: [keep.rec] }, null, 2));
  const gone = [];
  const store = machineStore(f2, { onRevoked: (ids) => gone.push(...ids) });
  ok(!!store.verify(keep.token), "store: a registered machine's token verifies");
  fs.writeFileSync(f2, '{"version":1,"machines":[{"id":"'); // truncated
  store.refresh();
  ok(gone.length === 0 && !!store.verify(keep.token), `store: a half-written machines.json keeps the last good list — no machine treated as revoked (notified ${JSON.stringify(gone)})`);
  let threw = false;
  try { store.add(newMachine("late").rec); } catch { threw = true; }
  ok(threw && fs.readFileSync(f2, "utf8").startsWith('{"version":1,"machines":[{"id":"'), "store: add() on an unreadable machines.json fails instead of overwriting it with one machine");
}

// --- Telegram API stubs ---------------------------------------------------------------------------------
// hang: getUpdates never answers (a long-poll in flight) — records when the client gives up on it
async function botStub({ hang = false, sendDelayMs = 0 } = {}) {
  const s = { sent: [], edits: [], updates: [], polls: 0, n: 1, mid: 100, held: [], sendDelayMs };
  const srv = http.createServer((rq, res) => {
    const u = new URL(rq.url, "http://x");
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let body = ""; rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      const b = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
      if (/\/getUpdates$/.test(u.pathname)) {
        s.polls++;
        if (hang) { const h = { at: Date.now(), closedAt: 0 }; s.held.push(h); res.on("close", () => (h.closedAt = Date.now())); return; }
        const deliver = () => { const out = s.updates; s.updates = []; json({ ok: true, result: out }); }; s.updates.length ? deliver() : setTimeout(deliver, 100); return;
      }
      if (/\/sendMessage$/.test(u.pathname)) { b.message_id = ++s.mid; s.sent.push(b); setTimeout(() => json({ ok: true, result: { message_id: b.message_id } }), b.reply_markup ? s.sendDelayMs : 0); return; }
      if (/\/createForumTopic$/.test(u.pathname)) { json({ ok: true, result: { message_thread_id: 77 } }); return; }
      if (/\/editMessageReplyMarkup$/.test(u.pathname)) { s.edits.push(b); json({ ok: true, result: true }); return; }
      json({ ok: true, result: true });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${srv.address().port}`;
  s.close = () => { srv.closeAllConnections?.(); srv.close(); };
  s.keyboardWith = (re, ms) => until(() => [...s.sent].reverse().find((m) => m.reply_markup?.inline_keyboard && re.test(m.text || "")), ms);
  s.tap = (msg, row, idx) => s.updates.push({ update_id: s.n++, callback_query: { id: `cq${s.n}`, data: msg.reply_markup.inline_keyboard[row][idx].callback_data, message: { chat: { id: 42 }, message_id: msg.message_id } } });
  return s;
}
const hubBot = await botStub();
const HUB_BOT = "111111:HUB-SECRET";
// a tunnel that can go down (530, like a dead cloudflared)
function tunnelTo(port) {
  const st = { down: false };
  const srv = http.createServer((rq, res) => {
    if (st.down) { res.writeHead(530, { "content-type": "text/html" }); res.end("<html>tunnel down</html>"); return; }
    const up = http.request({ host: "127.0.0.1", port, method: rq.method, path: rq.url, headers: rq.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end("bad gateway"); });
    rq.pipe(up);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } })));
}

// --- hub ------------------------------------------------------------------------------------------------
const H = freePort(), R = freePort();
const HUB = `http://127.0.0.1:${H}`, REMOTE = `http://127.0.0.1:${R}`;
const HUB_DIR = dir("hub"), MACHINES = path.join(HUB_DIR, "machines.json");
const M = Object.fromEntries(["pc1", "pc3", "pc4", "pc5", "gone", "gone3"].map((n) => [n, newMachine(n)]));
fs.writeFileSync(MACHINES, JSON.stringify({ version: 1, machines: Object.values(M).map((m) => m.rec) }, null, 2));
const hubLog = [];
let hub;
const spawnHub = () => {
  const h = spawn(process.execPath, [src("src", "relay.mjs")], {
    env: { ...baseEnv, MYNA_ENV: path.join(HUB_DIR, ".env"), MYNA_PROVIDER: "telegram", TELEGRAM_BOT_TOKEN: HUB_BOT, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: hubBot.url,
      RELAY_PORT: String(H), MYNA_REMOTE_PORT: String(R), MYNA_MACHINES_FILE: MACHINES, MYNA_MACHINE_NAME: "win", MYNA_ANSWER_HOLD_MS: "1500", TELEGRAM_TOPIC_ROUND_GRACE: "0",
      MYNA_JOIN_TTL_MS: "20000", MYNA_JOIN_INTERVAL_MS: "0", MYNA_JOIN_MAX_OPEN: "3", MYNA_REMOTE_ASK_MAX: "100" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(h); h.stderr.on("data", (d) => hubLog.push(String(d)));
  return h;
};
const startHub = async () => {
  hub = spawnHub();
  return until(async () => (await req(`${HUB}/health`)).status === 200 && (await req(`${REMOTE}/health`, { headers: { authorization: `Bearer ${M.pc1.token}` } })).status === 200, 8000);
};
if (!(await startHub())) { console.error("❌ hub relay never came up"); console.error(hubLog.join("")); process.exit(1); }

// === 2. remote port: an oversized body that never ends ================================================
{
  const t0 = Date.now();
  const r = await new Promise((resolve) => {
    const q = http.request({ host: "127.0.0.1", port: R, method: "POST", path: "/machines/join", headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) } }, (res) => { res.resume(); resolve({ status: res.statusCode, ms: Date.now() - t0 }); });
    q.on("error", (e) => resolve({ error: e.code, ms: Date.now() - t0 }));
    q.write("x".repeat(16 * 1024)); // over the 4 KB cap — and the rest never comes
    setTimeout(() => { resolve({ timeout: true, ms: Date.now() - t0 }); q.destroy(); }, 4000);
  });
  ok(r.status === 413 && r.ms < 3000, `remote /machines/join: a body over the cap that never ends → 413 at once, not when (if ever) it ends (${JSON.stringify(r)})`);
}

// === 3. hub restart: a machine revoked while the hub was down ==========================================
{
  const auth = { authorization: `Bearer ${M.gone.token}` };
  const a = await req(`${REMOTE}/ask`, { method: "POST", headers: auth, body: { question: "停機前問的題", options: ["a", "b"], session_id: "s1" } });
  const qmsg = await hubBot.keyboardWith(/停機前問的題/);
  ok(a.status === 200 && !!qmsg, `a remote question of "gone" is open on the phone (${a.status})`);
  hub.kill(); await until(async () => (await req(`${HUB}/health`)).status === 0, 5000);
  const rev = spawnSync(process.execPath, [src("scripts", "machines.mjs"), "revoke", "gone"], { env: { ...baseEnv, MYNA_MACHINES_FILE: MACHINES }, encoding: "utf8" });
  ok(rev.status === 0, `hub down: machines.mjs revoke gone (${rev.stdout.trim() || rev.stderr.trim()})`);
  await startHub();
  const r = await until(async () => { const x = await req(`${HUB}/answer/${a.json?.request_id}`); return x.json?.kind && x.json.kind !== "pending" ? x : null; }, 4000);
  ok(r?.json?.kind === "cancelled" && r.json.reason === "machine revoked" && hubBot.edits.some((e) => e.message_id === qmsg?.message_id),
    `hub restarted: the revoked machine's journaled question is cancelled at start and its buttons retracted (${JSON.stringify(r?.json)})`);
  // the same, but machines.json is unreadable when the hub starts: done at its first good read
  const g2 = newMachine("gone2");
  const good = JSON.parse(fs.readFileSync(MACHINES, "utf8")); good.machines.push(g2.rec); fs.writeFileSync(MACHINES, JSON.stringify(good, null, 2));
  await until(async () => (await req(`${REMOTE}/health`, { headers: { authorization: `Bearer ${g2.token}` } })).status === 200, 7000);
  const a2 = await req(`${REMOTE}/ask`, { method: "POST", headers: { authorization: `Bearer ${g2.token}` }, body: { question: "停機前問的第二題", options: ["a", "b"], session_id: "s2" } });
  await hubBot.keyboardWith(/停機前問的第二題/);
  hub.kill(); await until(async () => (await req(`${HUB}/health`)).status === 0, 5000);
  spawnSync(process.execPath, [src("scripts", "machines.mjs"), "revoke", "gone2"], { env: { ...baseEnv, MYNA_MACHINES_FILE: MACHINES } });
  const revokedText = fs.readFileSync(MACHINES, "utf8");
  fs.writeFileSync(MACHINES, revokedText.slice(0, 40)); // half-written when the hub starts
  hub = spawnHub();
  await until(async () => (await req(`${HUB}/health`)).status === 200, 8000);
  await sleep(500);
  fs.writeFileSync(MACHINES, revokedText);
  const r2 = await until(async () => { const x = await req(`${HUB}/answer/${a2.json?.request_id}`); return x.json?.kind && x.json.kind !== "pending" ? x : null; }, 9000);
  ok(r2?.json?.kind === "cancelled" && r2.json.reason === "machine revoked", `machines.json unreadable when the hub starts: once it reads again, the question of a machine revoked meanwhile is cancelled (${JSON.stringify(r2?.json)})`);
  await until(async () => (await req(`${REMOTE}/health`, { headers: { authorization: `Bearer ${M.pc1.token}` } })).status === 200, 8000);
  // revoked while its question is still being sent: cancelled once the message exists, buttons retracted
  hubBot.sendDelayMs = 2500;
  const pa3 = req(`${REMOTE}/ask`, { method: "POST", headers: { authorization: `Bearer ${M.gone3.token}` }, body: { question: "撤銷時還在送的題", options: ["a", "b"], session_id: "s3" } });
  const m3 = await hubBot.keyboardWith(/撤銷時還在送的題/, 4000);
  spawnSync(process.execPath, [src("scripts", "machines.mjs"), "revoke", "gone3"], { env: { ...baseEnv, MYNA_MACHINES_FILE: MACHINES } });
  await req(`${REMOTE}/health`, { headers: { authorization: `Bearer ${M.pc1.token}` } }); // the hub looks at machines.json on every request
  const a3 = await pa3; hubBot.sendDelayMs = 0;
  const r3 = await until(async () => { const x = await req(`${HUB}/answer/${a3.json?.request_id}`); return x.json?.kind && x.json.kind !== "pending" ? x : null; }, 8000);
  ok(!!m3 && r3?.json?.reason === "machine revoked" && !!(await until(() => hubBot.edits.some((e) => e.message_id === m3.message_id), 4000)),
    `revoked while its question is still being sent: once sent, it is cancelled and its buttons retracted (${JSON.stringify(r3?.json)})`);
}

// === 4. join.mjs ==========================================================================================
// joins straight to the remote port; the test taps ✅ on the hub's phone for the machine named
const approveJoin = async (name) => { const m = await hubBot.keyboardWith(new RegExp(`🆕[\\s\\S]*${name}`), 10000); if (m) hubBot.tap(m, 0, 0); return !!m; };
const runJoin = (args, env) => new Promise((resolve) => {
  // a join that starts the relay must never touch the real one on :7800
  if (!args.includes("--no-start") && !args.includes("--no-wait") && (!env.RELAY_PORT || [7800, 7801].includes(Number(env.RELAY_PORT)))) throw new Error("runJoin without --no-start needs a test RELAY_PORT");
  const c = spawn(process.execPath, [src("scripts", "join.mjs"), ...args], { env: { ...baseEnv, MYNA_ANSWER_HOLD_MS: "1000", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.on("exit", (rc) => resolve({ rc, out }));
});
{
  // a hub with its remote listener on does not turn itself into an edge
  const d = dir("pc9"), env = path.join(d, ".env"), before = `TELEGRAM_BOT_TOKEN=999999:X\nTELEGRAM_CHAT_ID=1\nMYNA_REMOTE_PORT=7801\n`;
  fs.writeFileSync(env, before);
  const r = await runJoin([REMOTE, "--name", "pc9", "--no-wait"], { MYNA_ENV: env });
  await sleep(500);
  ok(r.rc !== 0 && /hub off/.test(r.out) && fs.readFileSync(env, "utf8") === before && !hubBot.sent.some((m) => /pc9/.test(m.text || "")),
    `join.mjs on a hub with MYNA_REMOTE_PORT → refused before asking (rc=${r.rc}), .env unchanged — "${r.out.trim().split("\n").pop()}"`);
}
{
  // the token cannot be saved → the token stays in join-pending.json, --wait finishes the job later
  const d = dir("pc6"), env = path.join(d, ".env"), badTok = dir("pc6/token-is-a-dir"), goodTok = path.join(d, "machine-token");
  const p = runJoin([REMOTE, "--name", "pc6", "--no-start"], { MYNA_ENV: env, MYNA_MACHINE_TOKEN_FILE: badTok });
  ok(await approveJoin("pc6"), "pc6's join request reached the phone — ✅ tapped");
  const r1 = await p;
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(d, "join-pending.json"), "utf8")); } catch { return null; } })();
  ok(r1.rc !== 0 && /^myna_m_/.test(state?.token || ""), `approved but the token file cannot be written → join fails (rc=${r1.rc}) and keeps the token in join-pending.json for --wait`);
  const r2 = await runJoin(["--wait", "--no-start"], { MYNA_ENV: env, MYNA_MACHINE_TOKEN_FILE: goodTok });
  const tok = fs.existsSync(goodTok) ? fs.readFileSync(goodTok, "utf8").trim() : "";
  ok(r2.rc === 0 && !!tok && fs.readFileSync(MACHINES, "utf8").includes(sha(tok)) && !fs.existsSync(path.join(d, "join-pending.json")) && /^MYNA_ROLE=edge$/m.test(fs.readFileSync(env, "utf8")),
    `join.mjs --wait afterwards finishes without asking the hub again: token saved, .env written, join-pending.json removed (rc=${r2.rc}) ${r2.rc ? r2.out.trim().split("\n").pop() : ""}`);
}
{
  // ensure-relay cannot bring up an edge (something else holds the port) → the join reports it; files
  // left by an edge of another hub are removed
  const d = dir("pc7"), env = path.join(d, ".env");
  fs.writeFileSync(path.join(d, "upstream.json"), JSON.stringify({ bot_id: "telegram:424242", seen_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(d, "edge-state.json"), JSON.stringify({ forwarded: [["aaaaaaaaaa", { at: Date.now() }]], abandoned: ["bbbbbbbbbb"], down_since: null }));
  const squat = http.createServer((rq, res) => { res.writeHead(404); res.end("not a relay"); });
  const SQ = freePort(); await new Promise((r) => squat.listen(SQ, "127.0.0.1", r));
  const p = runJoin([REMOTE, "--name", "pc7"], { MYNA_ENV: env, RELAY_PORT: String(SQ) });
  await approveJoin("pc7");
  const r = await p;
  squat.close();
  ok(r.rc !== 0 && /relay/.test(r.out.trim().split("\n").pop()), `join approved but no edge relay came up on the port → join.mjs fails (rc=${r.rc}) — "${r.out.trim().split("\n").pop()}"`);
  ok(!fs.existsSync(path.join(d, "upstream.json")) && !fs.existsSync(path.join(d, "edge-state.json")), "a new join removes upstream.json / edge-state.json left by an earlier hub");
  // and the normal case: the relay comes up as an edge of this hub
  const d8 = dir("pc8"), env8 = path.join(d8, ".env"), P8 = freePort();
  const p8 = runJoin([REMOTE, "--name", "pc8"], { MYNA_ENV: env8, RELAY_PORT: String(P8) });
  await approveJoin("pc8");
  const r8 = await p8;
  for (const m of r8.out.matchAll(/\(pid (\d+)\)/g)) relayPids.add(Number(m[1])); // started detached: stopped at the end whatever happens
  const h8 = await req(`http://127.0.0.1:${P8}/health`);
  if (h8.json?.pid) relayPids.add(h8.json.pid);
  ok(r8.rc === 0 && h8.json?.role === "edge" && h8.json.upstream?.url === REMOTE, `join with ensure-relay: rc=0 and the relay on the port is an edge of this hub (${h8.json?.role} → ${h8.json?.upstream?.url}) ${r8.rc ? r8.out.trim().split("\n").pop() : ""}`);
  await req(`http://127.0.0.1:${P8}/shutdown`, { method: "POST" });
}

// === 5. edges ==============================================================================================
// MYNA_UPSTREAM_HOLD=off: 0.20.x's outage rules (0.21.0's holding is test/smoke-edge-chat.mjs)
const EDGE_TIMING = { MYNA_UPSTREAM_CHECK_MS: "250", MYNA_UPSTREAM_GRACE: "30", MYNA_ANSWER_HOLD_MS: "1500", MYNA_UPSTREAM_HOLD: "off" };
const edgeLogs = [];
const startEdge = (port, env, nodeArgs = []) => {
  const c = spawn(process.execPath, [...nodeArgs, src("src", "relay.mjs")], { env: { ...baseEnv, RELAY_PORT: String(port), MYNA_ROLE: "edge", ...EDGE_TIMING, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(c); const out = []; edgeLogs.push([port, out]); c.stderr.on("data", (d) => out.push(String(d)));
  c.on("exit", (rc) => out.push(`(exited rc=${rc})\n`));
  return c;
};
{
  // an edge whose .env still names a provider it has no keys for: forwards only, does not exit
  const P = freePort();
  startEdge(P, { MYNA_ENV: path.join(dir("pc1"), ".env"), MYNA_UPSTREAM: REMOTE, MYNA_MACHINE_TOKEN: M.pc1.token, MYNA_PROVIDER: "telegram" });
  const r = await until(async () => { const x = await req(`http://127.0.0.1:${P}/health`); return x.json?.upstream?.active ? x : null; }, 8000);
  ok(r?.json?.role === "edge" && r.json.own_bot?.on === false, `edge with MYNA_PROVIDER=telegram but no Telegram keys → runs, forwarding only (${r ? `own_bot.on=${r.json.own_bot?.on}` : "relay not up"})`);
}
{
  // restarted mid-outage: the recovery still takes MYNA_UPSTREAM_RECOVER good checks in a row
  const bot3 = await botStub(), tun = await tunnelTo(R), P = freePort(), E = `http://127.0.0.1:${P}`;
  const env = { MYNA_ENV: path.join(dir("pc3"), ".env"), MYNA_UPSTREAM: tun.url, MYNA_MACHINE_TOKEN: M.pc3.token, MYNA_UPSTREAM_RECOVER: "4",
    TELEGRAM_BOT_TOKEN: "333333:PC3", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: bot3.url };
  let c = startEdge(P, env);
  ok(!!(await until(async () => (await req(`${E}/health`)).json?.upstream?.active, 8000)), "pc3 (own bot) forwards to the hub");
  tun.st.down = true;
  await until(async () => (await req(`${E}/health`)).json?.upstream?.reachable === false, 5000);
  c.kill(); await until(async () => (await req(`${E}/health`)).status === 0, 4000);
  c = startEdge(P, env);
  ok(!!(await until(async () => (await req(`${E}/health`)).json?.upstream?.reachable === false, 10000)), "pc3 restarted while the hub is still away");
  tun.st.down = false;
  const t0 = Date.now(); let reach = 0, active = 0;
  while (!active && Date.now() - t0 < 8000) { const x = await req(`${E}/health`); if (x.json?.upstream?.reachable && !reach) reach = Date.now(); if (x.json?.upstream?.active) active = Date.now(); await sleep(30); }
  ok(reach > 0 && active > 0 && active - reach >= 500, `restarted mid-outage: new questions go back to the hub only after 4 good checks in a row (${active && reach ? `${active - reach} ms after it was reachable` : "never active"}, checks every 250 ms)`);
  // restarted again in the middle of a recovery (reachable, not yet active): still a recovery
  tun.st.down = true;
  await until(async () => (await req(`${E}/health`)).json?.upstream?.reachable === false, 5000);
  c.kill(); await until(async () => (await req(`${E}/health`)).status === 0, 4000);
  c = startEdge(P, { ...env, MYNA_UPSTREAM_RECOVER: "12" });
  await until(async () => (await req(`${E}/health`)).json?.upstream?.reachable === false, 10000);
  tun.st.down = false;
  const mid = await until(async () => { const x = await req(`${E}/health`); return x.json?.upstream?.reachable ? x : null; }, 5000);
  ok(mid?.json?.upstream?.active === false, "pc3 reachable again, still recovering (12 checks needed)");
  await sleep(300); // edge-state.json is written
  c.kill(); await until(async () => (await req(`${E}/health`)).status === 0, 4000);
  c = startEdge(P, env);
  const t1 = Date.now(); let reach2 = 0, active2 = 0;
  while (!active2 && Date.now() - t1 < 10000) { const x = await req(`${E}/health`); if (x.json?.upstream?.reachable && !reach2) reach2 = Date.now(); if (x.json?.upstream?.active) active2 = Date.now(); await sleep(30); }
  ok(reach2 > 0 && active2 > 0 && active2 - reach2 >= 500, `restarted mid-recovery: still 4 good checks before the hub gets new questions (${active2 && reach2 ? `${active2 - reach2} ms after reachable` : "never active"})`);
  // stopped while all was well, the hub went away while it was down: its return is still a recovery
  await sleep(300);
  c.kill(); await until(async () => (await req(`${E}/health`)).status === 0, 4000);
  tun.st.down = true;
  c = startEdge(P, env);
  await until(async () => (await req(`${E}/health`)).json?.upstream?.reachable === false, 10000);
  tun.st.down = false;
  const t2 = Date.now(); let reach3 = 0, active3 = 0;
  while (!active3 && Date.now() - t2 < 10000) { const x = await req(`${E}/health`); if (x.json?.upstream?.reachable && !reach3) reach3 = Date.now(); if (x.json?.upstream?.active) active3 = Date.now(); await sleep(30); }
  ok(reach3 > 0 && active3 > 0 && active3 - reach3 >= 500, `stopped while active, hub away when it started again: still 4 good checks (${active3 && reach3 ? `${active3 - reach3} ms after reachable` : "never active"})`);
  c.kill(); tun.close(); bot3.close();
}
{
  // started while the hub was away, its bot unknown → its own bot took a question; then the hub reports
  // that same bot. The question goes back to the terminal, its buttons retracted; the stop cuts the
  // in-flight getUpdates at once — also on a Node without AbortSignal.any
  const bot4 = await botStub({ hang: true }), tun = await tunnelTo(R), P = freePort(), E = `http://127.0.0.1:${P}`;
  tun.st.down = true;
  startEdge(P, { MYNA_ENV: path.join(dir("pc4"), ".env"), MYNA_UPSTREAM: tun.url, MYNA_MACHINE_TOKEN: M.pc4.token, TELEGRAM_BOT_TOKEN: "111111:SAME-AS-HUB", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: bot4.url },
    ["--import", "data:text/javascript,delete AbortSignal.any;"]);
  const h0 = await until(async () => { const x = await req(`${E}/health`); return x.json?.own_bot?.on ? x : null; }, 10000);
  ok(!!h0 && !!(await until(() => bot4.held.length > 0, 3000)), "pc4: hub away, its bot unknown → own bot on (a getUpdates is in flight)");
  const a = await req(`${E}/ask`, { method: "POST", body: { question: "自己 bot 上的題", options: ["a", "b"], session_id: "s4" } });
  const msg = await bot4.keyboardWith(/自己 bot 上的題/, 4000);
  ok(a.status === 200 && !!msg, `pc4: a question asked meanwhile is on its own bot (${a.status})`);
  tun.st.down = false;
  const off = await until(async () => { const x = await req(`${E}/health`); return x.json?.own_bot?.on === false ? Date.now() : null; }, 6000);
  ok(!!off, "pc4: the hub reports the same bot → own bot off");
  const ans = await until(async () => { const x = await req(`${E}/answer/${a.json?.request_id}`); return x.json?.kind && x.json.kind !== "pending" ? x : null; }, 4000);
  ok(ans?.json?.kind === "unreachable" && bot4.edits.some((e) => e.message_id === msg?.message_id),
    `pc4: the question on the stopped bot is given back (/answer → ${JSON.stringify(ans?.json)}), its buttons retracted`);
  const cut = await until(() => bot4.held.every((h) => h.closedAt), 3000);
  ok(!!cut, `pc4: stop() aborts the getUpdates in flight at once, without AbortSignal.any (${bot4.held.map((h) => (h.closedAt ? `closed ${h.closedAt - (off || h.closedAt)} ms after own bot off` : "still open")).join(", ")})`);
  tun.close(); bot4.close();
}
{
  // the hub reports the same bot while a question is still being sent on the own bot: withdrawn once sent
  const bot6 = await botStub({ sendDelayMs: 2500 }), tun = await tunnelTo(R), P = freePort(), E = `http://127.0.0.1:${P}`;
  tun.st.down = true;
  startEdge(P, { MYNA_ENV: path.join(dir("pc4b"), ".env"), MYNA_UPSTREAM: tun.url, MYNA_MACHINE_TOKEN: M.pc4.token, TELEGRAM_BOT_TOKEN: "111111:SAME-AS-HUB-2", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: bot6.url });
  await until(async () => (await req(`${E}/health`)).json?.own_bot?.on, 10000);
  const pa = req(`${E}/ask`, { method: "POST", body: { question: "送到一半的題", options: ["a", "b"], session_id: "s6" } });
  const msg = await bot6.keyboardWith(/送到一半的題/, 4000); // the request reached the bot, its reply is 2.5 s away
  tun.st.down = false;
  await until(async () => (await req(`${E}/health`)).json?.own_bot?.on === false, 4000);
  const a = await pa;
  const ans = await until(async () => { const x = await req(`${E}/answer/${a.json?.request_id}`); return x.json?.kind && x.json.kind !== "pending" ? x : null; }, 6000);
  ok(!!msg && ans?.json?.kind === "unreachable" && !!(await until(() => bot6.edits.some((e) => e.message_id === msg.message_id), 4000)),
    `same bot found while the question is still being sent: once sent, its buttons are retracted and it is given back (${JSON.stringify(ans?.json)})`);
  tun.close(); bot6.close();
}
{
  // edge files written for another hub are not used for this one
  const bot5 = await botStub(), tun = await tunnelTo(R), P = freePort(), E = `http://127.0.0.1:${P}`, d = dir("pc5");
  tun.st.down = true;
  fs.writeFileSync(path.join(d, "upstream.json"), JSON.stringify({ upstream: "https://old-hub.example.com", bot_id: "telegram:555555", seen_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(d, "edge-state.json"), JSON.stringify({ upstream: "https://old-hub.example.com", forwarded: [["aaaaaaaaaa", { at: Date.now() }]], abandoned: ["bbbbbbbbbb"], down_since: Date.now() }));
  startEdge(P, { MYNA_ENV: path.join(d, ".env"), MYNA_UPSTREAM: tun.url, MYNA_MACHINE_TOKEN: M.pc5.token, TELEGRAM_BOT_TOKEN: "555555:PC5", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: bot5.url });
  const r = await until(async () => { const x = await req(`${E}/health`); return x.json?.own_bot ? x : null; }, 10000);
  ok(r?.json?.own_bot?.on === true && r.json.upstream?.forwarded === 0 && r.json.upstream?.abandoned === 0,
    `edge files of another hub are ignored: the old hub's bot id does not switch its own bot off, no old question ids (own_bot.on=${r?.json?.own_bot?.on}, forwarded=${r?.json?.upstream?.forwarded}, abandoned=${r?.json?.upstream?.abandoned})`);
  tun.close(); bot5.close();
}

// === 6. a reply lost on the way back (issue #5: /answer and the join token) ================================
// A hub of its own with short windows (MYNA_ANSWER_REDELIVER_MS, MYNA_JOIN_TTL_MS) and no answer sweep in
// between (MYNA_SWEEP_MS) — the handlers judge the window themselves. The tunnel drops the next reply that
// carries a result: the hub did the work, the edge / joining machine never sees it (a broken link).
function lossyTunnelTo(port) {
  const st = { drop: 0, dropped: [] };
  const srv = http.createServer((rq, res) => {
    const up = http.request({ host: "127.0.0.1", port, method: rq.method, path: rq.url, headers: rq.headers }, (r) => {
      const chunks = []; r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(body); } catch {}
        const result = /^\/(answer|machines\/join)\//.test(rq.url) && r.statusCode === 200 && !!j && ((j.kind && j.kind !== "pending") || (j.status && j.status !== "pending"));
        if (result && st.drop > 0) { st.drop--; st.dropped.push(body); rq.socket.destroy(); return; }
        const h = { ...r.headers }; delete h["content-length"]; delete h["transfer-encoding"];
        res.writeHead(r.statusCode, h); res.end(body);
      });
    });
    up.on("error", () => { res.writeHead(502); res.end("bad gateway"); });
    rq.pipe(up);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ st, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } })));
}
{
  const bot = await botStub(), H2 = freePort(), R2 = freePort(), HUB2 = `http://127.0.0.1:${H2}`, REMOTE2 = `http://127.0.0.1:${R2}`;
  const d = dir("hub-redeliver"), MF = path.join(d, "machines.json"), X = { a: newMachine("xa"), b: newMachine("xb") };
  fs.writeFileSync(MF, JSON.stringify({ version: 1, machines: [X.a.rec, X.b.rec] }, null, 2));
  const WINDOW = 6000, TTL = 4000;
  const spawnHub2 = () => {
    const h = spawn(process.execPath, [src("src", "relay.mjs")], {
      env: { ...baseEnv, MYNA_ENV: path.join(d, ".env"), MYNA_PROVIDER: "telegram", TELEGRAM_BOT_TOKEN: "222222:HUB2", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: bot.url,
        RELAY_PORT: String(H2), MYNA_REMOTE_PORT: String(R2), MYNA_MACHINES_FILE: MF, MYNA_MACHINE_NAME: "hub2", MYNA_ANSWER_HOLD_MS: "3000", TELEGRAM_TOPIC_ROUND_GRACE: "0",
        MYNA_ANSWER_REDELIVER_MS: String(WINDOW), MYNA_SWEEP_MS: "600000", MYNA_JOIN_TTL_MS: String(TTL), MYNA_JOIN_INTERVAL_MS: "0", MYNA_JOIN_MAX_OPEN: "3", MYNA_REMOTE_ASK_MAX: "100" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(h); h.stderr.on("data", (x) => hubLog.push(`[hub2] ${x}`));
    return h;
  };
  let h2 = spawnHub2();
  const authA = { authorization: `Bearer ${X.a.token}` }, authB = { authorization: `Bearer ${X.b.token}` };
  ok(!!(await until(async () => (await req(`${REMOTE2}/health`, { headers: authA })).status === 200, 8000)), "hub2 (short re-delivery windows) is up");
  const tun = await lossyTunnelTo(R2), P = freePort(), E = `http://127.0.0.1:${P}`;
  startEdge(P, { MYNA_ENV: path.join(dir("xa"), ".env"), MYNA_UPSTREAM: tun.url, MYNA_MACHINE_TOKEN: X.a.token });
  ok(!!(await until(async () => (await req(`${E}/health`)).json?.upstream?.active, 8000)), "xa: an edge (no bot of its own) forwarding through a tunnel that can lose a reply");
  // the client's polls through the edge until a result (or a 404) comes back
  const pollEdge = async (id, ms = 12000) => { const seen = []; const r = await until(async () => { const x = await req(`${E}/answer/${id}`); seen.push(x.status === 0 ? `conn ${x.error}` : `${x.status} ${x.json?.kind || x.json?.error || ""}`); return x.status === 404 || (x.json?.kind && x.json.kind !== "pending") ? x : null; }, ms); return { r, seen }; };

  // X3 (a): answered before the client polls; the reply carrying the answer is lost once
  const a1 = await req(`${E}/ask`, { method: "POST", body: { question: "回程遺失 A", options: ["好", "不好"], session_id: "x3" } });
  const m1 = await bot.keyboardWith(/回程遺失 A/, 6000);
  if (m1) bot.tap(m1, 0, 0);
  await sleep(1000);
  tun.st.drop = 1;
  const p1 = await pollEdge(a1.json?.request_id);
  const firstAt = Date.now();
  ok(tun.st.dropped.length === 1 && p1.r?.status === 200 && p1.r.json?.kind === "selection" && p1.r.json.value === "好" && p1.r.text === tun.st.dropped[0],
    `answered before the poll, the reply carrying it lost once → the edge's retry gets the very same answer (${p1.seen.join(" | ")})`);
  let r = await req(`${REMOTE2}/answer/${a1.json?.request_id}`, { headers: authA });
  ok(r.status === 200 && r.text === tun.st.dropped[0], `the same machine asks for the delivered id again → the same result (${r.status} ${r.text})`);
  r = await req(`${REMOTE2}/answer/${a1.json?.request_id}`, { headers: authB });
  ok(r.status === 404, `another machine asks for the delivered id → 404 (${r.status})`);
  r = await req(`${REMOTE2}/cancel/${a1.json?.request_id}`, { method: "POST", headers: authA, body: {} });
  ok(r.status === 200 && r.json?.cancelled === false, `/cancel on a delivered id → {cancelled:false} (${r.status} ${r.text})`);
  // the hub restarts (an upgrade, a crash) within the window: the journal keeps the answer and when it was
  // first handed out — still there for that machine, and the window is not restarted (checked further down)
  await sleep(700);
  h2.kill(); await until(async () => (await req(`${HUB2}/health`)).status === 0, 5000);
  h2 = spawnHub2();
  await until(async () => (await req(`${REMOTE2}/health`, { headers: authA })).status === 200, 8000);
  r = await req(`${REMOTE2}/answer/${a1.json?.request_id}`, { headers: authA });
  ok(r.status === 200 && r.text === tun.st.dropped[0], `hub restarted within the window: the same machine still gets the same result (${r.status} ${r.text})`);
  ok(!!(await until(async () => (await req(`${E}/health`)).json?.upstream?.active, 8000)), "xa forwards to the restarted hub again");

  // X3 (b): the human answers while the poll is held; that reply is lost once
  const a2 = await req(`${E}/ask`, { method: "POST", body: { question: "回程遺失 B", options: ["甲", "乙"], session_id: "x3" } });
  const m2 = await bot.keyboardWith(/回程遺失 B/, 6000);
  tun.st.drop = 1;
  const held = pollEdge(a2.json?.request_id);
  await sleep(400);
  if (m2) bot.tap(m2, 0, 1);
  const p2 = await held;
  ok(tun.st.dropped.length === 2 && p2.r?.status === 200 && p2.r.json?.value === "乙" && p2.r.text === tun.st.dropped[1],
    `answered while the poll is held, that reply lost once → the edge's retry gets the very same answer (${p2.seen.join(" | ")})`);

  // the local port is unchanged: handed out once, then 404
  const l = await req(`${HUB2}/ask`, { method: "POST", body: { question: "本機的題", options: ["x", "y"], session_id: "loc" } });
  const ml = await bot.keyboardWith(/本機的題/, 6000);
  if (ml) bot.tap(ml, 0, 0);
  const l1 = await until(async () => { const x = await req(`${HUB2}/answer/${l.json?.request_id}`); return x.json?.kind && x.json.kind !== "pending" ? x : null; }, 6000);
  r = await req(`${HUB2}/answer/${l.json?.request_id}`);
  ok(l1?.json?.value === "x" && r.status === 404, `local port: the answer is handed out once, a second poll → 404 (${r.status})`);

  // past the window → 404 (the handler judges; the sweep is off here)
  await sleep(Math.max(0, firstAt + WINDOW + 500 - Date.now()));
  r = await req(`${REMOTE2}/answer/${a1.json?.request_id}`, { headers: authA });
  ok(r.status === 404, `the same machine asks ${WINDOW / 1000}s after the first delivery (a hub restart in between does not restart the window) → 404 (${r.status} ${r.text})`);

  // X4: xj1 approved, its reply lost once; xj3 denied; xj2 (asked after xj1 was collected) approved, never collected
  const join = async (name, code) => {
    const secret = crypto.randomBytes(32).toString("base64url");
    const x = await req(`${REMOTE2}/machines/join`, { method: "POST", headers: { "content-type": "application/json" }, body: { name, os: "Linux", hostname: `host-${name}`, code, enroll_secret_hash: sha(secret) } });
    return { id: x.json?.enroll_id, secret, status: x.status };
  };
  const pollJoin = (base, j, secret = j.secret) => req(`${base}/machines/join/${j.id}`, { headers: { "x-myna-enroll-secret": secret } });
  const tapJoin = async (name, idx) => { const m = await bot.keyboardWith(new RegExp(`🆕[\\s\\S]*${name}`), 6000); if (m) bot.tap(m, 0, idx); return !!m; };
  const j1 = await join("xj1", "ABC-234"), j3 = await join("xj3", "GHJ-456");
  ok(j1.status === 202 && j3.status === 202, `two join requests → 202 (${j1.status}/${j3.status})`);
  await tapJoin("xj1", 0); await tapJoin("xj3", 1);
  await sleep(800);
  tun.st.drop = 1;
  const q1 = await pollJoin(tun.url, j1);
  const q2 = await pollJoin(tun.url, j1);
  const collectedAt = Date.now();
  const jtok = q2.json?.token || "";
  ok(tun.st.dropped.length === 3 && q1.status === 0 && q2.status === 200 && q2.json?.status === "approved" && q2.text === tun.st.dropped[2],
    `approved, the reply carrying the token lost once → the retry gets the very same token (poll 1 ${q1.status === 0 ? `conn ${q1.error}` : q1.status}, poll 2 ${q2.status} ${q2.json?.status || q2.json?.error})`);
  ok((await req(`${REMOTE2}/health`, { headers: { authorization: `Bearer ${jtok}` } })).status === 200, "that token works on the hub");
  r = await pollJoin(REMOTE2, j1, "not-the-secret");
  ok(r.status === 404 && !r.json?.token, `a wrong enroll secret for the collected join → 404, no token (${r.status})`);
  r = await pollJoin(REMOTE2, j3);
  const r3 = await pollJoin(REMOTE2, j3);
  ok(r.json?.status === "denied" && r3.status === 404, `a denied join: handed out once, then 404 (${r.json?.status}, then ${r3.status})`);
  const j2 = await join("xj2", "DEF-345");
  ok(j2.status === 202 && await tapJoin("xj2", 0), `a third join request (xj2) → 202, ✅ tapped, never collected (${j2.status})`);
  await sleep(Math.max(0, collectedAt + TTL + 500 - Date.now()));
  r = await pollJoin(REMOTE2, j1);
  ok(r.status === 404 && !r.json?.token, `the same secret ${TTL / 1000}s after the token was first handed out → 404 (${r.status})`);
  const xj2Revoked = await until(() => { try { return JSON.parse(fs.readFileSync(MF, "utf8")).machines.find((m) => m.name === "xj2")?.revoked_at; } catch { return null; } }, 3 * TTL + 3000);
  const xj1 = (() => { try { return JSON.parse(fs.readFileSync(MF, "utf8")).machines.find((m) => m.name === "xj1"); } catch { return null; } })();
  ok(!!xj2Revoked, "an approved join whose token was never collected → its machine is revoked after the TTL (as before)");
  ok(!!xj1 && !xj1.revoked_at && xj1.sha256 === sha(jtok) && (await req(`${REMOTE2}/health`, { headers: { authorization: `Bearer ${jtok}` } })).status === 200,
    "the collected join's record expired too, but that machine is not revoked — its token still works");
  tun.close(); bot.close();
}

if (failed) {
  for (const [port, out] of edgeLogs) console.log(`--- edge :${port} log ---\n${out.join("").split("\n").slice(-12).join("\n")}`);
  console.log(`--- hub log (tail) ---\n${hubLog.join("").split("\n").slice(-25).join("\n")}`);
}
cleanup(); hubBot.close(); clearTimeout(watchdog);
await sleep(300);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(failed === 0 ? "\n✅ REMOTE FIXES (issue #5) PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
