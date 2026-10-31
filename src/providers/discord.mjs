// Discord provider — Gateway WebSocket (built-in WebSocket, Node 22+; zero npm deps) + REST v10.
// intents=0: buttons and modals arrive as INTERACTION_CREATE, which needs NO privileged intent —
// so the bot never reads channel messages and stray chat can't be mistaken for an answer
// (decision 8a holds structurally: free text only ever arrives via the ✍️ modal).
//   button number -> {kind:"selection", value}
//   ✍️ (modal)     -> {kind:"message", text}
//   ⏹             -> {kind:"aborted"}
import { questionLines, newToken, errText } from "./util.mjs";

export const name = "discord";
export const configured = (cfg) => !!(cfg.DISCORD_BOT_TOKEN && cfg.DISCORD_CHANNEL_ID);

// pure: build the question message payload. reg(kind, value?) must return a fresh callback token.
// Discord caps buttons at 5/row and 5 rows/message → numbered buttons use up to 4 rows (20 options),
// control row last; options beyond 20 are still listed in the body and answerable via ✍️ free text.
// approves: Discord renders message content as markdown, so the command's markdown characters
// are backslash-escaped — on screen it reads exactly as it will run. Every ASCII punctuation
// character is escaped (Discord drops the backslash before any of them), not only the emphasis ones:
// `<@123>` / `<#123>` / `<t:…>` would render as a mention / channel / timestamp, and a line of a
// multi-line command starting with "1." / "-" / "#" would become a list or a heading.
const mdEscape = (s) => String(s).replace(/[!-/:-@[-`{-~]/g, "\\$&");
export function buildQuestion({ header, question, options = [], questionNumber, questionTotal, approves } = {}, reg) {
  const content = questionLines({ header, question, options, questionNumber, questionTotal, approves: typeof approves === "string" ? mdEscape(approves) : undefined }).join("\n");
  const numBtns = options.slice(0, 20).map((o, i) => ({ type: 2, style: 2, label: String(i + 1), custom_id: reg("selection", o) }));
  const rows = [];
  for (let i = 0; i < numBtns.length; i += 5) rows.push({ type: 1, components: numBtns.slice(i, i + 5) });
  rows.push({
    type: 1, components: [
      { type: 2, style: 1, label: "✍️ 我想先問", custom_id: reg("ask") },
      { type: 2, style: 4, label: "⏹ 取消", custom_id: reg("abort") },
    ],
  });
  return { content, components: rows };
}

// pure: the ✍️ modal (interaction callback type 9 data); token comes back as the submit's custom_id
export function askModal(token) {
  return {
    custom_id: token, title: "✍️ 我想先問",
    components: [{ type: 1, components: [{ type: 4, custom_id: "text", style: 2, label: "你的問題", required: true }] }],
  };
}

// pure: extract the typed text from a modal-submit interaction's data
export function modalText(data) {
  for (const row of data?.components || []) {
    for (const c of row.components || []) if (c.value !== undefined) return c.value;
  }
  return "";
}

export function create(cfg, ctx) {
  if (typeof WebSocket !== "function") {
    throw new Error("discord provider needs the built-in WebSocket (Node 22+) — upgrade Node or use the telegram provider");
  }
  const TOKEN = cfg.DISCORD_BOT_TOKEN;
  const CHANNEL = String(cfg.DISCORD_CHANNEL_ID);
  const API = cfg.DISCORD_API_BASE || "https://discord.com/api/v10";
  const log = ctx.log;

  const tokens = new Map();        // custom_id token -> {request_id, kind, value?}
  const threadLastMsg = new Map(); // thread_id -> last message id (message_reference threading)

  // REST helper — same never-throw contract as the telegram provider's tg(): a cosmetic send
  // failing must never prevent resolve() from running.
  // tries defaults to 1 (no retry) — interaction callbacks must answer within Discord's 3s window,
  // so only the message send opts into a retry (tries=2) via sendThreaded (retro).
  async function rest(method, apiPath, body, tries = 1) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`${API}${apiPath}`, {
          method, headers: { authorization: `Bot ${TOKEN}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) log(`discord ${method} ${apiPath} error:`, r.status, JSON.stringify(j).slice(0, 300));
        return j;
      } catch (e) {
        if (attempt < tries) {
          log(`discord ${method} ${apiPath} transport err (retry ${attempt}/${tries - 1}):`, errText(e));
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        log(`discord ${method} ${apiPath} transport err:`, errText(e));
        return null;
      }
    }
  }

  // interaction callback (must answer within 3s or Discord shows "interaction failed")
  const callback = (i, type, data) => rest("POST", `/interactions/${i.id}/${i.token}/callback`, { type, ...(data ? { data } : {}) });

  async function sendThreaded(thread_id, payload) {
    if (thread_id && threadLastMsg.has(thread_id)) {
      payload.message_reference = { message_id: threadLastMsg.get(thread_id), fail_if_not_exists: false };
    }
    const res = await rest("POST", `/channels/${CHANNEL}/messages`, payload, 2); // retry the message send
    if (thread_id && res?.id) threadLastMsg.set(thread_id, res.id);
    return res;
  }

  async function sendQuestion(request_id, args = {}) {
    if (args.preamble) await sendThreaded(args.thread_id, { content: args.preamble });
    const reg = (kind, value) => { const tk = newToken(); tokens.set(tk, { request_id, kind, value }); return tk; };
    const res = await sendThreaded(args.thread_id, buildQuestion(args, reg));
    // A Discord message send returns the created message ({id}); null/no-id = it never landed, so the
    // user can't answer → throw so the relay resolves {kind:"unreachable"} and the orchestrator falls
    // back to the local picker (retro — was silently absorbed).
    if (!res?.id) throw new Error("discord message send failed (no message id returned)");
    log(`sent question ${request_id} (${(args.options || []).length} options)${args.thread_id ? " thread=" + args.thread_id : ""}`);
  }

  async function handleInteraction(i) {
    // allowlist: only the configured channel may answer (parity with the Telegram chat allowlist)
    if (String(i.channel_id) !== CHANNEL) { await callback(i, 6); return; } // silently ack foreign clicks
    if (i.type === 3) { // message component (button)
      const info = tokens.get(i.data?.custom_id);
      if (!info) { await callback(i, 4, { content: "已過期", flags: 64 }); return; }
      if (info.kind === "selection") {
        ctx.resolve(info.request_id, { kind: "selection", value: info.value }); // resolve FIRST
        await callback(i, 4, { content: `✅ 你選了:${info.value}` });
      } else if (info.kind === "abort") {
        ctx.resolve(info.request_id, { kind: "aborted" }); // resolve FIRST
        await callback(i, 4, { content: "⏹ 已取消" });
      } else if (info.kind === "ask") {
        const mt = newToken(); tokens.set(mt, { request_id: info.request_id, kind: "modal" }); ctx.persist?.();
        await callback(i, 9, askModal(mt));
      }
    } else if (i.type === 5) { // modal submit
      const info = tokens.get(i.data?.custom_id);
      if (!info) { await callback(i, 4, { content: "已過期", flags: 64 }); return; }
      ctx.resolve(info.request_id, { kind: "message", text: modalText(i.data) }); // resolve FIRST
      await callback(i, 4, { content: "✍️ 已收到" });
    }
  }

  async function gatewayOnce() {
    const g = await rest("GET", "/gateway/bot");
    const ws = new WebSocket(`${g?.url || "wss://gateway.discord.gg"}?v=10&encoding=json`);
    let seq = null, hb = null;
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.s) seq = m.s;
      if (m.op === 10) { // hello → heartbeat + identify
        hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch {} }, m.d?.heartbeat_interval || 41250);
        ws.send(JSON.stringify({ op: 2, d: { token: TOKEN, intents: 0, properties: { os: process.platform, browser: "myna", device: "myna" } } }));
      } else if (m.op === 1) { // server-requested heartbeat
        try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch {}
      } else if (m.op === 7 || m.op === 9) { // reconnect / invalid session → drop; outer loop re-identifies
        try { ws.close(); } catch {}
      } else if (m.op === 0 && m.t === "READY") {
        log(`Discord gateway READY as ${m.d?.user?.username || "bot"} (channel=${CHANNEL})`);
      } else if (m.op === 0 && m.t === "INTERACTION_CREATE") {
        handleInteraction(m.d).catch((e) => log("interaction err", e.message));
      }
    });
    await new Promise((r) => { ws.addEventListener("close", r); ws.addEventListener("error", r); });
    if (hb) clearInterval(hb);
  }

  async function start() {
    log("Discord gateway loop started");
    for (;;) {
      try { await gatewayOnce(); } catch (e) { log("gateway err", errText(e)); }
      log("Discord gateway disconnected — reconnecting in 3s");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return {
    name, start, sendQuestion,
    onResolve(request_id) {
      for (const [t, v] of tokens) if (v.request_id === request_id) tokens.delete(t);
    },
    // handoff (see telegram.mjs): custom_id tokens of buttons/modals already sent + reply anchors
    exportState: () => ({ tokens: [...tokens], threadLastMsg: [...threadLastMsg] }),
    importState(s) {
      for (const [k, v] of s?.tokens || []) tokens.set(k, v);
      for (const [k, v] of s?.threadLastMsg || []) threadLastMsg.set(k, v);
    },
  };
}
