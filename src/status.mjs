// /myna:status — a read-only overview of this machine's Myna: the relay, the Telegram chat and topics,
// every switch, the main settings, and what to do next. collect() gathers everything into a plain object
// (it prints nothing and writes nothing); scripts/status.mjs lays it out. /myna:config imports collect()
// and SWITCHES to show "what it is now" with the same reading before it writes.
//
// What it reads: ~/.myna/.env merged with this process's environment (the relay's own precedence), the
// switch files (each path and reading as in the program that actually reads it), the pairing record,
// telegram-topics.json, the last 256 KB of relay.log. Over the network: GET /health and GET /pair/status
// on the local relay, and — Telegram only — getMe, plus getChat / getChatMember when the paired chat is a
// group. One deadline for all of it (DEADLINE_MS); whatever has not answered by then is "逾時".
//
// Two columns for the relay's settings: what the relay actually uses (its own start line in relay.log,
// GET /pair/status) and what the config file / this session says. The relay reads .env once, at start,
// and the environment of the process that started it wins — the two can differ.
//
// Credentials: never printed. The 7 known credential keys only show "有設 / 沒設"; the environment section
// lists the values of ENV_KEYS only; and every string in the result is passed through a redactor built
// from the values of the credential keys and of any key whose NAME looks secret (SECRET_NAME_RE).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mynaDir, roleOf, holdSettings } from "./remote.mjs";
import { keepFile, readKeep } from "./inbox.mjs";
import { godmodeFile, godmodeSince, unsentSince, autopilotState } from "./godmode.mjs";

export const DEADLINE_MS = 6000;
export const LOG_TAIL_BYTES = 256 * 1024;

export const CREDENTIAL_KEYS = ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "MYNA_MACHINE_TOKEN", "MYNA_CF_ACCESS_CLIENT_ID", "MYNA_CF_ACCESS_CLIENT_SECRET"];
// the keys whose values the environment section shows — full names, no prefixes
export const ENV_KEYS = ["MYNA_PROVIDER", "MYNA_ROLE", "MYNA_REMOTE_PORT", "MYNA_MACHINE_NAME", "MYNA_TOPIC_MACHINE", "MYNA_UPSTREAM", "TELEGRAM_CHAT_ID", "TELEGRAM_TOPICS", "TELEGRAM_TOPIC_SCOPE", "TELEGRAM_TOPIC_ON_END", "TELEGRAM_TOPIC_ROUND_GRACE", "DISCORD_CHANNEL_ID", "SLACK_CHANNEL_ID", "RELAY_PORT", "MYNA_CHAT", "MYNA_CHAT_FORWARD", "MYNA_UPSTREAM_HOLD", "MYNA_UPSTREAM_HOLD_MAX", "MYNA_NET_ATTEMPT_MS", "MYNA_PERMISSION_DELAY", "MYNA_TRANSPORT", "MYNA_NODE_PORT", "MYNA_NODE_SERVE_PORT", "MYNA_PEER_SHOW_FIRST"];
export const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CLIENT_ID/i;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const pluginVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } };

// ~/.myna/.env as written (no environment merged) → {path, values, exists, mtime}
export function readEnvFile(envPath) {
  let text = "", st = null, error = null;
  try { st = fs.statSync(envPath); text = fs.readFileSync(envPath, "utf8"); } catch (e) { if (e.code !== "ENOENT") error = e.code || e.name; }
  const values = Object.fromEntries(text.split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  return { path: envPath, values, exists: !!st, mtime: st ? st.mtime.toISOString() : null, ...(error ? { error } : {}) };
}

// The redactor: every value of a credential key (any length), the secret half of a Telegram token, and
// the value of any key whose name looks secret (4+ characters), from .env and the environment → "***".
// Not "every value outside ENV_KEYS": COMPUTERNAME / HOSTNAME would blank the machine name.
export function makeRedactor(...sources) {
  const vals = new Set();
  for (const src of sources) for (const [k, v0] of Object.entries(src || {})) {
    const v = String(v0 ?? "").trim();
    if (!v) continue;
    if (CREDENTIAL_KEYS.includes(k)) {
      vals.add(v);
      const half = v.split(":").slice(1).join(":"); if (half) vals.add(half); // a Telegram token's secret half
    } else if (SECRET_NAME_RE.test(k) && v.length >= 4) vals.add(v);
  }
  const list = [...vals].sort((a, b) => b.length - a.length);
  return (s) => { let out = String(s); for (const v of list) out = out.split(v).join("***"); return out; };
}
const deepMap = (x, f) => (typeof x === "string" ? f(x) : Array.isArray(x) ? x.map((y) => deepMap(y, f))
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deepMap(v, f)])) : x);

// a path as shown: the home directory as ~, forward slashes (the same on Windows and macOS)
export function tildePath(f, home = os.homedir()) {
  if (!f) return "?";
  let s = String(f);
  if (home && s.toLowerCase().startsWith(home.toLowerCase())) s = `~${s.slice(home.length)}`;
  return s.replace(/\\/g, "/");
}

// the hub URL without credentials, path or query
export const originOf = (u) => { try { return new URL(String(u)).origin; } catch { return u ? "（網址看不懂）" : null; } };

// semver order (same rule as scripts/ensure-relay.mjs): <0 a older, 0 same, >0 a newer; unparseable = oldest
export function compareVersions(a, b) {
  const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? "").trim()); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] } : null; };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i] - pb.n[i];
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// --- switches ------------------------------------------------------------------------------------------
// Each switch: where its file is and how it is read, exactly as the program that READS it does (not the
// toggle script, where they differ). state(cfg, env) → {on | days, isDefault, source, file, ...}.
//   cfg: ~/.myna/.env merged with the environment (loadEnv()); env: the environment alone (process.env)
const offFirstLine = (file) => { try { return fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim() === "off"; } catch { return false; } };
const homeFile = (env, key, name) => env[key] || path.join(os.homedir(), ".myna", name);
const flagOff = (key, envKey, name, label, command, reader) => ({
  key, label, command, script: `${key}.mjs`, default: true, envFile: envKey, reader,
  file: (cfg, env) => homeFile(env, envKey, name),
  state(cfg, env) { const file = this.file(cfg, env), on = !offFirstLine(file); return { on, isDefault: on, source: on ? "default" : "file", file }; },
});
export const SWITCHES = [
  flagOff("intercept", "MYNA_INTERCEPT_FILE", "intercept", "intercept", "/myna:intercept", "scripts/intercept-ask.mjs"),
  flagOff("stopcatch", "MYNA_STOPCATCH_FILE", "stopcatch", "stopcatch", "/myna:stopcatch", "scripts/stop-catch-question.mjs"),
  {
    ...flagOff("perm", "MYNA_PERMISSION_FILE", "permission", "perm", "/myna:perm", "scripts/permission-request.mjs"),
    state(cfg, env) {
      const file = this.file(cfg, env), on = !offFirstLine(file);
      const d = Number(cfg.MYNA_PERMISSION_DELAY ?? 30), delay_s = Number.isFinite(d) && d >= 0 ? d : 30;
      return { on, isDefault: on, source: on ? "default" : "file", file, delay_s, delayDefault: cfg.MYNA_PERMISSION_DELAY === undefined };
    },
  },
  flagOff("brief", "MYNA_BRIEF_FILE", "brief", "brief", "/myna:brief", "scripts/intercept-ask.mjs"),
  {
    key: "autopilot", label: "autopilot", command: "/myna:autopilot", script: "autopilot.mjs", default: false, envFile: "MYNA_AUTOPILOT_FILE", reader: "src/mcp/ask-human.mjs",
    file: (cfg, env) => homeFile(env, "MYNA_AUTOPILOT_FILE", "autopilot"),
    state(cfg, env) { const file = this.file(cfg, env), on = fs.existsSync(file); return { on, isDefault: !on, source: on ? "file" : "default", file }; },
  },
  {
    // God mode (0.25.0): the flag file existing = on (src/godmode.mjs); while on, the unsent notices since it
    // was turned on (godmode-unsent.jsonl lines dated after the time in the flag file)
    key: "godmode", label: "godmode", command: "/myna:godmode", script: "godmode.mjs", default: false, envFile: "MYNA_GODMODE_FILE", reader: "scripts/permission-request.mjs",
    file: (cfg, env) => godmodeFile(env),
    state(cfg, env) {
      const file = this.file(cfg, env), on = fs.existsSync(file);
      const u = on ? unsentSince(godmodeSince(env), env) : null;
      // autopilot_by_godmode (v0.26.2): autopilot is on because /myna:godmode on turned it on (and nobody touched it since)
      return { on, isDefault: !on, source: on ? "file" : "default", file, ...(u ? { unsent: u.count, unsent_file: u.file } : {}), ...(on ? { autopilot_by_godmode: autopilotState(env).byGodmode } : {}) };
    },
  },
  {
    // the relay reads it — from its merged config, not only the environment
    key: "murmur", label: "murmur", command: "/myna:murmur", script: "murmur.mjs", default: true, envFile: "MYNA_PROGRESS_FILE", reader: "src/providers/telegram.mjs",
    file: (cfg) => cfg.MYNA_PROGRESS_FILE || path.join(os.homedir(), ".myna", "chat-progress"),
    state(cfg, env) { const file = this.file(cfg, env), on = !offFirstLine(file); return { on, isDefault: on, source: on ? "default" : "file", file }; },
  },
  {
    key: "files", label: "files", command: "/myna:files", script: "files.mjs", default: 7, envFile: "MYNA_INBOX_KEEP_FILE", reader: "src/inbox.mjs",
    file: (cfg) => keepFile(mynaDir(cfg), cfg),
    state(cfg, env) { const file = this.file(cfg, env), k = readKeep(file); return { days: k.days, isDefault: k.source === "default", source: k.source, file, ...(k.bad ? { bad: true } : {}) }; },
  },
  {
    // only matters on an edge; the relay's own reading (/health upstream.hold) wins in collect() when it has one
    key: "hold", label: "hold", command: "/myna:hold", script: "hold.mjs", default: true, envFile: "MYNA_UPSTREAM_HOLD_FILE", reader: "src/remote.mjs", edgeOnly: true,
    file: (cfg) => cfg.MYNA_UPSTREAM_HOLD_FILE || path.join(mynaDir(cfg), "upstream-hold"),
    state(cfg) { const s = holdSettings(cfg); return { on: s.on, max_s: s.max_s, isDefault: s.source === "default", source: s.source, file: this.file(cfg), ...(s.bad ? { bad: s.bad } : {}) }; },
  },
];

// --- relay.log -----------------------------------------------------------------------------------------
export function readLogTail(file, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (size > len) lines.shift(); // a cut first line
    return lines;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
const LINE_RE = /^\[relay ([0-9T:.\-]+Z)\] (.*)$/;
// the relay's start line (src/providers/telegram.mjs start()) → {at, topics, scope, round_grace, on_end}
export function relayTopicLine(lines, startedAt) {
  if (!lines) return null;
  const since = startedAt ? Date.parse(startedAt) : NaN;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const t = /^Telegram getUpdates long-poll started \(topics=(\w+), scope=(\w+), round_grace=([\d.]+)s, on_end=(\w+)/.exec(m[2]);
    if (!t) continue;
    if (Number.isFinite(since) && Date.parse(m[1]) < since) return null; // an older run's line
    return { at: m[1], topics: t[1], scope: t[2], round_grace: Number(t[3]), on_end: t[4] };
  }
  return null;
}
// the last failed topic create in the log → {at, kind: "gate" | "chat", text}
export function lastTopicFailure(lines) {
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    let f = /^topics unavailable for session \S+ \((.*)\) — falling back/.exec(m[2]);
    if (f) return { at: m[1], kind: "gate", text: f[1] };
    f = /^chat: no topic for \S+ \((.*)\) — it talks/.exec(m[2]);
    if (f) return { at: m[1], kind: "chat", text: f[1] };
  }
  return null;
}

// --- the topic settings as the Telegram provider reads them (telegram.mjs, create()) ----------------
export function topicSettings(get) {
  const on_end0 = String(get("TELEGRAM_TOPIC_ON_END") || "delete").trim().toLowerCase();
  const g = String(get("TELEGRAM_TOPIC_ROUND_GRACE") ?? "600").trim(), gn = Number(g);
  return {
    topics: String(get("TELEGRAM_TOPICS") || "auto").trim().toLowerCase() !== "off" ? "auto" : "off",
    scope: String(get("TELEGRAM_TOPIC_SCOPE") || "gate").trim().toLowerCase() === "session" ? "session" : "gate",
    on_end: ["close", "delete", "keep"].includes(on_end0) ? on_end0 : "delete",
    round_grace: g === "" || !Number.isFinite(gn) || gn < 0 ? 600 : gn,
  };
}

// the provider the relay picks (src/relay.mjs): MYNA_PROVIDER, else the first fully configured one
// (telegram, discord, slack), else telegram waiting to be paired (a token only). null: none.
export function expectedProvider(cfg, { paired = false } = {}) {
  const want = String(cfg.MYNA_PROVIDER || "").trim().toLowerCase();
  if (want) return want;
  const has = (k) => cfg[k] !== undefined && String(cfg[k]).trim() !== "";
  if (has("TELEGRAM_BOT_TOKEN") && (paired || has("TELEGRAM_CHAT_ID"))) return "telegram";
  if (has("DISCORD_BOT_TOKEN") && has("DISCORD_CHANNEL_ID")) return "discord";
  if (has("SLACK_BOT_TOKEN") && has("SLACK_APP_TOKEN") && has("SLACK_CHANNEL_ID")) return "slack";
  return has("TELEGRAM_BOT_TOKEN") ? "telegram" : null;
}

const errWhy = (e) => (e?.name === "TimeoutError" || e?.name === "AbortError" ? "逾時" : e?.cause?.code || e?.code || e?.name || "錯誤");

// --- collect --------------------------------------------------------------------------------------------
// cfg: loadEnv() (the .env merged with the environment, MYNA_ENV set). opts: {env (default process.env),
// fetch, deadlineMs, now}. Returns a plain object, every string already passed through the redactor.
export async function collect(cfg, opts = {}) {
  const env = opts.env || process.env;
  const doFetch = opts.fetch || globalThis.fetch;
  const signal = AbortSignal.timeout(opts.deadlineMs ?? DEADLINE_MS);
  const now = opts.now ?? Date.now();
  const envFile = readEnvFile(cfg.MYNA_ENV || path.join(os.homedir(), ".myna", ".env"));
  const redact = makeRedactor(envFile.values, env, cfg);
  const has = (k) => cfg[k] !== undefined && String(cfg[k]).trim() !== "";
  const sourceOf = (k) => (env[k] !== undefined ? "env" : envFile.values[k] !== undefined ? ".env" : "default");
  const dir = mynaDir(cfg);
  const port = Number(cfg.RELAY_PORT || 7800);
  const version = pluginVersion();
  const role = roleOf(cfg);

  const data = {
    at: new Date(now).toISOString(),
    machine: { name: String(cfg.MYNA_MACHINE_NAME || os.hostname().split(".")[0] || "?"), platform: process.platform },
    plugin_version: version,
    env_file: { path: envFile.path, exists: envFile.exists, mtime: envFile.mtime, ...(envFile.error ? { error: envFile.error } : opts.envError ? { error: opts.envError } : {}) },
    role_config: role,
  };

  // network: /health and getMe at once; /pair/status after /health; getChat + getChatMember after both
  const getJSON = async (url, init) => {
    const r = await doFetch(url, { ...init, signal });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, json };
  };
  const relayBase = `http://127.0.0.1:${port}`;
  const healthP = getJSON(`${relayBase}/health`).then(
    // ensure-relay's rule: a relay says name "myna-relay"; a 200 that is not JSON is a pre-0.7.2 relay;
    // anything else on the port is not Myna
    (r) => (r.json?.name === "myna-relay" && r.status === 200 ? { ok: true, h: r.json }
      : r.status === 200 && r.json === undefined ? { ok: true, legacy: true }
      : { ok: false, other: true, why: `HTTP ${r.status}${r.json && typeof r.json === "object" ? "，不是 myna relay 的回應" : ""}` }),
    (e) => ({ ok: false, why: errWhy(e) }));
  const token = String(cfg.TELEGRAM_BOT_TOKEN || "").trim();
  const API = `${cfg.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${token}`;
  // the token is in the URL: only in fetch; errors keep the error's name/code, never the URL
  const tg = (method, body = {}) => getJSON(`${API}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => (r.json?.ok ? { ok: true, result: r.json.result } : { ok: false, why: r.json?.description || `HTTP ${r.status}` }), (e) => ({ ok: false, why: errWhy(e) }));
  const chatFile = cfg.MYNA_TELEGRAM_CHAT_FILE || path.join(dir, "telegram-chat.json");
  let paired = false; try { paired = JSON.parse(fs.readFileSync(chatFile, "utf8"))?.chat_id != null; } catch {}
  const expected = expectedProvider(cfg, { paired });
  let meP = token && expected === "telegram" ? tg("getMe") : null;

  // --- relay
  const health = await healthP;
  const relay = { port };
  if (!health.ok) {
    relay.running = false; relay.why = health.why === "ECONNREFUSED" ? "沒在跑" : health.why;
    if (health.other) relay.other = true; // the port answers, but not as a Myna relay
  } else if (health.legacy) {
    relay.running = true; relay.legacy = true;
  } else {
    const h = health.h;
    Object.assign(relay, { running: true, version: h.version, started_at: h.started_at || null, role: h.role || "hub", provider: h.provider, pending: h.pending, machine: h.machine, ...(h.node ? { node: h.node } : {}) });
    relay.compare = h.version ? Math.sign(compareVersions(h.version, version)) : null; // -1 older, 0 same, 1 newer
  }
  if (!relay.running) {
    // ensure-relay's own test (scripts/ensure-relay.mjs): would a SessionStart start it?
    relay.autostart = role === "edge" ? has("MYNA_UPSTREAM")
      : role === "hub" ? !!(has("TELEGRAM_BOT_TOKEN") || (has("DISCORD_BOT_TOKEN") && has("DISCORD_CHANNEL_ID")) || (has("SLACK_BOT_TOKEN") && has("SLACK_APP_TOKEN") && has("SLACK_CHANNEL_ID")) || String(cfg.MYNA_TRANSPORT || "").trim().toLowerCase() === "tree")
      : false;
  }
  data.relay = relay;
  // the provider in use: the relay's own word, else what it would pick from the config
  const provider = relay.running && !relay.legacy && relay.provider && relay.provider !== "none" ? relay.provider : expected;
  data.provider = provider;
  data.expected_provider = expected;
  if (token && provider === "telegram" && !meP) meP = tg("getMe");
  const relayRole = relay.running && !relay.legacy ? relay.role : null;
  data.role = relayRole || role;
  // the running relay against what the config (with this session's environment) would make it
  const rp = relay.running && !relay.legacy && relay.provider && relay.provider !== "none" ? relay.provider : null;
  data.relay_differs = {
    role: !!relayRole && relayRole !== role,
    provider: !!rp && !!expected && rp !== expected,
  };
  data.im_configured = has("TELEGRAM_BOT_TOKEN") || (has("DISCORD_BOT_TOKEN") && has("DISCORD_CHANNEL_ID")) || (has("SLACK_BOT_TOKEN") && has("SLACK_APP_TOKEN") && has("SLACK_CHANNEL_ID"));
  const pairP = relay.running && !relay.legacy ? getJSON(`${relayBase}/pair/status`).catch(() => null) : null;

  // --- edge
  if (data.role === "edge") {
    const u = health.h?.upstream, ob = health.h?.own_bot;
    data.edge = {
      upstream: originOf(u?.url || cfg.MYNA_UPSTREAM),
      reported: !!u,
      reachable: u ? !!u.reachable : null,
      reason: u?.reason ?? null,
      hub_version: u?.version ?? null,
      own_bot: ob ? !!ob.on : null,
      // the hold in force: the relay's (0.21.0+); a relay that reports upstream without hold is older and
      // fails over to its own bot (0.20.x) = not holding; not reported at all (relay not running) = unknown
      hold_on: u?.hold ? !!u.hold.on : u ? false : null,
      hold_supported: u ? !!u.hold : null,
    };
  }

  // --- the relay's own start line in relay.log (only this run's: not before /health started_at)
  data.relay_log = path.join(dir, "relay.log");
  const lines = readLogTail(data.relay_log);
  const startLine = relay.running && relay.started_at ? relayTopicLine(lines, relay.started_at) : null;
  const envChangedSinceStart = !!(relay.running && relay.started_at && envFile.mtime && Date.parse(envFile.mtime) > Date.parse(relay.started_at));
  data.env_changed_since_start = envChangedSinceStart;

  // --- Telegram
  if (token && provider && provider !== "telegram") {
    // a Telegram token left in the config while the relay uses another provider: no Telegram checks or steps
    data.telegram = { token_set: true, token_source: sourceOf("TELEGRAM_BOT_TOKEN"), unused: provider };
  } else if (token || (!data.im_configured && data.role !== "edge")) {
    const t = { token_set: !!token, token_source: token ? sourceOf("TELEGRAM_BOT_TOKEN") : null };
    const me = meP ? await meP : null;
    if (me) t.bot = me.ok ? { ok: true, id: me.result.id, username: me.result.username, has_topics_enabled: me.result.has_topics_enabled } : { ok: false, why: me.why };
    // which chat: the relay's (GET /pair/status), else the pairing record, else TELEGRAM_CHAT_ID
    let chat = null;
    const pr = pairP ? await pairP : null;
    if (pr && pr.status === 200 && pr.json && "chat" in pr.json) {
      const c = pr.json.chat;
      chat = c ? { from: "relay", id: String(c.id), type: c.type || null, title: c.title ?? null, paired_at: c.paired_at || null, legacy_env: c.source === "TELEGRAM_CHAT_ID" } : { from: "relay", none: true };
    } else {
      let b = null; try { const j = JSON.parse(fs.readFileSync(chatFile, "utf8")); if (j?.chat_id != null) b = j; } catch {}
      if (b) chat = { from: "file", id: String(b.chat_id), type: b.type || null, title: b.title ?? null, paired_at: b.paired_at || null };
      else if (has("TELEGRAM_CHAT_ID")) chat = { from: "file", id: String(cfg.TELEGRAM_CHAT_ID).trim(), type: null, title: null, legacy_env: true };
      else chat = { from: "file", none: true };
    }
    if (chat.none) chat = null;
    // a TELEGRAM_CHAT_ID without a type: a negative id is a group (getChat tells which), positive private
    const isGroupish = chat && (chat.type === "group" || chat.type === "supergroup" || (!chat.type && chat.id.startsWith("-")));
    if (chat && !chat.type && !isGroupish) chat.type = "private";
    t.chat = chat;
    if (chat && isGroupish && token) {
      const botId = me?.ok ? me.result.id : (/^\d+$/.test(token.split(":")[0]) ? Number(token.split(":")[0]) : null);
      const [gc, gm] = await Promise.all([tg("getChat", { chat_id: chat.id }), botId ? tg("getChatMember", { chat_id: chat.id, user_id: botId }) : Promise.resolve({ ok: false, why: "bot id 查不到" })]);
      t.group = {
        chat: gc.ok ? { ok: true, type: gc.result.type, is_forum: gc.result.is_forum === true, title: gc.result.title ?? null } : { ok: false, why: gc.why },
        member: gm.ok ? { ok: true, status: gm.result.status, can_manage_topics: gm.result.status === "creator" || gm.result.can_manage_topics === true } : { ok: false, why: gm.why },
      };
      if (gc.ok && !chat.type) chat.type = gc.result.type;
      if (gc.ok && chat.title == null) chat.title = gc.result.title ?? null;
    }
    // topic settings: relay's (start line) vs config file / this session
    const file = topicSettings((k) => cfg[k]);
    t.topic_settings = {
      file, file_source: Object.fromEntries(["TELEGRAM_TOPICS", "TELEGRAM_TOPIC_SCOPE", "TELEGRAM_TOPIC_ON_END", "TELEGRAM_TOPIC_ROUND_GRACE"].map((k) => [k, sourceOf(k)])),
      relay: startLine ? { topics: startLine.topics, scope: startLine.scope, on_end: startLine.on_end, round_grace: startLine.round_grace, at: startLine.at } : null,
      relay_why: startLine ? null : !relay.running ? "relay 沒在跑" : relay.legacy ? "很舊的 relay" : "查不到",
    };
    const rs = t.topic_settings.relay;
    t.topic_settings.differs = !!rs && ["topics", "scope", "on_end", "round_grace"].some((k) => String(rs[k]) !== String(file[k]));
    // the bot this queried may not be the relay's: the token comes from this session's environment, or
    // .env changed after the relay started. Without a relay change the relay's bot id is not visible here.
    t.bot_maybe_other = !!(token && relay.running && (t.token_source === "env" || envChangedSinceStart));
    // failures on record: gate topics remembered as thread:null (only a failed createForumTopic writes
    // one) and the last failure line in relay.log. telegram-chat-topics.json's nulls are not counted:
    // "topics off" writes null too.
    const topicsFile = cfg.MYNA_TOPICS_FILE || path.join(dir, "telegram-topics.json");
    let nulls = 0, latest = null;
    try {
      for (const v of Object.values(JSON.parse(fs.readFileSync(topicsFile, "utf8")) || {})) {
        if (v && v.thread === null) { nulls++; if (v.created && (!latest || v.created > latest)) latest = v.created; }
      }
    } catch {}
    t.failures = { gate_null: nulls, gate_null_latest: latest, last_log: lastTopicFailure(lines) };
    t.verdict = topicVerdict(t);
    data.telegram = t;
  }
  if (has("DISCORD_BOT_TOKEN") || has("DISCORD_CHANNEL_ID")) data.discord = { token_set: has("DISCORD_BOT_TOKEN"), channel_id: cfg.DISCORD_CHANNEL_ID || null };
  if (has("SLACK_BOT_TOKEN") || has("SLACK_APP_TOKEN") || has("SLACK_CHANNEL_ID")) data.slack = { token_set: has("SLACK_BOT_TOKEN") && has("SLACK_APP_TOKEN"), channel_id: cfg.SLACK_CHANNEL_ID || null };

  // --- switches
  data.switches = SWITCHES.filter((s) => !s.edgeOnly || data.role === "edge").map((s) => {
    const st = s.state(cfg, env);
    if (s.key === "hold") {
      const rh = health.h?.upstream?.hold;
      if (rh) return { key: s.key, label: s.label, on: !!rh.on, max_s: rh.max_s, isDefault: rh.source === "default", source: rh.source, from: "relay" };
      return { key: s.key, label: s.label, ...st, from: "config", ...(health.h?.upstream ? { unsupported: true } : {}) };
    }
    return { key: s.key, label: s.label, ...st };
  });
  const chatDefault = String(cfg.MYNA_CHAT || "").trim().toLowerCase();
  data.chat_default = chatDefault === "on" || chatDefault === "off" ? { value: chatDefault, source: sourceOf("MYNA_CHAT") } : { value: "default" };

  // --- environment: the listed keys that are set (env wins), and the credentials as set / not set
  data.env = ENV_KEYS.filter((k) => cfg[k] !== undefined && String(cfg[k]).trim() !== "")
    .map((k) => ({ key: k, value: k === "MYNA_UPSTREAM" ? originOf(cfg[k]) : String(cfg[k]).trim(), source: sourceOf(k) }));
  data.credentials = CREDENTIAL_KEYS.filter((k) => has(k)).map((k) => ({ key: k, set: true, source: sourceOf(k) }));

  data.next = nextSteps(data);
  return deepMap(data, redact);
}

// --- the topic verdict: the first thing that does not hold is where it is stuck -------------------------
// → {state: "on" | "off" | "blocked" | "unknown" | "none", reasons: [...], guess: bool}
export function topicVerdict(t) {
  if (!t.token_set) return { state: "none", reasons: ["沒設定 Telegram"] };
  if (!t.chat) return { state: "none", reasons: ["還沒配對，題目會回終端機"] };
  const ts = t.topic_settings;
  const guess = !ts.relay || !!t.bot_maybe_other;
  const topics = ts.relay ? ts.relay.topics : ts.file.topics;
  const blockers = [], unknown = [];
  const group = t.chat.type === "group" || t.chat.type === "supergroup";
  if (!group) {
    if (!t.bot?.ok) unknown.push(`Threaded Mode 查不到（${t.bot?.why || "?"}）`);
    else if (t.bot.has_topics_enabled === undefined) unknown.push("這版 Bot API 沒回報 Threaded Mode");
    else if (t.bot.has_topics_enabled !== true) blockers.push("bot 沒開 Threaded Mode");
  } else {
    const g = t.group;
    if (!g) unknown.push("群組設定查不到");
    else {
      if (!g.chat.ok) unknown.push(`群組主題查不到（${g.chat.why}）`);
      else if (g.chat.type === "group" || !g.chat.is_forum) blockers.push("群組沒開主題");
      if (!g.member.ok) unknown.push(`bot 在群組的身分查不到（${g.member.why}）`);
      else if (!g.member.can_manage_topics) blockers.push("bot 不能管理主題");
    }
  }
  if (topics === "off") return { state: "off", reasons: ["TELEGRAM_TOPICS=off", ...blockers], unknown, guess };
  if (blockers.length) return { state: "blocked", reasons: blockers, unknown, guess };
  if (unknown.length) return { state: "unknown", reasons: unknown, unknown, guess };
  return { state: "on", reasons: [], unknown, guess };
}

// --- what to do next: a fixed table, one rule per field, in order -------------------------------------
export function nextSteps(d) {
  const out = [], t = d.telegram, r = d.relay;
  const envPath = tildePath(d.env_file.path);
  // an unreadable config comes first; what depends on its contents (no IM set up) is not guessed then
  if (d.env_file.error) out.push(`設定檔 ${envPath} 讀不到（${d.env_file.error}），先檢查它是不是檔案、權限對不對，修好再跑一次 /myna:status。`);
  else if (!d.im_configured && d.role !== "edge") out.push("設定 IM：/myna:setup <bot token>（Telegram；Discord／Slack 見 README）。");
  if (r.other) out.push(`127.0.0.1:${r.port} 被別的程式占用（不是 myna relay）：關掉它，或在 ${envPath} 設 RELAY_PORT 換一個 port。`);
  if (!r.running && !r.other && r.autostart) out.push(`啟動 relay：/myna:relay start；還是起不來就看 ${tildePath(d.relay_log)}。`);
  const old = r.running && (r.legacy || r.compare === -1);
  if (old) out.push("relay 比這個 plugin 舊：/myna:relay restart。");
  if (r.running && r.compare === 1) out.push("relay 比這個 plugin 新：/plugin update 更新 plugin。");
  const differs = t?.topic_settings?.differs || d.relay_differs?.role || d.relay_differs?.provider;
  if (!old && (differs || d.env_changed_since_start)) out.push(`relay 用的設定跟設定檔不同（或 ${envPath} 在 relay 啟動後改過）：/myna:relay restart 後才會照設定檔。`);
  else if (!old && t?.bot_maybe_other) out.push("（推測）Telegram 這幾項是用這個 session 的 bot token 查的，relay 可能用別支；要確定就 /myna:relay restart 再跑一次 /myna:status。");
  // an edge's own bot pairs like a hub's (only the edge without a bot pairs on the hub)
  if (t && !t.unused && t.token_set && !t.chat && d.provider === "telegram") out.push("配對聊天室：/myna:pair。");
  if (t?.chat && !t.unused) {
    const g = t.group;
    if (t.chat.type === "private" && t.bot?.ok && t.bot.has_topics_enabled === false)
      out.push("BotFather → /mybots → 選 bot → Bot Settings → Threaded Mode → 開（不用重啟 relay）。");
    if (g?.chat.ok && g.chat.type === "group")
      out.push("群組設定開「主題」。一般群組開主題後 Telegram 會把它升級成超級群組、聊天室 id 會變，開完在群組傳 !pair 重新配對（先跑 /myna:pair 拿配對碼）。");
    else if (g?.chat.ok && !g.chat.is_forum) out.push("群組設定開「主題」。");
    if (g?.member.ok && !g.member.can_manage_topics) out.push("把 bot 設成群組管理員，勾「管理主題」。");
  }
  if (t?.token_set && !t.unused && t.topic_settings.file.topics === "off") {
    out.push(t.topic_settings.file_source.TELEGRAM_TOPICS === "env"
      ? "拿掉環境變數 TELEGRAM_TOPICS=off（或改成 auto），再 /myna:relay restart。"
      : `把 ${envPath} 的 TELEGRAM_TOPICS=off 刪掉（或改成 auto），再 /myna:relay restart。`);
  }
  if (d.role === "edge" && d.edge) {
    if (d.edge.reachable === false) out.push(`主節點連不上（${d.edge.reason || "原因沒回報"}）：看主節點的 relay 和 tunnel。`);
    // the own bot takes new questions only while the hub is away and holding is off (SPEC §5.2)
    const ownTakes = d.edge.own_bot === true && d.edge.reachable === false && d.edge.hold_on === false;
    if (ownTakes) out.push("主節點連不上、斷線排隊關著，新題目現在由這台自己的 bot 發：topic 看上面 Telegram 那段；經主節點的題目，topic 的原因要在主節點跑 /myna:status。");
    else if (d.edge.reachable === false && d.edge.hold_on === true) out.push("主節點連不上時新題目先排著（還沒送到手機），恢復後才會開 topic；topic 的原因要在主節點跑 /myna:status。");
    else out.push("這台的題目用主節點的 bot；topic 的原因要在主節點跑 /myna:status。");
  }
  if (out.length) out.push("改完再跑一次 /myna:status 確認。");
  return out;
}
