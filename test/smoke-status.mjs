#!/usr/bin/env node
// /myna:status (scripts/status.mjs + src/status.mjs) — read-only overview. Temp HOME and MYNA_ENV; a fake
// relay (/health, /pair/status) and a fake Telegram Bot API (TELEGRAM_API_BASE) on random ports — never
// :7800, never a real bot. Every case also checks that status wrote nothing (paths, sizes, mtimes under the
// temp HOME) and that it only asked GET /health, GET /pair/status, getMe, getChat, getChatMember.
//    1 the friend's case (group, TELEGRAM_TOPICS=off, Threaded Mode off, no forum, bot a member, 2 failures)
//    2 private chat, Threaded Mode off      3 all good                  4 relay not running (with / without IM)
//    5 old relays (non-JSON, older, newer, no role, /pair/status 404)   6 every switch reads like its own script
//    7 credentials never printed            8 Telegram does not answer  9 edge
//   10 the relay's start line vs the file   11 .env newer than the relay
//   13 the environment wins over .env       14 /pair/status wins over telegram-chat.json
//   15 another provider in use, MYNA_ENV elsewhere, not a myna relay on the port, an edge's own bot
//      taking over, an unreadable .env, a huge log line through a pipe, MYNA_PERMISSION_DELAY set
//   16 an edge's own bot unpaired, an old edge relay without hold, unreadable .env without a token,
//      the relay's provider / role vs the config, per-setting sources, the token's second half alone
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const STATUS = path.join(ROOT, "scripts", "status.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-status-"));
const TOKEN = "7012345678:AAFakeSecretHalf_0123456789abcdefXYZ";
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$)/.test(k)) delete e[k];
  return e;
})();

// --- fake relay ---
let health = null;          // object → JSON; "text" → a pre-0.7.2 answer; null → 404
let pair = null;            // object → 200 JSON; null → 404
const relayReqs = [];
const relay = http.createServer((q, res) => {
  relayReqs.push(`${q.method} ${q.url}`);
  if (q.url === "/health") {
    if (health === "text") { res.writeHead(200); return res.end("ok"); }
    res.writeHead(health ? 200 : 404, { "content-type": "application/json" }); return res.end(JSON.stringify(health || {}));
  }
  if (q.url === "/pair/status") { res.writeHead(pair ? 200 : 404, { "content-type": "application/json" }); return res.end(JSON.stringify(pair || { error: "no" })); }
  res.writeHead(404); res.end();
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const RELAY_PORT = relay.address().port;
// a port nobody listens on
const DEAD_PORT = await new Promise((r) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

// --- fake Telegram ---
let tgAnswers = {};         // method → {ok, result} | {ok:false, description} | "hang"
const tgReqs = [];
const tg = http.createServer((q, res) => {
  let body = ""; q.on("data", (d) => (body += d));
  q.on("end", () => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(q.url);
    tgReqs.push({ method: m?.[2], token: m?.[1], body });
    const a = tgAnswers[m?.[2]];
    if (a === "hang") return; // never answers
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(a || { ok: false, description: "Not Found" }));
  });
});
await new Promise((r) => tg.listen(0, "127.0.0.1", r));
const TG_BASE = `http://127.0.0.1:${tg.address().port}`;

// --- a fresh HOME for each case ---
let n = 0;
// envAt(H): where MYNA_ENV points (default H/.myna/.env); envDir: make it a directory (unreadable as a file)
function home({ env = "", chatFile, topicsFile, log, envAgeMs = 3600000, envAt, envDir = false } = {}) {
  const H = path.join(TMP, `h${++n}`);
  fs.mkdirSync(H, { recursive: true });
  const ENV = envAt ? envAt(H) : path.join(H, ".myna", ".env"), D = path.dirname(ENV);
  fs.mkdirSync(D, { recursive: true });
  if (envDir) fs.mkdirSync(ENV);
  else { fs.writeFileSync(ENV, env); const t = new Date(Date.now() - envAgeMs); fs.utimesSync(ENV, t, t); }
  if (chatFile) fs.writeFileSync(path.join(D, "telegram-chat.json"), JSON.stringify(chatFile));
  if (topicsFile) fs.writeFileSync(path.join(D, "telegram-topics.json"), JSON.stringify(topicsFile));
  if (log) fs.writeFileSync(path.join(D, "relay.log"), log.join("\n") + "\n");
  return { H, D, ENV };
}
const snap = (dir) => {
  const out = [];
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) { out.push(`${f}/`); walk(f); } else { const s = fs.statSync(f); out.push(`${f} ${s.size} ${s.mtimeMs}`); } } };
  walk(dir); return out.sort().join("\n");
};
const ALLOWED_RELAY = new Set(["GET /health", "GET /pair/status"]), ALLOWED_TG = new Set(["getMe", "getChat", "getChatMember"]);
// run status (async: the fakes answer from this process's event loop); checks read-only + allowed requests
function run(h, extra = {}, { port = RELAY_PORT, script = STATUS } = {}) {
  relayReqs.length = 0; tgReqs.length = 0;
  const before = snap(h.H), t0 = Date.now();
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...(script === STATUS ? [] : extra.args || [])], {
      env: { ...baseEnv, HOME: h.H, USERPROFILE: h.H, MYNA_ENV: h.ENV, RELAY_PORT: String(port), TELEGRAM_API_BASE: TG_BASE, ...extra },
    });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (rc) => {
      if (script === STATUS) {
        const same = snap(h.H) === before;
        const relayOk = relayReqs.every((r) => ALLOWED_RELAY.has(r)), tgOk = tgReqs.every((r) => ALLOWED_TG.has(r.method));
        if (rc !== 0) ok(false, `status exited ${rc}: ${out.split(/\r?\n/).slice(0, 3).join(" | ")}`);
        if (!same || !relayOk || !tgOk) ok(false, `read-only (files same ${same}; relay ${relayReqs.join(",")}; telegram ${tgReqs.map((r) => r.method).join(",")})`);
      }
      resolve({ rc, out, ms: Date.now() - t0, tg: tgReqs.map((r) => r.method), relay: [...relayReqs] });
    });
  });
};
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const startLine = (at, topics = "auto") => `[relay ${at}] Telegram getUpdates long-poll started (topics=${topics}, scope=gate, round_grace=600s, on_end=delete, 0 known session topic(s), answers from chat -4012345678)`;
const hubHealth = (startedAt, extra = {}) => ({ ok: true, name: "myna-relay", version: VERSION, provider: "telegram", pid: 1, started_at: startedAt, pending: 0, role: "hub", ...extra });
const show = (label, out) => { if (process.env.VERBOSE) console.log(`----- ${label}
${out}-----`); };
const nextOf = (out) => out.slice(out.indexOf("建議的下一步"));
let r, h, started;

// 1 — the friend's case
started = iso(-60000);
h = home({
  env: `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_TOPICS=off\n`,
  topicsFile: { s1: { thread: null, name: "a", gate: "g", created: iso(-2 * 86400000) }, s2: { thread: null, name: "b", gate: "g", created: iso(-86400000) }, s3: { thread: 7, name: "c", gate: "g", created: iso(-3600000) } },
  log: [`[relay ${iso(-86400000)}] topics unavailable for session s2 (Bad Request: the chat is not a forum) — falling back to the flat chat. Enable "Threaded Mode" for the bot in @BotFather → Bot Settings to get one topic per gate.`, startLine(iso(-59000), "off")],
});
health = hubHealth(started);
pair = { chat: { id: "-4012345678", type: "group", title: "Family Group", paired_at: iso(-2 * 86400000) }, pairing: false };
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "friend_myna_bot", has_topics_enabled: false } }, getChat: { ok: true, result: { id: -4012345678, type: "group", title: "Family Group" } }, getChatMember: { ok: true, result: { status: "member" } } };
r = await run(h);
show("1", r.out);
ok(r.rc === 0, `1 exit 0 (${r.ms} ms)`);
ok(/TELEGRAM_TOPICS：relay 在用 off；設定檔 off/.test(r.out), "1 TELEGRAM_TOPICS: relay off, file off");
ok(/Threaded Mode：關（只影響私聊/.test(r.out), "1 Threaded Mode off, marked as private-chat only");
ok(/群組主題：沒開/.test(r.out) && /一般群組「Family Group」（id -4012345678）/.test(r.out), "1 group without topics, chat name and id shown");
ok(/bot 在群組：一般成員，不能管理主題/.test(r.out), "1 bot is a member and cannot manage topics");
ok(/gate topic 2 筆 thread: null/.test(r.out) && /the chat is not a forum/.test(r.out), "1 two gate-topic failures and the Telegram reason from relay.log");
ok(/topic：不會開 —— TELEGRAM_TOPICS=off；就算改回 auto，群組沒開主題、bot 不能管理主題/.test(r.out), "1 verdict: off, and what else blocks it");
{
  const nx = nextOf(r.out), a = nx.indexOf("開「主題」"), b = nx.indexOf("管理員"), c = nx.indexOf("TELEGRAM_TOPICS=off 刪掉");
  ok(a > 0 && b > a && c > b && /重新配對/.test(nx) && /再跑一次 \/myna:status/.test(nx), `1 next steps in order: topics (re-pair) → bot admin → drop TELEGRAM_TOPICS=off`);
}
ok(r.tg.includes("getMe") && r.tg.includes("getChat") && r.tg.includes("getChatMember"), `1 asked getMe, getChat, getChatMember (${r.tg.join(",")})`);
ok(tgReqs.find((x) => x.method === "getChatMember")?.body.includes("7012345678"), "1 getChatMember asks about the bot's own id");

// 2 — private chat, Threaded Mode off
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000))] });
health = hubHealth(iso(-60000));
pair = { chat: { id: "123456", type: "private", title: "Alex", paired_at: iso(-86400000) }, pairing: false };
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: false } } };
r = await run(h);
ok(/topic：不會開 —— bot 沒開 Threaded Mode/.test(r.out), "2 private: stuck at Threaded Mode");
ok(!r.tg.includes("getChat") && !r.tg.includes("getChatMember"), `2 no getChat / getChatMember for a private chat (${r.tg.join(",")})`);
ok(/BotFather/.test(nextOf(r.out)) && !/群組主題/.test(r.out), "2 next step is BotFather; no group lines");

// 3 — all good
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000))] });
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: true } } };
r = await run(h);
ok(/topic：會開\n/.test(r.out) && !/推測/.test(r.out), "3 verdict: topics will open (not a guess)");
ok(/建議的下一步\n  沒有，看起來都正常/.test(r.out), "3 no next steps");
ok(/在跑：v[\d.]+（跟 plugin 同版）/.test(r.out) && /主節點（hub）/.test(r.out), "3 relay: same version, hub");

// 4 — relay not running
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, chatFile: { chat_id: "555", type: "private", title: "Sam", paired_at: iso(-86400000) } });
r = await run(h, {}, { port: DEAD_PORT });
ok(/relay\n  沒在跑/.test(r.out) && /會自動啟動/.test(r.out), "4 relay not running, would start on the next session");
ok(/私聊「Sam」（id 555）/.test(r.out) && /relay 沒回報，從設定檔讀/.test(r.out), "4 pairing read from telegram-chat.json");
ok(/relay 實際在用的：relay 沒在跑/.test(r.out) && /開關\n  intercept 開/.test(r.out), "4 the relay column says it is not running; switches still shown");
ok(/\/myna:relay start/.test(nextOf(r.out)), "4 next: /myna:relay start");
h = home({ env: "" });
r = await run(h, {}, { port: DEAD_PORT });
ok(/不會自動啟動/.test(r.out) && /\/myna:setup/.test(nextOf(r.out)) && !/\/myna:relay start/.test(r.out), "4 no IM: no autostart, next is /myna:setup");

// 5 — old relays
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, chatFile: { chat_id: "555", type: "private", title: "Sam" } });
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: true } } };
health = "text"; pair = null;
r = await run(h);
ok(/很舊的 relay/.test(r.out) && /\/myna:relay restart/.test(nextOf(r.out)), "5 non-JSON /health → very old relay, restart");
health = { name: "myna-relay", version: "0.20.0", provider: "telegram", started_at: iso(-60000), pending: 0 }; // no role
r = await run(h);
ok(/比 plugin v[\d.]+ 舊/.test(r.out) && /relay 比這個 plugin 舊：\/myna:relay restart/.test(r.out), "5 older → restart");
ok(/主節點（hub）/.test(r.out), "5 no role → hub");
ok(/私聊「Sam」（id 555）/.test(r.out) && /從設定檔讀/.test(r.out), "5 /pair/status 404 → read the file");
health = { ...hubHealth(iso(-60000)), version: "99.0.0" };
r = await run(h);
ok(/比 plugin v[\d.]+ 新/.test(r.out) && /\/plugin update/.test(nextOf(r.out)), "5 newer → /plugin update");

// 6 — every switch reads like its own script
{
  h = home({ env: "MYNA_ROLE=edge\nMYNA_UPSTREAM=https://hub.example.com\n" });
  // no upstream in /health: the hold is read from the config, like hold.mjs does
  health = { ...hubHealth(iso(-60000)), role: "edge", provider: "none", own_bot: { on: false } };
  pair = null;
  const S =(name, ...args) => run(h, { args }, { script: path.join(ROOT, "scripts", name) });
  const pairs = [["intercept.mjs", "off", /intercept is OFF/, /intercept 關/], ["autopilot.mjs", "on", /autopilot is ON/, /autopilot 開/],
    ["murmur.mjs", "off", /murmur is OFF/, /murmur 關/], ["perm.mjs", "off", /forwarding is OFF/, /perm 關/], ["brief.mjs", "off", /gate-brief is OFF/, /brief 關/],
    ["stopcatch.mjs", "off", /stop-catch is OFF/, /stopcatch 關/], ["hold.mjs", "off", /斷線排隊：關/, /hold 關/]];
  for (const [s, a] of pairs) await S(s, a);
  await S("files.mjs", "keep", "3");
  r = await run(h);
  for (const [s, , own, mine] of pairs) { const o = await S(s); ok(own.test(o.out) && mine.test(r.out), `6 ${s} says ${own.source}, status says ${mine.source}`); }
  const fo = await S("files.mjs");
  ok(/保留 3 天/.test(fo.out) && /files 保留 3 天/.test(r.out), "6 files.mjs keep 3 ↔ status");
  for (const [s, a] of [["intercept.mjs", "on"], ["autopilot.mjs", "off"], ["murmur.mjs", "on"], ["perm.mjs", "on"], ["brief.mjs", "on"], ["stopcatch.mjs", "on"], ["hold.mjs", "on"]]) await S(s, a);
  await S("files.mjs", "keep", "default");
  r = await run(h);
  ok(/intercept 開（預設）/.test(r.out) && /autopilot 關（預設）/.test(r.out) && /murmur 開（預設）/.test(r.out) && /perm 開（預設，30 秒）/.test(r.out)
    && /brief 開（預設）/.test(r.out) && /stopcatch 開（預設）/.test(r.out) && /hold 開，上限 1 天/.test(r.out) && /files 保留 7 天（預設）/.test(r.out), "6 back to the defaults → status shows the defaults");
  h = home({ env: "" });
  health = hubHealth(iso(-60000));
  r = await run(h);
  ok(!/hold /.test(r.out.slice(r.out.indexOf("開關"), r.out.indexOf("環境變數"))), "6 hold is only shown on an edge");
}

// 7 — credentials never printed
{
  const SECRETS = { TELEGRAM_BOT_TOKEN: TOKEN, SLACK_APP_TOKEN: "xapp-1-FAKEAPPTOKEN123", MYNA_CF_ACCESS_CLIENT_SECRET: "cfsecretFAKE987", MYNA_MACHINE_TOKEN: "myna_m_0123456789ab_FAKEmachineTokenValue_abcdefghijklmnop",
    FOO_SECRET: "foosecretFAKE", TELEGRAM_TOPICS_SECRET: "topicsecretFAKE", MYNA_UPSTREAM_HOLD_TOKEN: "holdtokenFAKE", MYNA_CF_ACCESS_CLIENT_ID: "cfidFAKE42" };
  const ENV_ONLY = { DISCORD_BOT_TOKEN: "discordFAKE.token.value" };
  const all = [...Object.values(SECRETS), ...Object.values(ENV_ONLY), TOKEN.split(":")[1]];
  const leaked = (out) => all.filter((v) => out.includes(v));
  h = home({
    env: Object.entries(SECRETS).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    log: [`[relay ${iso(-30000)}] topics unavailable for session s9 (Bad Request: bot${TOKEN} ${SECRETS.SLACK_APP_TOKEN} ${ENV_ONLY.DISCORD_BOT_TOKEN} ${SECRETS.FOO_SECRET}) — falling back to the flat chat.`, startLine(iso(-59000))],
  });
  health = hubHealth(iso(-60000));
  pair = { chat: { id: "123456", type: "private", title: `Alex ${SECRETS.TELEGRAM_TOPICS_SECRET}` }, pairing: false };
  tgAnswers = { getMe: { ok: false, description: `Unauthorized ${TOKEN} ${SECRETS.MYNA_UPSTREAM_HOLD_TOKEN}` } };
  const name = os.hostname().split(".")[0];
  r = await run(h, { ...ENV_ONLY, COMPUTERNAME: name, HOSTNAME: name });
  show("7", r.out);
  ok(leaked(r.out).length === 0, `7 no credential (nor the token's second half) anywhere in stdout + stderr (leaked: ${leaked(r.out).length})`);
  ok(/TELEGRAM_BOT_TOKEN\s+有設（\.env）/.test(r.out) && /DISCORD_BOT_TOKEN\s+有設（環境變數）/.test(r.out), "7 credentials only as 有設, with their source");
  ok(!/FOO_SECRET|TELEGRAM_TOPICS_SECRET|MYNA_UPSTREAM_HOLD_TOKEN/.test(r.out), "7 keys outside the list (even with a listed prefix) are not listed");
  ok(r.out.split("\n")[0].includes(`Myna 狀態 · ${name}`), "7 machine name = COMPUTERNAME / HOSTNAME still printed in the header");
  ok(/\*\*\*/.test(r.out), "7 the redacted spots show ***");
  // a token from the environment → the Telegram lines say the relay may use another bot
  h = home({ env: "", log: [startLine(iso(-59000))] });
  tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: true } } };
  pair = { chat: { id: "123456", type: "private", title: "Alex" }, pairing: false };
  r = await run(h, { TELEGRAM_BOT_TOKEN: TOKEN });
  ok(/relay 可能用別支/.test(r.out) && /topic：會開（推測）/.test(r.out) && leaked(r.out).length === 0, "7 token from the environment → 'relay may use another bot', verdict a guess");
  // edge hold: the relay's /health upstream.hold wins over this session's variable
  h = home({ env: "MYNA_ROLE=edge\nMYNA_UPSTREAM=https://hub.example.com\n" });
  health = { ...hubHealth(iso(-60000)), role: "edge", provider: "none", upstream: { url: "https://hub.example.com", reachable: true, version: VERSION, hold: { on: false, max_s: 3600, source: "file", queued: 0, waiting: 0 } }, own_bot: { on: false } };
  pair = null;
  r = await run(h, { MYNA_UPSTREAM_HOLD: "on" });
  ok(/hold 關，上限 1 小時（relay 在用的）/.test(r.out), "7 edge hold from the relay's /health, not the session's MYNA_UPSTREAM_HOLD");
}

// 8 — Telegram does not answer
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000))] });
health = hubHealth(iso(-60000));
pair = { chat: { id: "123456", type: "private", title: "Alex" }, pairing: false };
tgAnswers = { getMe: "hang" };
r = await run(h);
ok(r.rc === 0 && r.ms < 8000, `8 exit 0 within 8 s (${r.ms} ms)`);
ok(/Telegram 查不到：逾時/.test(r.out) && /Threaded Mode：查不到（逾時）/.test(r.out) && /topic：沒辦法確定/.test(r.out), "8 Telegram timed out → marked, verdict cannot tell");
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000))] });
pair = { chat: { id: "-100777", type: "supergroup", title: "Team" }, pairing: false };
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot" } }, getChat: "hang", getChatMember: "hang" };
r = await run(h);
ok(r.rc === 0 && r.ms < 8000 && /群組主題：查不到（逾時）/.test(r.out) && /topic：沒辦法確定/.test(r.out), `8 group queries time out → cannot tell (${r.ms} ms)`);

// 9 — edge
h = home({ env: "MYNA_ROLE=edge\nMYNA_UPSTREAM=https://user:pw9@hub.example.com/x?k=v9\n" });
health = { ...hubHealth(iso(-60000)), role: "edge", provider: "none", upstream: { url: "https://user:pw9@hub.example.com/x?k=v9", reachable: false, reason: "hub answered HTTP 530", version: "0.22.0" }, own_bot: { on: false, id: null, reason: "no bot configured on this machine" } };
pair = null;
r = await run(h);
show("9", r.out);
ok(/主節點：https:\/\/hub\.example\.com\n/.test(r.out) && !/pw9|k=v9|user:/.test(r.out), "9 hub URL shown as its origin only (no user, password, path or query)");
ok(/連不上（hub answered HTTP 530）/.test(r.out) && /這台自己的 bot：沒在用/.test(r.out) && /子節點（edge）/.test(r.out), "9 unreachable with the reason; own bot off; role edge");
ok(/topic 的原因要在主節點跑 \/myna:status/.test(nextOf(r.out)) && /主節點連不上/.test(nextOf(r.out)), "9 next: look at the hub; run status there for topics");
ok(!/\n Telegram\n|\nTelegram\n/.test(r.out) && !/\/myna:setup/.test(r.out), "9 an edge without its own bot: no Telegram section, no /myna:setup");

// 10 — the relay's start line vs the file
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000), "off")] });
health = hubHealth(iso(-60000));
pair = { chat: { id: "123456", type: "private", title: "Alex" }, pairing: false };
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: true } } };
r = await run(h);
ok(/relay 在用 off；設定檔 auto/.test(r.out) && /⚠ relay 用的跟設定檔不同/.test(r.out) && /\/myna:relay restart/.test(nextOf(r.out)), "10 relay off, file auto → both shown, restart suggested");
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-120000), "off")] });
r = await run(h);
ok(/relay 實際在用的：查不到/.test(r.out) && /topic：會開（推測）/.test(r.out), "10 a start line from before started_at is not used → 查不到, verdict a guess");

// 11 — .env newer than the relay
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000))], envAgeMs: 1000 });
health = hubHealth(iso(-60000));
r = await run(h);
ok(/⚠ ~\/\.myna\/\.env 在 relay 啟動之後改過/.test(r.out) && /\/myna:relay restart/.test(nextOf(r.out)), "11 .env changed after the relay started → restart");

// 13 — the environment wins over .env
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_TOPICS=auto\n`, log: [startLine(iso(-59000))] });
r = await run(h, { TELEGRAM_TOPICS: "off" });
ok(/設定檔 off（環境變數）/.test(r.out) && /拿掉環境變數 TELEGRAM_TOPICS=off/.test(nextOf(r.out)), "13 TELEGRAM_TOPICS from the environment wins and the next step says to drop the variable");

// 14 — /pair/status wins over telegram-chat.json
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, chatFile: { chat_id: "111", type: "private", title: "Old" }, log: [startLine(iso(-59000))] });
pair = { chat: { id: "222", type: "private", title: "New", paired_at: iso(-1000) }, pairing: false };
r = await run(h);
ok(/id 222/.test(r.out) && !/id 111/.test(r.out) && /（relay 在用）/.test(r.out), "14 the relay's chat is shown, not the file's");

// 15 — review round 1 (X1–X7)
// X1: the relay uses Discord, a Telegram token is left over → no Telegram checks, no Telegram steps
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_TOPICS=off\nDISCORD_BOT_TOKEN=d.fake.tok\nDISCORD_CHANNEL_ID=42\nMYNA_PROVIDER=discord\n` });
health = { ...hubHealth(iso(-60000)), provider: "discord" };
pair = null; tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: false } } };
r = await run(h);
ok(/token 有設，但 relay 用的是 discord，不檢查 Telegram/.test(r.out) && r.tg.length === 0, `15 X1 provider discord → Telegram not checked (telegram calls: ${r.tg.join(",") || "none"})`);
ok(!/\/myna:pair|TELEGRAM_TOPICS=off 刪掉|BotFather/.test(nextOf(r.out)), "15 X1 …and no Telegram next steps");
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\nSLACK_BOT_TOKEN=xoxb-fake\nSLACK_APP_TOKEN=xapp-fake\nSLACK_CHANNEL_ID=C1\n` });
r = await run(h, {}, { port: DEAD_PORT });
ok(/relay 用的是 slack/.test(r.out) && r.tg.length === 0, "15 X1 auto: Slack fully set, Telegram not paired → the relay would pick Slack, Telegram not checked");
// X2: MYNA_ENV elsewhere → the messages name that file
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_TOPICS=off\n`, envAt: (H) => path.join(H, "config", "custom.env"), envAgeMs: 1000, log: [startLine(iso(-59000), "off")] });
health = hubHealth(iso(-60000));
pair = { chat: { id: "123456", type: "private", title: "Alex" }, pairing: false };
r = await run(h);
ok(/⚠ ~\/config\/custom\.env 在 relay 啟動之後改過/.test(r.out) && /把 ~\/config\/custom\.env 的 TELEGRAM_TOPICS=off 刪掉/.test(r.out) && !/~\/\.myna\/\.env/.test(r.out), "15 X2 MYNA_ENV=~/config/custom.env → named in the warning and the step");
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_TOPICS=off\n`, envAt: () => path.join(TMP, `outside${n}`, "m.env") });
r = await run(h);
ok(r.out.includes(`把 ${path.join(TMP, `outside${n}`, "m.env").replace(/\\/g, "/")} 的 TELEGRAM_TOPICS=off`), "15 X2 MYNA_ENV outside the home directory → its full path");
// X3: something else on the port
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n` });
for (const [label, doc] of [["404 {}", null], ["200 unrelated JSON", { foo: 1 }]]) {
  health = doc;
  r = await run(h);
  ok(/有程式在回應，但不是 myna relay/.test(r.out) && /被別的程式占用/.test(nextOf(r.out)) && !/在跑：/.test(r.out), `15 X3 ${label} on the port → not a myna relay`);
}
// X4: edge, hub away, holding off, own bot on → the own bot takes new questions: look here
h = home({ env: `MYNA_ROLE=edge\nMYNA_UPSTREAM=https://hub.example.com\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000))] });
health = { ...hubHealth(iso(-60000)), role: "edge", upstream: { url: "https://hub.example.com", reachable: false, reason: "timeout", version: VERSION, hold: { on: false, max_s: 86400, source: "file", queued: 0, waiting: 0 } }, own_bot: { on: true, id: "telegram:7012345678" } };
pair = { chat: { id: "123456", type: "private", title: "Alex" }, pairing: false };
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: true } } };
r = await run(h);
ok(/新題目現在由這台自己的 bot 發：topic 看上面 Telegram 那段/.test(nextOf(r.out)) && /\nTelegram\n/.test(r.out), "15 X4 edge + own bot taking over → topics are diagnosed here");
health = { ...health, upstream: { ...health.upstream, hold: { ...health.upstream.hold, on: true } } };
r = await run(h);
ok(/新題目先排著（還沒送到手機）/.test(nextOf(r.out)), "15 X4 edge, hub away, holding on → the questions are held, not sent");
// X5: an .env that cannot be read (a directory) → still a page, exit 0, the reason shown
h = home({ envDir: true });
health = hubHealth(iso(-60000));
r = await run(h, { TELEGRAM_BOT_TOKEN: TOKEN });
ok(r.rc === 0 && /設定檔 .* 讀不到（EISDIR）/.test(r.out) && /建議的下一步/.test(r.out), `15 X5 unreadable .env → exit ${r.rc}, the reason shown, the rest still printed`);
// X6: a huge relay.log line through a pipe → the page arrives whole
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [`[relay ${iso(-30000)}] topics unavailable for session s1 (Bad Request: ${"x".repeat(200000)}) — falling back to the flat chat.`, startLine(iso(-59000))] });
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: true } } };
r = await run(h);
ok(r.out.length > 200000 && /建議的下一步\n  (1\.|沒有)/.test(r.out) && /\/myna:status 確認|看起來都正常/.test(r.out.slice(-200)), `15 X6 a 200 KB log line → the whole page through the pipe (${r.out.length} chars)`);
// X7: MYNA_PERMISSION_DELAY changed → not shown as the default delay
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\nMYNA_PERMISSION_DELAY=5\n` });
r = await run(h);
ok(/perm 開（預設，5 秒，MYNA_PERMISSION_DELAY）/.test(r.out), "15 X7 MYNA_PERMISSION_DELAY=5 → the delay is marked as set");

// 16 — review round 2
// edge with its own Telegram bot, not paired → /myna:pair
h = home({ env: `MYNA_ROLE=edge\nMYNA_UPSTREAM=https://hub.example.com\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000))] });
health = { ...hubHealth(iso(-60000)), role: "edge", upstream: { url: "https://hub.example.com", reachable: true, version: VERSION, hold: { on: true, max_s: 86400, source: "default", queued: 0, waiting: 0 } }, own_bot: { on: true, id: "telegram:7012345678" } };
pair = { chat: null, pairing: false };
tgAnswers = { getMe: { ok: true, result: { id: 7012345678, username: "x_bot", has_topics_enabled: true } } };
r = await run(h);
ok(/配對聊天室：\/myna:pair/.test(nextOf(r.out)), "16 edge + own Telegram bot, not paired → /myna:pair suggested");
// edge, a relay older than 0.21.0 (upstream without hold), hub away, own bot on → its own bot takes over
health = { ...health, version: "0.20.4", upstream: { url: "https://hub.example.com", reachable: false, reason: "timeout", version: VERSION } };
pair = { chat: { id: "123456", type: "private", title: "Alex" }, pairing: false };
r = await run(h);
ok(/新題目現在由這台自己的 bot 發/.test(nextOf(r.out)) && !/先排著/.test(r.out) && /hold：這版 relay 不支援斷線排隊/.test(r.out), "16 old edge relay without hold → own bot takes over, not 'held'; hold cell says unsupported");
// unreadable .env, no IM in the environment → the file first, no /myna:setup
h = home({ envDir: true });
health = hubHealth(iso(-60000));
r = await run(h);
{ const nx = nextOf(r.out); ok(/  1\. 設定檔 .* 讀不到/.test(nx) && !/\/myna:setup/.test(nx), "16 unreadable .env and no token → step 1 is the file, no /myna:setup"); }
// the running relay's provider / role differ from what the config would make it (no .env change)
h = home({ env: `DISCORD_BOT_TOKEN=d.fake.tok\nDISCORD_CHANNEL_ID=42\n` });
health = { ...hubHealth(iso(-60000)), provider: "discord" };
pair = null;
r = await run(h, { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "123456" });
ok(/⚠ provider：relay 用的是 discord，照設定檔／這個 session 會是 telegram/.test(r.out) && /relay 用的設定跟設定檔不同/.test(nextOf(r.out)), "16 relay on discord, this session's config picks telegram → shown, restart");
health = { ...hubHealth(iso(-60000)), provider: "discord", role: "edge" };
r = await run(h);
ok(/⚠ 角色：relay 用的是 edge，照設定檔／這個 session 會是 hub/.test(r.out) && /relay 用的設定跟設定檔不同/.test(nextOf(r.out)), "16 relay an edge, config a hub → shown, restart");
// each topic setting's own source
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_TOPIC_SCOPE=session\n`, log: [startLine(iso(-59000))] });
health = hubHealth(iso(-60000));
pair = { chat: { id: "123456", type: "private", title: "Alex" }, pairing: false };
r = await run(h, { TELEGRAM_TOPIC_ON_END: "keep" });
ok(/設定檔 session（~\/\.myna\/\.env）／keep（環境變數）／600s（預設）/.test(r.out), "16 scope from .env, on_end from the environment, grace default → each with its source");
// only the token's second half in relay.log and a Telegram error → still redacted
{
  const half = TOKEN.split(":")[1];
  h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [`[relay ${iso(-30000)}] chat: no topic for n1 (Bad Request: ${half}) — it talks in the main chat until a later registration gets one`, startLine(iso(-59000))] });
  tgAnswers = { getMe: { ok: false, description: `Unauthorized ${half}` } };
  r = await run(h);
  ok(!r.out.includes(half) && /\*\*\*/.test(r.out), "16 the token's second half alone (log, Telegram error) → redacted");
}

// 17 — the relay could not make an owner-only file private (0.26.3: /health private_files; Windows icacls failing)
h = home({ env: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, log: [startLine(iso(-59000))] });
tgAnswers = {};
pair = { chat: { id: "123456", type: "private", title: "Alex" }, pairing: false };
health = hubHealth(iso(-60000), { private_files: { file: path.join(h.H, ".myna", "relay-secret"), error: "icacls: ENOENT", at: iso(-50000) } });
r = await run(h);
ok(/⚠ 敏感檔沒辦法設成只有你讀得到：~[\\/]\.myna[\\/]relay-secret（icacls: ENOENT）/.test(r.out) && /relay-secret 設成只有你讀得到（icacls: ENOENT）.*icacls/.test(nextOf(r.out)),
  "17 /health private_files → a ⚠ line under relay and a next step");
health = hubHealth(iso(-60000), { private_files: null });
r = await run(h);
ok(!/敏感檔/.test(r.out), "17 private_files null → nothing about it");

relay.closeAllConnections?.(); tg.closeAllConnections?.();
await Promise.all([new Promise((x) => relay.close(x)), new Promise((x) => tg.close(x))]);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
if (failed) { console.log(`\n❌ ${failed} check(s) FAILED`); process.exit(1); }
console.log("\n✅ all /myna:status checks passed");
