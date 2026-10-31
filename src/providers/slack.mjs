// Slack provider — Socket Mode (apps.connections.open → built-in WebSocket, Node 22+; zero npm
// deps) + Web API. No public HTTP endpoint needed, matching Myna's all-localhost design.
// Block Kit buttons; ✍️ opens a modal (views.open), so free text only ever arrives via modal
// submit — no message-event subscription, and stray chat can't be mistaken for an answer
// (decision 8a holds structurally).
//   button number -> {kind:"selection", value}
//   ✍️ (modal)     -> {kind:"message", text}
//   ⏹             -> {kind:"aborted"}
import { questionLines, newToken, errText, APPROVES_LABEL } from "./util.mjs";

export const name = "slack";
export const configured = (cfg) => !!(cfg.SLACK_BOT_TOKEN && cfg.SLACK_APP_TOKEN && cfg.SLACK_CHANNEL_ID);

// pure: build the chat.postMessage payload. reg(kind, value?) must return a fresh callback token
// (carried in each button's `value`). An actions block holds ≤25 elements — plenty for gates.
export function buildQuestion({ header, question, options = [], questionNumber, questionTotal, approves } = {}, reg) {
  // plain_text block: approves is shown verbatim — in a section of its own with emoji:false:
  // emoji:true turns ":x:" / ":tada:" into emoji, so a command containing one would read
  // differently from the one that runs. `text` (the notification fallback) keeps every line.
  const text = questionLines({ header, question, options, questionNumber, questionTotal, approves }).join("\n");
  const blocks = [{ type: "section", text: { type: "plain_text", text: questionLines({ header, question, options, questionNumber, questionTotal }).join("\n"), emoji: true } }];
  if (typeof approves === "string" && approves) blocks.push({ type: "section", block_id: "myna_approves", text: { type: "plain_text", text: `${APPROVES_LABEL}${approves}`, emoji: false } });
  const numBtns = options.slice(0, 25).map((o, i) => ({
    type: "button", text: { type: "plain_text", text: String(i + 1) }, action_id: `opt${i}`, value: reg("selection", o),
  }));
  if (numBtns.length) blocks.push({ type: "actions", block_id: "myna_opts", elements: numBtns });
  blocks.push({
    type: "actions", block_id: "myna_ctl", elements: [
      { type: "button", text: { type: "plain_text", text: "✍️ 我想先問" }, action_id: "ask", value: reg("ask") },
      { type: "button", text: { type: "plain_text", text: "⏹ 取消" }, style: "danger", action_id: "abort", value: reg("abort") },
    ],
  });
  return { text, blocks };
}

// pure: the ✍️ modal view; token rides in private_metadata (comes back on view_submission).
// modal titles are capped at 24 chars.
export function askModal(token) {
  return {
    type: "modal", callback_id: "myna_ask", private_metadata: token,
    title: { type: "plain_text", text: "✍️ 我想先問" },
    submit: { type: "plain_text", text: "送出" },
    close: { type: "plain_text", text: "取消" },
    blocks: [{
      type: "input", block_id: "myna_q", label: { type: "plain_text", text: "你的問題" },
      element: { type: "plain_text_input", action_id: "text", multiline: true },
    }],
  };
}

// pure: extract the typed text from a submitted view
export const submittedText = (view) => view?.state?.values?.myna_q?.text?.value || "";

export function create(cfg, ctx) {
  if (typeof WebSocket !== "function") {
    throw new Error("slack provider needs the built-in WebSocket (Node 22+) — upgrade Node or use the telegram provider");
  }
  const BOT = cfg.SLACK_BOT_TOKEN;       // xoxb-… (chat:write)
  const APP = cfg.SLACK_APP_TOKEN;       // xapp-… (connections:write, Socket Mode)
  const CHANNEL = String(cfg.SLACK_CHANNEL_ID);
  const API = cfg.SLACK_API_BASE || "https://slack.com/api";
  const log = ctx.log;

  const tokens = new Map();   // button/modal token -> {request_id, kind, value?, thread_ts?}
  const threadTs = new Map(); // thread_id -> root ts (Slack threads anchor on the FIRST message)

  // Web API helper — same never-throw contract as the other providers' senders.
  async function api(method, body, token = BOT, tries = 2) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`${API}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": body === undefined ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) log(`slack ${method} error:`, j.error || JSON.stringify(j).slice(0, 300));
        return j;
      } catch (e) {
        // transient transport blip → retry on a fresh socket before giving up (retro).
        if (attempt < tries) {
          log(`slack ${method} transport err (retry ${attempt}/${tries - 1}):`, errText(e));
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        // Exhausted: never throw here (cosmetic sends stay best-effort); sendQuestion throws on the
        // load-bearing question send so the relay can resolve unreachable → client falls back.
        log(`slack ${method} transport err:`, errText(e));
        return { ok: false, error: errText(e) };
      }
    }
  }

  async function sendThreaded(thread_id, payload) {
    const anchor = thread_id ? threadTs.get(thread_id) : undefined;
    const res = await api("chat.postMessage", { channel: CHANNEL, ...payload, ...(anchor ? { thread_ts: anchor } : {}) });
    if (thread_id && res.ok && res.ts && !threadTs.has(thread_id)) threadTs.set(thread_id, res.ts);
    return res;
  }

  async function sendQuestion(request_id, args = {}) {
    if (args.preamble) await sendThreaded(args.thread_id, { text: args.preamble });
    const reg = (kind, value) => { const tk = newToken(); tokens.set(tk, { request_id, kind, value }); return tk; };
    const res = await sendThreaded(args.thread_id, buildQuestion(args, reg));
    // If the question never reached Slack the user can't answer → throw so the relay resolves
    // {kind:"unreachable"} and the orchestrator falls back (retro — was silently absorbed).
    if (!res.ok) throw new Error(`slack chat.postMessage failed: ${res.error || JSON.stringify(res).slice(0, 200)}`);
    log(`sent question ${request_id} (${(args.options || []).length} options)${args.thread_id ? " thread=" + args.thread_id : ""}`);
  }

  async function handleInteractive(payload) {
    if (payload.type === "block_actions") {
      // allowlist: only the configured channel may answer (parity with the Telegram chat allowlist)
      const chan = payload.channel?.id || payload.container?.channel_id;
      if (String(chan) !== CHANNEL) return;
      const act = payload.actions?.[0];
      const info = act && tokens.get(act.value);
      const tts = payload.message?.thread_ts || payload.message?.ts; // confirmations thread onto the question
      if (!info) { await api("chat.postMessage", { channel: CHANNEL, thread_ts: tts, text: "已過期" }); return; }
      if (info.kind === "selection") {
        ctx.resolve(info.request_id, { kind: "selection", value: info.value }); // resolve FIRST
        await api("chat.postMessage", { channel: CHANNEL, thread_ts: tts, text: `✅ 你選了:${info.value}` });
      } else if (info.kind === "abort") {
        ctx.resolve(info.request_id, { kind: "aborted" }); // resolve FIRST
        await api("chat.postMessage", { channel: CHANNEL, thread_ts: tts, text: "⏹ 已取消" });
      } else if (info.kind === "ask") {
        const mt = newToken(); tokens.set(mt, { request_id: info.request_id, kind: "modal", thread_ts: tts }); ctx.persist?.();
        await api("views.open", { trigger_id: payload.trigger_id, view: askModal(mt) }); // trigger_id: 3s deadline
      }
    } else if (payload.type === "view_submission") {
      const info = tokens.get(payload.view?.private_metadata);
      if (!info) return; // envelope already acked (closes the modal)
      ctx.resolve(info.request_id, { kind: "message", text: submittedText(payload.view) }); // resolve FIRST
      await api("chat.postMessage", { channel: CHANNEL, thread_ts: info.thread_ts, text: "✍️ 已收到" });
    }
  }

  async function socketOnce() {
    const open = await api("apps.connections.open", undefined, APP);
    if (!open.ok || !open.url) throw new Error(`apps.connections.open failed: ${open.error || "no url"}`);
    const ws = new WebSocket(open.url);
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      // ack immediately (3s deadline); a bare ack on view_submission also closes the modal
      if (m.envelope_id) { try { ws.send(JSON.stringify({ envelope_id: m.envelope_id })); } catch {} }
      if (m.type === "hello") log(`Slack Socket Mode connected (channel=${CHANNEL})`);
      else if (m.type === "disconnect") { log(`Slack asked to reconnect (${m.reason || "?"})`); try { ws.close(); } catch {} }
      else if (m.payload) handleInteractive(m.payload).catch((e) => log("interactive err", e.message));
    });
    await new Promise((r) => { ws.addEventListener("close", r); ws.addEventListener("error", r); });
  }

  async function start() {
    log("Slack Socket Mode loop started");
    for (;;) {
      try { await socketOnce(); } catch (e) { log("socket err", errText(e)); }
      log("Slack socket disconnected — reconnecting in 3s");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return {
    name, start, sendQuestion,
    onResolve(request_id) {
      for (const [t, v] of tokens) if (v.request_id === request_id) tokens.delete(t);
    },
    // handoff (see telegram.mjs): button/modal tokens already sent + thread roots
    exportState: () => ({ tokens: [...tokens], threadTs: [...threadTs] }),
    importState(s) {
      for (const [k, v] of s?.tokens || []) tokens.set(k, v);
      for (const [k, v] of s?.threadTs || []) threadTs.set(k, v);
    },
  };
}
