#!/usr/bin/env node
// God mode (v0.25.0): the REAL PermissionRequest hook (scripts/permission-request.mjs) → the REAL relays
// (POST /notify) → local Telegram API stubs; /myna:godmode, /myna:config godmode and /myna:status.
// Nothing here touches ~/.myna or :7800 / :7801: HOME is a temp dir, every file is set by MYNA_* variables,
// every port is random.
//   1. on: the dialog is allowed at once (this call only: no updatedPermissions), a notice goes to the
//      chat's main view (no topic, no buttons) with the project, the tool, the command, its description,
//      the session label + id prefix (and a background agent's id); /myna:perm off does not matter
//   2. AskUserQuestion is not God mode's: the hook does what it did before (here: perm off → abstains)
//   3. the notice cannot go out (relay down / Telegram refuses / Telegram too slow / an IM without notices):
//      still allowed, within ~5 s, and the notice kept in the unsent file with the reason; the file keeps
//      the newest 200 lines
//   4. POST /notify: text required (400)
//   5. multi-machine: an edge forwards to the hub (machine name added; the hub's /health features has
//      "notify"), uses its own bot while the hub is away, and drops the connection when it has none
//   6. off: the hook is back to the normal path; godmode.mjs / config.mjs write the same flag file;
//      /myna:status shows it and counts only the unsent notices since it was turned on
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (...p) => path.join(ROOT, ...p);
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } };
const children = [];
const cleanup = () => { for (const c of children) { try { c.kill(); } catch {} } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 180s"); cleanup(); process.exit(1); }, 180000);
process.on("exit", cleanup);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-godmode-"));
const HOME = path.join(TMP, "home"); fs.mkdirSync(HOME, { recursive: true });
const used = new Set([7800, 7801]);
const freePort = () => { for (;;) { const p = 20000 + Math.floor(Math.random() * 20000); if (!used.has(p)) { used.add(p); return p; } } };
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|CLAUDE_CODE_SESSION_ID$)/.test(k)) delete e[k];
  e.HOME = e.USERPROFILE = HOME;
  return e;
})();
const dirOf = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
const GOD = path.join(TMP, "godmode"), UNSENT = path.join(TMP, "godmode-unsent.jsonl"), PERM = path.join(TMP, "permission");
const files = { MYNA_GODMODE_FILE: GOD, MYNA_GODMODE_UNSENT_FILE: UNSENT, MYNA_PERMISSION_FILE: PERM };

// --- Telegram API stubs ------------------------------------------------------------------------------------
function tgStub() {
  const s = { calls: [], updates: [], mid: 100, thread: 900, refuse: false, delayMs: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
      const method = u.pathname.split("/").pop();
      if (method === "getUpdates") { const deliver = () => { const out = s.updates; s.updates = []; json({ ok: true, result: out }); }; return s.updates.length ? deliver() : setTimeout(deliver, 100); }
      s.calls.push({ method, b });
      if (method === "sendMessage") {
        if (s.refuse) return json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
        if (s.drop) return req.socket.destroy(); // no answer at all: Telegram may or may not have taken it
        b._id = ++s.mid; return setTimeout(() => json({ ok: true, result: { message_id: b._id } }), s.delayMs);
      }
      if (method === "createForumTopic") return json({ ok: true, result: { message_thread_id: ++s.thread, name: b.name } });
      json({ ok: true, result: true });
    });
  });
  s.ready = new Promise((r) => srv.listen(0, "127.0.0.1", () => { s.url = `http://127.0.0.1:${srv.address().port}`; r(); }));
  s.sends = () => s.calls.filter((c) => c.method === "sendMessage").map((c) => c.b);
  s.notices = () => s.sends().filter((m) => /God mode 已自動同意/.test(m.text || ""));
  return s;
}
const hubTg = tgStub(), pc2Tg = tgStub(), pc4Tg = tgStub();
// a Discord REST stub: the gateway it names is a dead local port (the relay never reaches the real Discord)
const dsrv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(/\/gateway\/bot$/.test(req.url) ? { url: "ws://127.0.0.1:9" } : {})); });
await Promise.all([hubTg.ready, pc2Tg.ready, pc4Tg.ready, new Promise((r) => dsrv.listen(0, "127.0.0.1", r))]);

// --- machines (joining itself is test/smoke-remote.mjs) ----------------------------------------------------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const machine = (name) => { const id = crypto.randomBytes(6).toString("hex"); return { id, name, token: `myna_m_${id}_${crypto.randomBytes(32).toString("base64url")}` }; };
const MBP = machine("mbp"), PC2 = machine("pc2"), PC4 = machine("pc4");
const HUB_DIR = dirOf("hub"), MACHINES = path.join(HUB_DIR, "machines.json");
fs.writeFileSync(MACHINES, JSON.stringify({ version: 1, machines: [MBP, PC2, PC4].map((m) => ({ id: m.id, name: m.name, sha256: sha(m.token), os: "test", hostname: m.name, created_at: new Date().toISOString() })) }, null, 2));

// --- relays ------------------------------------------------------------------------------------------------
const up = (url) => until(async () => { try { await fetch(url, { signal: AbortSignal.timeout(400) }); return true; } catch { return false; } }, 10000);
async function relay(name, port, env) {
  const d = dirOf(name);
  const c = spawn(process.execPath, [src("src", "relay.mjs")], {
    env: { ...baseEnv, MYNA_ENV: path.join(d, ".env"), RELAY_PORT: String(port), MYNA_ANSWER_HOLD_MS: "1000", TELEGRAM_TOPIC_ROUND_GRACE: "0",
      MYNA_TOPICS_FILE: path.join(d, "topics.json"), MYNA_PENDING_FILE: path.join(d, "pending.json"), MYNA_TELEGRAM_CHAT_FILE: path.join(d, "chat.json"), MYNA_PROGRESS_FILE: path.join(d, "chat-progress"), ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(c);
  if (!(await up(`http://127.0.0.1:${port}/health`))) { console.error(`❌ relay ${name} never came up`); process.exit(1); }
  return c;
}
const H = freePort(), R = freePort();
await relay("hub", H, { MYNA_PROVIDER: "telegram", TELEGRAM_BOT_TOKEN: "111111:HUB", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: hubTg.url, MYNA_REMOTE_PORT: String(R), MYNA_MACHINES_FILE: MACHINES, MYNA_MACHINE_NAME: "win" });
const D = freePort();
await relay("discord", D, { MYNA_PROVIDER: "discord", DISCORD_BOT_TOKEN: "x.y.z", DISCORD_CHANNEL_ID: "123", DISCORD_API_BASE: `http://127.0.0.1:${dsrv.address().port}` });
const EDGE_TIMING = { MYNA_ROLE: "edge", MYNA_UPSTREAM_CHECK_MS: "250", MYNA_UPSTREAM_GRACE: "2", MYNA_UPSTREAM_RECOVER: "2" };
const E1 = freePort(), E2 = freePort(), E3 = freePort(), E4 = freePort();
await relay("mbp", E1, { ...EDGE_TIMING, MYNA_UPSTREAM: `http://127.0.0.1:${R}`, MYNA_MACHINE_TOKEN: MBP.token });
await relay("pc2", E2, { ...EDGE_TIMING, MYNA_UPSTREAM: "http://127.0.0.1:9", MYNA_MACHINE_TOKEN: PC2.token, TELEGRAM_BOT_TOKEN: "222222:PC2-OWN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: pc2Tg.url });
await relay("pc3", E3, { ...EDGE_TIMING, MYNA_UPSTREAM: "http://127.0.0.1:9", MYNA_MACHINE_TOKEN: PC2.token });
await relay("pc4", E4, { ...EDGE_TIMING, MYNA_UPSTREAM: `http://127.0.0.1:${R}`, MYNA_MACHINE_TOKEN: PC4.token, TELEGRAM_BOT_TOKEN: "444444:PC4-OWN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: pc4Tg.url });
const health = async (port) => { try { return await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })).json(); } catch { return null; } };
await until(async () => (await health(E1))?.upstream?.active);

// --- the hook ----------------------------------------------------------------------------------------------
function runHook(input, { port = H } = {}) {
  const c = spawn(process.execPath, [src("scripts", "permission-request.mjs")], {
    env: { ...baseEnv, ...files, MYNA_ENV: path.join(TMP, "no-such-env"), RELAY_PORT: String(port), MYNA_PERMISSION_DELAY: "0", MYNA_PERMISSION_WATCH_MS: "200" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.push(c);
  let out = ""; c.stdout.on("data", (d) => (out += d));
  const t0 = Date.now();
  const done = new Promise((r) => c.on("exit", (code) => r({ code, out, ms: Date.now() - t0, hso: (() => { try { return JSON.parse(out).hookSpecificOutput; } catch { return null; } })() })));
  c.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "3f9a1c2e-aaaa-bbbb-cccc-0123456789ab", cwd: "/work/myproj", permission_mode: "default", ...input }));
  return { c, done };
}
const bash = (command, description) => ({ tool_name: "Bash", tool_input: { command, ...(description ? { description } : {}) } });
const allowed = (r) => r.code === 0 && r.hso?.hookEventName === "PermissionRequest" && r.hso.decision?.behavior === "allow" && !("updatedPermissions" in r.hso.decision) && Object.keys(r.hso.decision).length === 1;
const unsent = () => { try { return fs.readFileSync(UNSENT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// === 1. on: allowed at once, a notice on the chat's main view ==================================================
fs.writeFileSync(GOD, new Date().toISOString());
fs.writeFileSync(PERM, "off\n"); // God mode does not depend on /myna:perm
{
  const n = hubTg.sends().length;
  const r = await runHook(bash("git push origin main", "把修正推到 main")).done;
  ok(allowed(r) && r.ms < 5000, `1: God mode on → allowed in ${r.ms} ms, this call only (decision ${JSON.stringify(r.hso?.decision)})`);
  const m = hubTg.sends().slice(n);
  const notice = m.find((x) => /God mode/.test(x.text || ""));
  ok(m.length === 1 && !!notice, `1: exactly one message reached Telegram (${m.length})`);
  ok(notice && notice.message_thread_id === undefined && !notice.reply_markup && !notice.parse_mode && String(notice.chat_id) === "42", "1: …in the chat's main view: no topic, no buttons, plain text");
  const lines = (notice?.text || "").split("\n");
  ok(lines[0] === "🔓 God mode 已自動同意｜myproj" && lines[1] === "Bash：git push origin main" && lines[2] === "（把修正推到 main）" && /^session：myproj \d\d\/\d\d \d\d:\d\d・3f9a1c2e$/.test(lines[3]) && lines[4] === "機器：win" && lines.length === 5,
    `1: the notice: project, tool, command, description, session label + id prefix, and (machines joined: as /ask) the machine → ${JSON.stringify(notice?.text)}`);
  ok(!hubTg.calls.some((c) => c.method === "createForumTopic"), "1: no topic was opened for it");
  ok(unsent().length === 0, "1: nothing in the unsent file");
}
{
  const n = hubTg.sends().length;
  const r = await runHook({ tool_name: "Write", tool_input: { file_path: "/work/myproj/a.txt", content: "x" }, agent_id: "a1b2c3" }).done;
  const t = hubTg.sends().slice(n).map((x) => x.text).join("\n");
  ok(allowed(r) && /Write：\/work\/myproj\/a\.txt/.test(t) && /・背景 agent a1b2c3\n機器：win$/.test(t), `1: a background subagent's Write → allowed, its agent id in the notice → ${JSON.stringify(t)}`);
}
{
  const n = hubTg.sends().length;
  const r = await runHook({ tool_name: "mcp__claude_ai_Gmail__send_message", tool_input: { to: "a@example.com", body: "x".repeat(2000) } }).done;
  const t = hubTg.sends().slice(n).map((x) => x.text).join("\n");
  ok(allowed(r) && /mcp__claude_ai_Gmail__send_message：\{/.test(t) && /…/.test(t) && t.length < 1100, `1: an MCP tool → its input as JSON, cut to 800 characters (${t.length} chars)`);
}

// === 2. AskUserQuestion is not a permission ================================================================
{
  const n = hubTg.sends().length;
  const r = await runHook({ tool_name: "AskUserQuestion", tool_input: { questions: [] } }).done;
  ok(r.code === 0 && r.out === "" && hubTg.sends().length === n, "2: AskUserQuestion with God mode on → not God mode's: the hook goes the normal way (perm off here → abstains, nothing sent)");
}

// === 3. the notice cannot go out: still allowed, kept in the unsent file =====================================
{
  const r = await runHook(bash("rm -rf build", "clean"), { port: 9 }).done;
  const u = unsent();
  ok(allowed(r) && r.ms < 6000, `3: relay down → still allowed (${r.ms} ms)`);
  ok(u.length === 1 && /God mode 已自動同意｜myproj/.test(u[0].text) && /rm -rf build/.test(u[0].text) && u[0].session_id && u[0].reason && !Number.isNaN(Date.parse(u[0].at)) && u[0].tool === "Bash",
    `3: …the notice kept in the unsent file with time, session, tool and reason (${u[0]?.reason})`);
  if (process.platform !== "win32") ok((fs.statSync(UNSENT).mode & 0o077) === 0, "3: the unsent file is private (0600)");
}
{
  hubTg.refuse = true;
  const r = await runHook(bash("git push origin main --force")).done;
  hubTg.refuse = false;
  const u = unsent().at(-1);
  ok(allowed(r) && /HTTP 502/.test(u?.reason || "") && /--force/.test(u?.text || ""), `3: Telegram refuses the message → still allowed, unsent with the relay's 502 (${u?.reason})`);
}
{
  hubTg.delayMs = 7000;
  const r = await runHook(bash("npm publish")).done;
  hubTg.delayMs = 0;
  const u = unsent().at(-1);
  ok(allowed(r) && r.ms < 6500 && /^timeout \(may still have been sent\)$/.test(u?.reason || "") && /npm publish/.test(u.text), `3: Telegram too slow → allowed after ~5 s (${r.ms} ms), unsent "${u?.reason}"`);
}
{
  const r = await runHook(bash("echo discord"), { port: D }).done;
  const u = unsent().at(-1);
  ok(allowed(r) && /HTTP 501/.test(u?.reason || "") && /echo discord/.test(u?.text || ""), `3: an IM without notices (Discord) → 501, still allowed, unsent (${u?.reason})`);
}
{
  const old = Array.from({ length: 205 }, (_, i) => JSON.stringify({ at: "2026-01-01T00:00:00.000Z", text: `old ${i}`, reason: "x" })).join("\n") + "\n";
  fs.writeFileSync(UNSENT, old);
  const r = await runHook(bash("echo cap"), { port: 9 }).done;
  const u = unsent();
  ok(allowed(r) && u.length === 200 && /echo cap/.test(u.at(-1).text) && u[0].text === "old 6", `3: the unsent file keeps the newest 200 lines (${u.length}; first "${u[0]?.text}")`);
  // many hooks at once on a full file (relay down, several sessions): none of their lines is lost to another's cut
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => runHook(bash(`echo par-${i}`), { port: 9 }).done));
  const u2 = unsent(), got = Array.from({ length: 8 }, (_, i) => u2.some((x) => x.text.includes(`echo par-${i}`)));
  ok(rs.every(allowed) && u2.length === 200 && got.every(Boolean) && !fs.existsSync(`${UNSENT}.lock`), `3: 8 hooks at once on a full file → all 8 lines kept, still 200 lines, no lock left (${got.filter(Boolean).length}/8, ${u2.length})`);
  // the lock held by a live process for longer than the hook can wait: the line goes to a spool file (the main
  // file untouched), counted by /myna:godmode status, and merged by the next writer that gets the lock
  const spools = () => fs.readdirSync(TMP).filter((n) => n.startsWith("godmode-unsent.jsonl.") && n.endsWith(".spool"));
  fs.writeFileSync(`${UNSENT}.lock`, `${process.pid} held-by-the-test\n`);
  const main0 = fs.readFileSync(UNSENT, "utf8");
  const rl = await runHook(bash("echo locked"), { port: 9 }).done;
  ok(allowed(rl) && rl.ms < 5500 && fs.readFileSync(UNSENT, "utf8") === main0 && spools().length === 1, `3: lock held elsewhere → allowed in ${rl.ms} ms, the line in a spool file (${spools().length}), the main file untouched`);
  const st = spawnSync(process.execPath, [src("scripts", "godmode.mjs"), "status"], { env: { ...baseEnv, ...files, MYNA_ENV: path.join(TMP, "no-such-env") }, encoding: "utf8" });
  ok(/有 \d+ 則通知沒送出去/.test(st.stdout), "3: …status counts it too");
  fs.rmSync(`${UNSENT}.lock`);
  const rn = await runHook(bash("echo after-lock"), { port: 9 }).done;
  const u3 = unsent();
  ok(allowed(rn) && spools().length === 0 && u3.length === 200 && u3.at(-2).text.includes("echo locked") && u3.at(-1).text.includes("echo after-lock"), "3: the next writer merges the spool (in order), removes it, keeps 200 lines");
  // Telegram gives no answer at all: it may have taken it → 504, marked "may still have been sent"
  hubTg.drop = true;
  const rd = await runHook(bash("echo dropped")).done;
  hubTg.drop = false;
  ok(allowed(rd) && /^HTTP 504.*may still have been sent/.test(unsent().at(-1)?.reason || ""), `3: no answer from Telegram → 504, unsent marked "may still have been sent" (${unsent().at(-1)?.reason})`);
}

// === 4. POST /notify itself ===================================================================================
{
  const post = (body) => fetch(`http://127.0.0.1:${H}/notify`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 0);
  ok((await post("{}")) === 400 && (await post('{"text":"  "}')) === 400 && (await post("not json")) === 400, "4: /notify without text (or bad JSON) → 400");
  const rr = await fetch(`http://127.0.0.1:${R}/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"text":"x"}' }).then((r) => r.status, () => 0);
  ok(rr === 401, `4: the hub's remote /notify without a machine token → 401 (${rr})`);
}

// === 5. multi-machine ===========================================================================================
fs.rmSync(UNSENT, { force: true });
{
  const rh = await fetch(`http://127.0.0.1:${R}/health`, { headers: { authorization: `Bearer ${MBP.token}` } }).then((r) => r.json(), () => null);
  ok(Array.isArray(rh?.features) && rh.features.includes("notify"), `5: the hub's remote /health features → ${JSON.stringify(rh?.features)}`);
  const n = hubTg.sends().length, before = unsent().length;
  const r = await runHook(bash("echo from-mbp"), { port: E1 }).done;
  const t = hubTg.sends().slice(n).map((x) => x.text).join("\n");
  ok(allowed(r) && /echo from-mbp/.test(t) && /\n機器：mbp$/.test(t) && unsent().length === before, `5: an edge → the notice goes out on the hub's bot with the machine name → ${JSON.stringify(t.split("\n").at(-1))}`);
}
{
  const n = hubTg.sends().length, before = unsent().length;
  const r = await runHook(bash("echo from-pc2"), { port: E2 }).done;
  ok(allowed(r) && pc2Tg.notices().some((m) => /echo from-pc2/.test(m.text)) && hubTg.sends().length === n && unsent().length === before, "5: an edge whose hub is away → the notice goes out on its own bot");
}
{
  const before = unsent().length;
  const r = await runHook(bash("echo from-pc3"), { port: E3 }).done;
  const u = unsent();
  ok(allowed(r) && u.length === before + 1 && /echo from-pc3/.test(u.at(-1).text) && /^HTTP 503/.test(u.at(-1).reason), `5: an edge whose hub is away, no bot of its own → 503, still allowed, unsent (${u.at(-1)?.reason})`);
}
{
  // the hub reachable but too slow to answer: it may still send it — the edge must not send a second copy on its own bot
  await until(async () => (await health(E4))?.upstream?.active);
  hubTg.delayMs = 5000;
  const n4 = pc4Tg.notices().length, before = unsent().length;
  const r = await runHook(bash("echo from-pc4"), { port: E4 }).done;
  await sleep(3000); // the hub's late send lands; a wrong fallback would have sent on pc4's bot by now
  hubTg.delayMs = 0;
  const u = unsent();
  ok(allowed(r) && pc4Tg.notices().length === n4 && u.length === before + 1 && /HTTP 504.*may still have been sent/.test(u.at(-1).reason) && hubTg.notices().some((m) => /echo from-pc4/.test(m.text)),
    `5: the hub reachable but no answer in time → 504, no second copy on the edge's own bot, unsent marked "may still have been sent" (${u.at(-1)?.reason})`);
}

// === 6. off, the toggles, /myna:status ============================================================================
const script = (name, args, extra = {}) => spawnSync(process.execPath, [src("scripts", name), ...args], { env: { ...baseEnv, ...files, MYNA_ENV: path.join(TMP, "no-such-env"), RELAY_PORT: "9", ...extra }, encoding: "utf8" });
{
  let r = script("godmode.mjs", ["off"]);
  ok(r.status === 0 && !fs.existsSync(GOD) && /God mode 關了/.test(r.stdout), "6: /myna:godmode off → the flag file is gone");
  fs.rmSync(PERM, { force: true }); // perm back on: the normal path asks the phone after the delay
  const n = hubTg.sends().length;
  const h = runHook(bash("echo normal"));
  const asked = await until(() => hubTg.sends().slice(n).find((m) => m.reply_markup && /echo normal/.test(m.text || "")), 6000);
  ok(!!asked && !hubTg.notices().some((m) => /echo normal/.test(m.text)), "6: off → the hook asks the phone (🔐 ✅/❌) as before, no God mode notice");
  h.c.kill("SIGTERM"); await h.done;
  fs.writeFileSync(PERM, "off\n");

  r = script("godmode.mjs", []);
  ok(r.status === 0 && /God mode 關著/.test(r.stdout), "6: no argument → status: off");
  r = script("godmode.mjs", ["on"]);
  ok(r.status === 0 && fs.existsSync(GOD) && !Number.isNaN(Date.parse(fs.readFileSync(GOD, "utf8"))) && /God mode 開了/.test(r.stdout), "6: /myna:godmode on → the flag file, holding the time it was turned on");
  const t0 = fs.readFileSync(GOD, "utf8");
  await sleep(20);
  r = script("godmode.mjs", ["on"]);
  ok(r.status === 0 && fs.readFileSync(GOD, "utf8") === t0 && /本來就開著/.test(r.stdout), "6: on again while on → the flag (its time) kept, says it was already on");
  r = script("godmode.mjs", ["on"], { MYNA_PROVIDER: "discord" });
  ok(/還不支援 God mode 的通知/.test(r.stdout), "6: on with a provider other than Telegram → says notices are not supported there");
  r = script("godmode.mjs", ["maybe"]);
  ok(r.status === 1 && fs.existsSync(GOD), "6: an unknown argument → refused, nothing changed");
  r = script("config.mjs", ["godmode", "off"]);
  ok(r.status === 0 && !fs.existsSync(GOD), "6: /myna:config godmode off → the same flag file removed");
  r = script("config.mjs", ["godmode", "on"]);
  ok(r.status === 0 && fs.existsSync(GOD) && /God mode 開了/.test(r.stdout), "6: /myna:config godmode on → the same flag file, the same output");
  r = script("config.mjs", []);
  ok(/godmode\s+on（設定檔/.test(r.stdout), "6: /myna:config lists godmode on, from its file");
  // unsent: one line older than the flag (an earlier time it was on), one newer
  const since = Date.parse(fs.readFileSync(GOD, "utf8"));
  fs.writeFileSync(UNSENT, [{ at: new Date(since - 60000).toISOString(), text: "old" }, { at: new Date(since + 1000).toISOString(), text: "new" }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  r = script("status.mjs", []);
  ok(/⚠ godmode 開/.test(r.stdout) && /這次開啟之後有 1 則通知沒送出去/.test(r.stdout), `6: /myna:status → godmode on, 1 unsent since it was turned on (the older line not counted): ${r.stdout.split("\n").find((l) => /God mode：/.test(l))}`);
  r = script("godmode.mjs", ["status"]);
  ok(/God mode 開著/.test(r.stdout) && /有 1 則通知沒送出去/.test(r.stdout), "6: /myna:godmode status → on, since when, 1 unsent");
  script("godmode.mjs", ["off"]);
  r = script("status.mjs", []);
  ok(!/⚠ godmode/.test(r.stdout) && /godmode 關（預設）/.test(r.stdout), "6: off → /myna:status shows godmode off (default)");
}

clearTimeout(watchdog);
cleanup();
if (failed) { console.log(`\n❌ ${failed} check(s) FAILED`); process.exit(1); }
console.log("\n✅ all God mode checks passed");
process.exit(0);
