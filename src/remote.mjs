// Multi-machine pieces shared by the relay (src/relay.mjs, hub or edge) and the local CLIs
// (scripts/machines.mjs, scripts/join.mjs). See SPEC §5.1 for the protocol.
//
// Roles: the HUB listens on 127.0.0.1:RELAY_PORT (local, unauthenticated as before) and — only when
// MYNA_REMOTE_PORT is set — on 127.0.0.1:<that> for other machines (every request carries a machine
// token; a tunnel such as cloudflared forwards public HTTPS to it). An EDGE relay (MYNA_ROLE=edge) runs
// on every other machine on 127.0.0.1:RELAY_PORT and forwards its local clients' questions to the hub;
// its own bot, if it has one (and it is not the hub's), takes new questions while the hub is away.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Remote protocol version. An integer, separate from the plugin version: it changes only when an
// existing endpoint, header or field changes incompatibly — new endpoints/fields do not bump it.
// The hub reports it on GET /health; an edge forwards only to a hub with the same protocol and sends
// its own in X-Myna-Protocol (a hub answers 426 to a protocol it does not speak).
export const PROTOCOL = 1;
export const PROTOCOL_HEADER = "x-myna-protocol";
export const ENROLL_SECRET_HEADER = "x-myna-enroll-secret";
export const REQUEST_ID_HEADER = "x-myna-request-id";
// the plugin version of the edge sending a request (0.21.0+; informational — /myna:machines lists it)
export const VERSION_HEADER = "x-myna-version";
// the hub's remote features (its remote /health `features`); "chat": an edge may forward /chat/* (SPEC §5.2);
// "notify" (0.25.0): an edge may forward God mode's POST /notify (only when the hub's provider has notices)
export const FEATURES = ["chat", "notify"];
export const CF_ID_HEADER = "CF-Access-Client-Id";
export const CF_SECRET_HEADER = "CF-Access-Client-Secret";

// a machine token: myna_m_<machine_id>_<32 random bytes, base64url>. The fixed prefix lets secret
// scanners recognise one; the id lets the hub find the record to compare the hash against.
export const TOKEN_PREFIX = "myna_m_";
const ID_RE = /^[a-f0-9]{12}$/;
export const newMachineId = () => crypto.randomBytes(6).toString("hex");
export const newMachineToken = (id) => `${TOKEN_PREFIX}${id}_${crypto.randomBytes(32).toString("base64url")}`;
export function parseMachineToken(t) {
  const s = String(t || "");
  if (!s.startsWith(TOKEN_PREFIX)) return null;
  const rest = s.slice(TOKEN_PREFIX.length), i = rest.indexOf("_");
  if (i < 0) return null;
  const id = rest.slice(0, i), secret = rest.slice(i + 1);
  if (!ID_RE.test(id) || secret.length < 32) return null;
  return { id };
}
export const sha256hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// constant-time compare of two hex digests (different lengths → false)
export function sameHex(a, b) {
  const x = Buffer.from(String(a || ""), "utf8"), y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
export const bearerOf = (req) => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "") || [])[1] || "";

// machine name: shown in topic names and logs. Short, lowercase, unique among active machines.
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
export const LOCAL_ID = "local";
// the 6-character confirmation code a joining machine shows in its terminal and the phone repeats
export const CODE_RE = /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/;
export function newJoinCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = crypto.randomBytes(6);
  const c = [...b].map((x) => abc[x % abc.length]).join("");
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

// config: ~/.myna/.env, overridden by process.env (same precedence as the relay always had)
export function loadEnv() {
  const ENV_PATH = process.env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env");
  const fileEnv = Object.fromEntries(
    (fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "")
      .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
  return { ...fileEnv, ...process.env, MYNA_ENV: ENV_PATH };
}
export const mynaDir = (cfg) => path.dirname(cfg.MYNA_ENV || path.join(os.homedir(), ".myna", ".env"));
export const roleOf = (cfg) => String(cfg.MYNA_ROLE || "hub").trim().toLowerCase();
export const machinesFile = (cfg) => cfg.MYNA_MACHINES_FILE || path.join(mynaDir(cfg), "machines.json");
export const seenFile = (cfg) => path.join(path.dirname(machinesFile(cfg)), "machines-seen.json");
export const tokenFile = (cfg) => cfg.MYNA_MACHINE_TOKEN_FILE || path.join(mynaDir(cfg), "machine-token");

// --- holding questions while the hub is away (an edge; SPEC §5.2, /myna:hold) ------------------------
// ~/.myna/upstream-hold: line 1 "on" | "off", then optionally "max=<seconds>", last line when it was
// changed. No file = on, max 1 day. MYNA_UPSTREAM_HOLD (on|off) and MYNA_UPSTREAM_HOLD_MAX (seconds),
// from the environment or ~/.myna/.env, win over the file. Read whenever it is needed — no restart.
export const HOLD_MAX_DEFAULT_S = 86400;
export const HOLD_MAX_MIN_S = 600, HOLD_MAX_MAX_S = 7 * 86400; // what /myna:hold max accepts
export const holdFile = (cfg) => cfg.MYNA_UPSTREAM_HOLD_FILE || path.join(mynaDir(cfg), "upstream-hold");
// → {on?, max_s?, bad?} (bad: why the file could not be read; it then counts as the default)
export function readHoldFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return e.code === "ENOENT" ? {} : { bad: e.message }; }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = (lines[0] || "").toLowerCase();
  if (first !== "on" && first !== "off") return { bad: `first line is "${lines[0] ?? ""}", not on / off` };
  const out = { on: first === "on" };
  for (const l of lines.slice(1)) {
    const m = /^max=(\d+)$/.exec(l);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 60) out.max_s = n; else return { bad: `max=${m[1]} is under 60 seconds` };
  }
  return out;
}
// the setting in force → {on, max_s, source: "default" | "file" | "env", bad?, env: {hold?, max?}}
export function holdSettings(cfg, { file = holdFile(cfg) } = {}) {
  const f = readHoldFile(file);
  const envHold = String(cfg.MYNA_UPSTREAM_HOLD ?? "").trim().toLowerCase();
  const envMax = String(cfg.MYNA_UPSTREAM_HOLD_MAX ?? "").trim();
  const env = {};
  if (envHold === "on" || envHold === "off") env.hold = envHold;
  if (/^\d+$/.test(envMax) && Number(envMax) >= 60) env.max = Number(envMax);
  const on = env.hold ? env.hold === "on" : f.bad ? true : f.on ?? true;
  const max_s = env.max ?? (f.bad ? undefined : f.max_s) ?? HOLD_MAX_DEFAULT_S;
  const source = env.hold || env.max ? "env" : !f.bad && (f.on !== undefined || f.max_s !== undefined) ? "file" : "default";
  return { on, max_s, source, ...(f.bad ? { bad: f.bad } : {}), env };
}
// Which bot a relay polls, without revealing its token: Telegram "telegram:<getMe id>" (the token's
// part before ":"), Discord "discord:<bot user id>" (the token's first segment, base64), Slack
// "slack:<first 16 hex of the bot token's SHA-256>" (Slack tokens carry no id). An edge compares the
// hub's with its own: the same bot polled twice fights (Telegram 409; Discord/Slack events twice).
export function botIdentity(name, cfg) {
  if (name === "telegram") { const id = String(cfg.TELEGRAM_BOT_TOKEN || "").trim().split(":")[0]; return /^\d+$/.test(id) ? `telegram:${id}` : null; }
  if (name === "discord") {
    try { const id = Buffer.from(String(cfg.DISCORD_BOT_TOKEN || "").trim().split(".")[0], "base64").toString("utf8"); return /^\d+$/.test(id) ? `discord:${id}` : null; } catch { return null; }
  }
  if (name === "slack") { const t = String(cfg.SLACK_BOT_TOKEN || "").trim(); return t ? `slack:${sha256hex(t).slice(0, 16)}` : null; }
  return null;
}
// Cloudflare Access service-token headers for requests to the hub (both keys or neither)
export function cfHeaders(cfg) {
  const id = String(cfg.MYNA_CF_ACCESS_CLIENT_ID || "").trim(), secret = String(cfg.MYNA_CF_ACCESS_CLIENT_SECRET || "").trim();
  return id && secret ? { [CF_ID_HEADER]: id, [CF_SECRET_HEADER]: secret } : {};
}
// the hub URL an edge talks to: https, or plain http only to a loopback host (tests, a local tunnel)
export function upstreamUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return { error: `MYNA_UPSTREAM="${raw ?? ""}" is not a URL` }; }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) return { error: `MYNA_UPSTREAM must be https:// (plain http only to 127.0.0.1/localhost) — got ${u.protocol}//${u.host}` };
  if (u.username || u.password) return { error: "MYNA_UPSTREAM must not carry credentials" };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

// write a file only this user can read (0600; on Windows the user profile's ACL protects it)
export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, text, { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch {} }
  try { fs.chmodSync(file, 0o600); } catch {}
}

// --- machines.json (hub) ---------------------------------------------------------------------------
// {version:1, machines:[{id, name, sha256, os, hostname, created_at, revoked_at?}]} — token HASHES only;
// the token itself is shown once, to the machine that joined. The hub re-reads the file whenever it
// changed on disk, so `machines.mjs revoke` takes effect on the very next request without a restart.
// last_seen_at / last_addr live in machines-seen.json, written by the hub alone (machines.json is
// written by the hub only when a machine joins, and by machines.mjs — never both on a timer).
// Those two writers are two processes: every read-modify-write holds <file>.lock (see withFileLock), so
// neither writes back a stale copy over the other's change (a join lost, or a revoked machine revived).
// A file that cannot be parsed (half-written by the plain-write fallback of writePrivate, or edited by
// hand) is never taken for "no machines": a look keeps the last good list, a write refuses.
// onLoad: called once, after the first successful read (a file unreadable at start is read later).
export function machineStore(file, { onRevoked, onError, onLoad } = {}) {
  let sig = null, list = [], first = true;
  // [] only when there is no file at all; anything else unreadable throws
  const read = () => {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
    const j = JSON.parse(text);
    if (!Array.isArray(j?.machines)) throw new Error("no machines array");
    return j.machines;
  };
  const stat = () => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return "none"; } };
  // returns the ids that turned revoked (or disappeared) since the last look
  function refresh() {
    const s = stat();
    if (s === sig) return [];
    let next;
    try { next = read(); }
    catch (e) { if (onError) { try { onError(`${file} unreadable (${e.message}) — keeping the last good list`); } catch {} } return []; } // sig unchanged: look again next time
    const before = new Set(list.filter((m) => !m.revoked_at).map((m) => m.id));
    sig = s; list = next;
    const now = new Set(list.filter((m) => !m.revoked_at).map((m) => m.id));
    const gone = first ? [] : [...before].filter((id) => !now.has(id));
    const wasFirst = first;
    first = false;
    if (wasFirst && onLoad) { try { onLoad(list); } catch {} }
    if (gone.length && onRevoked) { try { onRevoked(gone); } catch {} }
    return gone;
  }
  refresh();
  const save = (machines) => { writePrivate(file, JSON.stringify({ version: 1, machines }, null, 2) + "\n"); sig = null; refresh(); };
  const update = (fn) => withFileLock(file, () => { let cur; try { cur = read(); } catch (e) { throw new Error(`${file} is unreadable (${e.message}) — fix or restore it first`); } return fn(cur); });
  return {
    file, refresh, loaded: () => !first,
    all: () => (refresh(), list),
    active: () => (refresh(), list.filter((m) => !m.revoked_at)),
    // the active machine a token belongs to, or null (unknown id, wrong secret, revoked)
    verify(token) {
      refresh();
      const p = parseMachineToken(token);
      if (!p) return null;
      const m = list.find((x) => x.id === p.id);
      if (!m || m.revoked_at || !sameHex(sha256hex(token), m.sha256)) return null;
      return m;
    },
    add(rec) { update((cur) => { cur.push(rec); save(cur); }); },
    revoke(key) {
      return update((cur) => {
        const now = new Date().toISOString(), hit = [];
        for (const m of cur) if (!m.revoked_at && (m.id === key || m.name === key)) { m.revoked_at = now; hit.push(m); }
        if (hit.length) save(cur);
        return hit;
      });
    },
  };
}

// Run fn while holding <file>.lock — an exclusive-create lock file shared by every process that writes
// `file`, holding "<pid> <random token>". Synchronous (the callers are), waits up to 10 s. A holder only
// ever removes a lock that still carries its own token. A lock is stale only when the process named in
// it is gone (a holder that died mid-write; a live holder is never taken over, however long it holds) —
// or, when no pid can be read from it, once it is older than 30 s. A stale lock is taken over by renaming
// it away (atomic: of two processes that both saw it stale only one gets it); the renamed file must be
// the very lock judged stale (same content), else it is someone's fresh lock and is put back — and if
// that fails it is left in place under its new name, never deleted.
const LOCK_WAIT_MS = 10000, LOCK_STALE_MS = 30000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
export function withFileLock(file, fn) {
  const lock = `${file}.lock`, until = Date.now() + LOCK_WAIT_MS, mine = `${process.pid} ${crypto.randomBytes(12).toString("hex")}\n`;
  const readLock = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
  const isStale = (content) => {
    const pid = Number(/^(\d+) /.exec(content || "")?.[1]);
    if (pid > 0) return !pidAlive(pid);
    try { return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { return false; }
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try { fs.writeFileSync(lock, mine, { flag: "wx", mode: 0o600 }); break; }
    catch (e) {
      // EPERM / EACCES: Windows while the previous holder's delete is still pending
      if (!["EEXIST", "EPERM", "EACCES"].includes(e.code)) throw e;
      const owner = readLock(lock);
      if (owner !== null && isStale(owner)) {
        const away = `${lock}.${crypto.randomBytes(6).toString("hex")}.stale`;
        let moved = false;
        try { fs.renameSync(lock, away); moved = true; } catch {}
        if (moved) {
          if (readLock(away) === owner) fs.rmSync(away, { force: true });
          else { try { fs.linkSync(away, lock); fs.rmSync(away, { force: true }); } catch {} } // someone's fresh lock: put it back
          continue;
        }
      }
      if (Date.now() > until) throw new Error(`${lock} is held by another process — try again`);
      sleepSync(15);
    }
  }
  try { return fn(); } finally { if (readLock(lock) === mine) { try { fs.rmSync(lock, { force: true }); } catch {} } }
}

// ~/.myna/.env read-modify-write, for every program that changes it (configure, hub, join, config): under
// <.env>.lock (withFileLock) the file is read again, fn(text) returns the new text (anything else: leave
// it as it is), and that is written to a temp file next to the file and renamed over it — two writers at
// once each keep the other's change. The rename is tried a few times (Windows: a scanner holding the file);
// only if it still fails is the file written in place, as these writers always did, and only then can a
// crash in the middle leave it partly written. The file's mode is kept; a new one is 0600 (it holds the bot
// tokens); a link keeps pointing where it did (its target is written; a target not there yet is created
// through the link, as a plain write would). fn may throw to refuse: nothing is written, the lock is
// released, the error goes to the caller. → what fn returned.
// The lock sits next to the file actually written: a link is resolved first, so one program going through
// the link and another through the real path take the same lock (a dangling link: next to the file it names,
// which a program writing that path directly locks too).
export function updateEnvFile(envPath, fn) {
  let lockOn = envPath;
  try {
    if (fs.lstatSync(envPath).isSymbolicLink()) {
      try { lockOn = fs.realpathSync(envPath); }
      catch { lockOn = path.resolve(path.dirname(envPath), fs.readlinkSync(envPath)); }
    }
  } catch {}
  return withFileLock(lockOn, () => {
    let text = "";
    try { text = fs.readFileSync(envPath, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const out = fn(text);
    if (typeof out !== "string") return out;
    let target = envPath, mode = 0o600, dangling = false;
    try { if (fs.lstatSync(envPath).isSymbolicLink()) { try { target = fs.realpathSync(envPath); } catch { dangling = true; } } } catch {}
    if (dangling) { fs.writeFileSync(envPath, out, { mode }); return out; }
    try { mode = fs.statSync(target).mode & 0o777; } catch {}
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, out, { mode });
      fs.chmodSync(tmp, mode); // the umask may have narrowed it
      for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, target); break; }
        catch (e) { if (i >= 4) { fs.writeFileSync(target, out); break; } sleepSync(50); }
      }
    } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
    return out;
  });
}

// --- request helpers -------------------------------------------------------------------------------
// read a request body, at most `max` bytes: past it → {tooLarge:true} at once — the rest is neither
// buffered nor waited for (a body that never ends must not hold the request); answer with refuseTooLarge
export function readBody(req, max) {
  return new Promise((resolve) => {
    let size = 0, chunks = [], done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > max) { chunks = []; finish({ tooLarge: true }); return; }
      chunks.push(c);
    });
    req.on("end", () => finish({ body: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => finish({ tooLarge: false, body: "", error: true }));
  });
}
// 413 for a body readBody gave up on, then close the connection: the rest of that body is discarded
// for at most 2 s, never read to its end
export function refuseTooLarge(req, res, error) {
  res.writeHead(413, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error }), () => {
    req.resume();
    setTimeout(() => req.socket.destroy(), 2000).unref();
  });
}
export const ASK_MAX_BYTES_DEFAULT = 256 * 1024;

// The local listener (127.0.0.1:RELAY_PORT) takes no credentials, so three cheap checks keep it from
// being reached by what is not a local client: a request a proxy forwarded (a tunnel pointed at the
// local port by mistake would otherwise open it to the network), a Host that is not loopback (DNS
// rebinding from a web page), and a browser request (it carries Origin). Returns why, or "".
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "cf-ray", "tailscale-user-login"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
// checkProxy: only where a tunnel runs next to the relay (multi-machine); checkOrigin: off for /chat/*
export function localRefusal(req, { checkOrigin = true, checkProxy = true } = {}) {
  const h = req.headers;
  const proxied = checkProxy && PROXY_HEADERS.find((k) => h[k] !== undefined);
  if (proxied) return `proxied request (${proxied}) — the local port is for this machine only; point a tunnel at MYNA_REMOTE_PORT`;
  if (h.host !== undefined) {
    let host = String(h.host).trim().toLowerCase();
    if (host.startsWith("[")) host = host.slice(0, host.indexOf("]") + 1);
    else host = host.replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(host)) return `Host "${h.host}" is not loopback`;
  }
  if (checkOrigin && h.origin !== undefined) return "browser request (Origin) refused";
  return "";
}
