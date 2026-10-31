#!/usr/bin/env node
// Smoke test for the gate-brief renderer (scripts/render-gate.mjs) — Mermaid diagram support.
// No browser: the emitted module script is executed against a tiny fake DOM + a stub `mermaid`
// module (the CDN import is swapped for an injected loader), so the fallback paths are exercised
// for real, not just grepped. Verifies:
//   (a) top-level + per-question diagram → <pre class="mermaid" data-src> with escaped source, one
//       module script, correct CDN URL, securityLevel strict, per-node render;
//   (b) no diagram (absent / empty / blank / non-string) → no script, no mermaid, same output;
//   (c) hostile / broken diagram → escaped (no live markup), per-node fallback, CDN-import fallback,
//       re-render on color-scheme / data-theme change.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RENDER = fileURLToPath(new URL("../scripts/render-gate.mjs", import.meta.url));
const CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const scratch = path.join(os.tmpdir(), "myna-render-" + process.pid);
fs.mkdirSync(scratch, { recursive: true });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) failed++; };

let seq = 0;
async function render(brief) {
  const jf = path.join(scratch, `b${++seq}.json`), hf = path.join(scratch, `b${seq}.html`);
  fs.writeFileSync(jf, JSON.stringify(brief));
  const r = spawn("node", [RENDER, jf, hf]);
  const code = await new Promise((res) => r.on("close", res));
  return { code, html: fs.existsSync(hf) ? fs.readFileSync(hf, "utf8") : "" };
}
const count = (s, needle) => s.split(needle).length - 1;
const unescapeAttr = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const baseQuestion = (extra = {}) => ({
  header: "Deploy", question: "How should we ship?", context: "Release train is Thursday.", recommendedIndex: 0,
  options: [
    { label: "Canary", detail: "5% first", pros: ["safe"], cons: ["slower"], when_to_pick: "risky change", risks: "two versions live" },
    { label: "Big bang", detail: "all at once" },
  ],
  ...extra,
});

// ---- tiny fake DOM: only the surface the emitted script touches ----
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.parentNode = null; this.hidden = false; this.className = ""; this._text = ""; this.innerHTML = ""; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null; } }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  querySelector(sel) {   // supports ".class" only
    const cls = sel.replace(/^\./, "");
    for (const c of this.children) { if (c.className === cls) return c; const d = c.querySelector(sel); if (d) return d; }
    return null;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
}
// Build a fake page from the emitted HTML: one wrapper + <pre> per data-src, plus the module script.
function fakePage(html, { dark = false, dataTheme = null } = {}) {
  const srcs = [...html.matchAll(/<pre class="mermaid" data-src="([^"]*)">/g)].map((m) => unescapeAttr(m[1]));
  const root = new El("html");
  if (dataTheme) root.setAttribute("data-theme", dataTheme);
  const nodes = srcs.map((src) => { const w = new El("div"); w.className = "diagram"; const p = new El("pre"); p.setAttribute("data-src", src); p.textContent = src; w.appendChild(p); return p; });
  const listeners = [], observers = [];
  const mq = { matches: dark, addEventListener: (_t, cb) => listeners.push(cb) };
  const document = {
    documentElement: root,
    querySelectorAll: (sel) => (sel === "pre.mermaid[data-src]" ? nodes : []),
    createElement: (t) => new El(t),
    getElementById: () => null,
  };
  class MutationObserver { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} }
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  const script = m ? m[1] : "";
  return { srcs, nodes, root, mq, listeners, observers, document, MutationObserver, script };
}
// Run the emitted module script with `import(CDN)` routed to `loader` (records the URL it asked for).
function runScript(page, loader) {
  const body = page.script.trim().replace("await import(CDN)", "await __import(CDN)");
  const fn = new Function("document", "matchMedia", "MutationObserver", "__import", "console", "return " + body);
  return fn(page.document, () => page.mq, page.MutationObserver, loader, { error() {} });
}
const stubMermaid = () => {
  const calls = { init: [], render: [] };
  const mermaid = {
    initialize: (cfg) => calls.init.push(cfg),
    render: async (id, src) => {
      calls.render.push({ id, src });
      if (/BROKEN/.test(src)) throw new Error("Parse error on line 2: unexpected token");
      return { svg: `<svg id="${id}" viewBox="0 0 10 10"></svg>` };
    },
  };
  return { mermaid, calls };
};
const failBox = (node) => node.parentNode.querySelector(".mmd-fail");

// ======== (a) with diagram: top-level + per-question ========
const overviewSrc = "flowchart TD\n  A[Start] --> B{Canary ok?}\n  B -->|yes| C[Roll out]\n  B -->|no| D[Rollback]";
const qSrc = "flowchart TD\n  X[\"Build 'rc' & tag\"] --> Y[Deploy <5%]";
{
  const { code, html } = await render({ title: "Ship", diagram: overviewSrc, questions: [baseQuestion({ diagram: qSrc }), baseQuestion()] });
  ok(code === 0 && html.startsWith("<title>"), "a: renders body-level HTML");
  ok(count(html, '<pre class="mermaid"') === 2, "a: one <pre class=mermaid> per diagram (top-level + per-question)");
  ok(html.includes("流程總覽") && html.indexOf('class="diagram overview"') < html.indexOf('<section class="q">'), "a: top-level diagram sits above the questions");
  const q1 = html.slice(html.indexOf('<section class="q">'));
  ok(q1.indexOf("Release train is Thursday.") < q1.indexOf('<pre class="mermaid"') && q1.indexOf('<pre class="mermaid"') < q1.indexOf('<div class="opts">'),
    "a: per-question diagram comes after that question's context, before its options");
  ok(html.includes("Deploy &lt;5%") && html.includes("'rc' &amp; tag") && html.includes("&quot;Build"), "a: source HTML-escaped (& < > \") in text and attribute; apostrophe stays literal (pre-diagram escaper, data-src is double-quoted)");
  const page = fakePage(html);
  ok(page.srcs[0] === overviewSrc && page.srcs[1] === qSrc, "a: data-src round-trips to the exact Mermaid source");
  ok(count(html, '<script type="module">') === 1 && count(html, "<script") === 1, "a: exactly one module script");
  ok(html.includes(CDN), "a: imports mermaid@11 ESM from jsDelivr");
  ok(/securityLevel:\s*"strict"/.test(page.script) && /startOnLoad:\s*false/.test(page.script), "a: initialize with securityLevel strict + startOnLoad false");

  const { mermaid, calls } = stubMermaid();
  let asked = "";
  await runScript(page, async (u) => { asked = u; return { default: mermaid }; });
  ok(asked === CDN, "a: script imports exactly the CDN URL");
  ok(calls.init.length === 1 && calls.init[0].securityLevel === "strict" && calls.init[0].theme === "default", "a: light scheme → theme 'default', strict");
  ok(calls.render.length === 2 && calls.render.every((c, i) => c.src === page.srcs[i]), "a: mermaid.render called per node with its own source");
  ok(page.nodes.every((n) => n.innerHTML.startsWith("<svg") && n.hasAttribute("data-rendered") && !failBox(n)), "a: every node replaced by its svg, no fallback");
}

// ======== (b) no diagram → no mermaid anything, identical output ========
{
  const plain = (await render({ title: "Ship", questions: [baseQuestion()] })).html;
  ok(!plain.includes("<script") && !/mermaid/i.test(plain) && !plain.includes('class="diagram'), "b: no diagram → no script, no mermaid block");
  ok(count(plain, '<section class="q">') === 1 && count(plain, '<article class="opt') === 2 && plain.includes("建議") && plain.includes("何時選它"),
    "b: existing structure intact (section, option cards, badge, fields)");
  const variants = [
    { title: "Ship", diagram: "", questions: [baseQuestion({ diagram: "" })] },
    { title: "Ship", diagram: "   \n ", questions: [baseQuestion({ diagram: "\t" })] },
    { title: "Ship", diagram: 42, questions: [baseQuestion({ diagram: null })] },
    { title: "Ship", diagram: ["flowchart TD", "A-->B"], questions: [baseQuestion({ diagram: { src: "A-->B" } })] },
  ];
  let same = true;
  for (const v of variants) same = same && (await render(v)).html === plain;
  ok(same, "b: empty / blank / non-string diagram renders byte-identical to no diagram");
}

// ======== (c) hostile + broken diagram ========
const hostile = "flowchart TD\n  A[\"</script><img src=x onerror=alert(1)>\"] --> B";
const broken = "flowchart TD\n  BROKEN -->-->";
{
  const { html } = await render({ questions: [baseQuestion({ diagram: hostile }), baseQuestion({ diagram: broken }), baseQuestion({ diagram: "flowchart TD\n  P-->Q" })] });
  ok(!html.includes("<img") && !html.includes("onerror=alert(1)>") && count(html, "</script>") === 1 && count(html, "<script") === 1,
    "c: hostile </script><img onerror> stays inert (only our own <script> tag exists)");
  ok(html.includes("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;"), "c: hostile source visible as escaped text");
  const page = fakePage(html);
  ok(page.srcs[0] === hostile, "c: hostile source round-trips via data-src for the fallback");
  ok(/for \(let i = 0; i < nodes\.length; i\+\+\)[\s\S]*try \{[\s\S]*mermaid\.render\([\s\S]*\} catch \(e\) \{[\s\S]*fail\(node, e\)/.test(page.script),
    "c: emitted script renders per node inside try/catch → fail()");
  ok(/try \{\s*mermaid = \(await import\(CDN\)\)\.default;[\s\S]*\} catch \(e\) \{\s*for \(const node of nodes\) fail\(/.test(page.script),
    "c: emitted script handles a failed CDN import");
  ok(page.script.includes("圖表無法渲染，以下為 Mermaid 原始碼"), "c: fallback note is present (繁中)");

  // per-node isolation: the broken one falls back, the others still render
  const { mermaid, calls } = stubMermaid();
  const done = runScript(page, async () => ({ default: mermaid }));
  await done;
  const [nh, nb, ng] = page.nodes;
  ok(nh.hasAttribute("data-rendered") && ng.hasAttribute("data-rendered"), "c: good diagrams still render when a sibling is broken");
  const fb = failBox(nb);
  ok(nb.hidden && fb && /圖表無法渲染/.test(fb.children[0].textContent) && /Parse error on line 2/.test(fb.children[1].textContent)
    && fb.children[2].tagName === "pre" && fb.children[2].children[0].tagName === "code" && fb.children[2].textContent === broken,
    "c: broken diagram → note + error message + source in <pre><code>, original block hidden");

  // color-scheme change → re-initialize with theme dark and re-render from data-src
  page.mq.matches = true;
  ok(page.listeners.length === 1, "c: listens for prefers-color-scheme changes");
  await page.listeners[0]();
  ok(calls.init.at(-1).theme === "dark" && calls.init.at(-1).securityLevel === "strict", "c: dark scheme → re-initialize theme 'dark' (still strict)");
  ok(calls.render.length === 6 && calls.render.slice(3).every((c, i) => c.src === page.srcs[i]), "c: re-renders every node from data-src");
  ok(nb.parentNode.children.filter((c) => c.className === "mmd-fail").length === 1, "c: fallback not duplicated on re-render");
  // host flips data-theme=light while the OS is dark → back to default
  page.root.setAttribute("data-theme", "light");
  await page.observers[0].cb();
  ok(calls.init.at(-1).theme === "default", "c: data-theme=light overrides a dark OS scheme");
  await page.observers[0].cb();
  ok(calls.init.length === 3, "c: no re-render when the resolved theme did not change");
}
{
  // CDN import failure (offline / CSP): every block gets the fallback, nothing throws
  const { html } = await render({ diagram: overviewSrc, questions: [baseQuestion({ diagram: qSrc })] });
  const page = fakePage(html, { dark: true });
  let threw = false;
  try { await runScript(page, async () => { throw new TypeError("Failed to fetch dynamically imported module"); }); } catch { threw = true; }
  ok(!threw, "c: CDN import failure does not throw out of the script");
  ok(page.nodes.every((n) => n.hidden && failBox(n) && /無法載入 Mermaid/.test(failBox(n).children[1].textContent)
    && /Failed to fetch/.test(failBox(n).children[1].textContent)), "c: CDN import failure → every block shows note + load error");
  ok(page.nodes.every((n, i) => failBox(n).children[2].textContent === page.srcs[i]), "c: CDN import failure → each block shows its own source");
}
{
  // layout: the diagram box scrolls itself; the page must not scroll sideways at phone width
  const { html } = await render({ diagram: overviewSrc, questions: [baseQuestion()] });
  ok(/\.diagram\{[^}]*overflow-x:auto/.test(html) && /\.diagram svg\{max-width:100%;height:auto\}/.test(html), "layout: diagram container overflow-x:auto, svg max-width:100% height:auto");
  ok(/\.diagram pre\.mermaid\[hidden\]\{display:none\}/.test(html), "layout: hidden original block really hides (author display rule overridden)");
  ok(/var\(--card\)/.test(html.match(/\.diagram\{[^}]*\}/)[0]), "layout: diagram box reuses the page's theme tokens");
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed === 0 ? "\n✅ SMOKE (render-gate + mermaid) PASS" : `\n❌ ${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
