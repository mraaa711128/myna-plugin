// markdown → plain text that reads well on a phone, for IMs that show markdown literally
// (Telegram without parse_mode). No parse_mode on purpose: arbitrary content can never be rejected
// by Telegram's parser. Bold/backticks/# heading marks are dropped, tables become "header：value" lines,
// bullets become 「・」, [text](url) becomes "text url". Code blocks, inline code, URLs, Windows
// paths (backslashes) and snake_case are kept as written. Display only — answers keep the raw text.

// a URL as Telegram's autolinker would extend it: everything up to a separator / < > " « »
// (tdlib MessageEntity.cpp is_url_path_symbol) — which includes CJK and full-width brackets, so a URL
// written right against 中文 or （ would absorb them. The ASCII part is the URL we keep.
// (Trailing ASCII punctuation is fine: Telegram drops a trailing . , ; : ! ? and cuts at an unbalanced ")".)
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const wide = (c) => c !== undefined && c.charCodeAt(0) > 0x7f && !/\s/.test(c);

// keep URLs working as links: a space between a URL and a non-ASCII character touching it
const spaceUrls = (s) => s.replace(URL_RE, (u, at, all) => `${wide(all[at - 1]) ? " " : ""}${u}${wide(all[at + u.length]) ? " " : ""}`);

// inline markup of one line (outside code): links, images, bold, italic, strikethrough
function inline(s) {
  // protect inline code spans and bare URLs: their content is kept as written
  const keep = [];
  const hold = (v) => `\u0000${keep.push(v) - 1}\u0000`;
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1")));
  s = s.replace(/!?\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, text, url) => {
    const label = inline(text).trim();
    return hold(!label || label === url ? url : `${label} ${url}`);
  });
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url) => hold(url));
  s = s.replace(URL_RE, (u) => hold(u));
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  // *italic* only with no word character outside (a * b * c, 2*3*4 stay); _italic_ is left alone (snake_case)
  s = s.replace(/(^|[^\w*\\])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?![\w*])/g, "$1$2");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

const cells = (line) => {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, "|")));
};
const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
const isTableRow = (line) => /\|/.test(line) && line.trim() !== "";

export function mdToPlain(md) {
  const src = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let fence = null; // the open ``` / ~~~ marker
  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) { fence = null; continue; }
      out.push(line); // code: kept as written
      continue;
    }
    if (f) { fence = f[1]; continue; } // the fence line itself (and its language tag) goes

    // table: header row + |---| separator + rows → one block per row of "header：value" lines
    if (isTableRow(line) && i + 1 < src.length && isTableSep(src[i + 1])) {
      const head = cells(line);
      const rows = [];
      let j = i + 2;
      for (; j < src.length && isTableRow(src[j]) && !/^\s*(`{3,}|~{3,})/.test(src[j]); j++) rows.push(cells(src[j]));
      rows.forEach((r, n) => {
        if (n) out.push("");
        r.forEach((v, k) => {
          if (!v) return;
          const h = head[k] || "";
          out.push(spaceUrls(h ? `${h}：${v}` : v));
        });
      });
      if (!rows.length) out.push(spaceUrls(head.filter(Boolean).join("　")));
      i = j - 1;
      continue;
    }

    let m;
    if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/))) { out.push(spaceUrls(inline(m[1]))); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("——"); continue; }
    let text = line, prefix = "";
    while ((m = text.match(/^\s{0,3}>\s?/))) text = text.slice(m[0].length); // blockquote marks go
    if ((m = text.match(/^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/))) {
      const depth = Math.floor(m[1].replace(/\t/g, "  ").length / 2);
      prefix = `${"　".repeat(depth)}${m[2] === undefined ? "・" : m[2] === " " ? "☐ " : "☑ "}`;
      text = m[3];
    } else if ((m = text.match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/))) {
      const depth = Math.floor(m[1].replace(/\t/g, "  ").length / 3);
      prefix = `${"　".repeat(depth)}${m[2]}. `;
      text = m[3];
    }
    out.push(spaceUrls(prefix + inline(text)));
  }
  // at most one empty line in a row, none at the ends
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}
