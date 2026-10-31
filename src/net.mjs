// Connection attempt timeout for the relay's outgoing connections.
// Node (20+) connects with Happy Eyeballs: every address of a host (IPv6 and IPv4) gets
// autoSelectFamilyAttemptTimeout ms (default 250) before the next one is tried, and when all of them
// ran out the connect fails. On a network where IPv6 goes nowhere and the IPv4 handshake to Telegram
// takes longer than 250ms, every fetch() failed ("fetch failed", ETIMEDOUT) while curl got through.
// fetch() and WebSocket (undici) use net's process-wide default, so setting it once at relay start
// covers every provider call (Telegram, Discord, Slack) — the same thing
// NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000 does, without touching the shell.
// MYNA_NET_ATTEMPT_MS (ms, default 2000): 0, negative, non-numeric → the default (Node rejects < 1).
import net from "node:net";

export const NET_ATTEMPT_DEFAULT_MS = 2000;
const MAX_MS = 2 ** 31 - 1;

// the value to use and, when the setting was unusable, why
export function netAttemptMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { ms: NET_ATTEMPT_DEFAULT_MS };
  const v = String(raw).trim(), n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.round(n) < 1 || n > MAX_MS) {
    return { ms: NET_ATTEMPT_DEFAULT_MS, bad: `MYNA_NET_ATTEMPT_MS="${v}" is not a positive number of ms — using ${NET_ATTEMPT_DEFAULT_MS}` };
  }
  return { ms: Math.round(n) }; // Node takes integers only
}

// set it process-wide → the value now in effect, or null when this Node has no such setting (skipped)
export function applyNetAttemptTimeout(cfg, log, n = net) {
  const { ms, bad } = netAttemptMs(cfg.MYNA_NET_ATTEMPT_MS);
  if (bad) log(bad);
  if (typeof n.setDefaultAutoSelectFamilyAttemptTimeout !== "function") {
    log("net: this Node has no setDefaultAutoSelectFamilyAttemptTimeout — connection attempt timeout left as is");
    return null;
  }
  try { n.setDefaultAutoSelectFamilyAttemptTimeout(ms); }
  catch (e) { log("net: could not set the connection attempt timeout:", e.message); return null; }
  return typeof n.getDefaultAutoSelectFamilyAttemptTimeout === "function" ? n.getDefaultAutoSelectFamilyAttemptTimeout() : ms;
}
