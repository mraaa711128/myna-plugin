#!/usr/bin/env node
// A stand-in for the tailscale CLI (MYNA_TAILSCALE_CLI points here; src/tailscale.mjs runs a .mjs under
// node). Never touches the real Tailscale. Its world is a JSON file named by MYNA_FAKE_TS:
//   {self: "<ip>", suffix: "example.ts.net", devices: {"<ip>": {stable_id, name, login|null, tags: []}},
//    aliases: {"127.0.0.1": "<ip>"}, serve: "<state file>", log: "<file every call is appended to>"}
// Supports: status --json, whois --json <ip>, serve status --json, serve --bg … --tls-terminated-tcp=<n>
// tcp://<target>, serve --tls-terminated-tcp=<n> off. Anything else (e.g. `serve reset`) is logged and fails.
import fs from "node:fs";

const w = JSON.parse(fs.readFileSync(process.env.MYNA_FAKE_TS, "utf8"));
const args = process.argv.slice(2);
if (w.log) fs.appendFileSync(w.log, `${args.join(" ")}\n`);
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const die = (m) => { process.stderr.write(`${m}\n`); process.exit(1); };
const dev = (ip) => w.devices?.[w.aliases?.[ip] || ip];
const serveState = () => { try { return JSON.parse(fs.readFileSync(w.serve, "utf8")); } catch { return {}; } };

if (args[0] === "status" && args[1] === "--json") {
  const d = dev(w.self);
  out({ BackendState: "Running", MagicDNSSuffix: w.suffix, Self: { DNSName: `${d.name}.`, TailscaleIPs: [w.self, "fd7a:115c:a1e0::1"] } });
}
if (args[0] === "whois" && args[1] === "--json") {
  const ip = String(args[2] || "").replace(/:\d+$/, "");
  const d = dev(ip);
  if (!d) die(`no match for IP:port ${ip}`);
  const addr = w.aliases?.[ip] || ip;
  out({ Node: { StableID: d.stable_id, Name: `${d.name}.`, Addresses: [`${addr}/32`], ...(d.tags?.length ? { Tags: d.tags } : {}) }, UserProfile: d.login ? { LoginName: d.login, DisplayName: d.login } : { LoginName: "tagged-devices" } });
}
if (args[0] === "serve" && args[1] === "status" && args[2] === "--json") out(serveState());
if (args[0] === "serve") {
  const port = (args.find((a) => a.startsWith("--tls-terminated-tcp=")) || "").split("=")[1];
  const st = serveState();
  st.TCP ||= {};
  if (port && args[args.length - 1] === "off") { delete st.TCP[port]; fs.writeFileSync(w.serve, JSON.stringify(st)); process.exit(0); }
  const target = args.find((a) => a.startsWith("tcp://"));
  if (port && target && args.includes("--bg") && args.includes("--proxy-protocol=1")) { st.TCP[port] = { TCPForward: target.slice(6), TerminateTLS: "x", ProxyProtocol: 1 }; fs.writeFileSync(w.serve, JSON.stringify(st)); process.exit(0); }
}
die(`fake tailscale: unsupported: ${args.join(" ")}`);
