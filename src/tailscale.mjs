// The tailscale CLI, wrapped (tree transport, SPEC §5.4). Everything Myna asks Tailscale goes through
// here, so a test can put a fake CLI in its place (MYNA_TAILSCALE_CLI — a .mjs/.js file runs under this
// Node) and never touches the real one.
//   whois(ip)  → {stable_id, name, addrs, login, tags} | null   (tailscale whois --json <ip>)
//                login is null for a tagged device (Tailscale gives no user for one)
//   self()     → {ip, dns_name, suffix, ...whois of this device} | null
//   run(args)  → {ok, code, out, err} — scripts use it for `serve`; the relay never changes a setting
// Nothing here caches a failure: a CLI that is missing now may be installed a minute later.
import { execFile } from "node:child_process";
import fs from "node:fs";

const CANDIDATES = {
  win32: ["C:\\Program Files\\Tailscale\\tailscale.exe", "C:\\Program Files (x86)\\Tailscale\\tailscale.exe"],
  darwin: ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  linux: ["/usr/bin/tailscale", "/usr/local/bin/tailscale"],
};
// where the CLI is: MYNA_TAILSCALE_CLI, else a known install location, else "tailscale" from PATH
export function tailscaleCli(cfg = process.env) {
  const set = String(cfg.MYNA_TAILSCALE_CLI || "").trim();
  if (set) return set;
  for (const p of CANDIDATES[process.platform] || []) { try { if (fs.statSync(p).isFile()) return p; } catch {} }
  return process.platform === "win32" ? "tailscale.exe" : "tailscale";
}
const trimDot = (s) => String(s || "").replace(/\.$/, "");
// an IPv4-mapped IPv6 address ("::ffff:100.64.0.1") is the IPv4 one
export const normIp = (ip) => String(ip || "").trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1").toLowerCase();

export function parseWhois(j) {
  const n = j?.Node;
  if (!n || typeof n.StableID !== "string" || !n.StableID) return null;
  const tags = Array.isArray(n.Tags) ? n.Tags.map(String).sort() : [];
  const login = !tags.length && typeof j.UserProfile?.LoginName === "string" && j.UserProfile.LoginName ? j.UserProfile.LoginName.toLowerCase() : null;
  return { stable_id: n.StableID, name: trimDot(n.Name || n.ComputedName || ""), addrs: (Array.isArray(n.Addresses) ? n.Addresses : []).map((a) => normIp(String(a).replace(/\/\d+$/, ""))), login, tags };
}
// the identity a device stands for: tailscale:<login>, or null for a tagged one (its owner is assigned at join)
export const identityOf = (who) => (who?.login ? `tailscale:${who.login}` : null);

export function createTailscale(cfg = process.env, { timeoutMs = 5000 } = {}) {
  const cli = () => tailscaleCli(cfg);
  function run(args) {
    const c = cli();
    const [file, argv] = /\.(m?js|cjs)$/i.test(c) ? [process.execPath, [c, ...args]] : [c, args];
    return new Promise((resolve) => {
      execFile(file, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: process.env }, (e, out, err) => {
        resolve({ ok: !e, code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(out || ""), err: String(err || (e && e.code === "ENOENT" ? `tailscale CLI not found (${c})` : e?.message || "")) });
      });
    });
  }
  const cache = new Map(); // ip -> {at, who}: a long-poll reconnects every ~25 s — not a process each time
  async function whois(ip, { fresh = false } = {}) {
    const k = normIp(ip);
    if (!k) return null;
    const hit = cache.get(k);
    if (!fresh && hit && Date.now() - hit.at < 30000) return hit.who;
    const r = await run(["whois", "--json", k]);
    let who = null;
    if (r.ok) { try { who = parseWhois(JSON.parse(r.out)); } catch {} }
    if (who) cache.set(k, { at: Date.now(), who }); else cache.delete(k);
    return who;
  }
  let lastError = "";
  async function status() {
    const r = await run(["status", "--json"]);
    if (!r.ok) { lastError = r.err.trim() || `exit ${r.code}`; return null; }
    try { return JSON.parse(r.out); } catch { lastError = "tailscale status --json: not JSON"; return null; }
  }
  // this device: its tailnet address, MagicDNS name and suffix, and who it is (whois of its own address)
  async function self() {
    const s = await status();
    if (!s) return null;
    const ip = normIp((s.Self?.TailscaleIPs || [])[0]);
    const suffix = trimDot(s.MagicDNSSuffix || s.CurrentTailnet?.MagicDNSSuffix || "");
    if (!ip) { lastError = "tailscale status: this device has no tailnet address (logged out?)"; return null; }
    const who = await whois(ip, { fresh: true });
    if (!who) { lastError = `tailscale whois ${ip} gave no answer`; return null; }
    return { ip, dns_name: trimDot(s.Self?.DNSName || ""), suffix, ...who };
  }
  return { run, whois, self, status, cli, lastError: () => lastError };
}
