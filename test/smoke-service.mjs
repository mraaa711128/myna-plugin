#!/usr/bin/env node
// /myna:service (scripts/service.mjs, v0.27.0): start the relay at login. Everything in a temp dir (HOME
// with a space and "&" in it, the .env, the service files) and on a random port — never ~/.myna, never
// :7800/:7801. launchctl / systemctl are ALWAYS the fake test/helpers/fake-service-os.mjs (MYNA_SERVICE_*),
// APPDATA (where the Windows Startup folder is) is ALWAYS inside the temp dir, and MYNA_SERVICE_PLATFORM
// plays each OS on any machine: nothing is registered for real.
// A fake bot token whose API base points nowhere: the relay starts and answers /health, nothing reaches an IM.
//   - on (each OS): start.mjs + service.json written, the OS call's arguments / the registration file
//     (absolute node path, paths with spaces, the Windows .vbs as UTF-16), /health answers; on twice
//     (macOS: bootout then bootstrap, start.mjs not run by `on`)
//   - status in each state; off: registration gone, ~/.myna/service gone, the relay STILL running;
//     off when nothing is registered → exit 0; an OS failure → files kept, exit ≠ 0
//   - start.mjs: root gone / service.json broken / not configured → one line in relay.log, no crash;
//     MYNA_ENV recorded at `on` is used at login without MYNA_ENV in the environment
//   - ensure-relay's pointer update: only newer (or same version, root gone), never older, never
//     unreadable versions, never another .env's, never creates the file; broken / unwritable / two at
//     once → a warning only, the relay still starts
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { START_MJS, startupVbs } from "../src/service.mjs";
import { privateProblem } from "./helpers/private-mode.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
const SERVICE = path.join(ROOT, "scripts", "service.mjs");
const ENSURE = path.join(ROOT, "scripts", "ensure-relay.mjs");
const STOP = path.join(ROOT, "scripts", "stop-relay.mjs");
const FAKE = path.join(ROOT, "test", "helpers", "fake-service-os.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myna-service-"));
const freePort = (() => { const used = new Set([7800, 7801, 7802]); return () => { for (;;) { const p = 20000 + Math.floor(Math.random() * 20000); if (!used.has(p)) { used.add(p); return p; } } }; })();
const RP = freePort();
const BOT = "TELEGRAM_BOT_TOKEN=123456:FAKE\nTELEGRAM_CHAT_ID=1\nTELEGRAM_API_BASE=http://127.0.0.1:9\n";
const UID = typeof process.getuid === "function" ? process.getuid() : 0;

// a clean env: nothing of the developer's own myna setup leaks in; the fake OS tools always set
const cleanEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(MYNA_|TELEGRAM_|DISCORD_|SLACK_|RELAY_PORT$|CLAUDE_CODE_SESSION_ID$|XDG_CONFIG_HOME$)/.test(k)) delete e[k];
  return e;
})();
const envFor = (home, extra = {}) => ({
  ...cleanEnv, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), RELAY_PORT: String(RP),
  MYNA_GODMODE_FILE: path.join(TMP, "no-godmode"),
  MYNA_SERVICE_LAUNCHCTL: FAKE, MYNA_SERVICE_SYSTEMCTL: FAKE,
  ...extra,
});
// never let a run reach the real OS tools or the real Startup folder: refuse unless every override points
// at the fake and APPDATA (if set) is inside the temp dir
const guard = (env) => {
  for (const k of ["MYNA_SERVICE_LAUNCHCTL", "MYNA_SERVICE_SYSTEMCTL"]) if (env[k] !== FAKE) throw new Error(`test bug: ${k} is not the fake`);
  if (!["darwin", "win32", "linux"].includes(env.MYNA_SERVICE_PLATFORM)) throw new Error("test bug: MYNA_SERVICE_PLATFORM not set");
  if (!env.MYNA_FAKE_OS_DIR || !env.HOME.startsWith(TMP)) throw new Error("test bug: fake OS dir / HOME not in the temp dir");
  if (env.APPDATA !== undefined && !env.APPDATA.startsWith(TMP)) throw new Error("test bug: APPDATA not in the temp dir");
};
const startupOf = (env) => path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "myna-relay.vbs");
const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const node = (file, args, env, timeout = 45000) => {
  const r = spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8", timeout });
  return { out: ((r.stdout || "") + (r.stderr || "")).trim(), status: r.status };
};
const svc = (args, env) => { guard(env); return node(SERVICE, args, env); };
const show = (label, r) => console.log(`[${label}] rc=${r.status}\n${r.out.split("\n").map((l) => `    ${l}`).join("\n")}`);
const health = async (port = RP) => {
  for (let i = 0; i < 3; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).json(); if (j?.name === "myna-relay") return j; } catch {}
    await sleep(100);
  }
  return null;
};
const waitHealth = async (ms = 10000) => { const until = Date.now() + ms; let h; while (Date.now() < until && !(h = await health())) await sleep(200); return h; };
const stop = () => spawnSync(process.execPath, [STOP], { env: { ...cleanEnv, RELAY_PORT: String(RP) }, encoding: "utf8", timeout: 10000 });
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const calls = (fakeDir) => (read(path.join(fakeDir, "calls.jsonl")) || "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const clearCalls = (fakeDir) => fs.rmSync(path.join(fakeDir, "calls.jsonl"), { force: true });
const verbs = (cs) => cs.filter((c) => c.tool !== "launchd-run").map((c) => (c.tool === "systemctl" ? c.args[1] : c.args[0]));
const home = (name) => { const h = path.join(TMP, name); fs.mkdirSync(path.join(h, ".myna"), { recursive: true }); return h; };

const watchdog = setTimeout(() => { console.error("❌ TIMEOUT — smoke did not finish in 300s"); process.exit(1); }, 300000);
process.on("exit", () => { try { stop(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

try {
  // ============ on / status / off on each OS =========================================================
  for (const platform of ["darwin", "win32", "linux"]) {
    console.log(`\n--- ${platform} ---`);
    const H = home(`home dir & ${platform}`), F = path.join(TMP, `fake-${platform}`);
    fs.writeFileSync(path.join(H, ".myna", ".env"), BOT);
    const env = envFor(H, { MYNA_SERVICE_PLATFORM: platform, MYNA_FAKE_OS_DIR: F });
    const SDIR = path.join(H, ".myna", "service"), START = path.join(SDIR, "start.mjs"), REC = path.join(SDIR, "service.json");
    const regFile = platform === "darwin" ? path.join(H, "Library", "LaunchAgents", "com.myna.relay.plist")
      : platform === "linux" ? path.join(H, ".config", "systemd", "user", "myna-relay.service") : startupOf(env);
    // Windows: the Startup file is the registration; the others: the fake's state
    const registered = () => platform === "win32" ? fs.existsSync(regFile) : fs.existsSync(path.join(F, `registered-${platform === "darwin" ? "launchctl" : "systemctl"}`));

    let r = svc([], env);
    show("status (nothing)", r);
    ok(r.status === 0 && /^登記：沒有/m.test(r.out) && /沒有開常駐/.test(r.out) && /relay：沒有在跑/.test(r.out), `${platform}: status before on — not registered, no service dir, relay down`);
    ok(!fs.existsSync(SDIR), `${platform}: status wrote nothing`);

    clearCalls(F);
    r = svc(["on"], env);
    show("on", r);
    const rec = JSON.parse(read(REC) || "null");
    ok(r.status === 0 && read(START) === START_MJS, `${platform}: on wrote the fixed start.mjs`);
    ok(rec?.root === ROOT && rec?.version === VERSION && rec?.node === process.execPath && !("env" in rec), `${platform}: service.json = {root, version, node} (no env without MYNA_ENV): ${JSON.stringify(rec)}`);
    ok(registered(), `${platform}: the (fake) OS registration is there`);
    // like the rest of ~/.myna (v0.26.3): this user's only (Unix 0600; Windows the ACL, read back with icacls)
    const priv = [START, REC].map((f) => privateProblem(f)).filter(Boolean);
    ok(priv.length === 0, `${platform}: start.mjs and service.json are this user's only${priv.length ? ` — ${priv.join("; ")}` : ""}`);
    const cs = calls(F);
    if (platform === "darwin") {
      const plist = read(regFile) || "";
      const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      ok(plist.includes(`<string>${xml(process.execPath)}</string>`) && plist.includes(`<string>${xml(START)}</string>`), "darwin: plist ProgramArguments = absolute node + start.mjs (XML-escaped &)");
      ok(/<key>RunAtLoad<\/key>\s*<true\/>/.test(plist) && !/KeepAlive/.test(plist) && plist.includes(`<string>${xml(path.join(SDIR, "launchd.err"))}</string>`), "darwin: RunAtLoad true, no KeepAlive, StandardErrorPath → ~/.myna/service/launchd.err");
      ok(JSON.stringify(verbs(cs)) === JSON.stringify(["print", "bootstrap"]) && cs.find((c) => c.args[0] === "bootstrap")?.args.join(" ") === `bootstrap gui/${UID} ${regFile}`, `darwin: launchctl print, then bootstrap gui/${UID} <plist> (${JSON.stringify(verbs(cs))})`);
      ok(cs.some((c) => c.tool === "launchd-run"), "darwin: RunAtLoad ran start.mjs (the fake launchd)");
    } else if (platform === "win32") {
      const bytes = fs.readFileSync(regFile);
      const text = bytes.subarray(2).toString("utf16le");
      ok(regFile.startsWith(path.join(H, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup")), `win32: the entry is under %APPDATA%\\…\\Startup (temp APPDATA): ${regFile}`);
      ok(bytes[0] === 0xff && bytes[1] === 0xfe && bytes.equals(utf16(startupVbs({ node: process.execPath, start: START }))), "win32: the .vbs is UTF-16LE with a BOM, exactly what startupVbs() gives");
      ok(text.includes(`CreateObject("WScript.Shell").Run """${process.execPath}"" ""${START}""", 0, False\r\n`), `win32: WScript.Shell.Run "<node>" "<start.mjs>" with window style 0 (hidden), not waiting`);
      ok(cs.length === 0, `win32: no OS command run (${JSON.stringify(cs)})`);
      ok(/設定 → 應用程式 → 啟動/.test(r.out) && /偵測不到/.test(r.out), "win32: on reminds that Settings → Apps → Startup can turn it off unseen");
    } else {
      const unit = read(regFile) || "";
      const q = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
      ok(unit.includes(`ExecStart=${q(process.execPath)} ${q(START)}`), `linux: ExecStart = quoted absolute node + start.mjs`);
      ok(/^Type=oneshot$/m.test(unit) && /^RemainAfterExit=yes$/m.test(unit) && /^WantedBy=default\.target$/m.test(unit) && !/Restart=/.test(unit), "linux: oneshot, RemainAfterExit=yes, WantedBy=default.target, no Restart=");
      ok(JSON.stringify(verbs(cs)) === JSON.stringify(["daemon-reload", "enable"]) && cs.every((c) => c.args[0] === "--user"), `linux: systemctl --user daemon-reload, enable (${JSON.stringify(verbs(cs))})`);
    }
    let h = await waitHealth();
    ok(h?.root === ROOT && h?.version === VERSION && /relay：在跑/.test(r.out), `${platform}: on → the relay answers /health (v${h?.version}, pid ${h?.pid})`);
    const pid = h?.pid;

    // on again: same result, the registration replaced, the running relay (same version) left alone
    clearCalls(F);
    r = svc(["on"], env);
    show("on again", r);
    h = await health();
    ok(r.status === 0 && registered() && h?.pid === pid, `${platform}: on twice — still registered, same relay pid ${pid}`);
    const v2 = verbs(calls(F));
    if (platform === "darwin") ok(JSON.stringify(v2) === JSON.stringify(["print", "bootout", "bootstrap"]), `darwin: second on = print, bootout, bootstrap (${JSON.stringify(v2)})`);
    if (platform === "win32") ok(v2.length === 0 && fs.readFileSync(regFile).equals(utf16(startupVbs({ node: process.execPath, start: START }))), "win32: second on rewrites the same .vbs, no command");
    if (platform === "linux") ok(JSON.stringify(v2) === JSON.stringify(["daemon-reload", "enable"]), `linux: second on = daemon-reload, enable (${JSON.stringify(v2)})`);

    r = svc(["status"], env);
    show("status (on)", r);
    ok(r.status === 0 && /^登記：有/m.test(r.out) && r.out.includes(`指向：${ROOT}（在），v${VERSION}`) && r.out.includes(`node：${process.execPath}（在）`) && new RegExp(`relay：在跑 v${VERSION.replace(/\./g, "\\.")}（pid ${pid}`).test(r.out), `${platform}: status — registered, root and node there, relay running`);
    if (platform === "win32") {
      ok(r.out.includes(`登記檔：${regFile}（在，內容正確）`) && /設定 → 應用程式 → 啟動/.test(r.out) && /偵測不到/.test(r.out), "win32: status — the Startup file is there with the right content, and the Settings reminder");
      // someone edited the entry: status says so
      const good = fs.readFileSync(regFile);
      fs.writeFileSync(regFile, utf16(startupVbs({ node: "C:\\other\\node.exe", start: START })));
      r = svc(["status"], env);
      ok(r.out.includes("內容跟 on 寫的不一樣") , "win32: status — a .vbs that is not what on writes → says so, rerun on");
      fs.writeFileSync(regFile, good);
    } else ok(r.out.includes(`登記檔：${regFile}（在）`) && !/設定 → 應用程式/.test(r.out), `${platform}: status shows the registration file (no Windows reminder)`);

    // off with an OS failure: nothing deleted, exit ≠ 0 (Windows: the .vbs cannot be removed — a folder in its place)
    const failVerb = platform === "darwin" ? "bootout" : platform === "win32" ? null : "disable";
    if (platform === "win32") { fs.rmSync(regFile); fs.mkdirSync(regFile); }
    r = svc(["off"], failVerb ? { ...env, MYNA_FAKE_OS_FAIL: failVerb } : env);
    show(`off (${failVerb || "the .vbs cannot be removed"})`, r);
    ok(r.status !== 0 && /拿掉登記失敗/.test(r.out) && (platform === "win32" || /Access is denied/.test(r.out)) && fs.existsSync(START) && fs.existsSync(REC) && registered() && fs.existsSync(regFile), `${platform}: off failing to remove the registration → exit ${r.status}, error shown, files and registration kept`);
    if (platform === "win32") { fs.rmdirSync(regFile); svc(["on"], env); }

    // the query itself fails (access denied, no bus): never read as "not registered" (Windows has no query)
    const queryVerb = platform === "darwin" ? "print" : platform === "linux" ? "is-enabled" : null;
    if (queryVerb) {
      r = svc(["status"], { ...env, MYNA_FAKE_OS_FAIL: queryVerb });
      ok(r.status === 0 && /^登記：查不到/m.test(r.out), `${platform}: status with ${queryVerb} failing → "查不到", not "沒有"`);
      r = svc(["off"], { ...env, MYNA_FAKE_OS_FAIL: `${queryVerb},${failVerb}` });
      show(`off (${queryVerb} and ${failVerb} fail)`, r);
      ok(r.status !== 0 && fs.existsSync(SDIR) && registered(), `${platform}: off with ${queryVerb} failing → still tries ${failVerb}; that failing too → exit ${r.status}, files and registration kept`);
    }

    clearCalls(F);
    r = svc(["off"], env);
    show("off", r);
    h = await health();
    ok(r.status === 0 && !registered() && !fs.existsSync(SDIR) && (!regFile || !fs.existsSync(regFile)), `${platform}: off — registration gone, ~/.myna/service gone${regFile ? ", registration file gone" : ""}`);
    ok(h?.pid === pid && /沒有停/.test(r.out) && /stop-relay/.test(r.out), `${platform}: off did NOT stop the relay (pid ${h?.pid}) and says how to`);
    const v3 = verbs(calls(F));
    if (platform === "darwin") ok(JSON.stringify(v3) === JSON.stringify(["print", "bootout"]), `darwin: off = print, bootout (${JSON.stringify(v3)})`);
    if (platform === "win32") ok(v3.length === 0, `win32: off = delete the .vbs, no command (${JSON.stringify(v3)})`);
    if (platform === "linux") ok(JSON.stringify(v3) === JSON.stringify(["is-enabled", "disable", "daemon-reload"]) && !v3.includes("stop"), `linux: off = is-enabled, disable, daemon-reload — never stop (${JSON.stringify(v3)})`);

    // off when nothing is registered: exit 0, nothing to take away
    clearCalls(F);
    r = svc(["off"], env);
    show("off (nothing)", r);
    const v4 = verbs(calls(F));
    ok(r.status === 0 && !v4.some((v) => ["bootout", "/Delete", "disable"].includes(v)) && /本來就沒有登記/.test(r.out), `${platform}: off with nothing registered → exit 0, no removal call, says so (${JSON.stringify(v4)})`);

    // on again, then off while the query fails: the removal is tried anyway and succeeds
    if (queryVerb) {
      svc(["on"], env);
      clearCalls(F);
      r = svc(["off"], { ...env, MYNA_FAKE_OS_FAIL: queryVerb });
      show(`off (${queryVerb} fails)`, r);
      ok(r.status === 0 && !registered() && !fs.existsSync(SDIR) && verbs(calls(F)).includes(failVerb), `${platform}: off with ${queryVerb} failing → ${failVerb} tried anyway, registration and files gone`);
    }

    r = svc(["status"], env);
    ok(r.status === 0 && /^登記：沒有/m.test(r.out) && /沒有開常駐/.test(r.out) && /relay：在跑/.test(r.out), `${platform}: status after off — not registered, no service dir, relay still up`);

    stop();
    ok(!(await health()), `${platform}: relay stopped for the next part`);
  }

  // ============ macOS: `on` does not run start.mjs itself (bootstrap + RunAtLoad does) ================
  {
    console.log("\n--- darwin: no RunAtLoad effect → on must not start the relay by itself ---");
    const H = home("home-darwin-norun"), F = path.join(TMP, "fake-darwin-norun");
    fs.writeFileSync(path.join(H, ".myna", ".env"), BOT);
    const env = envFor(H, { MYNA_SERVICE_PLATFORM: "darwin", MYNA_FAKE_OS_DIR: F, MYNA_FAKE_OS_NORUN: "1" });
    const r = svc(["on"], env);
    show("on (darwin, no RunAtLoad)", r);
    ok(r.status !== 0 && !(await health()) && /relay：沒有在跑/.test(r.out) && /relay 沒有起來/.test(r.out), `darwin: with launchd not running it, on did not run start.mjs a second way — relay down, exit ${r.status}`);
    ok(fs.existsSync(path.join(H, ".myna", "service", "service.json")) && fs.existsSync(path.join(F, "registered-launchctl")), "darwin: relay not up → the registration stays");
    svc(["off"], env);
  }

  // ============ on with nothing configured: registered, exit 0, says so ==========================
  for (const platform of ["darwin", "win32"]) {
    const H = home(`home-unconfigured-${platform}`), F = path.join(TMP, `fake-unconfigured-${platform}`);
    const env = envFor(H, { MYNA_SERVICE_PLATFORM: platform, MYNA_FAKE_OS_DIR: F });
    const t0 = Date.now();
    const r = svc(["on"], env);
    show(`on (${platform}, not configured)`, r);
    ok(r.status === 0 && /還沒設定/.test(r.out) && !(await health()) && fs.existsSync(path.join(H, ".myna", "service", "service.json")), `${platform}: on with no bot → registered, exit 0, says to configure first`);
    ok(Date.now() - t0 < 8000, `${platform}: … without waiting the full 10 s for /health (${Date.now() - t0} ms)`);
    svc(["off"], env);
  }

  // ============ linux: daemon-reload fails during off → kept, retried by the next off ==============
  {
    const H = home("home-reload"), F = path.join(TMP, "fake-reload");
    fs.writeFileSync(path.join(H, ".myna", ".env"), BOT);
    const env = envFor(H, { MYNA_SERVICE_PLATFORM: "linux", MYNA_FAKE_OS_DIR: F });
    svc(["on"], env);
    let r = svc(["off"], { ...env, MYNA_FAKE_OS_FAIL: "daemon-reload" });
    show("off (linux, daemon-reload fails)", r);
    ok(r.status !== 0 && /daemon-reload/.test(r.out) && fs.existsSync(path.join(H, ".myna", "service")), "linux: daemon-reload failing in off → exit ≠ 0, ~/.myna/service kept");
    clearCalls(F);
    r = svc(["off"], env);
    ok(r.status === 0 && verbs(calls(F)).includes("daemon-reload") && !fs.existsSync(path.join(H, ".myna", "service")), "linux: the next off retries daemon-reload (unit file already gone) and cleans up");
    stop();
  }

  // ============ on: the registration fails =======================================================
  {
    console.log("\n--- on: registration refused ---");
    const H = home("home-refused"), F = path.join(TMP, "fake-refused");
    fs.writeFileSync(path.join(H, ".myna", ".env"), BOT);
    const env = envFor(H, { MYNA_SERVICE_PLATFORM: "linux", MYNA_FAKE_OS_DIR: F, MYNA_FAKE_OS_FAIL: "enable" });
    let r = svc(["on"], env);
    show("on (enable refused)", r);
    ok(r.status !== 0 && /登記失敗/.test(r.out) && /Access is denied/.test(r.out) && !(await health()), "on with systemctl --user enable refused → exit ≠ 0, OS error shown, no relay started");
    ok(fs.existsSync(path.join(H, ".myna", "service", "service.json")) && /off 清掉/.test(r.out), "on refused: service files kept, says to rerun on or clean with off");

    // Windows: the Startup folder cannot be made (a file where a folder should be)
    const W = home("home-refused-win"), wenv = envFor(W, { MYNA_SERVICE_PLATFORM: "win32", MYNA_FAKE_OS_DIR: F });
    fs.writeFileSync(path.join(W, ".myna", ".env"), BOT);
    fs.mkdirSync(path.dirname(path.dirname(startupOf(wenv))), { recursive: true });
    fs.writeFileSync(path.dirname(startupOf(wenv)), "not a folder");
    r = svc(["on"], wenv);
    show("on (win32, Startup not writable)", r);
    ok(r.status !== 0 && /登記失敗/.test(r.out) && !(await health()), "win32: the Startup entry cannot be written → exit ≠ 0, error shown, no relay started");

    // Windows without APPDATA: no Startup folder to find — refused, never a guessed path
    const nenv = envFor(home("home-noappdata"), { MYNA_SERVICE_PLATFORM: "win32", MYNA_FAKE_OS_DIR: F });
    delete nenv.APPDATA;
    r = svc(["status"], nenv);
    ok(/^登記：查不到/m.test(r.out) && /APPDATA/.test(r.out), "win32 without APPDATA: status says it cannot tell (APPDATA not set)");
    r = svc(["on"], nenv);
    ok(r.status !== 0 && /APPDATA/.test(r.out), "win32 without APPDATA: on refused, says why");
  }

  // ============ linux: no user instance to ask ===================================================
  {
    const H = home("home-nobus"), F = path.join(TMP, "fake-nobus");
    const r = svc(["status"], envFor(H, { MYNA_SERVICE_PLATFORM: "linux", MYNA_FAKE_OS_DIR: F, MYNA_FAKE_OS_BUS: "down" }));
    show("status (linux, bus down)", r);
    ok(r.status === 0 && /^登記：查不到/m.test(r.out) && /Failed to connect to bus/.test(r.out), "linux: systemctl --user cannot reach the bus → status says it cannot tell, with the reason");
  }

  // ============ the port from .env, read the relay's way ==========================================
  {
    const H = home("home-port"), F = path.join(TMP, "fake-port");
    fs.writeFileSync(path.join(H, ".myna", ".env"), BOT + "RELAY_PORT = 1111\nRELAY_PORT=  2222 \n");
    const env = envFor(H, { MYNA_SERVICE_PLATFORM: "linux", MYNA_FAKE_OS_DIR: F });
    delete env.RELAY_PORT;
    const r = svc(["status"], env);
    ok(/127\.0\.0\.1:2222/.test(r.out), "status: RELAY_PORT from .env — spaces trimmed, the last line wins (2222), as the relay reads it");
  }

  // ============ start.mjs ========================================================================
  {
    console.log("\n--- start.mjs ---");
    const H = home("home-start"), SDIR = path.join(H, ".myna", "service"), LOG = path.join(H, ".myna", "relay.log");
    fs.mkdirSync(SDIR, { recursive: true });
    fs.writeFileSync(path.join(SDIR, "start.mjs"), START_MJS);
    const env = envFor(H);
    const run = () => node(path.join(SDIR, "start.mjs"), [], env);

    fs.writeFileSync(path.join(SDIR, "service.json"), JSON.stringify({ root: path.join(TMP, "gone"), version: VERSION, node: process.execPath }));
    let r = run(), log = read(LOG) || "";
    ok(r.status === 1 && /myna service \(login start\): no myna at .*gone/.test(log) && log.trim().split("\n").length === 1 && !/\n\s+at /.test(r.out), `start.mjs, root gone → one line in relay.log, exit 1, no stack trace`);

    fs.writeFileSync(path.join(SDIR, "service.json"), "{ broken");
    r = run(); log = read(LOG) || "";
    ok(r.status === 1 && /could not be read/.test(log) && log.trim().split("\n").length === 2, "start.mjs, service.json broken → one more line, exit 1");

    fs.writeFileSync(path.join(SDIR, "service.json"), JSON.stringify({ root: ROOT, version: VERSION, node: process.execPath }));
    r = run(); log = read(LOG) || "";
    ok(r.status === 1 && /started no relay/.test(log) && /not configured/.test(log) && !(await health()), "start.mjs, nothing configured → ensure-relay's reason in relay.log, no relay");

    fs.writeFileSync(path.join(H, ".myna", ".env"), BOT);
    const before = read(LOG);
    // no env recorded = the default ~/.myna/.env, even with a MYNA_ENV inherited from the environment
    r = node(path.join(SDIR, "start.mjs"), [], { ...env, MYNA_ENV: path.join(TMP, "nowhere", ".env") });
    const h = await waitHealth();
    ok(r.status === 0 && h?.root === ROOT && /started relay/.test(r.out) && !fs.existsSync(path.join(TMP, "nowhere")), `start.mjs, configured, no env recorded → the default .env, not an inherited MYNA_ENV; relay started (pid ${h?.pid})`);
    // status from a shell with another MYNA_ENV still reports the service's own (default) .env
    const other = svc(["status"], envFor(H, { MYNA_SERVICE_PLATFORM: "linux", MYNA_FAKE_OS_DIR: path.join(TMP, "fake-start"), MYNA_ENV: path.join(TMP, "nowhere", ".env") }));
    ok(/\.env：預設/.test(other.out) && other.out.includes(path.join(H, ".myna", "relay.log")) && /relay：在跑/.test(other.out), "status from a shell with another MYNA_ENV → the service's default .env and its relay");
    ok(!/login start/.test((read(LOG) || "").slice(before.length)), "start.mjs, success → no extra line of its own in relay.log");
    stop();
  }

  // ============ MYNA_ENV at `on`, none at login ===================================================
  {
    console.log("\n--- MYNA_ENV recorded ---");
    const H = home("home-env"), F = path.join(TMP, "fake-env"), CUSTOM = path.join(TMP, "custom env", ".env");
    fs.mkdirSync(path.dirname(CUSTOM), { recursive: true });
    fs.writeFileSync(CUSTOM, BOT);
    const env = envFor(H, { MYNA_SERVICE_PLATFORM: "linux", MYNA_FAKE_OS_DIR: F, MYNA_ENV: CUSTOM });
    let r = svc(["on"], env);
    show("on (MYNA_ENV)", r);
    const rec = JSON.parse(read(path.join(H, ".myna", "service", "service.json")) || "null");
    ok(r.status === 0 && rec?.env === path.resolve(CUSTOM) && !!(await health()), `on with MYNA_ENV → service.json env = ${rec?.env}, relay up`);
    stop();
    const loginEnv = envFor(H); // the login environment: no MYNA_ENV
    r = node(path.join(H, ".myna", "service", "start.mjs"), [], loginEnv);
    const h = await waitHealth();
    ok(r.status === 0 && !!h && fs.existsSync(path.join(TMP, "custom env", "relay.log")) && !fs.existsSync(path.join(H, ".myna", ".env")), "login without MYNA_ENV → start.mjs uses the recorded .env (relay up, relay.log next to it)");
    const shellEnv = { ...env };
    delete shellEnv.MYNA_ENV;
    r = svc(["status"], shellEnv);
    ok(r.out.includes(`.env：${path.resolve(CUSTOM)}`) && /relay：在跑/.test(r.out), "status (no MYNA_ENV in the shell) reads the recorded .env");
    svc(["off"], env);
    stop();
  }

  // ============ ensure-relay updates the pointer ==================================================
  {
    console.log("\n--- ensure-relay → service.json ---");
    // two more myna copies, older and newer: just what ensure-relay needs (it imports src/service.mjs only)
    const copy = (name, version) => {
      const d = path.join(TMP, "roots", name);
      fs.mkdirSync(path.join(d, "scripts"), { recursive: true }); fs.mkdirSync(path.join(d, "src"), { recursive: true });
      fs.copyFileSync(ENSURE, path.join(d, "scripts", "ensure-relay.mjs"));
      for (const f of ["service.mjs", "private-file.mjs"]) fs.copyFileSync(path.join(ROOT, "src", f), path.join(d, "src", f));
      fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "myna-plugin", version }));
      return path.join(d, "scripts", "ensure-relay.mjs");
    };
    const OLD = copy("old", "0.1.0"), NEW = copy("new", "99.0.0"), NEWER = copy("newer", "99.1.0");
    const OLD_ROOT = path.dirname(path.dirname(OLD)), NEW_ROOT = path.dirname(path.dirname(NEW));
    const H = home("home-pointer"), SDIR = path.join(H, ".myna", "service"), REC = path.join(SDIR, "service.json");
    const env = envFor(H); // no .env: ensure-relay starts nothing, the pointer step still runs
    const put = (o) => { fs.mkdirSync(SDIR, { recursive: true }); fs.writeFileSync(REC, typeof o === "string" ? o : JSON.stringify(o)); return read(REC); };
    const ens = (file, e = env) => node(file, [], e, 20000);

    let r = ens(NEW);
    ok(r.status === 0 && !fs.existsSync(SDIR), "no service.json → ensure-relay does not create it");

    put({ root: ROOT, version: VERSION, node: "/x/node", env: undefined });
    r = ens(NEW);
    let rec = JSON.parse(read(REC));
    ok(rec.root === NEW_ROOT && rec.version === "99.0.0" && rec.node === "/x/node" && /login start \(myna service\) now uses v99\.0\.0/.test(r.out), "newer ensure-relay → root/version updated, node kept, says so");
    const p = privateProblem(REC);
    ok(!p, `… the rewritten service.json is still this user's only${p ? ` — ${p}` : ""}`);

    let before = put({ root: NEW_ROOT, version: "99.0.0", node: "/x/node" });
    r = ens(OLD);
    ok(read(REC) === before, "older ensure-relay → unchanged");

    before = put({ root: path.join(TMP, "gone"), version: "99.0.0", node: "/x/node" });
    r = ens(OLD);
    ok(read(REC) === before, "older ensure-relay, recorded root gone → still unchanged (no going back)");

    put({ root: path.join(TMP, "gone"), version: "0.1.0", node: "/x/node" });
    r = ens(OLD);
    rec = JSON.parse(read(REC));
    ok(rec.root === OLD_ROOT && rec.version === "0.1.0", "same version, recorded root gone → points at this one");

    before = put({ root: NEW_ROOT, version: "0.1.0", node: "/x/node" });
    r = ens(OLD);
    ok(read(REC) === before, "same version, recorded root still there → unchanged");

    before = put({ root: NEW_ROOT, version: "garbage", node: "/x/node" });
    r = ens(NEW);
    ok(read(REC) === before, "recorded version unreadable → unchanged");

    const OTHER = path.join(TMP, "other", ".env");
    before = put({ root: OLD_ROOT, version: "0.1.0", node: "/x/node", env: OTHER });
    r = ens(NEW);
    ok(read(REC) === before, "service.json is for another .env (recorded MYNA_ENV) → an ensure-relay for the default one leaves it");
    r = ens(NEW, { ...env, MYNA_ENV: OTHER });
    rec = JSON.parse(read(REC));
    ok(rec.root === NEW_ROOT && rec.env === OTHER, "… and one run with that MYNA_ENV updates it (env kept)");

    // concurrency: two newer ones at once — the file is valid JSON afterwards, no temp file left
    put({ root: OLD_ROOT, version: "0.1.0", node: "/x/node" });
    const both = await Promise.all([NEW, NEWER].map((f) => new Promise((res) => { const c = spawn(process.execPath, [f], { env, stdio: "ignore" }); c.on("close", res); })));
    rec = (() => { try { return JSON.parse(read(REC)); } catch { return null; } })();
    ok(both.every((s) => s === 0) && ["99.0.0", "99.1.0"].includes(rec?.version) && fs.readdirSync(SDIR).every((f) => !f.endsWith(".tmp")), `two at once → exit 0 both, valid JSON (v${rec?.version}), no temp file left`);

    // broken / unwritable → a warning only; the relay still starts (the real ensure-relay, configured)
    fs.writeFileSync(path.join(H, ".myna", ".env"), BOT);
    put("{ broken");
    r = ens(ENSURE);
    let h = await waitHealth();
    ok(r.status === 0 && /warning — could not update/.test(r.out) && h?.root === ROOT, `service.json broken → warning, relay started anyway (pid ${h?.pid})`);
    stop();

    put({ root: OLD_ROOT, version: "0.1.0", node: "/x/node" });
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) console.log("⏭️  skipped the unwritable case (running as root: permissions do not stop it)");
    else {
      // Windows: rename over a read-only file fails; POSIX: no new file in a read-only dir
      if (process.platform === "win32") fs.chmodSync(REC, 0o444); else fs.chmodSync(SDIR, 0o555);
      r = ens(ENSURE);
      h = await waitHealth();
      if (process.platform === "win32") fs.chmodSync(REC, 0o644); else fs.chmodSync(SDIR, 0o755);
      ok(r.status === 0 && /warning — could not update/.test(r.out) && h?.root === ROOT && JSON.parse(read(REC)).version === "0.1.0", `service.json unwritable → warning, unchanged, relay started anyway (pid ${h?.pid})`);
      ok(fs.readdirSync(SDIR).every((f) => !f.endsWith(".tmp")), "unwritable → no temp file left behind");
      stop();
    }
  }
} catch (e) {
  console.error(e);
  failed++;
}
clearTimeout(watchdog);
console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ smoke-service: all checks passed");
process.exit(failed ? 1 : 0);
