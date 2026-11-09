// Local-listener auth (MYNA_LOCAL_AUTH, off by default). The relay's local listener (127.0.0.1:RELAY_PORT) takes no
// credentials: any process of this machine can POST /ask, take an answer with GET /answer/<id>, cancel a question,
// mark an approval used (/attest), start pairing or shut the relay down. With MYNA_LOCAL_AUTH=1 in ~/.myna/.env every
// local request but GET /health and /chat/* (which authenticate with their own secrets) must carry the relay secret
// (~/.myna/relay-secret, the one /chat/register already uses) in X-Myna-Local-Secret; without it: 401.
//
// The clients that ship with Myna (the MCP server, the hooks, the scripts) always send the secret when they can read
// it, so turning the setting on needs no other change. A program of another user, or one that cannot read
// ~/.myna (a sandbox, a container), cannot use the relay any more.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_SECRET_HEADER = "x-myna-local-secret";

// cfg: the relay's settings (.env merged with the environment)
export const localAuthOn = (cfg = {}) => /^(1|on|true|yes)$/i.test(String(cfg.MYNA_LOCAL_AUTH ?? "").trim());

// The requests that never need it: the liveness probe, and the chat endpoints (their own Bearer secret / token).
export const localExempt = (method, pathname) => (method === "GET" && pathname === "/health") || String(pathname).startsWith("/chat/");

// Where the relay secret is, for a client: MYNA_RELAY_SECRET_FILE, else next to the .env (MYNA_ENV, ~/.myna/.env).
export const secretFile = (env = process.env) => env.MYNA_RELAY_SECRET_FILE || path.join(path.dirname(env.MYNA_ENV || path.join(os.homedir(), ".myna", ".env")), "relay-secret");

// headers + the secret when it can be read (else headers as they are: a relay without MYNA_LOCAL_AUTH needs none)
export function localHeaders(headers = {}, env = process.env) {
  try {
    const s = fs.readFileSync(secretFile(env), "utf8").trim();
    if (s) return { ...headers, [LOCAL_SECRET_HEADER]: s };
  } catch {}
  return headers;
}
