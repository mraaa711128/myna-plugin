// Myna tree transport, batch 0 (SPEC §5.4): relays as nodes of a tree, sessions on two directly joined
// nodes talking to each other. The old hub/edge (MYNA_REMOTE_PORT / MYNA_ROLE=edge, the 7801 listener,
// /machines/*) is a separate path and is not touched here; one machine runs one or the other.
//
// Who is who (design-auth): the identity is a Tailscale account (tailscale:<login>). A relay's owner is
// the account this device is logged in with (tailscale whois of its own address) — or, for a tagged
// device (no user), the owner its parent assigned when it joined. IM accounts are only where buttons
// are pressed: one is bound to an identity once, through a link that opens only inside the tailnet.
//
// Pieces:
//   node listener   127.0.0.1:MYNA_NODE_PORT (default 7802), only behind `tailscale serve
//                   --proxy-protocol=1 --tls-terminated-tcp=<serve port>`: every connection starts with a
//                   PROXY v1 line (no line → closed); its source address is asked to `tailscale whois`.
//                   POST /node/join, GET /node/join/<id>   a child asks to join (no token yet)
//                   GET|POST /bind/<code>                   an IM account bound to the opener's identity
//                   GET /node/health, POST /node/send, POST /node/take, POST /node/result
//                                                           a child: its node token AND the device it
//                                                           joined from (whois StableID + account) — 401 otherwise
//   parent link     a child keeps a long-poll POST /node/take open to its parent (messages coming down) and
//                   sends up with POST /node/send (the reply is the result).
//   peer messages   POST /peer/send on the local port (the session's own chat token): the relay stamps the
//                   envelope (from, owner, project, machine, session) from the session's record; the AI only
//                   writes `to` and the text. Batch 0 reaches the node itself and its direct neighbours.
//   delivery        the receiving node checks one rule (Q7: same owner), the pair's ⏹ / 20-message limit,
//                   posts a copy to its bot (when it has one; "show first" waits for that post), then puts
//                   the message in the session's inbox. The result goes back hop by hop:
//                   {delivered:true, to} | {delivered:false, reason, error, hint?} | {delivered:"unknown"}.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { createTailscale, identityOf, normIp } from "./tailscale.mjs";
import {
  machineStore, newMachineId, newMachineToken, sha256hex, sameHex, bearerOf, readBody, writePrivate,
  NAME_RE, CODE_RE, ENROLL_SECRET_HEADER,
} from "./remote.mjs";
import { normNick } from "./chat.mjs";

export const NODE_PROTOCOL = 1;
export const DEFAULT_NODE_PORT = 7802;
export const DEFAULT_SERVE_PORT = 8443;
export const PEER_TEXT_MAX = 3500;
export const JOIN_ALLOW = "✅ 允許", JOIN_DENY = "❌ 拒絕";
const ONLINE_GAP_MS = 3000;        // a child is online while a take is open, or one ended less than this ago
const TAKE_WAIT_MAX_MS = 25000;
const RESULT_KEEP_MS = 3600000;    // id → result, for a resend of the same message (a reply lost on the way)

export const nodeFiles = (cfg, dir) => ({
  parent: cfg.MYNA_NODE_PARENT_FILE || path.join(dir, "node-parent.json"),
  token: cfg.MYNA_NODE_TOKEN_FILE || path.join(dir, "node-token"),
  children: cfg.MYNA_NODE_CHILDREN_FILE || path.join(dir, "node-children.json"),
  bindings: cfg.MYNA_BINDINGS_FILE || path.join(dir, "bindings.json"),
  pairs: path.join(dir, "peer-pairs.json"),
  sessionTokens: path.join(dir, "session-tokens"),
});
const intOf = (v, dflt, min = 0) => { const n = Number(String(v ?? "").trim()); return String(v ?? "").trim() !== "" && Number.isInteger(n) && n >= min ? n : dflt; };
// the tree settings in .env: MYNA_TRANSPORT=tree (the mode; written by /myna:hub tree and /myna:join tree),
// MYNA_NODE_PORT (this node takes children / bind links), MYNA_NODE_SERVE_PORT (the tailnet port in front of it)
export function treeSettings(cfg) {
  const tree = String(cfg.MYNA_TRANSPORT || "").trim().toLowerCase() === "tree";
  const raw = String(cfg.MYNA_NODE_PORT ?? "").trim();
  const port = raw ? intOf(raw, null, 1) : null;
  return { tree, port: port && port <= 65535 ? port : null, portRaw: raw, servePort: intOf(cfg.MYNA_NODE_SERVE_PORT, DEFAULT_SERVE_PORT, 1) };
}
export const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
export function readBindings(file) {
  const j = readJson(file);
  return Array.isArray(j?.bindings) ? j.bindings.filter((b) => b && typeof b.im === "string" && typeof b.identity === "string") : [];
}
export const saveBindings = (file, list) => writePrivate(file, JSON.stringify({ version: 1, bindings: list }, null, 2) + "\n");
// a session token file's name (the MCP server of that session reads it to call /peer/send)
export const sessionTokenName = (sid) => String(sid).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);

// "kite" or "kite@mac" → {nick, node|null}; anything else (dots, a second @, characters a nick may not
// have) → null: a look-alike character can never make a look-alike address
export function parseAddress(s) {
  const raw = String(s ?? "").trim().toLowerCase().replace(/^@/, "");
  const m = /^([^@]+)(?:@([^@]+))?$/.exec(raw);
  if (!m) return null;
  const nick = m[1], node = m[2] ?? null;
  if (!nick || normNick(nick) !== nick) return null;
  if (node !== null && !NAME_RE.test(node)) return null;
  return { nick, node };
}
// zero-width / direction marks / control characters (but newline and tab) out of a peer message
export const cleanPeerText = (t) => String(t ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g, "");

// PROXY protocol v1: "PROXY TCP4|TCP6 <src> <dst> <sport> <dport>\r\n" (≤ 107 bytes) → the source address
export function parseProxyLine(line) {
  const m = /^PROXY (TCP4|TCP6) (\S+) (\S+) (\d{1,5}) (\d{1,5})$/.exec(line);
  if (!m || net.isIP(m[2]) === 0) return null;
  return normIp(m[2]);
}

const html = (title, body) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.6}button{font-size:1.1rem;padding:.6rem 1.2rem}</style></head><body>${body}</body></html>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// cfg, log, dir: as the relay's; version; machineName: this relay's own name (MYNA_MACHINE_NAME / host);
// chat: the chat core (src/chat.mjs); provider(): the current IM provider; botId(): its bot id or null;
// conflict: why the tree must stay off ("" = it may run) — the old multi-machine settings win on one machine
export function createNode({ cfg, log, dir, version, machineName, chat, provider, botId, conflict = "" }) {
  const S = treeSettings(cfg);
  const F = nodeFiles(cfg, dir);
  const ts = createTailscale(cfg);
  const parentRec = conflict ? null : readJson(F.parent);
  const active = S.tree && !conflict;                 // the tree mode is on here
  const listenPort = conflict ? null : S.port;        // the node listener (children, bind links)
  const ownName = (parentRec && NAME_RE.test(String(parentRec.name || "")) ? parentRec.name : machineName);
  const PEER_BUDGET_MS = intOf(cfg.MYNA_PEER_BUDGET_MS, 20000, 500);
  const PAIR_MAX = intOf(cfg.MYNA_PEER_PAIR_MAX, 20, 1);
  const JOIN_TTL_MS = intOf(cfg.MYNA_JOIN_TTL_MS, 600000, 1000);
  const BIND_TTL_MS = 600000;
  const hasBot = () => { const p = provider(); return !!p && p.name !== "none"; };
  // "show first, then deliver" (M10): on by default where this relay has a bot; off where it has none
  const showFirst = () => {
    const v = String(cfg.MYNA_PEER_SHOW_FIRST ?? "").trim().toLowerCase();
    return hasBot() && v !== "off";
  };

  // --- this device (M1) ------------------------------------------------------------------------------
  let me = null, meError = "not checked yet";
  async function refreshMe() {
    const s = await ts.self();
    if (s) { me = s; meError = ""; } else meError = ts.lastError() || "tailscale gave no answer";
    return me;
  }
  // tailscale:<login>; a tagged device: the owner its parent assigned at join; unknown → null
  const owner = () => (me ? identityOf(me) || (me.tags.length && parentRec?.owner ? String(parentRec.owner).toLowerCase() : null) : null);

  // --- bindings (M4): telegram:<id> → tailscale:<login>, read whenever needed (/myna:bind edits the file) --
  const bindings = () => readBindings(F.bindings);
  const ownerBound = () => { const o = owner(); return !!o && bindings().some((b) => b.identity.toLowerCase() === o && b.im.startsWith("telegram:")); };
  const binds = new Map(); // one-time bind code → {im, name, expires}
  const nameOf = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(" ") || (from?.username ? `@${from.username}` : `id ${from?.id}`);
  function bindStart(from) {
    if (!from?.id || from.is_bot) return { error: "這個帳號不能綁定（bot 或匿名管理員）" };
    if (!listening || !me?.dns_name) return { error: "這台沒有開 tree 的 listener（/myna:hub tree），沒辦法綁定" };
    for (const [c, b] of binds) if (b.expires < Date.now()) binds.delete(c);
    const code = crypto.randomBytes(15).toString("base64url");
    binds.set(code, { im: `telegram:${from.id}`, name: nameOf(from), expires: Date.now() + BIND_TTL_MS });
    return { link: `https://${me.dns_name}:${S.servePort}/bind/${code}` };
  }
  // may this IM user press an important button (M4)? only one bound to this relay's owner
  function mayPress(from) {
    const o = owner();
    if (!from || !from.id || from.is_bot) return { ok: false, why: "這個按鈕只認綁過的帳號（匿名或 bot 不算）" };
    if (!o) return { ok: false, why: `這台查不到 owner（Tailscale：${meError || "?"}）` };
    if (bindings().some((b) => b.im === `telegram:${from.id}` && b.identity.toLowerCase() === o)) return { ok: true };
    return { ok: false, why: `這個按鈕只認綁到 ${o} 的 Telegram 帳號`, link: bindStart(from).link };
  }

  // --- children (parent side): node-children.json, same record shape and token as machines.json --------
  const children = listenPort ? machineStore(F.children, {
    onRevoked: (ids) => { for (const id of ids) { const L = links.get(id); if (L) { failLink(L, "revoked"); links.delete(id); } log(`node: child ${id} revoked — its token no longer works`); } },
    onError: (m) => log(`node: ${m}`),
  }) : null;
  if (children) setInterval(() => children.refresh(), 5000).unref();
  const childByName = (name) => children?.active().find((c) => c.name === name) || null;

  // --- pairs: ⏹ and the 20-message limit, kept at this end (both directions pass both ends) -----------
  const pairs = new Map(); // `${sid}\n${remote address}` → {count, stopped, warned}
  for (const k of readJson(F.pairs)?.stopped || []) pairs.set(String(k), { count: 0, stopped: true });
  const pairOf = (sid, remote) => { const k = `${sid}\n${remote}`; if (!pairs.has(k)) pairs.set(k, { count: 0, stopped: false }); return { key: k, st: pairs.get(k) }; };
  const savePairs = () => { try { writePrivate(F.pairs, JSON.stringify({ stopped: [...pairs].filter(([, v]) => v.stopped).map(([k]) => k) }) + "\n"); } catch (e) { log("node: could not save", F.pairs, e.message); } };
  function pairBlock(sid, remote) {
    const { st } = pairOf(sid, remote);
    if (st.stopped) return { delivered: false, reason: "stopped", error: "這段對話在 Telegram 被 ⏹ 停住了，等人按 ▶️ 或在這個 session 打字後再試" };
    if (st.count >= PAIR_MAX) {
      if (!st.warned) { st.warned = true; Promise.resolve(provider()?.notify?.(`🛑 ${remote} ↔ ${chat.ctx.get(sid)?.nick || sid}：自動來回到了 ${PAIR_MAX} 則，先停下來。在這個 session 打字（終端機或 Telegram）就解除。`)).catch(() => {}); }
      return { delivered: false, reason: "needs_human", error: `這兩個 session 已經自動來回 ${PAIR_MAX} 則，要有人在這個 session 打字才會繼續` };
    }
    return null;
  }
  function peerControl(op, key) {
    const st = pairs.get(key);
    if (!st) return { ok: false, text: "這個按鈕已失效（relay 重啟過，或那個 session 已結束）" };
    const [sid, remote] = key.split("\n");
    const nick = chat.ctx.get(sid)?.nick || sid;
    if (op === "stop") { st.stopped = true; savePairs(); log(`node: pair ${nick} ↔ ${remote} stopped (⏹)`); return { ok: true, stopped: true, text: `⏹ 已停住 ${remote} ↔ ${nick}：兩個方向之後的訊息都會擋下。按 ▶️ 恢復。` }; }
    if (op === "resume") { st.stopped = false; st.count = 0; st.warned = false; savePairs(); log(`node: pair ${nick} ↔ ${remote} resumed (▶️)`); return { ok: true, stopped: false, text: `▶️ 已恢復 ${remote} ↔ ${nick}。` }; }
    return { ok: false, text: "?" };
  }
  // a human typed into this session (terminal or phone): its pairs count from zero again (⏹ stays)
  function onHuman(sid) { for (const [k, st] of pairs) if (k.startsWith(`${sid}\n`)) { st.count = 0; st.warned = false; } }
  function onSessionClosed(sid) { let gone = false; for (const k of [...pairs.keys()]) if (k.startsWith(`${sid}\n`)) { if (pairs.get(k).stopped) gone = true; pairs.delete(k); } if (gone) savePairs(); }

  // --- delivery on this node (the message's address is a session here) -------------------------------
  const results = new Map();  // `${sender stable id}:${id}` → {at, result}
  const inflight = new Map();
  let displayFailed = 0, lastDisplayFailure = null;
  setInterval(() => { const now = Date.now(); for (const [k, v] of results) if (now - v.at > RESULT_KEEP_MS) results.delete(k); }, 600000).unref();
  const localHint = () => ({ here: chat.ctx.list().map((n) => `${n}@${ownName}`), children: children ? children.active().map((c) => c.name) : [], parent: parentRec?.parent?.name || null });
  const notFound = (why) => ({ delivered: false, reason: "not_found", error: why, hint: localHint() });
  const quoted = (t) => t.split(/\r?\n/).map((l) => `> ${l}`).join("\n");
  const showText = (env, to, tail = "") => `📨 ${env.from} → ${to}${tail}\n${[env.owner, env.project].filter(Boolean).join(" · ")}\n${quoted(env.body.text)}`;
  async function show(sid, text, key) {
    const p = provider();
    if (!p?.peerShow) return false;
    try { return !!(await p.peerShow({ sid, text, pair: key })); } catch (e) { log("node: peerShow err", e.message); return false; }
  }
  function deliverLocal(env) {
    const k = `${env.machine?.stable_id || "local"}:${env.id}`;
    const hit = results.get(k);
    if (hit) return Promise.resolve(hit.result);
    if (inflight.has(k)) return inflight.get(k);
    const run = deliverNow(env).then((r) => { results.set(k, { at: Date.now(), result: r }); inflight.delete(k); return r; }, (e) => { inflight.delete(k); return { delivered: false, reason: "error", error: e.message }; });
    inflight.set(k, run);
    return run;
  }
  async function deliverNow(env) {
    const a = parseAddress(env.to);
    if (!a || (a.node && a.node !== ownName)) return notFound(`第 0 批只送到這台（${ownName}）和直接相鄰的節點`);
    const sid = chat.ctx.byNick(a.nick);
    if (!sid) return notFound(`這台（${ownName}）沒有叫 ${a.nick} 的 session`);
    const to = `${a.nick}@${ownName}`;
    // M11 (Q7): only the same owner may hand a session work
    const o = owner();
    if (!o || String(env.owner || "").toLowerCase() !== o) return { delivered: false, reason: "different_owner", error: `收件的 session 屬於 ${o || "（查不到 owner）"}，只收同一個 owner 的 session 傳來的訊息` };
    const blocked = pairBlock(sid, env.from);
    if (blocked) return blocked;
    const { key, st } = pairOf(sid, env.from);
    if (showFirst()) {
      const ok = await show(sid, showText(env, to), key);
      if (!ok) { displayFailed++; lastDisplayFailure = new Date().toISOString(); log(`node: ${env.from} → ${to}: the copy could not be posted to this relay's bot — not delivered (show first is on)`); return { delivered: false, reason: "display_failed", error: "收件那台的 bot 貼不出這則訊息，先給人看才送出的設定開著，所以沒有交付" }; }
      if (st.stopped) return pairBlock(sid, env.from); // ⏹ while it was being shown
    } else if (hasBot()) show(sid, showText(env, to), key).catch(() => {});
    const r = chat.ctx.deliver(sid, { text: env.body.text, from: env.from, via: "session", peer: { owner: env.owner, project: env.project, project_source: env.project_source, machine: env.machine?.name } });
    if (r.closed) return notFound(`${to} 已經結束`);
    st.count++;
    log(`node: ${env.from} → ${to} delivered (${env.body.text.length} chars)`);
    return { delivered: true, to };
  }

  // --- downward: the child's long-poll take ------------------------------------------------------------
  const links = new Map(); // child id → {queue, unacked, taking, lastEnd, waiters, wake}
  const linkOf = (id) => { if (!links.has(id)) links.set(id, { queue: [], unacked: [], taking: 0, lastEnd: 0, waiters: new Map(), wake: new Set() }); return links.get(id); };
  function failLink(L, why) { for (const [, w] of L.waiters) w({ delivered: false, reason: "unreachable", error: why }); L.waiters.clear(); for (const w of L.wake) w(); }
  const online = (L) => L.taking > 0 || Date.now() - L.lastEnd < ONLINE_GAP_MS;
  async function downSend(child, env, budgetMs) {
    const L = linkOf(child.id), until = Date.now() + budgetMs;
    if (!online(L)) return { delivered: false, reason: "unreachable", error: `${child.name} 現在沒有連上來` };
    while (!L.taking && Date.now() - L.lastEnd < ONLINE_GAP_MS && Date.now() < until) await sleep(50);
    if (!L.taking) return Date.now() >= until ? unknown() : { delivered: false, reason: "unreachable", error: `${child.name} 現在沒有連上來` };
    L.queue.push(env);
    for (const w of L.wake) w();
    const r = await new Promise((res) => { L.waiters.set(env.id, res); setTimeout(() => res(undefined), Math.max(0, until - Date.now())).unref?.(); });
    L.waiters.delete(env.id);
    return r === undefined ? unknown() : r;
  }
  const unknown = () => ({ delivered: "unknown", error: "等太久沒有結果，可能送到也可能沒有", hint: "不要重送同樣的內容；看 Telegram 有沒有 📨" });

  // --- upward (child side): the parent link -----------------------------------------------------------
  const up = parentRec && active ? {
    url: String(parentRec.url || "").replace(/\/+$/, ""), name: parentRec.parent?.name || "", stable: parentRec.parent?.stable_id || "",
    reachable: false, reason: "not checked yet", blocked: "", ack: [], verifiedIp: null, parentWho: null,
  } : null;
  const nodeToken = () => { try { return fs.readFileSync(F.token, "utf8").trim(); } catch { return ""; } };
  const upHeaders = (extra = {}) => ({ authorization: `Bearer ${nodeToken()}`, "x-myna-node-protocol": String(NODE_PROTOCOL), ...extra });
  async function upCheck() {
    if (!up) return;
    // the parent's name must still be its device (MagicDNS name given to another one → stop, wait for a human)
    try {
      const host = new URL(up.url).hostname.replace(/^\[|\]$/g, "");
      const ip = net.isIP(host) ? host : (await dns.lookup(host)).address;
      if (ip !== up.verifiedIp) {
        const who = await ts.whois(ip, { fresh: true });
        if (!who || who.stable_id !== up.stable) { up.blocked = `上層網址現在指到另一台裝置（${who?.name || ip}），停用往上送 — 重新 /myna:join tree`; up.reachable = false; up.reason = up.blocked; log(`node: ${up.blocked}`); return; }
        up.verifiedIp = ip; up.parentWho = who; up.blocked = "";
      }
    } catch (e) { up.reachable = false; up.reason = `cannot resolve the parent (${e.code || e.message})`; return; }
    try {
      const r = await fetch(`${up.url}/node/health`, { headers: upHeaders(), redirect: "manual", signal: AbortSignal.timeout(5000) });
      const j = await r.json().catch(() => null);
      if (r.status === 401) { up.reachable = false; up.reason = `the parent refused this node (401: ${j?.error || "token or device"}) — run /myna:join tree again`; return; }
      if (r.status !== 200 || j?.name !== "myna-relay" || j?.node_protocol !== NODE_PROTOCOL) { up.reachable = false; up.reason = `not a myna tree parent (HTTP ${r.status})`; return; }
      if (j.node?.name && j.node.name !== up.name) log(`node: the parent now calls itself ${j.node.name} (was ${up.name})`);
      if (!up.reachable) log(`node: parent ${up.name} (${up.url}) reachable`);
      Object.assign(up, { reachable: true, reason: "" });
    } catch (e) { if (up.reachable) log(`node: parent unreachable (${e.cause?.code || e.message})`); up.reachable = false; up.reason = `cannot connect (${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message})`; }
  }
  async function upSend(env, budgetMs) {
    if (!up.reachable || up.blocked) return { delivered: false, reason: "unreachable", error: `上層 ${up.name} 連不上：${up.blocked || up.reason}` };
    let r, j;
    try {
      r = await fetch(`${up.url}/node/send`, { method: "POST", headers: upHeaders({ "content-type": "application/json" }), body: JSON.stringify({ ...env, budget_ms: budgetMs }), redirect: "manual", signal: AbortSignal.timeout(budgetMs + 1000) });
      j = await r.json().catch(() => null);
    } catch (e) { return e.name === "TimeoutError" ? unknown() : { delivered: false, reason: "unreachable", error: `上層 ${up.name} 連不上（${e.cause?.code || e.message}）` }; }
    if (r.status === 401) { up.reachable = false; up.reason = `the parent refused this node (401)`; return { delivered: false, reason: "unreachable", error: "上層不認這台（token 或裝置不對，或被撤銷）" }; }
    if (r.status !== 200 || !j || !("delivered" in j)) return { delivered: false, reason: "unreachable", error: `上層回 HTTP ${r.status}${j?.error ? `：${j.error}` : ""}` };
    return j;
  }
  // the parent hands this node envelopes over the take long-poll; each is checked, delivered here, answered
  async function handleDown(env) {
    let r;
    const f = parseAddress(env?.from), t = parseAddress(env?.to);
    const po = up.parentWho ? identityOf(up.parentWho) || String(parentRec.parent?.owner || "").toLowerCase() : null;
    if (!env?.id || !f || f.node !== up.name || env.machine?.stable_id !== up.stable || (po && String(env.owner || "").toLowerCase() !== po) || typeof env.body?.text !== "string") r = { delivered: false, reason: "bad_stamp", error: "上層送來的信封章不對" };
    else if (!t || t.node !== ownName) r = notFound(`第 0 批只送到直接相鄰的節點`);
    else r = await deliverLocal(env);
    try { await fetch(`${up.url}/node/result`, { method: "POST", headers: upHeaders({ "content-type": "application/json" }), body: JSON.stringify({ id: env?.id, result: r }), redirect: "manual", signal: AbortSignal.timeout(5000) }); }
    catch (e) { log(`node: result of ${env?.id} not sent up (${e.cause?.code || e.message}) — the parent hands it again`); }
  }
  let stopped = false;
  async function takeLoop() {
    while (!stopped) {
      if (!up.reachable || up.blocked) { await sleep(1000); continue; }
      try {
        const r = await fetch(`${up.url}/node/take`, { method: "POST", headers: upHeaders({ "content-type": "application/json" }), body: JSON.stringify({ wait_ms: TAKE_WAIT_MAX_MS, ack: up.ack }), redirect: "manual", signal: AbortSignal.timeout(TAKE_WAIT_MAX_MS + 10000) });
        const j = await r.json().catch(() => null);
        if (r.status !== 200) { if (r.status === 401) { up.reachable = false; up.reason = "the parent refused this node (401)"; } await sleep(2000); continue; }
        const envs = Array.isArray(j?.envelopes) ? j.envelopes : [];
        up.ack = envs.map((e) => e?.id).filter(Boolean);
        for (const e of envs) handleDown(e).catch((x) => log("node: handling a message from the parent failed:", x.message));
      } catch { await sleep(1000); }
    }
  }

  // --- /peer/send (local port): a session sends ---------------------------------------------------------
  async function peerSend(req, res) {
    const reply = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const sid = chat.sidOfToken(bearerOf(req));
    const s = sid && chat.ctx.get(sid);
    if (!s || s.closed) return reply(401, { error: "session token missing or expired — the session's chat must be registered (/myna:config chat on)" });
    const { body, tooLarge } = await readBody(req, 64 * 1024);
    if (tooLarge) return reply(413, { error: "body too large" });
    let a; try { a = JSON.parse(body || "{}"); } catch { return reply(400, { error: "bad JSON" }); }
    const text = cleanPeerText(a?.text).trim();
    if (!text) return reply(400, { delivered: false, reason: "empty", error: "text is empty" });
    if (text.length > PEER_TEXT_MAX) return reply(400, { delivered: false, reason: "too_long", error: `text over ${PEER_TEXT_MAX} characters` });
    const to = parseAddress(a?.to);
    if (!to) return reply(400, { delivered: false, reason: "bad_address", error: "to must be <nick> or <nick>@<node> (a-z 0-9 - _)" });
    const o = owner();
    if (!o) return reply(503, { delivered: false, reason: "no_owner", error: `這台查不到 Tailscale 帳號（${meError}）` });
    const node = to.node || ownName, toFull = `${to.nick}@${node}`, from = `${s.nick}@${ownName}`;
    if (node === ownName && to.nick === s.nick) return reply(400, { delivered: false, reason: "to_self", error: "不能傳給自己" });
    const env = {
      v: 1, id: crypto.randomBytes(8).toString("hex"), kind: "chat", to: toFull, from, owner: o,
      project: s.project || null, project_source: s.project_source || null, machine: { name: ownName, stable_id: me?.stable_id || null }, session: sid,
      budget_ms: PEER_BUDGET_MS, body: { text },
    };
    const blocked = pairBlock(sid, toFull);
    if (blocked) return reply(200, blocked);
    let r;
    if (node === ownName) r = await deliverLocal(env);
    else if (childByName(node)) r = await downSend(childByName(node), env, PEER_BUDGET_MS);
    else if (up && up.name === node) r = await upSend(env, PEER_BUDGET_MS);
    else r = notFound(`找不到節點 ${node}：第 0 批只送到這台（${ownName}）和直接相鄰的節點`);
    if (r.delivered === true || r.delivered === "unknown") {
      const { key, st } = pairOf(sid, toFull);
      if (r.delivered === true) st.count++;
      // a copy on this relay's bot too (the receiving end's copy covers a message within this node)
      if (node !== ownName && hasBot()) show(sid, showText(env, toFull, r.delivered === true ? "（已送到）" : "（不確定有沒有送到）"), key).catch(() => {});
    }
    log(`node: ${from} → ${toFull}: ${r.delivered === true ? "delivered" : r.delivered === "unknown" ? "unknown" : r.reason}`);
    reply(200, r);
  }

  // --- the node listener ---------------------------------------------------------------------------------
  let listening = false, listenError = "";
  const joins = new Map(), joinByQ = new Map();
  const send = (res, code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const page = (res, code, title, body) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html(title, body)); };
  async function authChild(req) {
    const rec = children.verify(bearerOf(req));
    if (!rec) return { error: "node token missing, wrong or revoked" };
    const who = await ts.whois(req.socket.mynaSrc);
    if (!who) return { error: "the connection does not come from a tailnet device" };
    if (who.stable_id !== rec.tailnet?.stable_id) return { error: "wrong_device: this token belongs to another device" };
    const sameAccount = rec.login ? who.login === rec.login : !who.login && JSON.stringify(who.tags) === JSON.stringify(rec.tags || []);
    if (!sameAccount) return { error: "the device's Tailscale account (or tags) changed since it joined — join again" };
    return { rec, who };
  }
  async function handleNode(req, res) {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/node/join") return joinStart(req, res);
    const jm = /^\/node\/join\/([a-f0-9]{16})$/.exec(url.pathname);
    if (req.method === "GET" && jm) return joinPoll(req, res, jm[1]);
    const bm = /^\/bind\/([A-Za-z0-9_-]{20})$/.exec(url.pathname);
    if (bm && (req.method === "GET" || req.method === "POST")) return bindPage(req, res, bm[1]);
    const a = await authChild(req);
    if (a.error) { log(`node: 401 ${req.method} ${url.pathname} from ${req.socket.mynaSrc} — ${a.error}`); return send(res, 401, { error: a.error }); }
    const { rec } = a;
    if (req.method === "GET" && url.pathname === "/node/health") {
      return send(res, 200, { ok: true, name: "myna-relay", version, node_protocol: NODE_PROTOCOL, node: { name: ownName, stable_id: me?.stable_id || null, owner: owner() }, you: { name: rec.name, owner: rec.owner }, bot_id: botId() });
    }
    if (!active) return send(res, 503, { error: "this relay is not in tree mode" });
    if (req.method === "POST" && url.pathname === "/node/send") {
      const { body, tooLarge } = await readBody(req, 64 * 1024);
      if (tooLarge) return send(res, 413, { error: "body too large" });
      let env; try { env = JSON.parse(body || "{}"); } catch { return send(res, 400, { error: "bad JSON" }); }
      // M6: the stamps must be the ones Tailscale vouches for on this connection
      const f = parseAddress(env?.from);
      if (!env?.id || typeof env.body?.text !== "string" || !f || f.node !== rec.name || env.machine?.name !== rec.name || env.machine?.stable_id !== rec.tailnet.stable_id || String(env.owner || "").toLowerCase() !== rec.owner) {
        log(`node: bad stamp from ${rec.name}: from=${env?.from} owner=${env?.owner} machine=${JSON.stringify(env?.machine)}`);
        return send(res, 200, { delivered: false, reason: "bad_stamp", error: "信封的章跟連線的裝置或帳號對不上" });
      }
      env.body.text = cleanPeerText(env.body.text).slice(0, PEER_TEXT_MAX);
      return send(res, 200, await deliverLocal(env));
    }
    if (req.method === "POST" && url.pathname === "/node/take") {
      const { body } = await readBody(req, 64 * 1024);
      let b = {}; try { b = JSON.parse(body || "{}"); } catch {}
      const L = linkOf(rec.id);
      const ack = new Set(Array.isArray(b.ack) ? b.ack.map(String) : []);
      L.unacked = L.unacked.filter((e) => !ack.has(e.id));
      const wait = Math.max(0, Math.min(TAKE_WAIT_MAX_MS, Number(b.wait_ms) || 0));
      L.taking++;
      try {
        if (!L.unacked.length && !L.queue.length && wait) {
          let wake, timer;
          await new Promise((r) => { wake = r; timer = setTimeout(r, wait); L.wake.add(wake); res.on("close", r); });
          clearTimeout(timer); L.wake.delete(wake);
        }
        if (res.writableEnded || res.destroyed) return;
        if (!L.unacked.length) L.unacked = L.queue.splice(0);
        send(res, 200, { envelopes: L.unacked });
      } finally { L.taking--; L.lastEnd = Date.now(); }
      return;
    }
    if (req.method === "POST" && url.pathname === "/node/result") {
      const { body } = await readBody(req, 64 * 1024);
      let b = {}; try { b = JSON.parse(body || "{}"); } catch {}
      const L = linkOf(rec.id), w = L.waiters.get(String(b.id || ""));
      if (w && b.result && typeof b.result === "object") w(b.result);
      return send(res, 200, { ok: !!w });
    }
    send(res, 404, { error: `not available on the node port: ${req.method} ${url.pathname}` });
  }

  // --- join (M2) ---------------------------------------------------------------------------------------------
  const shown = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ").trim().slice(0, n) || "?";
  const accountLine = (who, o) => (who.login ? `帳號：tailscale:${who.login}` : `tagged：${who.tags.join(", ")}，按 ✅ 後 owner 會是你（${o}）`);
  function finishJoin(j, status, extra = {}) { clearTimeout(j.timer); Object.assign(j, { status, doneAt: Date.now(), ...extra }); joinByQ.delete(j.qid); for (const w of j.wake) w(); }
  async function joinStart(req, res) {
    const { body, tooLarge } = await readBody(req, 4096);
    if (tooLarge) return send(res, 413, { error: "body too large" });
    let a; try { a = JSON.parse(body || "{}"); } catch { return send(res, 400, { error: "bad JSON" }); }
    if (!active) return send(res, 503, { error: "this relay is not in tree mode (/myna:hub tree)" });
    const name = String(a?.name ?? "").trim().toLowerCase();
    if (!NAME_RE.test(name)) return send(res, 400, { error: "name must be 1–16 of a-z 0-9 - (starting with a letter or digit)" });
    if (!CODE_RE.test(String(a.code ?? ""))) return send(res, 400, { error: "code must look like ABC-234" });
    if (!/^[a-f0-9]{64}$/.test(String(a.enroll_secret_hash ?? ""))) return send(res, 400, { error: "enroll_secret_hash must be a hex SHA-256" });
    const who = await ts.whois(req.socket.mynaSrc, { fresh: true });
    if (!who) return send(res, 403, { error: "the connection does not come from a device of this tailnet (tailscale whois)" });
    const o = owner();
    if (!o) return send(res, 503, { error: `this relay has no owner (tailscale: ${meError || "?"})` });
    const open = [...joins.values()].filter((j) => j.status === "pending");
    if (open.length >= 3) return send(res, 429, { error: "too many join requests waiting (3)" });
    if (name === ownName || childByName(name) || open.some((j) => j.name === name)) return send(res, 409, { error: `the name "${name}" is taken here (this node, a child or a join waiting) — pick another --name` });
    if (a.bot_id && botId() && String(a.bot_id) === botId()) return send(res, 409, { error: "this node uses the same bot as the parent — one bot can serve only one relay" });
    // the phone when someone there can press the ✅ (Telegram, an account bound to the owner); else this
    // machine's terminal — never for a tagged parent (that would be the device approving itself)
    const viaPhone = provider()?.name === "telegram" && ownerBound();
    if (!viaPhone && me?.tags?.length) return send(res, 403, { error: "a tagged parent takes a new node only through a bot bound to its assigned owner (a terminal approval here would be the device approving itself)" });
    const enrollId = crypto.randomBytes(8).toString("hex"), qid = crypto.randomBytes(5).toString("hex");
    const j = { qid, name, os: shown(a.os, 24), hostname: shown(a.hostname, 64), code: a.code, secretHash: a.enroll_secret_hash, who, bot_id: a.bot_id ? String(a.bot_id) : null, expires: Date.now() + JOIN_TTL_MS, status: "pending", via: viaPhone ? "phone" : "terminal", wake: new Set() };
    joins.set(enrollId, j);
    if (viaPhone) {
      joinByQ.set(qid, enrollId);
      try {
        await provider().sendQuestion(qid, {
          header: "🆕 新節點要接到這台下面",
          question: `${name}（${j.os}，主機名 ${j.hostname}）要接到這台（${ownName}）下面。\n裝置：${shown(who.name, 80)}\n${accountLine(who, o)}\n核對碼：${j.code}\n先確認跟那台終端機上顯示的核對碼一樣，再按允許。不是你發起的就按拒絕。`,
          options: [JOIN_ALLOW, JOIN_DENY],
        });
      } catch (e) { joins.delete(enrollId); joinByQ.delete(qid); return send(res, 503, { error: `could not reach the phone: ${e.message}` }); }
    }
    j.timer = setTimeout(() => { if (j.status !== "pending") return; if (j.via === "phone") Promise.resolve(provider()?.cancelQuestion?.(qid, "join_expired")).catch(() => {}).finally(() => provider()?.onResolve?.(qid, { kind: "cancelled" })); finishJoin(j, "expired"); }, JOIN_TTL_MS);
    j.timer.unref?.();
    log(`node: ${name} (${who.name}, ${who.login || who.tags.join(",")}) asks to join — code ${j.code}, ${viaPhone ? "waiting for the tap" : "waiting for /myna:machines approve on this machine"}`);
    send(res, 202, { enroll_id: enrollId, expires_at: new Date(j.expires).toISOString(), approve: j.via, node_protocol: NODE_PROTOCOL });
  }
  function approve(j) {
    const o = owner();
    const id = newMachineId(), token = newMachineToken(id);
    const rec = { id, name: j.name, sha256: sha256hex(token), tailnet: { stable_id: j.who.stable_id, name: j.who.name, addrs: j.who.addrs }, login: j.who.login, tags: j.who.tags, owner: identityOf(j.who) || o, bot_id: j.bot_id, os: j.os, hostname: j.hostname, created_at: new Date().toISOString() };
    try { children.add(rec); } catch (e) { log("node: could not save", F.children, e.message); return finishJoin(j, "denied", { reason: "save_failed" }); }
    log(`node: ${j.name} joined (${rec.owner}${j.who.login ? "" : ", assigned"}) — child ${id} in ${F.children}`);
    finishJoin(j, "approved", { token, rec });
  }
  // a tap on a join question's buttons (only important-button checked ones reach here for ✅)
  function onTap(qid, result) {
    if (!joinByQ.has(qid)) return false;
    const j = joins.get(joinByQ.get(qid));
    joinByQ.delete(qid);
    provider()?.onResolve?.(qid, result);
    if (!j || j.status !== "pending") return true;
    if (result?.kind !== "selection" || result.value !== JOIN_ALLOW) { log(`node: join of ${j.name} denied on the phone`); finishJoin(j, "denied"); return true; }
    if (childByName(j.name)) { finishJoin(j, "denied", { reason: "name_taken" }); return true; }
    approve(j);
    return true;
  }
  async function joinPoll(req, res, enrollId) {
    const j = joins.get(enrollId);
    if (!j || !sameHex(sha256hex(String(req.headers[ENROLL_SECRET_HEADER] || "")), j.secretHash)) return send(res, 404, { error: "no such join request" });
    if (j.collectedAt !== undefined && Date.now() - j.collectedAt >= JOIN_TTL_MS) { joins.delete(enrollId); return send(res, 404, { error: "no such join request" }); }
    if (j.status === "pending") {
      let timer, wake;
      await new Promise((r) => { timer = setTimeout(r, 25000); wake = r; j.wake.add(wake); res.on("close", r); });
      clearTimeout(timer); j.wake.delete(wake);
    }
    if (res.destroyed) return;
    if (j.status === "pending") return send(res, 200, { status: "pending", expires_at: new Date(j.expires).toISOString() });
    if (j.status === "approved") {
      j.collectedAt ??= Date.now();
      return send(res, 200, { status: "approved", name: j.rec.name, child_id: j.rec.id, token: j.token, owner: j.rec.owner, parent: { name: ownName, stable_id: me?.stable_id || null, owner: owner() }, node_protocol: NODE_PROTOCOL });
    }
    joins.delete(enrollId);
    return send(res, 200, { status: j.status, ...(j.reason ? { reason: j.reason } : {}) });
  }
  // /myna:machines approve <code> on this machine (no bot here)
  function approveByCode(code) {
    const j = [...joins.values()].find((x) => x.status === "pending" && x.code === String(code || "").trim().toUpperCase());
    if (!j) return { ok: false, error: "沒有等待中的加入要求是這個核對碼" };
    if (j.via !== "terminal") return { ok: false, error: "這個加入要求送到手機了：要在手機上按 ✅（綁定過的帳號）" };
    if (me?.tags?.length) return { ok: false, error: "tagged 的上層不能在終端機核准" };
    approve(j);
    return j.status === "approved" ? { ok: true, name: j.name, owner: j.rec.owner } : { ok: false, error: `沒有加入成功（${j.reason || j.status}）` };
  }
  const joinList = () => [...joins.values()].filter((j) => j.status === "pending").map((j) => ({ name: j.name, code: j.code, os: j.os, hostname: j.hostname, device: j.who.name, account: j.who.login ? `tailscale:${j.who.login}` : `tagged ${j.who.tags.join(",")}`, approve: j.via, expires_at: new Date(j.expires).toISOString() }));

  // --- bind page (M4) --------------------------------------------------------------------------------------
  async function bindPage(req, res, code) {
    const b = binds.get(code);
    if (!b || b.expires < Date.now()) { binds.delete(code); return page(res, 404, "Myna 綁定", "<p>這個綁定連結無效或已過期。在 Telegram 再傳一次 <code>!bind</code>。</p>"); }
    const who = await ts.whois(req.socket.mynaSrc, { fresh: true });
    if (!who) return page(res, 403, "Myna 綁定", "<p>這個連線不是從 tailnet 裡的裝置來的。</p>");
    if (!who.login) return page(res, 403, "Myna 綁定", `<p>這台裝置是 tagged（${esc(who.tags.join(", "))}），沒有使用者帳號，不能當身分證。請用登入自己帳號的裝置打開。</p>`);
    const identity = `tailscale:${who.login}`;
    if (req.method === "GET") {
      return page(res, 200, "Myna 綁定", `<p>把 Telegram 帳號 <b>${esc(b.name)}</b> 綁到 <b>${esc(identity)}</b>？</p><p>綁定後，這個 Telegram 帳號可以替這個身分按 Myna 的確認鈕（✅ 核准、權限允許、新節點加入）。</p><form method="post"><button type="submit">確認綁定</button></form>`);
    }
    await readBody(req, 4096);
    binds.delete(code);
    const list = bindings().filter((x) => !(x.im === b.im && x.identity.toLowerCase() === identity));
    list.push({ im: b.im, identity, name: b.name, at: new Date().toISOString() });
    try { saveBindings(F.bindings, list); } catch (e) { return page(res, 500, "Myna 綁定", `<p>寫不進綁定檔：${esc(e.message)}</p>`); }
    log(`node: ${b.im} bound to ${identity}`);
    Promise.resolve(provider()?.notify?.(`🔐 已把 Telegram 帳號 ${b.name} 綁到 ${identity}。`)).catch(() => {});
    return page(res, 200, "Myna 綁定", `<p>✅ 已綁定：Telegram 帳號 <b>${esc(b.name)}</b> → <b>${esc(identity)}</b>。可以關掉這頁了。</p>`);
  }

  // --- the listener: a PROXY v1 line first, then plain HTTP on the same socket --------------------------
  function startListener() {
    const srv = http.createServer({ requestTimeout: 0, headersTimeout: 15000 }, (req, res) => {
      handleNode(req, res).catch((e) => { log("node: handler error:", e.message); try { send(res, 500, { error: "internal error" }); } catch {} });
    });
    const tcp = net.createServer((sock) => {
      let buf = Buffer.alloc(0), done = false;
      const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); } }, 5000);
      const onData = (chunk) => {
        if (done) return;
        buf = Buffer.concat([buf, chunk]);
        const i = buf.indexOf("\r\n");
        if (i < 0) { if (buf.length > 107) { done = true; clearTimeout(timer); sock.destroy(); } return; }
        done = true; clearTimeout(timer); sock.removeListener("data", onData);
        const src = i <= 105 ? parseProxyLine(buf.subarray(0, i).toString("latin1")) : null;
        if (!src) { log("node: a connection without a valid PROXY line — closed (only tailscale serve may connect here)"); sock.destroy(); return; }
        sock.mynaSrc = src;
        sock.pause();
        const rest = buf.subarray(i + 2);
        if (rest.length) sock.unshift(rest);
        srv.emit("connection", sock);
        sock.resume();
      };
      sock.on("data", onData);
      sock.on("error", () => {});
    });
    tcp.on("error", (e) => { listenError = e.message; log(`node: listener on 127.0.0.1:${listenPort} failed: ${e.message}`); });
    tcp.listen(listenPort, "127.0.0.1", () => { listening = true; log(`node: listener on 127.0.0.1:${listenPort} (behind tailscale serve :${S.servePort}, PROXY v1)${active ? "" : " — tree mode is not on yet: bind links only"}`); });
  }

  // --- local endpoints (127.0.0.1:RELAY_PORT; the relay already refused browsers and non-loopback hosts) ---
  async function handleLocal(req, res, url) {
    const p = url.pathname;
    if (req.method === "POST" && p === "/peer/send") { if (!active) return false; await peerSend(req, res); return true; }
    if (req.method === "GET" && p === "/node/joins") { if (!listenPort) return false; send(res, 200, { joins: joinList() }); return true; }
    if (req.method === "POST" && p === "/node/approve") {
      if (!listenPort) return false;
      if (!chat.secretOk(bearerOf(req))) { send(res, 401, { error: "relay secret required" }); return true; }
      const { body } = await readBody(req, 4096);
      let b = {}; try { b = JSON.parse(body || "{}"); } catch {}
      send(res, 200, approveByCode(b.code));
      return true;
    }
    return false;
  }

  function health() {
    return {
      tree: active, ...(conflict ? { off: conflict } : {}), protocol: NODE_PROTOCOL, name: ownName, owner: owner(),
      tailscale: me ? { stable_id: me.stable_id, dns_name: me.dns_name, tagged: me.tags.length > 0 } : { error: meError },
      listener: listenPort ? { port: listenPort, serve_port: S.servePort, listening, ...(listenError ? { error: listenError } : {}) } : null,
      parent: up ? { url: up.url, name: up.name, reachable: up.reachable, ...(up.reason ? { reason: up.reason } : {}) } : parentRec && !active ? { name: parentRec.parent?.name || null, reachable: false, reason: "tree mode off" } : null,
      children: children ? children.active().length : 0, joining: joinList().length,
      bindings: bindings().length, owner_bound: ownerBound(), show_first: showFirst(),
      display_failed: displayFailed, ...(lastDisplayFailure ? { last_display_failure: lastDisplayFailure } : {}),
    };
  }

  async function start() {
    if (conflict) { if (S.tree || S.port || readJson(F.parent)) log(`node: tree transport off — ${conflict}`); return; }
    if (!S.tree && !listenPort) return;
    await refreshMe();
    if (!me) log(`node: tailscale: ${meError} — no owner; joins, binds and peer messages are refused until it answers`);
    else log(`node: this device ${me.dns_name || me.ip} (${me.stable_id}), owner ${owner() || "none (tagged, not joined)"}${active ? `, tree mode on as "${ownName}"` : ""}`);
    setInterval(() => { refreshMe().catch(() => {}); }, 300000).unref();
    if (listenPort) startListener();
    if (up) {
      await upCheck();
      setInterval(() => { upCheck().catch(() => {}); }, intOf(cfg.MYNA_UPSTREAM_CHECK_MS, 10000, 50)).unref();
      takeLoop();
    }
  }

  return {
    active, listenerConfigured: !!listenPort, ownName, start, health, handleLocal, onTap, mayPress, ownerBound, bindStart, peerControl, onHuman, onSessionClosed,
    isJoinQuestion: (qid) => joinByQ.has(qid), listening: () => listening, owner,
    sessionTokenDir: active ? F.sessionTokens : null,
    stop() { stopped = true; },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
