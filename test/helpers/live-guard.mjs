// Checks that keep tests off the relay that is actually serving the phone. liveTestOptedIn and
// daemonIsolationProblem are pure (everything comes in as arguments), so they are tested with synthetic
// values only (test/smoke-live-guard.mjs) — never by pointing a test at :7800 or the real ~/.myna.
// portInUse only opens a TCP connection to the port it is given.
import net from "node:net";
import path from "node:path";

export const LIVE_RELAY_PORT = 7800;

// settings that point a relay at a real bot or a real hub (src/providers/*, src/remote.mjs)
export const INHERITED_LIVE_KEYS = ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
  "MYNA_UPSTREAM", "MYNA_MACHINE_TOKEN", "MYNA_MACHINE_TOKEN_FILE"];
// MYNA_<…>_FILE moves one state file (journal, topics, chat, machines, edge state, secret …) away from the
// folder next to MYNA_ENV — possibly into the real ~/.myna, so any of them set is refused as well
export const isInheritedLiveKey = (k) => INHERITED_LIVE_KEYS.includes(k) || /^MYNA_\w+_FILE$/.test(k);

// smoke-relay / smoke-relay-multiround are MANUAL live tests: they go through a running relay to the
// real phone and wait for a tap. They run only when MYNA_RELAY_URL is set explicitly — no silent
// default to the live relay, so "run every test" never reaches the phone.
export const liveTestOptedIn = (env) => typeof env.MYNA_RELAY_URL === "string" && env.MYNA_RELAY_URL.trim() !== "";

export const liveTestRefusal = (file) => [
  `${file} is a MANUAL live test: it sends a real question through a running relay to your phone and waits for a tap.`,
  "It is not part of the automated suite (see .github/workflows/ci.yml) — do not run it from scripts or agents.",
  `To run it yourself, set MYNA_RELAY_URL explicitly, e.g.: MYNA_RELAY_URL=http://127.0.0.1:${LIVE_RELAY_PORT} node test/${file}`,
].join("\n");

// smoke-daemon stops / replaces whatever relay holds its port and writes next to MYNA_ENV, so it must
// not run against the live relay's port or the real user's ~/.myna. Checks the EFFECTIVE values (same
// formulas as smoke-daemon and src/relay.mjs), so any isolation works: a fake MYNA_ENV or a temp HOME,
// plus a RELAY_PORT other than 7800.
// Its relays inherit the environment, and the environment wins over the .env file, so a real bot token,
// hub link or state-file path exported in the shell would reach the real bot / hub / ~/.myna files even
// with a fake .env: refused too.
//   env          the environment smoke-daemon runs with (RELAY_PORT, MYNA_ENV, provider / hub settings)
//   homedir      os.homedir() — follows HOME / USERPROFILE, i.e. where the relay would look
//   userHomedir  os.userInfo().homedir — the real user's home from the OS, not overridable by HOME
//   platform     process.platform (win32 / darwin compare paths case-insensitively)
// Returns null when isolated, else a message saying what to change.
export function daemonIsolationProblem({ env, homedir, userHomedir, platform }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const problems = [];
  const port = Number(env.RELAY_PORT || LIVE_RELAY_PORT);
  if (port === LIVE_RELAY_PORT) {
    problems.push(`RELAY_PORT is ${port}, the live relay's port — set RELAY_PORT to another port (CI uses 17899).`);
  }
  const configDir = p.dirname(p.resolve(env.MYNA_ENV || p.join(homedir, ".myna", ".env")));
  const realDir = p.resolve(userHomedir, ".myna");
  const fold = (s) => (platform === "win32" || platform === "darwin" ? s.toLowerCase() : s);
  if (fold(configDir) === fold(realDir)) {
    problems.push(`the config folder is the real ${realDir} — point MYNA_ENV at a fake .env in a temp folder, or HOME at a temp folder.`);
  }
  const inherited = Object.keys(env).filter((k) => env[k] && isInheritedLiveKey(k)).sort();
  if (inherited.length) {
    problems.push(`${inherited.join(", ")} set in the environment would override the isolated config — unset ${inherited.length > 1 ? "them" : "it"}.`);
  }
  if (!problems.length) return null;
  return [
    "smoke-daemon refuses to run: it could stop or replace the relay that is serving your phone, or reach the real bot / hub.",
    ...problems.map((s) => `  - ${s}`),
    "Run it the way CI does: MYNA_ENV=<temp>/myna.env RELAY_PORT=17899 node test/smoke-daemon.mjs",
  ].join("\n");
}

// smoke-daemon's first step stops whatever relay holds its port. Something already listening there was
// not started by the test (it may be a relay serving the phone on a non-default port), so smoke-daemon
// refuses instead. A bare TCP connect — no request is sent. A timeout counts as in use (fail closed).
export const portInUse = (port, host = "127.0.0.1", timeoutMs = 1000) => new Promise((resolve) => {
  const s = net.connect({ port, host });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(timeoutMs, () => done(true));
  s.once("connect", () => done(true));
  s.once("error", (e) => done(e.code !== "ECONNREFUSED"));
});
