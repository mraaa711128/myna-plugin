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
export function machineStore(file, { onRevoked } = {}) {
  let sig = null, list = [], first = true;
  const read = () => {
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(j?.machines) ? j.machines : []; }
    catch { return []; }
  };
  const stat = () => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return "none"; } };
  // returns the ids that turned revoked (or disappeared) since the last look
  function refresh() {
    const s = stat();
    if (s === sig) return [];
    const before = new Set(list.filter((m) => !m.revoked_at).map((m) => m.id));
    sig = s; list = read();
    const now = new Set(list.filter((m) => !m.revoked_at).map((m) => m.id));
    const gone = first ? [] : [...before].filter((id) => !now.has(id));
    first = false;
    if (gone.length && onRevoked) { try { onRevoked(gone); } catch {} }
    return gone;
  }
  refresh();
  const save = (machines) => { writePrivate(file, JSON.stringify({ version: 1, machines }, null, 2) + "\n"); sig = null; refresh(); };
  return {
    file, refresh,
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
    add(rec) { const cur = read(); cur.push(rec); save(cur); },
    revoke(key) {
      const cur = read(), now = new Date().toISOString(), hit = [];
      for (const m of cur) if (!m.revoked_at && (m.id === key || m.name === key)) { m.revoked_at = now; hit.push(m); }
      if (hit.length) save(cur);
      return hit;
    },
  };
}

// --- request helpers -------------------------------------------------------------------------------
// read a request body, at most `max` bytes: past it → {tooLarge:true} (the rest is not buffered)
export function readBody(req, max) {
  return new Promise((resolve) => {
    let size = 0, chunks = [], over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > max) { over = true; chunks = []; return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(over ? { tooLarge: true } : { body: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => resolve({ tooLarge: false, body: "", error: true }));
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
