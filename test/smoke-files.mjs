#!/usr/bin/env node
// Autonomous e2e of files sent from the phone to a chat session (SPEC §5.3) on one machine: the real
// relay, a local Telegram API stub (getFile + the file URL), the chat mod (hooks/chat-mod.mjs) on a stub
// `$`, and /myna:files. Temp HOME / MYNA_ENV, random port — never ~/.myna, never :7800.
// Proves: a document / the biggest photo in a chat topic is saved in the inbox and the session gets its
// local path + the untrusted-data line + the caption; an album is several messages taken together; the
// sender's file name never becomes a path; > 20 MB (declared or streamed) is refused without a file
// left; no chat session / an unsupported type / a closed session is told why; a caption "!cmd" is text;
// the bot token is in no log line, reply, inbox file, chat record or take; a failed download says a
// fixed reason; old files are pruned before a new one (/myna:files keep), a pruned one is "unavailable";
// a slow download holds up no text; the chat mod lets the session Read exactly the delivered file
// without a prompt (tool.check: ask → allow) and nothing else.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import * as inbox from "../src/inbox.mjs";
import { readKey } from "../hooks/chat-mod.mjs";

// MYNA_TEST_ROOT=<another checkout> runs the relay, the chat mod and /myna:files of that code (0.21.1 → the
// file checks fail; the pure parts above them always test this checkout's helpers)
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const relayPath = path.join(ROOT, "src", "relay.mjs");
const filesScript = path.join(ROOT, "scripts", "files.mjs");
const { register } = await import(pathToFileURL(path.join(ROOT, "hooks", "chat-mod.mjs")).href);
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 150s"); process.exit(1); }, 150000);
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myna-files-test-")));
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 50) { const v = await fn(); if (v) return v; await sleep(50); } return fn(); };
const TOKEN = "123456:TESTTOKENsecretPART";
const WIN = process.platform === "win32";

// --- pure parts ----------------------------------------------------------------------------------
{
  const n = inbox.fileName({ fid: "0123456789abcdef", original: "../../a.PDF", mime: "application/pdf", at: "2026-11-10T01:02:03Z" });
  ok(n === "20261110-010203-0123456789abcdef.pdf", `fileName from controlled parts only → ${n}`);
  ok(inbox.extOf("a.<script>", "image/png") === "png" && inbox.extOf("noext", "") === "bin" && inbox.extOf("x.verylongext", "application/pdf") === "pdf", "extension: the sender's when short and plain, else the MIME's, else bin");
  ok(inbox.displayName("a\u202eb\nc.txt") === "ab c.txt" && Array.from(inbox.displayName("長".repeat(200))).length === 80, "displayName drops invisible characters, folds newlines, keeps ≤ 80 characters");
  let threw = false; try { inbox.fileName({ fid: "../x", original: "a" }); } catch { threw = true; }
  ok(threw, "a file id that is not 16 hex is refused");
  ok(readKey("C:/Users/A/x.pdf") === "c:\\users\\a\\x.pdf" && readKey("relative/x") === null && readKey("C:\\a\\..\\x") === null
    && readKey("\\\\server\\share\\x") === null && readKey("//server/x") === null && readKey("/a/./b") === null && readKey("/a//b") === null && readKey("~/x") === null && readKey("/a/b\\c") === null,
  "readKey: plain absolute paths only (no relative, .., ., empty segment, UNC, ~); Windows folds / and case");
}

// --- Telegram API stub (with getFile and file downloads) --------------------------------------------
const calls = [];
let updates = [], nextUpdateId = 1, mid = 100, nextTopic = 900;
const files = new Map(); // file_id -> {file_path, bytes, size?, mode?: "500"|"cut"|"slow"|"huge"|"getfail"}
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "GET" && u.pathname.startsWith("/file/")) {
    calls.push({ method: "download", b: { path: u.pathname } });
    const wantPrefix = `/file/bot${TOKEN}/`;
    const f = [...files.values()].find((x) => u.pathname === wantPrefix + x.file_path);
    if (!f) { res.writeHead(404); return res.end("no"); }
    if (f.mode === "500") { res.writeHead(500); return res.end("boom"); }
    if (f.mode === "short") { res.writeHead(200); res.write(f.bytes.subarray(0, Math.floor(f.bytes.length / 2))); return res.end(); } // chunked, ends early, cleanly
    if (f.mode === "cut") { res.writeHead(200, { "content-length": String(f.bytes.length) }); res.write(f.bytes.subarray(0, 10)); return setTimeout(() => res.destroy(), 50); }
    if (f.mode === "huge") {
      res.writeHead(200); // chunked, no length: the relay has to count
      const chunk = Buffer.alloc(1024 * 1024, 7); let n = 0;
      const pump = () => { while (n < 22) { n++; if (!res.write(chunk)) return res.once("drain", pump); } res.end(); };
      res.on("error", () => {}); return pump();
    }
    const send = () => { res.writeHead(200, { "content-length": String(f.bytes.length) }); res.end(f.bytes); };
    return f.mode === "slow" ? setTimeout(send, 2000) : f.mode === "slower" ? setTimeout(send, 2500) : send();
  }
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    const method = u.pathname.split("/").pop();
    if (method === "getUpdates") { const deliver = () => { const out = updates; updates = []; json({ ok: true, result: out }); }; return updates.length ? deliver() : setTimeout(deliver, 100); }
    calls.push({ method, b, at: Date.now() });
    if (method === "sendMessage") { b._id = ++mid; return json({ ok: true, result: { message_id: b._id } }); }
    if (method === "getMe") return json({ ok: true, result: { id: 1, is_bot: true, username: "MynaTestBot", has_topics_enabled: true } });
    if (method === "createForumTopic") return json({ ok: true, result: { message_thread_id: ++nextTopic, name: b.name } });
    if (method === "getFile") {
      const f = files.get(b.file_id);
      if (!f || f.mode === "getfail") return json({ ok: false, error_code: 400, description: "Bad Request: file is too big" });
      return json({ ok: true, result: { file_id: b.file_id, file_unique_id: `u${b.file_id}`, file_path: f.file_path, ...(f.size !== undefined ? { file_size: f.size } : {}) } });
    }
    json({ ok: true, result: true });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const of = (method) => calls.filter((c) => c.method === method).map((c) => c.b);
const repliesTo = (id) => of("sendMessage").filter((b) => b.reply_parameters?.message_id === id);

// --- real relay ----------------------------------------------------------------------------------
const PORT = 20000 + Math.floor(Math.random() * 20000);
const RELAY = `http://127.0.0.1:${PORT}`;
const SECRET_FILE = path.join(tmp, "relay-secret");
const LOG = path.join(tmp, "relay.log");
const KEEP = path.join(tmp, "inbox-keep");
const CHAT_FILE = path.join(tmp, "chat-sessions.json");
let relay;
async function stopRelay() { relay.kill(); await new Promise((r) => relay.once("exit", r)); }
async function startRelay() {
  const out = fs.openSync(LOG, "a");
  relay = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env, MYNA_ENV: path.join(tmp, "no-such-env"), MYNA_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${stub.address().port}`,
      RELAY_PORT: String(PORT), TELEGRAM_TOPIC_ROUND_GRACE: "0", MYNA_CHAT_PROGRESS_MS: "200", MYNA_FILE_TIMEOUT_MS: "3000",
      MYNA_TOPICS_FILE: path.join(tmp, "topics.json"), MYNA_PENDING_FILE: path.join(tmp, "pending.json"), MYNA_TELEGRAM_CHAT_FILE: path.join(tmp, "chat.json"),
      MYNA_RELAY_SECRET_FILE: SECRET_FILE, MYNA_CHAT_FILE: CHAT_FILE, MYNA_CHAT_TOPICS_FILE: path.join(tmp, "chat-topics.json"),
      MYNA_PROGRESS_FILE: path.join(tmp, "chat-progress"), MYNA_INBOX_KEEP_FILE: KEEP,
    },
    stdio: ["ignore", out, out],
  });
  for (let i = 0; ; i++) {
    try { await fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(500) }); break; }
    catch { if (i > 50) { console.error("❌ relay never came up"); process.exit(1); } await sleep(100); }
  }
}
await startRelay();
const api = async (p, body, auth) => {
  const r = await fetch(`${RELAY}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const SECRET = () => fs.readFileSync(SECRET_FILE, "utf8").trim();
const push = (m) => { const id = ++mid; updates.push({ update_id: nextUpdateId++, message: { message_id: id, chat: { id: 42, type: "private" }, from: { id: 7, first_name: "Alice" }, ...m } }); return id; };
let fseq = 0;
const addFile = (bytes, extra = {}) => { const id = `F${++fseq}`; files.set(id, { file_path: `documents/file_${fseq}.bin`, bytes, size: bytes.length, ...extra }); return id; };
const sendDoc = ({ thread, caption, name, mime = "application/pdf", bytes = crypto.randomBytes(2000), extra = {}, group, replyTo, declared } = {}) => {
  const file_id = addFile(bytes, extra);
  const doc = { file_id, file_unique_id: `u${file_id}`, ...(name !== undefined ? { file_name: name } : {}), mime_type: mime, ...(declared !== undefined ? { file_size: declared } : extra.size !== undefined ? (extra.size === null ? {} : { file_size: extra.size }) : { file_size: bytes.length }) };
  const id = push({ document: doc, ...(caption !== undefined ? { caption } : {}), ...(thread ? { message_thread_id: thread } : {}), ...(group ? { media_group_id: group } : {}), ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) });
  return { id, file_id, bytes };
};
const takeAll = async (token, n = 1, ms = 6000) => {
  const got = [];
  await until(async () => { const t = await api("/chat/take", { max: 20 }, token); got.push(...(t.messages || [])); return got.length >= n; }, ms);
  return got;
};

const A = await api("/chat/register", { session_id: "s-a", nick: "egret", label: "app" }, SECRET());
const tA = A.topic;
const sdirA = inbox.sessionDir(tmp, "s-a");

// 1) a document in the session's topic → saved; the session gets the local path, the untrusted line, the caption
let firstPath;
{
  const d = sendDoc({ thread: tA, caption: "看這份報告", name: "report.pdf" });
  const [m] = await takeAll(A.token);
  firstPath = m?.file_path;
  ok(m && m.text.startsWith(inbox.UNTRUSTED) && m.text.includes(m.file_path) && m.text.endsWith("看這份報告") && m.text.includes("原檔名：report.pdf"),
    `document in the topic → text = untrusted line + local path + caption:\n${m?.text}`);
  ok(m?.file_path && path.isAbsolute(m.file_path) && path.dirname(m.file_path) === fs.realpathSync.native(sdirA) && fs.readFileSync(m.file_path).equals(d.bytes),
    `…the file is in this session's inbox folder, byte for byte (${m?.file_path})`);
  if (!WIN) ok((fs.statSync(m.file_path).mode & 0o777) === 0o600 && (fs.statSync(sdirA).mode & 0o777) === 0o700, "…file 0600, folder 0700");
  ok(!fs.readdirSync(sdirA).some((f) => f.endsWith(".part")), "…no .part left behind");
}

// 2) a photo: the biggest size, whatever the order
{
  const small = addFile(crypto.randomBytes(100)), big = addFile(crypto.randomBytes(5000)), mid2 = addFile(crypto.randomBytes(900));
  push({ message_thread_id: tA, photo: [
    { file_id: mid2, file_unique_id: "p2", width: 320, height: 240, file_size: 900 },
    { file_id: big, file_unique_id: "p3", width: 1280, height: 960, file_size: 5000 },
    { file_id: small, file_unique_id: "p1", width: 90, height: 60, file_size: 100 },
  ] });
  const [m] = await takeAll(A.token);
  ok(m?.file_path?.endsWith(".jpg") && fs.readFileSync(m.file_path).equals(files.get(big).bytes) && m.text.includes("原檔名：photo.jpg"), `photo → the biggest size saved as .jpg (${m?.file_path})`);
}

// 3) an album: several messages, one media_group_id → each saved, taken together
{
  for (let i = 0; i < 3; i++) sendDoc({ thread: tA, name: `a${i}.txt`, mime: "text/plain", group: "g1", ...(i === 0 ? { caption: "三個檔" } : {}) });
  await until(async () => (JSON.parse(fs.readFileSync(CHAT_FILE, "utf8")).sessions["s-a"].inbox || []).length >= 3, 6000);
  const t = await api("/chat/take", { max: 20 }, A.token);
  ok(t.messages?.length === 3 && t.messages.every((m) => m.file_path && fs.existsSync(m.file_path)), `album of 3 → 3 messages in one take, each with its file (${t.messages?.length})`);
}

// 4) the sender's file name never becomes a path
{
  const names = ["../../evil.txt", "..\\..\\evil.txt", "a\u202eexe.txt", "CON.txt", `${"長".repeat(200)}.txt`, "a.<script>", undefined];
  for (const n of names) sendDoc({ thread: tA, name: n, mime: "text/plain" });
  const got = await takeAll(A.token, names.length);
  const real = fs.realpathSync.native(sdirA);
  ok(got.length === names.length && got.every((m) => m.file_path && path.dirname(m.file_path) === real && /^\d{8}-\d{6}-[a-f0-9]{16}\.[a-z0-9]{1,8}$/.test(path.basename(m.file_path))),
    `hostile names → every file is <time>-<fid>.<ext> in the session folder:\n  ${got.map((m) => path.basename(m.file_path || "?")).join("\n  ")}`);
  ok(!got.some((m) => m.text.includes("\u202e")) && got.every((m) => !/evil\.txt\)/.test(path.basename(m.file_path || ""))), "…the shown names carry no invisible characters");
  ok(!fs.existsSync(path.join(tmp, "evil.txt")) && !fs.existsSync(path.join(path.dirname(tmp), "evil.txt")), "…nothing written outside the inbox");
}

// 5) over 20 MB: declared → no getFile; undeclared and streamed → stopped, nothing left
{
  const before = of("getFile").length;
  const d = sendDoc({ thread: tA, name: "big.zip", declared: 25 * 1024 * 1024 });
  await until(() => repliesTo(d.id).length);
  ok(/超過 20 MB/.test(repliesTo(d.id)[0]?.text || "") && of("getFile").length === before, `declared 25 MB → "${repliesTo(d.id)[0]?.text}", getFile never called`);
  const h = sendDoc({ thread: tA, name: "huge.bin", bytes: Buffer.alloc(10), extra: { mode: "huge", size: null } });
  await until(() => repliesTo(h.id).length, 15000);
  ok(/超過 20 MB/.test(repliesTo(h.id)[0]?.text || "") && !fs.readdirSync(sdirA).some((f) => f.endsWith(".part")), `no size given, 22 MB streamed → "${repliesTo(h.id)[0]?.text}", no file left`);
  const t = await api("/chat/take", { max: 20 }, A.token);
  ok(!t.messages?.length, "…and nothing was handed to the session");
}

// 6) who gets it: no chat session → told; "@nick" caption in the main chat → that session; "!cmd" caption is text
{
  const n = sendDoc({ name: "x.pdf" });
  await until(() => repliesTo(n.id).length);
  ok(/只能傳給開了聊天/.test(repliesTo(n.id)[0]?.text || ""), `main chat, no @nick → "${repliesTo(n.id)[0]?.text}"`);
  sendDoc({ name: "y.pdf", caption: "@egret 這個給你" });
  const [m] = await takeAll(A.token);
  ok(m?.file_path && m.text.endsWith("這個給你"), `caption "@egret 這個給你" in the main chat → egret, words after the nick (${JSON.stringify(m?.text?.split("\n").pop())})`);
  sendDoc({ thread: tA, name: "z.pdf", caption: "!usage" });
  const [c] = await takeAll(A.token);
  ok(c?.text.startsWith("📎") && c.text.endsWith("!usage"), "caption \"!usage\" → the message starts with the file line, so it is text, not a command");
}

// 7) unsupported types → told to send it as a file
{
  const ids = [push({ message_thread_id: tA, video: { file_id: "V1", file_unique_id: "v" } }), push({ message_thread_id: tA, voice: { file_id: "V2", file_unique_id: "w" } }), push({ message_thread_id: tA, sticker: { file_id: "V3", file_unique_id: "s" } })];
  await until(() => ids.every((id) => repliesTo(id).length));
  ok(ids.every((id) => /改用「檔案」傳送/.test(repliesTo(id)[0]?.text || "")), "video / voice / sticker → \"請改用「檔案」傳送\"");
}

// 8) a failed download: a fixed reason; the token nowhere
{
  const a = sendDoc({ thread: tA, name: "f1.pdf", extra: { mode: "500" } });
  const b = sendDoc({ thread: tA, name: "f2.pdf", extra: { mode: "cut" } });
  await until(() => repliesTo(a.id).length && repliesTo(b.id).length, 8000);
  const ra = repliesTo(a.id)[0]?.text || "", rb = repliesTo(b.id)[0]?.text || "";
  const fixed = /\((Telegram 拒絕|逾時|連不上 Telegram|超過 20 MB|寫檔失敗)\)/;
  ok(fixed.test(ra) && fixed.test(rb), `download 500 → "${ra}"; cut mid-way → "${rb}"`);
  const c = sendDoc({ thread: tA, name: "short.pdf", extra: { mode: "short" } });
  await until(() => repliesTo(c.id).length, 8000);
  ok(fixed.test(repliesTo(c.id)[0]?.text || "") && !fs.readdirSync(sdirA).some((f) => f.endsWith(".part")), `a body that ends early without a length → "${repliesTo(c.id)[0]?.text}", nothing kept`);
  const t = await api("/chat/take", { max: 20 }, A.token);
  ok(!t.messages?.some((m) => /short\.pdf|f1\.pdf|f2\.pdf/.test(m.text)), "…none of the failed files reached the session");
}

// 8b) the relay stops while a file is downloading → picked up again at start, delivered once
{
  const d = sendDoc({ thread: tA, name: "restart.pdf", extra: { mode: "slower" } });
  await until(() => of("download").some((x) => x.path.includes(files.get(d.file_id).file_path)), 5000);
  await stopRelay();
  ok(fs.existsSync(path.join(tmp, "inbox-pending.json")) && JSON.parse(fs.readFileSync(path.join(tmp, "inbox-pending.json"), "utf8")).some((x) => x.msg?.message_id === d.id), "a file message being downloaded is journaled (inbox-pending.json)");
  await startRelay();
  const A2 = await api("/chat/register", { session_id: "s-a", nick: "egret", label: "app" }, SECRET());
  A.token = A2.token;
  const got = await takeAll(A.token, 1, 10000);
  await sleep(800);
  const more = await api("/chat/take", { max: 20 }, A.token);
  ok(got.filter((m) => m.text.includes("restart.pdf")).length === 1 && !more.messages?.length && got[0]?.file_path && fs.readFileSync(got[0].file_path).equals(d.bytes), "…the relay restarted mid-download delivers it once, whole");
  ok(JSON.parse(fs.readFileSync(path.join(tmp, "inbox-pending.json"), "utf8")).length === 0, "…and the journal is empty again");
}

// 9) retention: /myna:files keep, pruned before the next file; a pruned file shows as unavailable
{
  const run = (...args) => spawnSync(process.execPath, [filesScript, ...args], { encoding: "utf8", env: { ...process.env, MYNA_ENV: path.join(tmp, "no-such-env"), MYNA_INBOX_KEEP_FILE: KEEP } });
  const st = run();
  ok(st.status === 0 && /7 天/.test(st.stdout) && !fs.existsSync(KEEP), `/myna:files (status) → default 7 days, writes nothing:\n${st.stdout.trim()}`);
  const bad = [run("keep", "0"), run("keep", "91"), run("keep", "abc")];
  ok(bad.every((r) => r.status === 1) && !fs.existsSync(KEEP), "keep 0 / 91 / abc → refused, nothing written");
  const k3 = run("keep", "3");
  ok(k3.status === 0 && /^days=3\n/.test(fs.readFileSync(KEEP, "utf8")), `keep 3 → ${JSON.stringify(fs.readFileSync(KEEP, "utf8").split("\n")[0])}`);
  fs.writeFileSync(KEEP, "days=999\n");
  ok(inbox.readKeep(KEEP).days === 7 && inbox.readKeep(KEEP).bad && /讀不懂/.test(run().stdout), "an unreadable setting counts as the default 7 days, and status says so");
  ok(run("keep", "default").status === 0 && !fs.existsSync(KEEP), "keep default → the file is removed");
  fs.mkdirSync(KEEP); // something that cannot be removed like a file
  const stuck = run("keep", "default");
  ok(stuck.status === 1 && fs.existsSync(KEEP) && /刪不掉/.test(stuck.stderr), `keep default when the setting cannot be removed → exit 1, says so (${stuck.stderr.trim()})`);
  fs.rmSync(KEEP, { recursive: true, force: true });
  // a delivered message whose file is pruned before it is taken → "unavailable", no file_path
  sendDoc({ thread: tA, name: "late.pdf" });
  await until(async () => (JSON.parse(fs.readFileSync(CHAT_FILE, "utf8")).sessions["s-a"].inbox || []).some((m) => m.file?.name === "late.pdf"), 6000);
  const queued = JSON.parse(fs.readFileSync(CHAT_FILE, "utf8")).sessions["s-a"].inbox.find((m) => m.file?.name === "late.pdf");
  const old8 = path.join(sdirA, "old8.bin"), old2 = path.join(sdirA, "old2.bin");
  fs.writeFileSync(old8, "x"); fs.writeFileSync(old2, "x");
  const ago = (d) => (Date.now() - d * 86400000) / 1000;
  fs.utimesSync(old8, ago(8), ago(8)); fs.utimesSync(old2, ago(2), ago(2)); fs.utimesSync(queued.file.path, ago(8), ago(8));
  sendDoc({ thread: tA, name: "new.pdf" });
  // the new file is saved (and the prune done) before anything is taken
  await until(async () => (JSON.parse(fs.readFileSync(CHAT_FILE, "utf8")).sessions["s-a"].inbox || []).some((m) => m.file?.name === "new.pdf"), 6000);
  const got = await takeAll(A.token, 2);
  const late = got.find((m) => m.text.includes("late.pdf")), fresh = got.find((m) => m.text.includes("new.pdf"));
  ok(!fs.existsSync(old8) && fs.existsSync(old2) && fresh?.file_path && fs.existsSync(fresh.file_path), "a new file prunes what came > 7 days ago, keeps the 2-day-old one");
  ok(late && !late.file_path && late.text.includes(inbox.UNAVAILABLE), `…a queued message whose file was pruned → "${late?.text.split("\n")[1]}", no file_path`);
  fs.writeFileSync(KEEP, "days=1\n");
  sendDoc({ thread: tA, name: "after-keep1.pdf" });
  await takeAll(A.token);
  ok(!fs.existsSync(old2), "keep 1 → the 2-day-old file goes at the next file");
  fs.rmSync(KEEP, { force: true });
}

// 10) a slow download holds up no text
{
  sendDoc({ thread: tA, name: "slow.pdf", extra: { mode: "slow" } });
  await sleep(200);
  const t0 = Date.now();
  push({ message_thread_id: tA, text: "還在嗎" });
  const [m] = await takeAll(A.token, 1, 3000);
  ok(m?.text === "還在嗎" && Date.now() - t0 < 2000, `text sent during a 2 s download reaches the session in ${Date.now() - t0} ms`);
  const [s] = await takeAll(A.token, 1, 8000);
  ok(s?.file_path, "…the slow file arrives after");
}

// 11) a closed session: told, nothing delivered
{
  const C = await api("/chat/register", { session_id: "s-c", nick: "crane" }, SECRET());
  await api("/chat/close", {}, C.token);
  const d = sendDoc({ thread: C.topic, name: "c.pdf" });
  await until(() => repliesTo(d.id).length);
  ok(/已經結束/.test(repliesTo(d.id)[0]?.text || ""), `a closed session's topic → "${repliesTo(d.id)[0]?.text}"`);
}

// 12) the chat mod: Read of a delivered file → no prompt; everything else as Claude Code decided
{
  const hooks = [];
  register((event, a, b) => { const [match, hook] = b ? [a, b] : [null, a]; hooks.push({ event, match, hook }); return { catch() { return this; } }; });
  let settings = {};
  const S = { sid: "s-m", submits: [], timers: new Set() };
  const $ = {
    http: { fetch: async (url, init = {}) => { const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body }); return { status: r.status, ok: r.ok, headers: {}, text: await r.text() }; } },
    fs: {
      read: async (p) => fs.readFileSync(p, "utf8"),
      // like the engine: lstat (isLink), realPath with { resolve: true }
      stat: async (p, o = {}) => { const s = fs.lstatSync(p); return { kind: s.isFile() ? "file" : s.isDirectory() ? "dir" : "other", size: s.size, mtimeMs: s.mtimeMs, isLink: s.isSymbolicLink(), ...(o.resolve ? { realPath: fs.realpathSync.native(p) } : {}) }; },
    },
    settings: { read: async () => settings },
    session: { id: async () => S.sid, root: async () => "/work/app", cwd: async () => "/work/app" },
    ui: { status: () => {} },
    prompt: { submit: async ({ text }) => { S.submits.push(text); return { text }; } },
    command: { list: async () => [], run: async () => ({}) },
    clock: { every: (ms, fn) => { const h = setInterval(fn, 100); S.timers.add(h); return { cancel: () => { clearInterval(h); S.timers.delete(h); } }; } },
    store: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    env: { get: async (n) => ({ HOME: tmp, MYNA_ENV: path.join(tmp, "no-such-env"), RELAY_PORT: String(PORT), MYNA_RELAY_SECRET_FILE: SECRET_FILE, MYNA_CHAT: "on" })[n] },
  };
  const fire = async (event, e, result = e) => {
    for (const h of hooks.filter((x) => x.event === event && (!x.match || Object.entries(x.match).every(([k, v]) => e[k] === v)))) return h.hook($, e, async () => result);
    return result;
  };
  await fire("session.start", { cwd: "/work/app", surface: "terminal", isInteractive: true });
  const reg = await until(async () => { const j = await (await fetch(`${RELAY}/chat/session?session_id=s-m`)).json(); return j.chat && j; });
  const topicM = await until(() => of("createForumTopic").find((t) => t.name.includes(reg.nick)) && nextTopic);
  const d = sendDoc({ thread: topicM, name: "mod.pdf", caption: "讀這個" });
  await until(() => S.submits.some((t) => t.includes("mod.pdf")), 8000);
  const p = /- (\S.*?)(?:（|$)/m.exec(S.submits.find((t) => t.includes("mod.pdf")) || "")?.[1];
  ok(p && fs.readFileSync(p).equals(d.bytes), `the mod submitted the prompt with the local path (${p})`);
  const check = (file_path, decision = "ask", extra = {}) => fire("tool.check", { tool: "Read", input: { file_path }, ...extra }, { decision });
  ok((await check(p)).decision === "allow", "Read of the delivered file + Claude Code would ask → allow");
  ok((await check(p, "deny")).decision === "deny" && (await check(p, "allow")).decision === "allow", "…a deny stays a deny, an allow stays an allow");
  if (WIN) ok((await check(p.replace(/\\/g, "/").toUpperCase())).decision === "allow", "…the same path with / and other case (Windows) → allow");
  else ok((await check(p.toUpperCase())).decision === "ask", "…another case on a case-sensitive OS → ask");
  const other = path.join(path.dirname(p), "other.pdf"); fs.writeFileSync(other, "x");
  ok((await check(other)).decision === "ask", "another file in the same folder → ask");
  const dotdot = path.join(path.dirname(p), "..", path.basename(path.dirname(p)), path.basename(p)).replace(/[\\/][^\\/]+[\\/]\.\.[\\/]/, (m) => m) ;
  const viaDots = `${path.dirname(p)}${path.sep}..${path.sep}${path.basename(path.dirname(p))}${path.sep}${path.basename(p)}`;
  ok((await check(viaDots)).decision === "ask", `the same file through ".." → ask (${dotdot ? "checked" : ""})`);
  ok((await check(path.basename(p))).decision === "ask" && (await check(`\\\\localhost\\c$\\${path.basename(p)}`)).decision === "ask", "relative path / UNC → ask");
  ok((await check(p, "ask", { agentId: "sub1" })).decision === "ask", "a subagent's Read → ask");
  settings = { permissions: { blockReadsOutsideWorkingDirectories: true } };
  ok((await check(p)).decision === "ask", "blockReadsOutsideWorkingDirectories on → ask");
  settings = {};
  ok((await fire("tool.check", { tool: "Edit", input: { file_path: p } }, { decision: "ask" })).decision === "ask", "Edit of that file → untouched (ask)");
  // the delivered file swapped for a link → ask (needs symlink rights on Windows; skipped when refused)
  const keep = fs.readFileSync(p); fs.rmSync(p);
  let linked = false; try { fs.symlinkSync(other, p); linked = true; } catch {}
  if (linked) ok((await check(p)).decision === "ask", "the delivered file replaced by a link → ask");
  else console.log("⏭ symlink test skipped (no symlink rights here)");
  try { fs.rmSync(p); } catch {} fs.writeFileSync(p, keep);
  ok((await check(p)).decision === "allow", "…restored → allow again");
  fs.rmSync(p); fs.mkdirSync(p);
  ok((await check(p)).decision === "ask", "the delivered path replaced by a folder → ask");
  fs.rmSync(p, { recursive: true }); fs.writeFileSync(p, keep);
  // another session in the same process (/clear, /resume): what the old one was handed is not its
  S.sid = "s-m2";
  await fire("session.end", { reason: "clear", sessionId: "s-m" });
  await fire("session.start", { cwd: "/work/app", surface: "terminal", isInteractive: true });
  ok((await check(p)).decision === "ask", "after a switch to another session → the old session's file is ask again");
  await fire("session.end", { reason: "prompt_input_exit", sessionId: "s-m" });
  for (const h of S.timers) clearInterval(h);
}

// 13) the token: in no log line, reply, chat record, take or inbox file
{
  await sleep(300);
  const logText = fs.readFileSync(LOG, "utf8");
  const replies = of("sendMessage").map((b) => b.text || "").join("\n");
  const record = fs.readFileSync(CHAT_FILE, "utf8");
  let inInbox = false;
  for (const d of fs.readdirSync(inbox.inboxDir(tmp))) for (const f of fs.readdirSync(path.join(inbox.inboxDir(tmp), d))) {
    if (f.includes("TESTTOKEN")) inInbox = true;
    try { if (fs.readFileSync(path.join(inbox.inboxDir(tmp), d, f), "latin1").includes("TESTTOKEN")) inInbox = true; } catch {}
  }
  ok(!logText.includes("TESTTOKEN") && !replies.includes("TESTTOKEN") && !record.includes("TESTTOKEN") && !inInbox, "the bot token is in no relay log line, reply, chat record or inbox file");
  ok(/was not saved/.test(logText), "…while the failed downloads were logged");
}

relay.kill(); await new Promise((r) => relay.once("exit", r)); stub.close(); clearTimeout(watchdog);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ all file checks passed");
process.exit(failed ? 1 : 0);
