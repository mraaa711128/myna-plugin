#!/usr/bin/env node
// Orphan sweep: an open gate nobody polls, older than MYNA_ORPHAN_TTL, is cancelled (buttons retracted,
// a note in its topic) and dropped from the journal — instead of being adopted by every restarted relay
// forever. A young one, a detached one and an attended one are left alone; MYNA_ORPHAN_TTL=0 turns it off.
// Isolated: random port, fake MYNA_ENV, own journal, stubbed Telegram on 127.0.0.1.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const relayPath = fileURLToPath(new URL("../src/relay.mjs", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return undefined; await sleep(50); } };
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 60s"); process.exit(1); }, 60000);

// --- Telegram API stub -----------------------------------------------------------
const sent = [], markupEdits = [];
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    if (/\/getUpdates$/.test(u.pathname)) { setTimeout(() => json({ ok: true, result: [] }), 150); return; }
    if (/\/sendMessage$/.test(u.pathname)) { sent.push(b); json({ ok: true, result: { message_id: 900 + sent.length } }); return; }
    if (/\/editMessageReplyMarkup$/.test(u.pathname)) { markupEdits.push(b); json({ ok: true, result: true }); return; }
    json({ ok: true, result: true });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "myna-orphan-"));
const JOURNAL = path.join(scratch, "pending.json");
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const DAY = 86400000, now = Date.now();
let relay;
async function startRelay(extra = {}) {
  relay = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env,
      MYNA_ENV: path.join(scratch, "no-such.env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "TESTTOKEN", TELEGRAM_CHAT_ID: "42",
      TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      RELAY_PORT: String(RELAY_PORT), MYNA_ANSWER_HOLD_MS: "1000",
      MYNA_TOPICS_FILE: path.join(scratch, "topics.json"), MYNA_PENDING_FILE: JOURNAL,
      MYNA_ATTENDED_GRACE_MS: "500", MYNA_SWEEP_MS: "300", ...extra,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const up = await until(() => fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false), 8000);
  if (!up) { console.error("❌ relay never came up"); process.exit(1); }
}
async function stopRelay() { const gone = new Promise((r) => relay.once("exit", r)); relay.kill(); await gone; }
const health = () => fetch(`${RELAY}/health`).then((r) => r.json());
const journalIds = () => Object.keys(JSON.parse(fs.readFileSync(JOURNAL, "utf8")).requests || {});

// a journal as an old relay left it: a 3-day-old gate with no session id (the real-world orphan), a
// 2-day-old one still being polled, a 2-day-old detached one, and a fresh one
const seed = () => fs.writeFileSync(JOURNAL, JSON.stringify({
  version: "0.8.0", saved_at: new Date().toISOString(), closing: [],
  requests: {
    aaaa000001: { created: now - 3 * DAY },
    aaaa000002: { created: now - 2 * DAY, session_id: "sess-live" },
    aaaa000003: { created: now - 2 * DAY, session_id: "sess-gone", detached: { at: now, until: now + 3600000, by: "sess-gone" } },
    aaaa000004: { created: now - 3600000 },
  },
  provider: { tokens: [], awaitingText: [], threadLastMsg: [], askPrompts: [],
    questionMsg: [["aaaa000001", { message_id: 77, topic: 9191, chat: 42 }]] },
}));

// 1) default TTL (1 day): the old unpolled one is reaped, the rest stay
seed();
await startRelay();
let polling = true;
(async () => { while (polling) await fetch(`${RELAY}/answer/aaaa000002`).catch(() => {}); })(); // a live asker on #2
await until(async () => (await health()).pending === 3, 5000);
await sleep(1500); // several sweeps past the attended grace
let h = await health();
ok(h.pending === 3, `only the orphan is gone (open now: ${h.pending}, want 3)`);
ok(markupEdits.some((e) => e.message_id === 77), "the orphan's buttons were retracted");
ok(sent.some((s) => s.message_thread_id === 9191 && /放太久/.test(s.text)), "a note went to the orphan's topic");
const ids = journalIds();
ok(!ids.includes("aaaa000001"), "the orphan is no longer in the journal (the next relay will not adopt it)");
ok(["aaaa000002", "aaaa000003", "aaaa000004"].every((id) => ids.includes(id)), "attended, detached and young gates are kept");
polling = false;
await stopRelay();

// 2) MYNA_ORPHAN_TTL=0: nothing is reaped
markupEdits.length = 0; sent.length = 0;
seed();
await startRelay({ MYNA_ORPHAN_TTL: "0" });
await sleep(1500);
h = await health();
ok(h.pending === 4 && markupEdits.length === 0, `MYNA_ORPHAN_TTL=0 keeps every open gate (open: ${h.pending})`);
await stopRelay();

stub.close();
fs.rmSync(scratch, { recursive: true, force: true });
clearTimeout(watchdog);
console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ all orphan-sweep checks passed");
process.exit(failed ? 1 : 0);
