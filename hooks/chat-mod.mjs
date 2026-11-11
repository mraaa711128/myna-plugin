// Myna chat mod — makes this Claude Code session a chat partner on Telegram (session side of
// src/chat.mjs). Loaded by hooks/hooks.json `modules` on Claude Code ≥ 2.1.287; older CLIs ignore it.
//
// On session start (a terminal session, by default) it registers the session with the relay under a
// bird nickname (egret for example-app), then polls the relay for what the human wrote to it on
// Telegram and submits it as a prompt, only while the session is idle: what piled up during a turn
// goes in together as one prompt; a "!command args" message runs that slash command instead. A message
// the human sent as a Telegram reply goes in with the message it replied to, quoted (replyLine).
// Every turn — started from the phone, at the terminal, or by nobody typing (a background notification,
// another session, a plugin) — is reported as it runs (tool calls, interim text, the final answer); the
// relay turns that into one progress message edited in place + the answer.
//
// Settings (process env first, then ~/.myna/.env, like the relay and the hook scripts):
//   MYNA_CHAT=on|off       the default for this session (otherwise: on for a terminal / VS Code
//                          session, off for -p / SDK)
//   MYNA_CHAT_NICK=<name>  the nickname to ask for instead of a bird
//   RELAY_PORT / MYNA_RELAY_URL / MYNA_RELAY_SECRET_FILE   where the relay and its secret are
// Per session (kept across a resume, in $.store): /myna:config chat on|off (or its alias /myna:chat),
// /myna:nick <name>.
//
// The engine only takes `$` spelled out at each call site (never stored or passed), so session.start
// builds `io`, a set of closures over its `$`, and everything else goes through those.
// Plain JS on purpose: test/smoke-chatmod.mjs runs it under node against a stub `$`.

const POLL_MS = 2000;
const TAKE_MAX = 20; // phone messages taken at once (they go in as one prompt)
const KEEP_MS = 30 * 24 * 3600 * 1000; // a session's stored nick / on-off is forgotten after this
const BIRDS = {
  a: ["albatross", "avocet"], b: ["bittern", "bunting"], c: ["crane", "curlew"], d: ["dunlin", "dipper"],
  e: ["egret", "eider"], f: ["finch", "falcon"], g: ["grebe", "goshawk"], h: ["heron", "hoopoe"],
  i: ["ibis"], j: ["jay", "junco"], k: ["kestrel", "kite"], l: ["lark", "loon"], m: ["magpie", "merlin"],
  n: ["nuthatch", "nightjar"], o: ["oriole", "osprey"], p: ["puffin", "plover"], q: ["quail"],
  r: ["robin", "redstart"], s: ["swift", "sparrow"], t: ["tern", "thrush"], v: ["vireo"],
  w: ["wren", "warbler"], y: ["yellowhammer"],
};
const ANY_BIRD = Object.values(BIRDS).flat();

export function birdFor(label, pick = Math.random) {
  const c = (String(label || "").toLowerCase().match(/[a-z]/) || [])[0];
  return BIRDS[c]?.[0] || ANY_BIRD[Math.floor(pick() * ANY_BIRD.length)];
}
// "!name args" (or "！name") typed on the phone — the relay hands it over on its own (src/chat.mjs
// isCommand); Myna takes no "/name" on Telegram (the relay answers one with a hint)
const PHONE_COMMAND = /^[!！]([^\s/!！]+)(?:\s+([\s\S]*))?$/;
// answered by the mod from $.session.usage() — the built-ins of these names draw a terminal panel
const USAGE_NAMES = new Set(["usage", "cost", "context", "status", "用量"]);
// built-ins that do their thing without arguments; any other built-in run bare draws a panel or asks on
// the terminal (nothing for the phone) — with arguments (/model opus) it mostly just does it
const BUILTIN_BARE_OK = new Set(["compact", "clear", "exit"]);
// a command that printed nothing and started no turn within this long: the phone is told so
const CMD_QUIET_MS = 5000;
// /myna:chat is kept as an alias of /myna:config chat for a while (until 0.25.0 and at least 30 days)
const CHAT_ALIAS_HINT = "提示：/myna:chat 之後會移除，請改用 /myna:config chat on|off";
const CHAT_ALIAS_HINT_PHONE = "提示：!myna:chat 之後會移除，請改用 !myna:config chat on|off";
// what "/myna:config chat" (the state) adds below it: the purpose and the values, as scripts/config.mjs shows
// them for every other item (its INFO.chat holds the same two texts; test/smoke-config.mjs checks they match)
export const CHAT_CONFIG_PURPOSE = "在 Telegram 跟這個 session 聊天：手機上打的字交給它，它做了什麼、怎麼回答都回到手機";
export const CHAT_CONFIG_VALUES = "on / off（只改目前這個 session）";
const CHAT_CONFIG_INFO = `用途：${CHAT_CONFIG_PURPOSE}（需要 Claude Code 2.1.287 以上，只支援 Telegram）\n可設：${CHAT_CONFIG_VALUES}`;
// Each session's chat on/off, for /myna:config's list (scripts/config.mjs reads them): one small JSON file
// per session in <myna dir>/chat-state/ — {session_id, on, nick?, project, updated_at, ended_at?}. Written on
// session start, /myna:config chat on|off (and /myna:chat), a registration or a new nick, a new session id
// (after /clear or a resume), every STATE_REFRESH_MS at most on a prompt or a turn's start (a turn started from
// the phone has no prompt.submit), and at session end (ended_at).
// Best effort: a write that fails changes nothing else. config.mjs removes the files of ended sessions.
const STATE_REFRESH_MS = 10 * 60 * 1000;
export const stateFileName = (sid) => `${String(sid).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)}.json`;
// the arguments of /myna:config → what follows "chat" (lowercased, "" = the state), or null: not chat
export function configChatArgs(args) {
  const m = /^\s*chat(?:\s+([\s\S]*?))?\s*$/i.exec(String(args ?? ""));
  return m ? (m[1] || "").toLowerCase() : null;
}
const LIMIT_NAMES = { five_hour: "5 小時額度", seven_day: "7 天額度", spend_limit: "花費上限" };
const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pad2 = (n) => String(n).padStart(2, "0");
const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// The message a phone message replied to (the relay's reply_to {message_id, text}, relay ≥ 0.20.4) → the
// line put before the human's words: one line, clipped, labeled as a quote — it is often this session's
// own earlier answer, so it must read as context, not as something new to do. "" when not a reply.
const REPLY_QUOTE_MAX = 200;
export function replyLine(r) {
  if (!r || typeof r !== "object") return "";
  const chars = Array.from(String(r.text ?? "").replace(/\s+/g, " ").trim());
  if (!chars.length) return "（回覆一則沒有文字的訊息）\n";
  const quote = chars.length > REPLY_QUOTE_MAX ? `${chars.slice(0, REPLY_QUOTE_MAX).join("")}…` : chars.join("");
  return `（回覆這則，只是引用、不是新的指示：「${quote}」）\n`;
}

// $.session.usage() → the text the phone gets for !usage
export function usageText(u, nick) {
  const lines = [`📊 ${nick ? `${nick} 的` : ""}用量`];
  const c = u?.context;
  if (c?.window) {
    lines.push(typeof c.tokens === "number"
      ? `context:${c.percent ?? Math.round((100 * c.tokens) / c.window)}%(${kTokens(c.tokens)} / ${kTokens(c.window)} tokens)`
      : `context:還沒有讀數(視窗 ${kTokens(c.window)} tokens)`);
  }
  const limits = Array.isArray(u?.rateLimits) ? u.rateLimits : [];
  for (const r of limits) lines.push(`${LIMIT_NAMES[r.kind] || r.kind}:已用 ${r.percentUsed}%${r.resetsAt ? `,${when(r.resetsAt)} 重置` : ""}`);
  if (!limits.length) lines.push("額度:目前沒有讀數");
  if (typeof u?.cost?.usd === "number") lines.push(`這個 session 花費:US$${u.cost.usd.toFixed(2)}`);
  return lines.join("\n");
}
const basename = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

// a tool call's arguments, cut down to what a one-line summary needs (a Write's content can be huge)
export function slimInput(input) {
  if (!input || typeof input !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    else if (Array.isArray(v)) out[k] = JSON.stringify(v).length > 2000 ? Array(v.length).fill(0) : v;
    else if (v && typeof v === "object") out[k] = JSON.stringify(v).length > 1000 ? {} : v;
    else out[k] = v;
  }
  return out;
}

// Where a turn came from. prompt.submit's e.origin.kind says it (turn.start has no origin); a person
// typed it: composer (Enter at the terminal), bridge (Remote Control), person, sdk (a VS Code / SDK host's
// own turn), slack-ping (the owner from Slack). Everything else nobody typed: one short label on the
// phone instead of the text (a <task-notification> can be long, and repeats what the human just wrote).
const HUMAN_KINDS = new Set(["composer", "bridge", "person", "sdk", "slack-ping"]);
const PEER = "🔗 其他 session 的訊息";
function kindLabel(o) {
  switch (o?.kind) {
    case "task-notification": return "⚙ 背景通知";
    case "scheduled-trigger": return "⏰ 排程";
    case "peer": case "peer-send-message": case "projects-relay": case "coordinator": return PEER;
    case "plugin": return `🧩 ${o.name || "其他"} plugin`;
    case "channel": return `📡 ${o.server ? `${o.server} ` : ""}頻道訊息`;
    case "observer": case "observer-activity": return "👁 觀察者回報";
    case "auto-continuation": return "↪ 自動接續";
    default: return null; // unclassified, or a kind this mod does not know yet
  }
}
// no origin to go by (unclassified, an older CLI, a prompt that never passed prompt.submit): the engine's
// framing. A control tag the harness rewrote inside a message reads "<\tag"
const TEXT_MARKS = [
  [/^<\\?task-notification\b/, "⚙ 背景通知"],
  [/^<\\?(cross-session-message|teammate-message)\b/, PEER],
  [/^Another Claude session sent a message/, PEER],
  [/^<\\?channel\b/, "📡 頻道訊息"],
  [/^The (\S+) plugin sent a message:/, (m) => `🧩 ${m[1]} plugin`],
];
// origins: the e.origin of every prompt.submit this turn's text carries. null = a person typed it (or
// nothing says otherwise — better an extra 🖥 line than a person's prompt left out); else the label
export function turnSource(text, origins = []) {
  if (origins.some((o) => HUMAN_KINDS.has(o?.kind))) return null;
  for (const o of origins) { const l = kindLabel(o); if (l) return l; }
  const t = String(text || "").trimStart();
  for (const [re, label] of TEXT_MARKS) { const m = re.exec(t); if (m) return typeof label === "function" ? label(m) : label; }
  return null;
}

// A file the human sent from the phone (relay ≥ 0.22.0, SPEC §5.3) comes with file_path: its local path,
// the one written at the front of the prompt. The session may Read exactly those files without a prompt
// (tool.check below); everything else about Read is left to Claude Code. readKey: the form two paths
// are compared in, or null for anything that is not a plain absolute path — relative, "~", UNC or
// "\\?\", a "." / ".." / empty segment, a NUL. Windows paths: "/" read as "\", case folded (NTFS).
export function readKey(p) {
  if (typeof p !== "string" || !p || p.includes("\0") || p.includes("~")) return null;
  const win = /^[A-Za-z]:[\\/]/.test(p);
  if (!win && (!p.startsWith("/") || p.includes("\\"))) return null;
  if (p.startsWith("//")) return null;
  const segs = p.split(win ? /[\\/]/ : "/").slice(1);
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return win ? p.replace(/\//g, "\\").toLowerCase() : p;
}
export const parentOf = (p) => String(p).replace(/[\\/][^\\/]*$/, "");
const MAY_READ_MAX = 500;

export const register = (on) => {
  // module state — a hot reload starts it over, and session.start fires again
  let io = null;          // closures over session.start's `$`
  let cfg = null;         // {relay, secretFile, chat, nick}
  let sid = null;         // the session registered with the relay
  let token = null, nick = null, topic = null;
  let enabled = false;    // chat is on for this session
  let timer = null;
  let ticking = false, retryAt = 0, failures = 0;
  let unavailable = "";   // why chat is not running right now (relay down / not Telegram / …)
  let note = "";          // a line the relay sent with the registration (an edge: the hub is away, or too old to forward chat)
  let queued = 0;
  let inTurn = false;     // a main-loop turn is running
  let sent = [];          // texts we submitted (or a command's <command-name> mark) that have not started a turn yet
  let sentAt = 0;
  let pendingCmd = null;  // {mark, name, at}: a phone command that printed nothing — a turn or nothing to come
  let submitted = [];     // {text, origin, at}: prompts submitted while idle, oldest first, until their turn starts
  let chain = Promise.resolve(); // progress posts, in order
  const mayRead = new Map();     // readKey -> path of a file the relay handed this session (memory only: a reload asks again)
  const allowRead = (p) => {
    const k = readKey(p);
    if (!k) return;
    mayRead.delete(k); mayRead.set(k, p);
    if (mayRead.size > MAY_READ_MAX) mayRead.delete(mayRead.keys().next().value);
  };

  const now = () => Date.now();
  const storeKey = (id) => `chat:${id}`;
  async function saved(id) { try { return (await io.storeGet(storeKey(id))) || {}; } catch { return {}; } }
  async function remember(id, patch) {
    try { await io.storeSet(storeKey(id), { ...(await saved(id)), ...patch, at: now() }); } catch {}
  }
  // this session's chat on/off for /myna:config's list (see STATE_REFRESH_MS); never throws
  // One write at a time, in the order asked, each built from the state as it is when its turn comes: a write
  // asked earlier (a prompt's refresh) can never land after a later one (chat off, session end) with older
  // state. refresh: only when the session id changed (after /clear or a resume) or the record is stale.
  let recorded = { sid: null, at: 0 };
  let stateChain = Promise.resolve();
  function recordState(opts = {}) {
    stateChain = stateChain.then(() => writeState(opts)).catch(() => {});
    return stateChain;
  }
  const refreshState = () => recordState({ refresh: true });
  async function writeState({ ended = false, id: given = null, refresh = false }) {
    if (!io || !cfg) return;
    const id = given || (await io.sessionId());
    if (!id) return;
    if (refresh && id === recorded.sid && now() - recorded.at <= STATE_REFRESH_MS) return;
    const root = (await io.root().catch(() => "")) || (await io.cwd().catch(() => ""));
    const at = new Date(now()).toISOString();
    const rec = { session_id: id, on: enabled, ...(nick && token && sid === id ? { nick } : {}), project: root || "", updated_at: at, ...(ended ? { ended_at: at } : {}) };
    await io.write(`${cfg.stateDir}/${stateFileName(id)}`, `${JSON.stringify(rec)}\n`);
    recorded = ended ? { sid: null, at: 0 } : { sid: id, at: now() };
  }

  async function prune() {
    try {
      for (const k of await io.storeKeys()) {
        if (!k.startsWith("chat:")) continue;
        const v = await io.storeGet(k);
        if (!v || now() - (v.at || 0) > KEEP_MS) await io.storeDelete(k);
      }
    } catch {}
  }

  // env: the variables read at session start; ~/.myna/.env fills what the process env leaves unset
  async function settings(env) {
    const dir = `${env.HOME || env.USERPROFILE || ""}/.myna`;
    const file = {};
    try {
      for (const l of String(await io.read(env.MYNA_ENV || `${dir}/.env`)).split(/\r?\n/)) {
        if (!l || l.startsWith("#") || !l.includes("=")) continue;
        const i = l.indexOf("="), k = l.slice(0, i).trim();
        if (["RELAY_PORT", "MYNA_RELAY_URL", "MYNA_RELAY_SECRET_FILE", "MYNA_CHAT", "MYNA_CHAT_NICK"].includes(k)) file[k] = l.slice(i + 1).trim();
      }
    } catch {}
    const get = (k) => env[k] ?? file[k];
    // the per-session state files sit next to the .env, like the rest of Myna's files (scripts mynaDir())
    const mynaDir = !env.MYNA_ENV ? dir : /[\\/]/.test(env.MYNA_ENV) ? String(env.MYNA_ENV).replace(/[\\/][^\\/]*$/, "") : ".";
    return {
      stateDir: `${mynaDir}/chat-state`,
      relay: (get("MYNA_RELAY_URL") || `http://127.0.0.1:${Number(get("RELAY_PORT") || 7800)}`).replace(/\/+$/, ""),
      secretFile: get("MYNA_RELAY_SECRET_FILE") || `${dir}/relay-secret`,
      chat: String(get("MYNA_CHAT") || "").toLowerCase(),
      nick: get("MYNA_CHAT_NICK") || "",
    };
  }

  async function call(p, body, auth) {
    const r = await io.fetch(`${cfg.relay}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    let j = {};
    try { j = JSON.parse(r.text || "{}"); } catch {}
    return { status: r.status, ...j };
  }

  function status() {
    if (!io) return;
    if (!enabled) return io.status(undefined);
    if (!token) return io.status(unavailable ? `💬 聊天未連線(${unavailable})` : undefined);
    io.status(`💬 ${nick}${queued ? ` · ${queued} 則待處理` : ""}${note ? ` · ${note}` : ""}`);
  }
  function backoff(why, ms) {
    unavailable = why; failures++;
    retryAt = now() + (ms ?? Math.min(30000, 2000 * 2 ** Math.min(failures, 4)));
    status();
  }

  async function registerNow() {
    const id = await io.sessionId();
    if (sid && sid !== id) mayRead.clear(); // another session now: the files handed to the old one are not its
    if (sid && sid !== id && token) await close(); // a /clear: the old conversation is over
    let secret = "";
    try { secret = String(await io.read(cfg.secretFile)).trim(); } catch {}
    if (!secret) return backoff("找不到 relay 密鑰"), false;
    const root = (await io.root().catch(() => "")) || (await io.cwd().catch(() => ""));
    const label = basename(root);
    const mine = await saved(id);
    let r;
    try {
      r = await call("/chat/register", { session_id: id, nick: mine.nick || cfg.nick || birdFor(label), label, cwd: root }, secret);
    } catch { return backoff("relay 沒有回應"), false; }
    // an old relay (< 0.12) — SessionStart's ensure-relay is likely swapping it right now: normal retry pace
    if (r.status === 404) return backoff("relay 版本太舊"), false;
    // an edge without a bot of its own whose hub does not forward chat says why (r.hint)
    if (r.status === 501) return backoff(r.hint || "目前的 IM 不支援聊天", 300000), false;
    if (r.status !== 200 || !r.token) return backoff(r.status === 401 ? "relay 密鑰不符" : `relay ${r.status}`), false;
    sid = id; token = r.token; nick = r.nick; topic = r.topic ?? null; queued = r.queued || 0;
    // an edge: the hub is away (the topic comes once it is back), or too old to forward chat (r.note)
    note = r.note || (r.upstream === "down" ? "主節點連不上,恢復後補上" : "");
    unavailable = ""; failures = 0; retryAt = 0;
    await remember(id, { nick });
    status();
    await recordState();
    return true;
  }

  async function close() {
    await chain; // a reply still on its way goes out first
    const t = token;
    token = null; topic = null;
    if (t) { try { await call("/chat/close", {}, t); } catch {} }
  }

  async function tick() {
    if (ticking || !enabled || now() < retryAt) return;
    ticking = true;
    try {
      const id = await io.sessionId();
      if (!token || id !== sid) { if (!(await registerNow())) return; }
      if (pendingCmd && !inTurn) {
        if (!sent.includes(pendingCmd.mark)) pendingCmd = null; // its turn came (and went)
        else if (now() - pendingCmd.at > CMD_QUIET_MS) {
          const { mark, name } = pendingCmd;
          pendingCmd = null; sent = sent.filter((t) => t !== mark);
          replyToPhone(`✅ !${name} 已在終端機執行,但它沒有文字結果可以傳回來。`);
        }
      }
      if (!inTurn && sent.length && now() - sentAt > 60000) sent = []; // idle and it never started: give up on it
      if (inTurn || sent.length) return; // one message per idle moment; the rest wait at the relay
      let r;
      try { r = await call("/chat/take", { max: TAKE_MAX }, token); } catch { token = null; return backoff("relay 沒有回應"); }
      if (r.status === 401) { token = null; return; } // the relay restarted: register again next tick
      if (r.status !== 200) return backoff(`relay ${r.status}`);
      queued = r.queued || 0;
      if (r.upstream === "down") note = "主節點連不上,恢復後補上";
      else if (note === "主節點連不上,恢復後補上") note = "";
      // everything that piled up comes at once (an older relay hands over one); a command comes alone
      const msgs = (Array.isArray(r.messages) ? r.messages : r.message ? [r.message] : []).filter((m) => m?.text);
      for (const m of msgs) if (typeof m.file_path === "string") allowRead(m.file_path);
      if (msgs.length === 1 && PHONE_COMMAND.test(msgs[0].text.trim())) runCommand(msgs[0]).catch(() => {});
      else if (msgs.length) submitText(msgs);
      status();
    } finally { ticking = false; }
  }

  // phone messages → one prompt; one the human sent as a Telegram reply carries the message it replied to
  function submitText(msgs) {
    const text = msgs.map((m) => `[Telegram${m.from ? ` · ${m.from}` : ""}] ${replyLine(m.reply_to)}${m.text}`).join("\n\n");
    const forget = () => { sent = sent.filter((t) => t !== text); };
    sent.push(text); sentAt = now();
    io.submit(text).then((res) => { if (res?.drop) forget(); }, forget);
  }
  // a reply that is not a model turn (a command's output) goes to the phone as this "turn"'s answer
  function replyToPhone(text) {
    progress({ event: "start", origin: "phone" });
    progress({ event: "done", text });
  }
  // "!name args" from the phone: run /name as if typed at the terminal. A prompt command (a skill, a
  // markdown command) starts a turn, reported as usual; a local one (/compact) prints text, which goes
  // back as the answer. !usage / !cost / !context / !status are answered here from $.session.usage()
  // (the built-ins draw a terminal panel); another built-in run bare is refused (a panel too). Our
  // own /myna:chat and /myna:nick are answered here directly — the engine does not route a plugin's
  // own $.command.run through that plugin's hooks.
  async function runCommand(m) {
    const [, raw, rest = ""] = PHONE_COMMAND.exec(m.text.trim());
    const name = raw.toLowerCase(), args = rest.trim();
    if (USAGE_NAMES.has(name)) {
      let u = null;
      try { u = await io.usage(); } catch {}
      return replyToPhone(u ? usageText(u, nick) : "📊 這個 Claude Code 版本拿不到用量資料。");
    }
    if (name === "myna:chat") {
      if (args.toLowerCase() === "off") { replyToPhone(`💬 聊天已關閉:這個 session 不再收 Telegram 訊息。要重新開啟,請在終端機執行 /myna:config chat on。\n${CHAT_ALIAS_HINT_PHONE}`); await chatCommand(args); return; }
      return replyToPhone(`${await chatCommand(args, "!")}\n${CHAT_ALIAS_HINT_PHONE}`);
    }
    // !myna:config chat …: as !myna:chat (our own $.command.run would skip our command.run hook and reach
    // config.mjs, which has no session); any other item runs as a command below
    const cc = name === "myna:config" ? configChatArgs(args) : null;
    if (cc === "off") { replyToPhone("💬 聊天已關閉:這個 session 不再收 Telegram 訊息。要重新開啟,請在終端機執行 /myna:config chat on。"); await chatCommand(cc); return; }
    if (cc !== null) return replyToPhone(await configChat(cc, "!"));
    if (name === "myna:nick") return replyToPhone(await nickCommand(args));
    let info = null;
    try { info = (await io.list()).find((c) => c.name === name) || null; } catch {}
    if (info?.source === "builtin" && !args && !BUILTIN_BARE_OK.has(name)) {
      return replyToPhone(`⚠️ !${name} 不帶參數會在終端機開面板,手機上無法操作;請帶上參數(例如 !model opus)。看用量請打 !usage。`);
    }
    const mark = `<command-name>/${name}</command-name>`; // how a command's turn reads in turn.start
    const forget = () => { sent = sent.filter((t) => t !== mark); };
    sent.push(mark); sentAt = now();
    let res;
    try { res = await io.run({ command: name, args }); } catch (x) {
      forget();
      const why = String(x?.message || x || "");
      if (/no command named/i.test(why)) return submitText([m]); // "/tmp 是什麼" — just text after all
      return replyToPhone(`⚠️ !${name} 沒有執行:${why.replace(/^.*?\$\.command\.run:\s*/, "")}`);
    }
    if (typeof res?.text === "string") { forget(); replyToPhone(res.text.trim() || `✅ !${name} 已執行。`); return; }
    // no text: a prompt command — its turn starts once the session is idle and turn.start clears the
    // mark; if no turn comes (a panel after all), tick tells the phone after CMD_QUIET_MS
    pendingCmd = { mark, name, at: now() };
  }

  function start() {
    if (timer || !io) return;
    timer = io.every(POLL_MS, () => { tick().catch(() => {}); });
    tick().catch(() => {});
  }
  function stop() { if (timer) { timer.cancel(); timer = null; } }

  // progress reports, kept in order; a failure never touches the turn
  function progress(body) {
    if (!enabled || !token) return;
    const t = token;
    chain = chain.then(() => call("/chat/progress", body, t)).then(
      (r) => { if (r.status === 401 && token === t) token = null; },
      () => {},
    );
  }

  on("session.start", async ($, e, next) => {
    mayRead.clear(); // a new (or resumed) session: nothing handed to it yet
    const r = await next(e);
    io = {
      fetch: (url, init) => $.http.fetch(url, init),
      read: (p) => $.fs.read(p),
      write: (p, text) => $.fs.write(p, text),
      sessionId: () => $.session.id(),
      root: () => $.session.root(),
      cwd: () => $.session.cwd(),
      status: (text) => $.ui.status(text),
      submit: (text) => $.prompt.submit({ text }),
      run: (a) => $.command.run(a),
      list: () => $.command.list(),
      usage: () => $.session.usage(),
      every: (ms, fn) => $.clock.every(ms, fn),
      storeGet: (k) => $.store.get(k),
      storeSet: (k, v) => $.store.set(k, v),
      storeDelete: (k) => $.store.delete(k),
      storeKeys: () => $.store.keys(),
    };
    try {
      cfg = await settings({
        HOME: await $.env.get("HOME"),
        USERPROFILE: await $.env.get("USERPROFILE"),
        MYNA_ENV: await $.env.get("MYNA_ENV"),
        RELAY_PORT: await $.env.get("RELAY_PORT"),
        MYNA_RELAY_URL: await $.env.get("MYNA_RELAY_URL"),
        MYNA_RELAY_SECRET_FILE: await $.env.get("MYNA_RELAY_SECRET_FILE"),
        MYNA_CHAT: await $.env.get("MYNA_CHAT"),
        MYNA_CHAT_NICK: await $.env.get("MYNA_CHAT_NICK"),
      });
      await prune();
      const entry = await $.env.get("CLAUDE_CODE_ENTRYPOINT");
      let want = e.isInteractive || entry === "claude-vscode";
      if (cfg.chat === "on") want = true;
      if (cfg.chat === "off") want = false;
      const mine = await saved(await $.session.id());
      if (typeof mine.on === "boolean") want = mine.on;
      enabled = want;
      if (enabled) start();
      await recordState();
    } catch {}
    return r;
  });

  on("session.end", async ($, e, next) => {
    // after a /clear or an in-app /resume the process goes on under another session id: keep polling,
    // the next tick registers that one; any other reason is the process going away
    if (e.reason !== "clear" && e.reason !== "resume") stop();
    await recordState({ ended: true, id: e.sessionId });
    mayRead.clear();
    await close();
    return next(e);
  });

  // where each prompt came from, for turn.start (which has no origin). Kept before next(e): the turn
  // starts inside it. A prompt delivered into a running turn (turnId) starts none; a slash command's
  // turn reads otherwise (and it was typed); a dropped prompt never starts one
  on("prompt.submit", async ($, e, next) => {
    refreshState(); // not awaited: the prompt never waits for it (it never throws)
    let entry = null;
    if (!e.turnId && !e.command && e.origin && e.text) {
      const t = now();
      entry = { text: String(e.text), origin: e.origin, at: t };
      submitted = [...submitted.filter((s) => t - s.at < 120000), entry].slice(-20);
    }
    const r = await next(e);
    if (entry && r?.drop) submitted = submitted.filter((s) => s !== entry);
    return r;
  });

  on("turn.start", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId) return r; // a subagent's run: one Agent line in the main loop's progress already
    // a turn started from the phone never passes prompt.submit (our own $.prompt.submit skips our hooks):
    // refresh here too, or a session used only from the phone would look dead after 30 days
    refreshState();
    inTurn = true;
    const text = String(e.text || "");
    // our own prompt: the engine frames it ("The myna plugin sent a message: …"), so look for the text
    // we sent (the hook that submitted it can't mark it at prompt.submit — that frame is skipped)
    const mine = sent.find((t) => text.includes(t));
    if (mine) sent = sent.filter((t) => t !== mine);
    // the prompts this turn carries (framed, or several queued ones in one turn): oldest first, one per text
    const origins = [], seen = new Set();
    submitted = submitted.filter((s) => {
      if (seen.has(s.text) || !text.includes(s.text)) return true;
      seen.add(s.text); origins.push(s.origin);
      return false;
    });
    const label = mine ? null : turnSource(text, origins);
    progress(mine ? { event: "start", origin: "phone" }
      : label ? { event: "start", origin: "background", label }
      : { event: "start", origin: "terminal", ...(text ? { prompt: text.slice(0, 2000) } : {}) });
    return r;
  });

  on("turn.step", async function* ($, e, next) {
    const r = yield* next(e);
    // the main loop's steps only: a subagent's run is one Agent line already
    if (!e.agentId && r?.toolUses?.length) {
      progress({ event: "step", text: String(r.answer || "").slice(0, 4000), tools: r.toolUses.slice(0, 50).map((t) => ({ name: t.name, input: slimInput(t.input) })) });
    }
    return r;
  });

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (!e.agentId) {
      inTurn = false;
      // the relay takes up to 256 KB of JSON; an answer longer than this is cut (it goes out in 4000-char parts)
      progress({ event: "done", text: String(e.answer || "").slice(0, 100000), interrupted: !!e.isAborted });
    }
    return r;
  });

  // A Read of a file the human sent this session from the phone: no prompt. Only ever turns Claude Code's
  // "ask" into "allow" — never a deny (a deny rule, a PreToolUse hook), never a subagent's call, never
  // with permissions.blockReadsOutsideWorkingDirectories on. The path must be one the relay handed over,
  // compared whole (readKey), and still a plain file there: not a link, resolving to itself. Anything
  // that cannot be checked leaves Claude Code's decision as it was (it asks); a throw does the same.
  on("tool.check", { tool: "Read" }, async ($, e, next) => {
    const d = await next(e);
    if (d?.decision !== "ask" || e.agentId) return d;
    const key = readKey(e.input?.file_path);
    const p = key && mayRead.get(key);
    if (!p) return d;
    try {
      const s = await $.settings.read();
      if (s?.permissions?.blockReadsOutsideWorkingDirectories === true) return d;
      // the path Read will read, resolved: it must be the very file handed over — same string, case
      // included (a case-sensitive folder on Windows can hold File.pdf and file.pdf)
      const asked = e.input.file_path;
      const st = await $.fs.stat(asked, { resolve: true });
      if (!st || st.kind !== "file" || st.isLink !== false) return d;
      if (typeof st.realPath === "string") { if (st.realPath !== p) return d; }
      else {
        // no realPath (an older CLI): the path exactly as handed over, and the two folders above it no links
        if (asked !== p) return d;
        const a = await $.fs.stat(parentOf(p));
        const b = await $.fs.stat(parentOf(parentOf(p)));
        if (!a || a.kind !== "dir" || a.isLink !== false || !b || b.kind !== "dir" || b.isLink !== false) return d;
      }
    } catch { return d; }
    return { decision: "allow", reason: "myna:這個 session 從 Telegram 收到的附檔" };
  });

  // /myna:chat and /myna:nick: answered here; the markdown files are the fallback for an old CLI
  on("command.run", { command: "myna:chat" }, async ($, e) => ({ text: `${await chatCommand(e.args)}\n${CHAT_ALIAS_HINT}` }))
    .catch(() => ({ text: "💬 /myna:chat 執行失敗,請再試一次。" })); // never fall through to the old-CLI text
  // /myna:config chat [on|off]: the same as /myna:chat, answered here (chat is this session's); any other
  // item goes on to commands/config.md → scripts/config.mjs
  on("command.run", { command: "myna:config" }, async ($, e, next) => {
    const c = configChatArgs(e.args);
    // args is always set in a session ("" when bare); a plugin's own $.command.run may leave it out
    return c === null ? next(e.args === undefined ? { ...e, args: "" } : e) : { text: await configChat(c) };
  // the engine's guard form: once next was called, next(e) here replays what it settled to (nothing runs twice)
  }).catch(($, e, next) => (configChatArgs(e.args) !== null && !next.called ?{ text: "💬 /myna:config chat 執行失敗,請再試一次。" } : next(e)));
  on("command.run", { command: "myna:nick" }, async ($, e) => ({ text: await nickCommand(e.args) }))
    .catch(() => ({ text: "💬 /myna:nick 執行失敗,請再試一次。" }));

  // "/myna:config chat <value>": on | off | "" (the state); anything else is refused (config.mjs refuses
  // a bad value for every other item too)
  async function configChat(arg, p = "/") {
    if (arg !== "" && arg !== "on" && arg !== "off") return `💬 chat 只接受 on 或 off(你給的是「${arg}」),沒有改。`;
    // the state comes with what the item is for and what it takes, like every other /myna:config <item>
    return arg === "" ? `${await chatCommand(arg, p)}\n${CHAT_CONFIG_INFO}` : chatCommand(arg, p);
  }

  // p: how the human types a command where the reply goes ("/" at the terminal, "!" on the phone)
  async function chatCommand(args, p = "/") {
    if (!io || !cfg) return "💬 聊天模組還沒準備好,請稍後再試。";
    const arg = String(args || "").trim().toLowerCase();
    const id = await io.sessionId();
    if (arg === "on") {
      enabled = true; failures = 0; retryAt = 0;
      await remember(id, { on: true });
      const okNow = token || (await registerNow());
      start();
      await recordState();
      return okNow ? `💬 聊天已開啟:這個 session 在 Telegram 叫 ${nick}。` : `💬 聊天已開啟,但還連不上 relay(${unavailable}),會自動重試。`;
    }
    if (arg === "off") {
      enabled = false; stop(); await close(); status();
      await remember(id, { on: false });
      await recordState();
      return "💬 聊天已關閉:這個 session 不再收 Telegram 訊息,也不回報進度。";
    }
    if (!enabled) return "💬 聊天目前關閉。用 /myna:config chat on 開啟。";
    if (!token) return `💬 聊天開啟中,但還沒連上 relay${unavailable ? `(${unavailable})` : ""}。`;
    return `💬 聊天開啟中:暱稱 ${nick}${queued ? `,${queued} 則訊息待處理` : ""}。改名用 ${p}myna:nick <名字>。`;
  }

  async function nickCommand(args) {
    if (!io || !cfg) return "💬 聊天模組還沒準備好,請稍後再試。";
    const want = String(args || "").trim();
    if (!want) return nick && token ? `💬 這個 session 的暱稱是 ${nick}。` : "💬 這個 session 還沒有註冊聊天(/myna:config chat on)。";
    const id = await io.sessionId();
    if (!token) {
      await remember(id, { nick: want });
      return `💬 已記下暱稱「${want}」,連上 relay 時會用它。`;
    }
    let r;
    try { r = await call("/chat/nick", { nick: want }, token); } catch { return "💬 relay 沒有回應,暱稱沒有改。"; }
    if (r.status !== 200 || !r.nick) return `💬 改名失敗(relay ${r.status})。`;
    nick = r.nick;
    await remember(id, { nick });
    status();
    await recordState();
    return nick === want.toLowerCase() ? `💬 暱稱改為 ${nick}。` : `💬 暱稱改為 ${nick}(「${want}」已被用走或含不能用的字元)。`;
  }
};
