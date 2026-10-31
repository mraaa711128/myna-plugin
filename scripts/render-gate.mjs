#!/usr/bin/env node
// Myna — render a gate "decision brief" JSON into a self-contained HTML page for publishing as an
// Artifact. The model authors the rich per-option context (the hook can't — it only sees terse
// labels); this script turns that JSON into consistent, theme-aware markup so every gate's brief
// looks the same and the model needn't hand-write HTML/CSS.
//
// Usage:  node render-gate.mjs <input.json> <output.html>
// Output is BODY-LEVEL content (a <title>, a <style>, then the page) — no <!doctype>/<html>/<body>,
// because the Artifact publisher wraps the file in its own skeleton.
//
// Brief JSON shape:
//   { title?, diagram?, questions: [ {
//       header?, question, context?, diagram?, recommendedIndex?,
//       options: [ { label, detail?, pros?:[], cons?:[], when_to_pick?, risks?,
//                    cost?, reversibility?, impact?, example? } ] } ] }
//
// `diagram` (optional; top-level = page overview under the header bar, per-question = after that
// question's context) is Mermaid source (e.g. "flowchart TD\n  A-->B"). It is emitted HTML-escaped
// inside <pre class="mermaid" data-src="...">, so the source is readable before/without JS and hostile
// text can never become live markup. Only when at least one diagram exists, a module script loads
// Mermaid from the jsDelivr CDN (Artifact allowlist), renders each block independently
// (securityLevel "strict"), re-renders on color-scheme change, and on a parse/render error - or a
// failed CDN import (offline / CSP) - swaps that block for a visible fallback (note + error + source).
import fs from "node:fs";
import path from "node:path";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: render-gate.mjs <input.json> <output.html>"); process.exit(2); }

const brief = JSON.parse(fs.readFileSync(inPath, "utf8"));
const questions = Array.isArray(brief.questions) ? brief.questions : [];

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim() !== "") : v ? [v] : []);
const list = (items, cls, mark) => arr(items).length
  ? `<ul class="${cls}">${arr(items).map((x) => `<li><span class="mk">${mark}</span>${esc(x)}</li>`).join("")}</ul>` : "";
const line = (label, val) => (val && String(val).trim())
  ? `<p class="line"><span class="lbl">${esc(label)}</span>${esc(val)}</p>` : "";
const chip = (label, val) => (val && String(val).trim())
  ? `<span class="chip"><b>${esc(label)}</b> ${esc(val)}</span>` : "";

// Mermaid diagram: only a non-blank string counts; anything else renders nothing (back-compat).
const dgSrc = (v) => (typeof v === "string" && v.trim() ? v.replace(/\r\n?/g, "\n").trim() : "");
let diagramCount = 0;
function diagramBlock(v, cls, label) {
  const src = dgSrc(v);
  if (!src) return "";
  diagramCount++;
  return `<div class="diagram${cls ? " " + cls : ""}">${label ? `<div class="dg-lbl">${esc(label)}</div>` : ""}<pre class="mermaid" data-src="${esc(src)}">${esc(src)}</pre></div>`;
}

function optionCard(o, i, recommended) {
  const meta = [chip("成本", o.cost), chip("可逆性", o.reversibility), chip("影響", o.impact)].join("");
  return `<article class="opt${recommended ? " rec" : ""}">
    <header class="opt-h"><span class="num">${i + 1}</span><h3>${esc(o.label)}</h3>${recommended ? '<span class="badge">建議</span>' : ""}</header>
    ${o.detail ? `<p class="detail">${esc(o.detail)}</p>` : ""}
    ${arr(o.pros).length || arr(o.cons).length ? `<div class="pc">${list(o.pros, "pros", "✓")}${list(o.cons, "cons", "✗")}</div>` : ""}
    ${line("何時選它", o.when_to_pick)}
    ${o.risks ? `<p class="risks"><span class="mk">⚠</span>${esc(o.risks)}</p>` : ""}
    ${meta.trim() ? `<div class="meta">${meta}</div>` : ""}
    ${o.example ? `<pre class="example">${esc(o.example)}</pre>` : ""}
  </article>`;
}

function questionBlock(q, qi) {
  const ri = Number.isInteger(q.recommendedIndex) ? q.recommendedIndex : -1;
  const opts = (q.options || []).map((o, i) => optionCard(o, i, i === ri)).join("");
  return `<section class="q">
    ${questions.length > 1 ? `<div class="qi">問題 ${qi + 1} / ${questions.length}</div>` : ""}
    ${q.header ? `<div class="hdr">${esc(q.header)}</div>` : ""}
    <h2>${esc(q.question)}</h2>
    ${q.context ? `<p class="ctx">${esc(q.context)}</p>` : ""}${diagramBlock(q.diagram, "", "")}
    <div class="opts">${opts}</div>
  </section>`;
}

// Client-side Mermaid renderer — static code, never interpolates brief content (each source is read
// back from its block's data-src attribute). Plain string concatenation only, so it can live in this
// template literal. Every block renders on its own inside try/catch: one bad diagram cannot break the
// others or the page; a failed CDN import (offline / CSP) turns every block into the fallback.
const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const MERMAID_SCRIPT = `
(async () => {
  const CDN = "${MERMAID_CDN}";
  const NOTE = "圖表無法渲染，以下為 Mermaid 原始碼";
  const nodes = Array.from(document.querySelectorAll("pre.mermaid[data-src]"));
  if (!nodes.length) return;
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const theme = () => {
    const t = document.documentElement.getAttribute("data-theme");
    return t === "dark" || (t !== "light" && mq && mq.matches) ? "dark" : "default";
  };
  const msg = (e) => String((e && e.message) || e || "unknown error");
  const clear = (node) => {
    const old = node.parentNode && node.parentNode.querySelector(".mmd-fail");
    if (old) old.remove();
    node.hidden = false;
  };
  const fail = (node, e) => {
    clear(node);
    const box = document.createElement("div");
    box.className = "mmd-fail";
    const note = document.createElement("p");
    note.textContent = "⚠ " + NOTE;
    const err = document.createElement("p");
    err.className = "mmd-err";
    err.textContent = msg(e);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = node.getAttribute("data-src");
    pre.appendChild(code);
    box.appendChild(note);
    box.appendChild(err);
    box.appendChild(pre);
    node.hidden = true;
    node.parentNode.appendChild(box);
  };
  let mermaid;
  try {
    mermaid = (await import(CDN)).default;
    if (!mermaid || typeof mermaid.render !== "function") throw new Error("mermaid module has no render()");
  } catch (e) {
    for (const node of nodes) fail(node, "無法載入 Mermaid（離線或 CSP 阻擋）：" + msg(e));
    return;
  }
  let gen = 0;
  let current = "";
  const renderAll = async () => {
    const th = theme();
    if (th === current) return;
    current = th;
    gen++;
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: th, suppressErrorRendering: true });
    } catch (e) {
      for (const node of nodes) fail(node, e);
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const id = "mmd-" + gen + "-" + i;
      try {
        const out = await mermaid.render(id, node.getAttribute("data-src"));
        clear(node);
        node.innerHTML = out.svg;
        node.setAttribute("data-rendered", "");
      } catch (e) {
        const stray = document.getElementById("d" + id) || document.getElementById(id);
        if (stray) stray.remove();
        node.removeAttribute("data-rendered");
        fail(node, e);
      }
    }
  };
  let queue = Promise.resolve();
  const schedule = () => { queue = queue.then(renderAll, renderAll); return queue; };
  if (mq) {
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", schedule);
    else if (typeof mq.addListener === "function") mq.addListener(schedule);
  }
  if (typeof MutationObserver === "function") {
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  await schedule();
})().catch((e) => { try { console.error("myna mermaid:", e); } catch (_) {} });
`;

// Diagram CSS is emitted only when the page has a diagram, so diagram-free briefs stay unchanged.
const DIAGRAM_CSS = `
  .diagram{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:.4em 0 1em;max-width:100%;overflow-x:auto;box-sizing:border-box}
  .dg-lbl{color:var(--muted);font-size:13px;font-weight:600;margin-bottom:6px}
  .diagram pre.mermaid{margin:0;font-size:13px;white-space:pre;overflow-x:auto;color:var(--fg);background:transparent}
  .diagram pre.mermaid[data-rendered]{white-space:normal;text-align:center}
  .diagram pre.mermaid[hidden]{display:none}
  .diagram svg{max-width:100%;height:auto}
  .mmd-fail{color:var(--warn);font-size:14px}
  .mmd-fail p{margin:.2em 0;overflow-wrap:anywhere}
  .mmd-fail .mmd-err{color:var(--muted);font-size:13px}
  .mmd-fail pre{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:13px;margin:.5em 0 0}
`;

const title = esc(brief.title || (questions[0]?.header ? `Myna gate — ${questions[0].header}` : "Myna gate"));
const overview = diagramBlock(brief.diagram, "overview", "流程總覽");
const body = questions.map(questionBlock).join("");

const html = `<title>${title}</title>
<style>
  :root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--card:#f6f7f9;--line:#e3e6ea;--rec:#2e7d32;--recbg:#eef7ee;--pro:#2e7d32;--con:#c62828;--warn:#b26a00;--accent:#3155d4}
  @media (prefers-color-scheme:dark){:root{--bg:#15171b;--fg:#e8eaed;--muted:#9aa0a6;--card:#1e2127;--line:#2c3038;--rec:#7bd88f;--recbg:#1c2a1f;--pro:#7bd88f;--con:#f28b82;--warn:#f6c453;--accent:#8ab0ff}}
  :root[data-theme="light"]{--bg:#fff;--fg:#1a1a1a;--muted:#666;--card:#f6f7f9;--line:#e3e6ea;--rec:#2e7d32;--recbg:#eef7ee;--pro:#2e7d32;--con:#c62828;--warn:#b26a00;--accent:#3155d4}
  :root[data-theme="dark"]{--bg:#15171b;--fg:#e8eaed;--muted:#9aa0a6;--card:#1e2127;--line:#2c3038;--rec:#7bd88f;--recbg:#1c2a1f;--pro:#7bd88f;--con:#f28b82;--warn:#f6c453;--accent:#8ab0ff}
  body{background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;margin:0}
  .wrap{max-width:820px;margin:0 auto;padding:28px 20px 64px}
  .top{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:14px;margin-bottom:18px}
  .q{margin:30px 0;padding-top:22px;border-top:1px solid var(--line)}
  .q:first-of-type{border-top:0;padding-top:0}
  .qi{color:var(--muted);font-size:13px;letter-spacing:.02em}
  .hdr{display:inline-block;background:var(--accent);color:#fff;font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;margin:6px 0}
  h2{font-size:22px;margin:.2em 0 .3em}
  .ctx{color:var(--muted);margin:.2em 0 1em}
  .opts{display:flex;flex-direction:column;gap:14px}
  .opt{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .opt.rec{border-color:var(--rec);background:var(--recbg)}
  .opt-h{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .num{flex:none;width:26px;height:26px;border-radius:7px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px}
  .opt-h h3{margin:0;font-size:17px;flex:1}
  .badge{flex:none;background:var(--rec);color:#fff;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px}
  .detail{margin:.3em 0 .6em}
  .pc{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin:.4em 0}
  @media(max-width:560px){.pc{grid-template-columns:1fr}}
  .pc ul{list-style:none;margin:.2em 0;padding:0}
  .pc li{display:flex;gap:7px;align-items:flex-start;margin:.2em 0;font-size:14.5px}
  .mk{flex:none;font-weight:700}
  .pros .mk{color:var(--pro)} .cons .mk{color:var(--con)}
  .line{margin:.4em 0}.lbl{display:inline-block;font-weight:600;color:var(--muted);margin-right:6px}
  .risks{display:flex;gap:7px;color:var(--warn);margin:.4em 0;font-size:14.5px}
  .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:.5em}
  .chip{font-size:12.5px;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:2px 10px;color:var(--muted)}
  .example{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:13px;margin:.6em 0 0}
${diagramCount ? DIAGRAM_CSS : ""}</style>
<div class="wrap">
  <div class="top">🐦 Myna gate · 決策輔助 · 回 IM 按鈕作答</div>
  ${overview}${body || '<p class="ctx">（沒有問題內容）</p>'}
</div>${diagramCount ? `\n<script type="module">${MERMAID_SCRIPT}</script>` : ""}`;

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(outPath);
