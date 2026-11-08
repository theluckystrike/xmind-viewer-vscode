'use strict';
// Mind map -> Markdown outline. Pure, iterative.

function oneLine(s) { return String(s || '').replace(/\s*\n\s*/g, ' ').trim(); }
function esc(s) { return s.replace(/([\\`*_[\]])/g, '\\$1'); }

function topicLine(t) {
  let title = oneLine(t.title) || (t.equation ? '' : '(no title)');
  title = esc(title);
  if (t.href && /^(https?:|mailto:)/i.test(t.href)) title = `[${title || t.href}](${t.href.replace(/\)/g, '%29')})`;
  const parts = [title];
  if (t.equation) parts.push('$' + oneLine(t.equation) + '$');
  if (t.labels && t.labels.length) parts.push(t.labels.map(l => '`' + oneLine(l).replace(/`/g, "'") + '`').join(' '));
  return parts.filter(Boolean).join(' ');
}

function sheetMarkdown(sheet, level) {
  const out = [];
  const h = '#'.repeat(Math.min(6, level || 1));
  out.push(`${h} ${oneLine(sheet.title)}`, '');
  const walk = (start, indent0) => {
    const st = [{ t: start, d: indent0, prefix: '' }];
    while (st.length) {
      const { t, d, prefix } = st.pop();
      const pad = '  '.repeat(d);
      out.push(`${pad}- ${prefix}${topicLine(t)}`);
      if (t.note) for (const line of String(t.note).split('\n')) if (line.trim()) out.push(`${pad}  > ${line.trim()}`);
      const next = [];
      for (const c of t.children) next.push({ t: c, d: d + 1, prefix: '' });
      for (const s of t.summaries || []) if (s.topic) next.push({ t: s.topic, d: d + 1, prefix: `(summary of ${s.from + 1}-${s.to + 1}) ` });
      for (let i = next.length - 1; i >= 0; i--) st.push(next[i]);
    }
  };
  walk(sheet.root, 0);
  if (sheet.detached && sheet.detached.length) {
    out.push('', `${h}# Floating topics`, '');
    for (const t of sheet.detached) walk(t, 0);
  }
  if (sheet.relationships && sheet.relationships.length) {
    const byId = new Map();
    const st = [sheet.root, ...(sheet.detached || [])];
    while (st.length) { const t = st.pop(); byId.set(t.id, t); for (const c of t.children) st.push(c); for (const s of t.summaries || []) if (s.topic) st.push(s.topic); }
    out.push('', `${h}# Relationships`, '');
    for (const r of sheet.relationships) {
      const a = byId.get(r.from), b = byId.get(r.to);
      if (a && b) out.push(`- ${esc(oneLine(a.title))} → ${esc(oneLine(b.title))}${r.title ? `: ${esc(oneLine(r.title))}` : ''}`);
    }
  }
  return out.join('\n') + '\n';
}

function mapMarkdown(model, fileTitle) {
  if (model.sheets.length === 1) return sheetMarkdown(model.sheets[0], 1);
  const parts = [`# ${oneLine(fileTitle)}`, ''];
  for (const s of model.sheets) parts.push(sheetMarkdown(s, 2));
  return parts.join('\n');
}

module.exports = { sheetMarkdown, mapMarkdown, topicLine };
