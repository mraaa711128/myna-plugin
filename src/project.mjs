// The project stamp of a chat session (tree transport, SPEC §5.4): the git `origin` remote reduced to
// owner/repo — host ignored, case folded, so the HTTPS, scp and SSH-alias spellings of one repo are the
// same project. Azure DevOps paths (…/<project>/_git/<repo>) keep their organization: org/project/repo.
// No remote (not a git repo) → dir:<folder name>. The relay computes it once, from what the session
// froze at its start, and locks it (a later registration with another project is refused).

// characters that must never reach a header line a session reads: C0/C1 controls (line breaks included),
// zero-width and direction marks, the Unicode line/paragraph separators, BOM. Built from code points: a
// literal U+2028 in a regex literal would end the line.
const range = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
export const UNSAFE_CHARS = `\\x00-\\x1f\\x7f-\\x9f${range(0x200b, 0x200f)}${range(0x2028, 0x202e)}${range(0x2060, 0x2069)}${String.fromCharCode(0xfeff)}`;
const UNSAFE_RE = new RegExp(`[${UNSAFE_CHARS}]`, "g");
// one safe line: every such character becomes a space (an encoded %0A in a remote, a newline in a folder name)
export const oneLineSafe = (s) => String(s ?? "").replace(UNSAFE_RE, " ").replace(/\s+/g, " ").trim();
const clean = (s) => { let v = String(s || ""); try { v = decodeURIComponent(v); } catch {} return oneLineSafe(v).toLowerCase(); };
const stripGit = (s) => s.replace(/\.git$/i, "").replace(/\/+$/, "");

export function projectOfRemote(remote) {
  const raw = String(remote || "").trim();
  if (!raw) return null;
  let host = "", p = "";
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw); // git@github.com:owner/repo.git, alias:owner/repo
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try { const u = new URL(raw); host = u.hostname; p = u.pathname; } catch { return null; }
  } else if (scp) { host = scp[1]; p = scp[2]; }
  else return null;
  const segs = stripGit(p).split("/").filter(Boolean).map(clean).filter(Boolean);
  // Azure DevOps: https://dev.azure.com/<org>/<project>/_git/<repo>, https://<org>.visualstudio.com/<project>/_git/<repo>,
  // git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
  const gi = segs.indexOf("_git");
  if (gi >= 0 && segs[gi + 1]) {
    const before = segs.slice(0, gi);
    const vs = /^([^.]+)\.visualstudio\.com$/i.exec(host);
    const org = vs ? vs[1].toLowerCase() : before.length >= 2 ? before[before.length - 2] : null;
    const proj = before[before.length - 1];
    return org && proj ? `${org}/${proj}/${segs[gi + 1]}` : null;
  }
  if (segs[0] === "v3" && segs.length === 4) return segs.slice(1).join("/");
  if (segs.length < 2) return null;
  return segs.slice(-2).join("/");
}
// {project, project_source} for a session: its remote, else its folder's name
export function projectOf({ remote, root } = {}) {
  const p = projectOfRemote(remote);
  if (p) return { project: p, project_source: "git" };
  const dir = oneLineSafe(String(root || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "");
  return { project: `dir:${dir.toLowerCase() || "?"}`, project_source: "dir" };
}
