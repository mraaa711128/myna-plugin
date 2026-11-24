// Preload (node --import, passed down through NODE_OPTIONS) for test/smoke-env-port.mjs: wraps fetch so a
// process under test can never reach the live relay's ports on this machine (127.0.0.1:7800 local,
// :7801 remote listener, :7802 tree node listener) — such a call is recorded to MYNA_TEST_FETCH_LOG and
// rejected; every other call goes through. The scripts under test read their port from a temp .env: if
// that ever regressed to the default, they would land here instead of on the relay serving the phone.
import fs from "node:fs";

const LIVE = new Set(["7800", "7801", "7802"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const log = process.env.MYNA_TEST_FETCH_LOG;
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  let u = null;
  try { u = new URL(url); } catch {}
  const port = u ? (u.port || (u.protocol === "https:" ? "443" : "80")) : "";
  if (u && LOOPBACK.has(u.hostname) && LIVE.has(port)) {
    if (log) fs.appendFileSync(log, url + "\n");
    throw new Error(`live port ${port} blocked by test/helpers/no-live-ports.mjs`);
  }
  return real(input, init);
};
