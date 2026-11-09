#!/usr/bin/env node
// Stop the machine's Myna relay via its POST /shutdown endpoint (cross-platform).
// The relay answers /shutdown and exits ~50ms later, so wait until the port is actually free before
// reporting "stopped" — otherwise a start right after (stop → ensure-relay) still sees the dying
// process answer and reports "already running", leaving NO relay once it exits.
import { localHeaders } from "../src/local-auth.mjs"; // the relay secret (MYNA_LOCAL_AUTH)
const port = Number(process.env.RELAY_PORT || 7800);
const answers = () => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
try {
  await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: localHeaders(), signal: AbortSignal.timeout(1500) });
} catch {
  console.log(`myna: no relay running on :${port}`);
  process.exit(0);
}
const until = Date.now() + 4000;
while (Date.now() < until && (await answers())) await new Promise((r) => setTimeout(r, 100));
console.log((await answers()) ? `myna: relay on :${port} did not exit within 4s — check it (/myna:relay status)` : `myna: relay on :${port} stopped`);
