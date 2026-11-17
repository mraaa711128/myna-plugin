#!/usr/bin/env node
// The two hosts in one repo (SPEC §5.6): the rules that keep the Claude Code files and the Codex CLI files
// apart, checked on the files themselves. Reads files only — no relay, no network, no HOME.
//   1. Codex's files are only in codex/ and .codex-plugin/: no skills/ and no plugin.json at the root
//   2. .codex-plugin/plugin.json names mcpServers, hooks and skills inside codex/, and commands is
//      ./codex/commands, a folder that must not exist; codex/hooks.json has only SessionStart, Stop and
//      SessionEnd and every command runs a script that exists; codex/mcp.json has no "${", sets MYNA_HOST=codex
//      and approves only ask_human / await_human / detach_human, one by one (no server-wide default)
//   3. Claude's files never carry the host switches: .mcp.json, hooks/hooks.json, commands/*.md
//   4. one version: package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json,
//      .codex-plugin/plugin.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.MYNA_TEST_ROOT ? path.resolve(process.env.MYNA_TEST_ROOT) : HERE;
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; return c; };
const at = (...p) => path.join(ROOT, ...p);
const json = (...p) => { try { return JSON.parse(fs.readFileSync(at(...p), "utf8")); } catch (e) { return { __error: e.message }; } };
const text = (...p) => { try { return fs.readFileSync(at(...p), "utf8"); } catch { return ""; } };
// a manifest path ("./codex/x") as a repo-relative POSIX path
const rel = (p) => (typeof p === "string" ? path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "") : "");

// 1
ok(!fs.existsSync(at("skills")), "no skills/ at the root (Claude Code would load it)");
ok(!fs.existsSync(at("plugin.json")), "no plugin.json at the root (Codex would read it before .codex-plugin/)");

// 2
const man = json(".codex-plugin", "plugin.json");
ok(!man.__error && man.name === "myna", `.codex-plugin/plugin.json reads, name "myna"${man.__error ? ` (${man.__error})` : ""}`);
for (const k of ["mcpServers", "hooks", "skills"]) {
  const p = rel(man[k]);
  ok(p.startsWith("codex/") && fs.existsSync(at(p)), `manifest ${k} = ${JSON.stringify(man[k])}: inside codex/ and present`);
}
ok(man.commands === "./codex/commands", `manifest commands = "./codex/commands" (got ${JSON.stringify(man.commands)}) — else Codex turns commands/*.md into skills`);
ok(!fs.existsSync(at("codex", "commands")), "codex/commands does not exist");
const skillDirs = fs.existsSync(at("codex", "skills")) ? fs.readdirSync(at("codex", "skills")).sort() : [];
ok(JSON.stringify(skillDirs) === JSON.stringify(["config", "manage"]), `codex/skills has config and manage only (${skillDirs.join(", ")})`);
for (const s of skillDirs) {
  const md = text("codex", "skills", s, "SKILL.md");
  const name = /^---\r?\n[\s\S]*?^name:\s*(\S+)\s*$[\s\S]*?^---/m.exec(md)?.[1];
  ok(name === s && /^description:\s*\S/m.test(md), `codex/skills/${s}/SKILL.md: frontmatter name "${name}" and a description`);
  ok(!md.includes("${CLAUDE_PLUGIN_ROOT}") && !md.includes("$ARGUMENTS"), `codex/skills/${s}/SKILL.md uses no Claude Code placeholders`);
}

const hooks = json("codex", "hooks.json");
const events = Object.keys(hooks.hooks || {}).sort();
ok(JSON.stringify(events) === JSON.stringify(["SessionEnd", "SessionStart", "Stop"]), `codex/hooks.json events: SessionStart, Stop, SessionEnd only (${events.join(", ")})`);
const cmds = Object.values(hooks.hooks || {}).flat().flatMap((g) => g.hooks || []);
for (const h of cmds) {
  const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+\.mjs)/.exec(h.command || "")?.[1];
  ok(h.type === "command" && script && fs.existsSync(at(script)), `codex hook runs an existing script: ${h.command}`);
}
const se = cmds.find((h) => /session-end\.mjs/.test(h.command));
ok(se?.timeout === 3, "SessionEnd states timeout 3 (Codex's cap for SessionEnd)");
ok(cmds.filter((h) => /ensure-relay|stop-catch-question/.test(h.command)).every((h) => /--host codex$/.test(h.command)), "SessionStart / Stop run their scripts with --host codex");

const mcpText = text("codex", "mcp.json"), mcp = json("codex", "mcp.json");
const srv = mcp.mcpServers?.myna || {};
ok(!mcpText.includes("${"), "codex/mcp.json has no ${…} (Codex does not substitute it in plugin MCP settings)");
ok(srv.command === "node" && JSON.stringify(srv.args) === JSON.stringify(["./dist/ask-human.mjs"]) && srv.cwd === "." && fs.existsSync(at("dist", "ask-human.mjs")), "codex/mcp.json runs node ./dist/ask-human.mjs from the plugin root (cwd \".\")");
ok(srv.env?.MYNA_HOST === "codex", "codex/mcp.json sets MYNA_HOST=codex");
ok(srv.tool_timeout_sec === 86400, "tool_timeout_sec 86400 (24 h, as Claude's 86400000 ms)");
ok(!("default_tools_approval_mode" in srv), "no server-wide default_tools_approval_mode");
const tools = srv.tools || {};
ok(JSON.stringify(Object.keys(tools).sort()) === JSON.stringify(["ask_human", "await_human", "detach_human"]) && Object.values(tools).every((t) => t?.approval_mode === "approve" && Object.keys(t).length === 1),
  `approval only for the 3 tools, each "approve" (${JSON.stringify(tools)})`);

// 3
ok(!text(".mcp.json").includes("MYNA_HOST"), ".mcp.json (Claude) does not set MYNA_HOST");
ok(!/MYNA_HOST|--host/.test(text("hooks", "hooks.json")), "hooks/hooks.json (Claude) has no MYNA_HOST / --host");
const withHost = fs.readdirSync(at("commands")).filter((f) => f.endsWith(".md") && /--host|MYNA_HOST/.test(text("commands", f)));
ok(withHost.length === 0, `commands/*.md (Claude) never pass --host / MYNA_HOST${withHost.length ? ` (${withHost.join(", ")})` : ""}`);

// 4
const versions = {
  "package.json": json("package.json").version,
  ".claude-plugin/plugin.json": json(".claude-plugin", "plugin.json").version,
  ".claude-plugin/marketplace.json": (json(".claude-plugin", "marketplace.json").plugins || []).find((p) => p.name === "myna")?.version,
  ".codex-plugin/plugin.json": man.version,
};
ok(new Set(Object.values(versions)).size === 1 && !!versions["package.json"], `one version everywhere: ${JSON.stringify(versions)}`);

console.log(failed ? `\n❌ ${failed} check(s) failed` : "\n✅ smoke-host-layout: all checks passed");
process.exit(failed ? 1 : 0);
