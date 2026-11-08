'use strict';
// XMind Viewer webview: sheet tabs, layouts, SVG drawing, pan and zoom, collapse, search, export.
// Talks to the extension only through postMessage. Loads nothing from the network.
const { layout, preorder, shift, layoutHorizontal, layoutOrgSub, subtreeBoxes, SUM_GAP } = require('./layout');
const { markerGlyph } = require('./markers');
const { sheetMarkdown, mapMarkdown } = require('./outline');
const { unflatten } = require('../core/flat');

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

const S = {
  name: '', size: 0, sizeText: '', settings: {}, model: null, error: null, errorCode: '',
  sheet: 0, views: [], images: new Map(), imgQueue: [], imgBusy: 0, imgStats: { requested: 0, loaded: 0, failed: 0 },
  notices: [], firstRenderMs: 0, renderMs: 0, t0: performance.now(), readMs: 0, rendered: false, failedSent: false,
  last: null, // last render: { nodes, byId, box }
  search: { q: '', hits: [], idx: -1 },
  selected: null, detailsOpen: false, dismissed: false, eqCache: new Map(), measureCache: new Map(),
};

// ---------- small helpers ----------
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const esc = s => String(s).replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
};
const cssVar = (name, fb) => (getComputedStyle(document.body).getPropertyValue(name) || '').trim() || fb;
const isLight = () => document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
const notice = msg => {
  S.notices.push(msg);
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.hidden = false;
  clearTimeout(notice.t); notice.t = setTimeout(() => { el.hidden = true; }, 4000);
};

// ---------- theme ----------
const PAL_DARK = ['#4e9cf5', '#f2994a', '#5fc28f', '#e8687f', '#a68be8', '#3fc1c9', '#d9b44a', '#e58a6b', '#7fa7f7', '#9ccc65'];
const PAL_LIGHT = ['#1f6fd1', '#c8651a', '#1f8f5a', '#c23a5a', '#7a4fc2', '#12858c', '#9a7a10', '#b9502f', '#3d5fd0', '#55862a'];
function theme() {
  const light = isLight();
  const bg = cssVar('--vscode-editor-background', light ? '#ffffff' : '#1e1e1e');
  return {
    light, bg,
    fg: cssVar('--vscode-editor-foreground', light ? '#333333' : '#cccccc'),
    node: cssVar('--vscode-editorWidget-background', light ? '#f3f3f3' : '#252526'),
    accent: cssVar('--vscode-button-background', '#0e639c'),
    accentFg: cssVar('--vscode-button-foreground', '#ffffff'),
    desc: cssVar('--vscode-descriptionForeground', light ? '#717171' : '#9d9d9d'),
    rel: light ? '#8e3fc0' : '#c58af9',
    font: cssVar('--vscode-font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Hiragino Sans", "Microsoft YaHei", sans-serif'),
    pal: light ? PAL_LIGHT : PAL_DARK,
  };
}
// CJK and emoji fallbacks after the VS Code font, so Chinese, Japanese and Korean titles never show as boxes.
const FONT_TAIL = ', "PingFang SC", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans CJK JP", "Malgun Gothic", "Apple SD Gothic Neo", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

function luminance(hex) {
  let x = hex.replace('#', '');
  if (x.length === 3 || x.length === 4) x = x.split('').map(c => c + c).join('');
  const n = parseInt(x.slice(0, 6), 16);
  const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

// ---------- measuring ----------
const LEVELS = [
  { size: 18, weight: 600, padX: 16, padY: 11, maxW: 320, rx: 10 },
  { size: 14.5, weight: 500, padX: 11, padY: 7, maxW: 260, rx: 7 },
  { size: 13, weight: 400, padX: 8, padY: 5, maxW: 260, rx: 5 },
];
const mctx = document.createElement('canvas').getContext('2d');
let fontFamily = '';
const TOKEN = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]|[^\s⺀-鿿가-힯豈-﫿＀-￯　-〿]+|\s+/g;

function wrap(text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    const toks = para.match(TOKEN) || [''];
    let cur = '', curW = 0;
    for (const tk of toks) {
      const w = mctx.measureText(tk).width;
      if (curW + w <= maxW || !cur.trim()) {
        if (w > maxW && !/\s/.test(tk)) { // one very long word: break by characters
          for (const ch of Array.from(tk)) { const cw = mctx.measureText(ch).width; if (curW + cw > maxW && cur) { lines.push(cur); cur = ''; curW = 0; } cur += ch; curW += cw; }
        } else { cur += tk; curW += w; }
      } else {
        lines.push(cur.trimEnd()); cur = /^\s+$/.test(tk) ? '' : tk; curW = /^\s+$/.test(tk) ? 0 : w;
      }
    }
    lines.push(cur.trimEnd());
    if (lines.length > 60) break;
  }
  const out = lines.slice(0, 60);
  if (lines.length > 60) out.push('…');
  return out;
}

function eqMeasure(latex) {
  if (S.eqCache.has(latex)) return S.eqCache.get(latex);
  let r;
  const box = document.getElementById('measure');
  try {
    if (!window.katex) throw new Error('KaTeX missing');
    box.innerHTML = window.katex.renderToString(latex, { throwOnError: false, displayMode: true, output: 'html', strict: 'ignore', trust: false, maxExpand: 500, maxSize: 20 });
    const k = box.querySelector('.katex') || box.firstElementChild;
    const b = k.getBoundingClientRect();
    r = { html: box.innerHTML, w: Math.min(800, Math.ceil(b.width) + 14), h: Math.min(400, Math.ceil(b.height) + 8), ok: true };
  } catch (e) {
    r = { html: '', w: Math.min(400, mctx.measureText(latex).width + 8), h: 20, ok: false };
  }
  box.innerHTML = '';
  S.eqCache.set(latex, r);
  return r;
}

function measure(t, level) {
  const L = LEVELS[Math.min(level, 2)];
  const key = Math.min(level, 2) + '|' + t.id;
  const c = S.measureCache.get(key);
  if (c) return c;
  mctx.font = `${L.weight} ${L.size}px ${fontFamily}`;
  const hasTitle = t.title !== '' || !t.equation;
  const lines = hasTitle ? wrap(t.title === '' ? ' ' : t.title, L.maxW) : [];
  let textW = 0;
  for (const ln of lines) textW = Math.max(textW, mctx.measureText(ln).width);
  const lh = Math.round(L.size * 1.35);
  const textH = lines.length * lh;
  const ms = Math.round(L.size + 2);
  const mW = t.markers.length ? t.markers.length * (ms + 3) + 2 : 0;
  const icons = (t.note ? 1 : 0) + (t.href ? 1 : 0);
  const iW = icons ? icons * (ms + 2) + 4 : 0;
  const rowW = mW + textW + iW;
  const rowH = Math.max(textH, t.markers.length || icons ? ms : 0);
  let img = null;
  if (t.image) {
    let w = t.image.w || 160, ih = t.image.h || 100;
    const k = Math.min(1, 220 / w, 170 / ih);
    img = { w: Math.round(w * k), h: Math.round(ih * k) };
  }
  let eq = null;
  if (t.equation) eq = eqMeasure(t.equation);
  mctx.font = `500 11px ${fontFamily}`;
  const labels = t.labels.map(l => ({ text: l.length > 40 ? l.slice(0, 39) + '…' : l, w: mctx.measureText(l.length > 40 ? l.slice(0, 39) + '…' : l).width + 12 }));
  const lW = labels.reduce((a, b) => a + b.w + 4, 0);
  const inner = Math.max(rowW, img ? img.w : 0, eq ? eq.w : 0, lW);
  const w = Math.ceil(inner + L.padX * 2);
  let hh = L.padY * 2 + rowH;
  if (img) hh += img.h + (rowH ? 6 : 0);
  if (eq) hh += eq.h + (rowH ? 4 : 0);
  if (labels.length) hh += 22;
  const m = { w: Math.max(w, level === 0 ? 60 : 24), h: Math.ceil(hh), L, lines, lh, textW, rowW, rowH, mW, ms, img, eq, labels, lW };
  S.measureCache.set(key, m);
  return m;
}

// ---------- model index ----------
function indexSheet(sheet) {
  if (sheet._ix) return sheet._ix;
  const parent = new Map(), depth = new Map(), byId = new Map(), all = [];
  const st = [[sheet.root, null, 0]];
  for (const d of sheet.detached) st.push([d, null, 1]);
  while (st.length) {
    const [t, p, d] = st.pop();
    byId.set(t.id, t); parent.set(t.id, p); depth.set(t.id, d); all.push(t);
    for (const c of t.children) st.push([c, t, d + 1]);
    for (const s of t.summaries) if (s.topic) st.push([s.topic, t, d + 1]);
  }
  sheet._ix = { parent, depth, byId, all };
  return sheet._ix;
}

function view() {
  const i = S.sheet;
  if (!S.views[i]) {
    const sheet = S.model.sheets[i];
    const collapsed = new Set();
    const ix = indexSheet(sheet);
    for (const t of ix.all) if (t.folded && t.children.length) collapsed.add(t.id);
    const lvl = Number(S.settings.collapseLevel) || 0;
    if (lvl > 0) for (const t of ix.all) if (ix.depth.get(t.id) >= lvl && t.children.length) collapsed.add(t.id);
    const def = S.settings.defaultLayout;
    S.views[i] = { collapsed, layout: def && def !== 'file' ? def : sheet.layout, z: 1, tx: 0, ty: 0, fitted: false };
  }
  return S.views[i];
}

// ---------- building the visible tree ----------
function buildNodes(t0, level0, v, out) {
  const mk = (t, level, parent) => {
    const m = measure(t, level);
    const n = { t, w: m.w, h: m.h, m, kids: [], sums: [], parent, depth: level, x: 0, y: 0, i: out.length };
    out.push(n);
    return n;
  };
  const root = mk(t0, level0, null);
  const st = [root];
  while (st.length) {
    const n = st.pop();
    if (v.collapsed.has(n.t.id)) { n.collapsed = true; continue; }
    for (const c of n.t.children) { const k = mk(c, n.depth + 1, n); n.kids.push(k); st.push(k); }
    for (const s of n.t.summaries) {
      const sn = s.topic ? mk(s.topic, Math.max(2, n.depth + 1), n) : null;
      n.sums.push({ from: s.from, to: s.to, node: sn });
      if (sn) { sn.isSummary = true; st.push(sn); }
    }
  }
  return root;
}

function hiddenCount(t) {
  let n = 0;
  const st = [...t.children];
  while (st.length) { const x = st.pop(); n++; for (const c of x.children) st.push(c); }
  return n;
}

// ---------- layout of one sheet ----------
function computeLayout(sheet, v) {
  const nodes = [];
  const root = buildNodes(sheet.root, 0, v, nodes);
  const mode = v.layout;
  // Room for boundary frames and their title tabs, so they do not cover the next branch.
  for (const n of nodes) {
    for (const b of n.t.boundaries) {
      const tp = b.title ? 30 : 14;
      if (b.from < 0 || n.collapsed) { n.padT = Math.max(n.padT || 0, tp); n.padB = Math.max(n.padB || 0, 14); }
      else if (n.kids[b.from] && n.kids[b.to]) { const a = n.kids[b.from], z = n.kids[b.to]; a.padT = Math.max(a.padT || 0, tp); z.padB = Math.max(z.padB || 0, 14); }
    }
  }
  layout(root, mode);
  // Summaries: placed beside the range they summarize, in the direction of the branch.
  const queue = preorder(root);
  const sumDraw = [];
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi];
    for (const s of n.sums) {
      const kids = n.kids.slice(s.from, s.to + 1);
      if (!kids.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const k of kids) { x0 = Math.min(x0, k.bx0); y0 = Math.min(y0, k.by0); x1 = Math.max(x1, k.bx1); y1 = Math.max(y1, k.by1); }
      const dir = kids[0].dir;
      const vertical = dir === 2 || dir === 3;
      const brace = { x0, y0, x1, y1, dir: vertical ? (dir === 3 ? -2 : 2) : (dir === -1 ? -1 : 1) };
      if (s.node) {
        const sn = s.node;
        if (vertical) {
          layoutOrgSub(sn, dir === 3);
          const dx = (x0 + x1) / 2 - (sn.x + sn.w / 2);
          const dy = dir === 3 ? (y0 - SUM_GAP) - (sn.y + sn.h) : (y1 + SUM_GAP) - sn.y;
          shift(sn, dx, dy);
        } else {
          layoutHorizontal(sn, brace.dir);
          subtreeBoxes(sn);
          const dx = brace.dir > 0 ? (x1 + SUM_GAP) - sn.x : (x0 - SUM_GAP) - (sn.x + sn.w);
          const dy = (y0 + y1) / 2 - (sn.y + sn.h / 2);
          shift(sn, dx, dy);
        }
        for (const z of preorder(sn)) queue.push(z);
      }
      sumDraw.push({ brace, node: s.node });
    }
  }
  // Floating (detached) topics: in a row under the map.
  let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
  for (const n of queue) { mx0 = Math.min(mx0, n.x); my0 = Math.min(my0, n.y); mx1 = Math.max(mx1, n.x + n.w); my1 = Math.max(my1, n.y + n.h); }
  let fx = mx0;
  const floats = [];
  for (const d of sheet.detached) {
    const fr = buildNodes(d, 1, v, nodes);
    layoutHorizontal(fr, 1);
    subtreeBoxes(fr);
    const all = preorder(fr);
    let a0 = Infinity, b0 = Infinity;
    for (const z of all) { a0 = Math.min(a0, z.x); b0 = Math.min(b0, z.y); }
    shift(fr, fx - a0, my1 + 70 - b0);
    let a1 = -Infinity;
    for (const z of all) { a1 = Math.max(a1, z.x + z.w); queue.push(z); }
    fx = a1 + 60;
    fr.floating = true;
    floats.push(fr);
  }
  // Boundaries, from the subtree boxes.
  const bounds = [];
  for (const n of queue) {
    for (const b of n.t.boundaries) {
      let box;
      if (b.from < 0 || n.collapsed) box = { x0: n.bx0 ?? n.x, y0: n.by0 ?? n.y, x1: n.bx1 ?? n.x + n.w, y1: n.by1 ?? n.y + n.h };
      else {
        const kids = n.kids.slice(b.from, b.to + 1);
        if (!kids.length) continue;
        box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        for (const k of kids) { box.x0 = Math.min(box.x0, k.bx0); box.y0 = Math.min(box.y0, k.by0); box.x1 = Math.max(box.x1, k.bx1); box.y1 = Math.max(box.y1, k.by1); }
      }
      bounds.push({ ...box, title: b.title, color: null, n });
    }
  }
  // Everything that is drawn, and the box around it.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of queue) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  for (const b of bounds) { x0 = Math.min(x0, b.x0 - 12); y0 = Math.min(y0, b.y0 - 30); x1 = Math.max(x1, b.x1 + 12); y1 = Math.max(y1, b.y1 + 12); }
  const byId = new Map();
  // data-i in the SVG is the index in this drawn list
  queue.forEach((n, i) => { n.i = i; byId.set(n.t.id, n); });
  return { root, nodes: queue, floats, sumDraw, bounds, byId, box: { x0: x0 - 40, y0: y0 - 40, x1: x1 + 40, y1: y1 + 40 }, mode };
}

// ---------- drawing ----------
function branchColors(L, th, sheet) {
  // main topic index -> palette color; children inherit
  const col = new Map();
  const order = L.nodes;
  for (const n of order) {
    if (n.depth === 0 || n.floating) col.set(n, th.accent);
    else if (!n.parent) col.set(n, th.pal[0]);
    else if (n.parent.depth === 0 && !n.isSummary) col.set(n, th.pal[n.parent.kids.indexOf(n) % th.pal.length]);
    else col.set(n, col.get(n.parent) || th.pal[0]);
  }
  return col;
}

function nodeSvg(n, th, color, useMapColors, forExport, lod) {
  const t = n.t, m = n.m, L = m.L;
  const parts = [];
  let fill, stroke, text, sw = 1;
  if (useMapColors && t.fill) { fill = t.fill; stroke = color; text = t.color || (luminance(t.fill) > 0.35 ? '#1b1b1b' : '#ffffff'); }
  else if (n.depth === 0) { fill = th.accent; stroke = th.accent; text = th.accentFg; }
  else if (n.depth === 1 && !n.isSummary) { fill = th.bg; stroke = color; text = th.fg; sw = 1.6; }
  else { fill = th.node; stroke = color; text = th.fg; }
  if (useMapColors && t.color) text = t.color;
  parts.push(`<rect class="frame" width="${n.w}" height="${n.h}" rx="${L.rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${n.depth >= 2 || n.isSummary ? ' stroke-opacity="0.6"' : ''}/>`);
  // Far zoomed out on a large map: boxes only, text is too small to read anyway.
  if (lod) return `<g class="tp${n.depth === 0 ? ' root' : ''}" data-i="${n.i}" transform="translate(${r1(n.x)},${r1(n.y)})">${parts[0]}</g>`;
  if (n.depth === 1 && !n.isSummary && !(useMapColors && t.fill)) parts.push(`<rect width="${n.w}" height="${n.h}" rx="${L.rx}" fill="${color}" fill-opacity="0.2" pointer-events="none"/>`);
  let y = L.padY;
  const cx = n.w / 2;
  if (m.img) {
    const ix = (n.w - m.img.w) / 2;
    const url = S.images.get(t.image.src);
    const href = url && url !== 'pending' && url !== 'error' ? url : '';
    if (href) parts.push(`<image data-src="${esc(t.image.src)}" x="${ix}" y="${y}" width="${m.img.w}" height="${m.img.h}" preserveAspectRatio="xMidYMid meet" href="${esc(href)}"/>`);
    else parts.push(`<rect class="imgph" data-src="${esc(t.image.src)}" x="${ix}" y="${y}" width="${m.img.w}" height="${m.img.h}" rx="3" fill="${th.desc}" fill-opacity="0.15"/><image data-src="${esc(t.image.src)}" x="${ix}" y="${y}" width="${m.img.w}" height="${m.img.h}" preserveAspectRatio="xMidYMid meet"/>`);
    y += m.img.h + (m.rowH ? 6 : 0);
  }
  if (m.rowH) {
    let x = (n.w - m.rowW) / 2;
    const midY = y + Math.min(m.rowH, m.lh) / 2;
    for (const id of t.markers) {
      const g = markerGlyph(id);
      const r = m.ms / 2;
      const gx = x + r, gy = midY;
      let s = `<g class="mk"><title>${esc(g.label)}</title>`;
      if (g.kind === 'num') s += `<circle cx="${gx}" cy="${gy}" r="${r}" fill="${g.color}"/><text x="${gx}" y="${gy}" dy="0.35em" text-anchor="middle" font-size="${Math.round(m.ms * 0.62)}" font-weight="700" fill="#fff">${g.text}</text>`;
      else if (g.kind === 'pie') {
        s += `<circle cx="${gx}" cy="${gy}" r="${r - 0.75}" fill="${th.bg}" stroke="${g.color}" stroke-width="1.5"/>`;
        if (g.frac >= 1) s += `<circle cx="${gx}" cy="${gy}" r="${r - 0.75}" fill="${g.color}"/><path d="M${gx - r * 0.45} ${gy}l${r * 0.3} ${r * 0.32}l${r * 0.55} ${-r * 0.6}" stroke="#fff" stroke-width="1.6" fill="none"/>`;
        else if (g.frac > 0) { const a = g.frac * 2 * Math.PI, rr = r - 2.5; s += `<path d="M${gx} ${gy}L${gx} ${gy - rr}A${rr} ${rr} 0 ${g.frac > 0.5 ? 1 : 0} 1 ${gx + rr * Math.sin(a)} ${gy - rr * Math.cos(a)}Z" fill="${g.color}"/>`; }
      } else if (g.kind === 'tag') s += `<rect x="${gx - r}" y="${gy - r}" width="${m.ms}" height="${m.ms}" rx="3" fill="${g.color}"/><text x="${gx}" y="${gy}" dy="0.35em" text-anchor="middle" font-size="${Math.round(m.ms * 0.55)}" font-weight="700" fill="#fff">${esc(g.text)}</text>`;
      else s += `<text x="${gx}" y="${gy}" dy="0.36em" text-anchor="middle" font-size="${Math.round(m.ms * 0.95)}"${g.color ? ` fill="${g.color}"` : ''}>${esc(g.text)}</text>`;
      parts.push(s + '</g>');
      x += m.ms + 3;
    }
    if (m.mW) x += 2;
    if (m.lines.length) {
      const ty = y + (m.rowH - m.lines.length * m.lh) / 2;
      let s = `<text x="${x}" y="${ty}" font-size="${L.size}" font-weight="${L.weight}" fill="${text}">`;
      m.lines.forEach((ln, i) => { s += `<tspan x="${x}" y="${ty + i * m.lh + m.lh * 0.5}" dy="0.35em">${esc(ln) || ' '}</tspan>`; });
      parts.push(s + '</text>');
      x += m.textW + 4;
    }
    if (t.note) { parts.push(`<text class="ico" data-act="note" x="${x + m.ms / 2}" y="${midY}" dy="0.35em" text-anchor="middle" font-size="${Math.round(m.ms * 0.8)}" fill="${n.depth === 0 ? text : th.desc}"><title>${esc(t.note.slice(0, 600))}</title>✎</text>`); x += m.ms + 2; }
    if (t.href) parts.push(`<text class="ico link" data-act="link" x="${x + m.ms / 2}" y="${midY}" dy="0.35em" text-anchor="middle" font-size="${Math.round(m.ms * 0.85)}" fill="${n.depth === 0 ? text : th.rel}"><title>${esc(t.href.slice(0, 300))} (click to open)</title>🔗</text>`);
    y += m.rowH;
  }
  if (m.eq) {
    const ex = (n.w - m.eq.w) / 2;
    y += m.rowH ? 4 : 0;
    if (forExport === 'png') {
      // A canvas does not draw MathML from an SVG picture, so the PNG shows the LaTeX source, squeezed to fit the box.
      const src = t.equation.length > 80 ? t.equation.slice(0, 79) + '…' : t.equation;
      const fit = src.length * 7.3 > m.eq.w - 6 ? ` textLength="${Math.max(10, m.eq.w - 6)}" lengthAdjust="spacingAndGlyphs"` : '';
      parts.push(`<text x="${n.w / 2}" y="${y + m.eq.h / 2}" dy="0.35em" text-anchor="middle" font-family="Menlo, Consolas, monospace" font-size="12"${fit} fill="${text}">${esc(src)}</text>`);
    } else if (forExport) {
      let mathml = '';
      try { mathml = window.katex.renderToString(t.equation, { throwOnError: false, output: 'mathml', displayMode: true, strict: 'ignore' }); } catch {}
      parts.push(`<foreignObject x="${ex}" y="${y}" width="${m.eq.w}" height="${m.eq.h}"><div xmlns="http://www.w3.org/1999/xhtml" style="color:${text};font-size:15px;text-align:center">${mathml.replace(XML_BAD, '')}</div></foreignObject>`);
    } else if (m.eq.ok) parts.push(`<foreignObject class="eqfo" x="${ex}" y="${y}" width="${m.eq.w}" height="${m.eq.h}"><div xmlns="http://www.w3.org/1999/xhtml" class="eqbox" style="color:${text}">${m.eq.html}</div></foreignObject>`);
    else parts.push(`<text x="${n.w / 2}" y="${y + 10}" dy="0.35em" text-anchor="middle" font-family="monospace" font-size="12" fill="${text}">${esc(t.equation)}</text>`);
    y += m.eq.h;
  }
  if (m.labels.length) {
    let x = (n.w - m.lW) / 2 + 2;
    const ly = n.h - L.padY - 18;
    for (const l of m.labels) {
      parts.push(`<rect x="${x}" y="${ly}" width="${l.w}" height="18" rx="9" fill="${color}" fill-opacity="0.25"/><text x="${x + l.w / 2}" y="${ly + 9}" dy="0.35em" text-anchor="middle" font-size="11" font-weight="500" fill="${text}">${esc(l.text)}</text>`);
      x += l.w + 4;
    }
  }
  // collapse toggle
  let tog = '';
  if (!forExport && n.depth > 0 && n.t.children.length) {
    let tx, ty;
    const d = n.dir;
    if (d === 2) { tx = n.w / 2; ty = n.h + 8; } else if (d === 3) { tx = n.w / 2; ty = -8; } else if (d === -1) { tx = -8; ty = n.h / 2; } else { tx = n.w + 8; ty = n.h / 2; }
    if (n.collapsed) {
      const cnt = hiddenCount(n.t);
      const label = cnt > 999 ? '999+' : String(cnt);
      const r = label.length > 2 ? 10 + (label.length - 2) * 3 : 8;
      tog = `<g class="tg on" data-tg="1"><title>Show ${cnt} hidden topic${cnt === 1 ? '' : 's'}</title><rect x="${tx - r}" y="${ty - 8}" width="${r * 2}" height="16" rx="8" fill="${th.bg}" stroke="${color}"/><text x="${tx}" y="${ty}" dy="0.35em" text-anchor="middle" font-size="10" font-weight="600" fill="${th.fg}">${label}</text></g>`;
    } else tog = `<g class="tg" data-tg="1"><title>Collapse</title><circle cx="${tx}" cy="${ty}" r="6" fill="${th.bg}" stroke="${color}"/><path d="M${tx - 3} ${ty}h6" stroke="${th.fg}" stroke-width="1.4"/></g>`;
  }
  return `<g class="tp${n.depth === 0 ? ' root' : ''}" data-i="${n.i}" transform="translate(${r1(n.x)},${r1(n.y)})">${parts.join('')}${tog}</g>`;
}
const r1 = v => Math.round(v * 10) / 10;

function connector(p, c) {
  const d = c.dir;
  if (d === 2 || d === 3) {
    const px = p.x + p.w / 2, cx = c.x + c.w / 2;
    const py = d === 2 ? p.y + p.h : p.y, cy = d === 2 ? c.y : c.y + c.h;
    const my = (py + cy) / 2;
    return `M${r1(px)} ${r1(py)}V${r1(my)}H${r1(cx)}V${r1(cy)}`;
  }
  if (d === 4) {
    const px = p.x + Math.min(16, p.w / 2), py = p.y + p.h, cy = c.y + c.h / 2;
    return `M${r1(px)} ${r1(py)}V${r1(cy - 6)}Q${r1(px)} ${r1(cy)} ${r1(px + 6)} ${r1(cy)}H${r1(c.x)}`;
  }
  const dir = d === -1 ? -1 : 1;
  const px = p.depth === 0 && !p.floating ? p.x + p.w / 2 + dir * p.w * 0.35 : (dir > 0 ? p.x + p.w : p.x);
  const py = p.y + p.h / 2;
  const cx = dir > 0 ? c.x : c.x + c.w, cy = c.y + c.h / 2;
  const k = Math.max(14, Math.abs(cx - px) * 0.55);
  return `M${r1(px)} ${r1(py)}C${r1(px + dir * k)} ${r1(py)} ${r1(cx - dir * k)} ${r1(cy)} ${r1(cx)} ${r1(cy)}`;
}

function bracePath(b) {
  const g = 8;
  if (b.dir === 1 || b.dir === -1) {
    const x = b.dir > 0 ? b.x1 + g : b.x0 - g, s = b.dir * 10, m = (b.y0 + b.y1) / 2;
    return `M${x} ${b.y0}Q${x + s} ${b.y0} ${x + s} ${b.y0 + 10}V${m - 6}Q${x + s} ${m} ${x + s * 1.8} ${m}Q${x + s} ${m} ${x + s} ${m + 6}V${b.y1 - 10}Q${x + s} ${b.y1} ${x} ${b.y1}`;
  }
  const y = b.dir > 0 ? b.y1 + g : b.y0 - g, s = (b.dir > 0 ? 1 : -1) * 10, m = (b.x0 + b.x1) / 2;
  return `M${b.x0} ${y}Q${b.x0} ${y + s} ${b.x0 + 10} ${y + s}H${m - 6}Q${m} ${y + s} ${m} ${y + s * 1.8}Q${m} ${y + s} ${m + 6} ${y + s}H${b.x1 - 10}Q${b.x1} ${y + s} ${b.x1} ${y}`;
}

function edgePoint(n, tx, ty) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const sx = (n.w / 2) / Math.abs(dx || 1e-9), sy = (n.h / 2) / Math.abs(dy || 1e-9);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

function visibleNode(L, ix, id) {
  let t = ix.byId.get(id);
  while (t) {
    const n = L.byId.get(t.id);
    if (n) return n;
    t = ix.parent.get(t.id);
  }
  return null;
}

const CULL_AT = 2500; // larger maps draw only what is near the screen
const inRect = (r, x0, y0, x1, y1) => !r || (x1 >= r.x0 && x0 <= r.x1 && y1 >= r.y0 && y0 <= r.y1);

function drawSvg(L, sheet, forExport, rect) {
  const th = theme();
  const useMapColors = S.settings.useMapColors !== false;
  const col = branchColors(L, th, sheet);
  const ix = indexSheet(sheet);
  const b = L.box;
  const W = Math.ceil(b.x1 - b.x0), H = Math.ceil(b.y1 - b.y0);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${r1(b.x0)} ${r1(b.y0)} ${W} ${H}" font-family="${esc(th.font + FONT_TAIL)}">`);
  out.push(`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${th.rel}"/></marker></defs>`);
  if (forExport) out.push(`<rect x="${r1(b.x0)}" y="${r1(b.y0)}" width="${W}" height="${H}" fill="${th.bg}"/>`);
  const stats = { boundaries: 0, summaries: 0, relationships: 0, markers: 0, labels: 0, equations: 0, images: 0 };
  // boundaries
  out.push('<g class="bounds">');
  for (const bd of L.bounds) {
    if (!inRect(rect, bd.x0 - 12, bd.y0 - 30, bd.x1 + 12, bd.y1 + 12)) continue;
    const c = col.get(bd.n.kids[0] || bd.n) || th.desc;
    const x = bd.x0 - 10, y = bd.y0 - (bd.title ? 26 : 10), w = bd.x1 - bd.x0 + 20, hh = bd.y1 - y + 10;
    out.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(hh)}" rx="12" fill="${c}" fill-opacity="0.07" stroke="${c}" stroke-dasharray="6 4" stroke-width="1.3"/>`);
    if (bd.title) {
      mctx.font = `600 12px ${fontFamily}`;
      const tw = Math.min(w - 8, mctx.measureText(bd.title).width + 16);
      out.push(`<rect x="${r1(x + 8)}" y="${r1(y - 9)}" width="${r1(tw)}" height="20" rx="10" fill="${c}"/><text x="${r1(x + 8 + tw / 2)}" y="${r1(y + 1)}" dy="0.35em" text-anchor="middle" font-size="12" font-weight="600" fill="${luminance(c) > 0.4 ? '#1b1b1b' : '#ffffff'}">${esc(bd.title.length > 60 ? bd.title.slice(0, 59) + '…' : bd.title)}</text>`);
    }
    stats.boundaries++;
  }
  out.push('</g><g class="links" fill="none">');
  for (const n of L.nodes) for (const k of n.kids) {
    if (rect && !inRect(rect, Math.min(n.x, k.x), Math.min(n.y, k.y), Math.max(n.x + n.w, k.x + k.w), Math.max(n.y + n.h, k.y + k.h))) continue;
    out.push(`<path d="${connector(n, k)}" stroke="${col.get(k)}" stroke-width="${k.depth === 1 ? 2.2 : 1.5}"/>`);
  }
  out.push('</g><g class="sums" fill="none">');
  for (const s of L.sumDraw) {
    if (!inRect(rect, s.brace.x0 - 40, s.brace.y0 - 40, s.brace.x1 + 40, s.brace.y1 + 40)) continue;
    const c = s.node ? col.get(s.node) || th.desc : th.desc;
    out.push(`<path d="${bracePath(s.brace)}" stroke="${c}" stroke-width="1.6"/>`);
    if (s.node) {
      const n = s.node, bb = s.brace;
      let p;
      if (bb.dir === 1) p = `M${r1(bb.x1 + 26)} ${r1((bb.y0 + bb.y1) / 2)}H${r1(n.x)}`;
      else if (bb.dir === -1) p = `M${r1(bb.x0 - 26)} ${r1((bb.y0 + bb.y1) / 2)}H${r1(n.x + n.w)}`;
      else if (bb.dir === 2) p = `M${r1((bb.x0 + bb.x1) / 2)} ${r1(bb.y1 + 26)}V${r1(n.y)}`;
      else p = `M${r1((bb.x0 + bb.x1) / 2)} ${r1(bb.y0 - 26)}V${r1(n.y + n.h)}`;
      out.push(`<path d="${p}" stroke="${c}" stroke-width="1.4"/>`);
    }
    stats.summaries++;
  }
  out.push('</g><g class="nodes">');
  let count = 0;
  const lod = !!rect && !forExport && view().z < 0.25;
  for (const n of L.nodes) {
    if (!inRect(rect, n.x - 20, n.y - 20, n.x + n.w + 20, n.y + n.h + 20)) continue;
    count++;
    out.push(nodeSvg(n, th, col.get(n) || th.accent, useMapColors, forExport, lod && n.depth > 1));
    stats.markers += n.t.markers.length; stats.labels += n.t.labels.length;
    if (n.t.equation) stats.equations++;
    if (n.t.image) stats.images++;
  }
  out.push('</g><g class="rels" fill="none">');
  for (const r of sheet.relationships) {
    const a = visibleNode(L, ix, r.from), c = visibleNode(L, ix, r.to);
    if (!a || !c || a === c) continue;
    if (!inRect(rect, Math.min(a.x, c.x) - 200, Math.min(a.y, c.y) - 200, Math.max(a.x + a.w, c.x + c.w) + 200, Math.max(a.y + a.h, c.y + c.h) + 200)) continue;
    const hidden = a.t.id !== r.from || c.t.id !== r.to;
    const ac = [a.x + a.w / 2, a.y + a.h / 2], cc = [c.x + c.w / 2, c.y + c.h / 2];
    const dx = cc[0] - ac[0], dy = cc[1] - ac[1], len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(160, len * 0.3);
    const ctl = [(ac[0] + cc[0]) / 2 - dy / len * bend, (ac[1] + cc[1]) / 2 + dx / len * bend];
    const p0 = edgePoint(a, ctl[0], ctl[1]), p2 = edgePoint(c, ctl[0], ctl[1]);
    out.push(`<path class="rel" d="M${r1(p0[0])} ${r1(p0[1])}Q${r1(ctl[0])} ${r1(ctl[1])} ${r1(p2[0])} ${r1(p2[1])}" stroke="${th.rel}" stroke-width="1.6" stroke-dasharray="${hidden ? '2 4' : '7 4'}" marker-end="url(#arr)"/>`);
    if (r.title) {
      const mx = 0.25 * p0[0] + 0.5 * ctl[0] + 0.25 * p2[0], my = 0.25 * p0[1] + 0.5 * ctl[1] + 0.25 * p2[1];
      mctx.font = `400 12px ${fontFamily}`;
      const label = r.title.length > 60 ? r.title.slice(0, 59) + '…' : r.title;
      const tw = mctx.measureText(label).width + 12;
      out.push(`<rect x="${r1(mx - tw / 2)}" y="${r1(my - 10)}" width="${r1(tw)}" height="20" rx="4" fill="${th.bg}" stroke="${th.rel}" stroke-width="1"/><text x="${r1(mx)}" y="${r1(my)}" dy="0.35em" text-anchor="middle" font-size="12" fill="${th.rel}">${esc(label)}</text>`);
    }
    stats.relationships++;
  }
  out.push('</g></svg>');
  return { svg: out.join(''), W, H, stats, count };
}

// ---------- page ----------
let els = {};
function buildChrome() {
  app.innerHTML = '';
  const sheets = S.model.sheets;
  els.tabs = h('div', { class: 'tabs', role: 'tablist' });
  sheets.forEach((s, i) => {
    els.tabs.append(h('button', { class: 'tab', role: 'tab', 'data-i': i, title: `${s.title} (${s.counts.topics} topics)`, onclick: () => switchSheet(i) },
      h('span', { class: 'tab-t', text: s.title }), h('span', { class: 'tab-n', text: String(s.counts.topics) })));
  });
  els.layout = h('select', { title: 'Layout', 'aria-label': 'Layout', onchange: () => { view().layout = els.layout.value; view().fitted = false; render(true); } },
    ...[['map', 'Map'], ['right', 'Logic right'], ['left', 'Logic left'], ['tree', 'Tree'], ['org', 'Org chart'], ['orgup', 'Org chart up']].map(([v, l]) => h('option', { value: v, text: l })));
  els.zoomTxt = h('span', { class: 'zoomtxt', text: '100%' });
  els.search = h('input', { type: 'search', class: 'search', placeholder: 'Search', 'aria-label': 'Search topics', oninput: () => runSearch(els.search.value), onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { els.search.value = ''; runSearch(''); els.stage.focus(); } } });
  els.hitTxt = h('span', { class: 'hits' });
  els.level = h('select', { title: 'Show levels', 'aria-label': 'Show levels', onchange: () => { const v = Number(els.level.value); els.level.value = ''; if (v) collapseTo(v); } },
    h('option', { value: '', text: 'Levels…' }), ...[1, 2, 3, 4].map(n => h('option', { value: n, text: `Show ${n} level${n > 1 ? 's' : ''}` })));
  els.exp = h('select', { title: 'Export', 'aria-label': 'Export', onchange: () => { const v = els.exp.value; els.exp.value = ''; doExport(v); } },
    h('option', { value: '', text: 'Export…' }), h('option', { value: 'png', text: 'PNG picture' }), h('option', { value: 'svg', text: 'SVG picture' }),
    h('option', { value: 'mdcopy', text: 'Copy sheet as Markdown' }), h('option', { value: 'md', text: 'Save all sheets as Markdown' }));
  els.details = h('button', { title: 'Show the notes, labels and link of the selected topic', 'aria-pressed': 'false', onclick: () => { S.detailsOpen = !S.detailsOpen; showDetails(); } }, 'Details');
  const tb = h('div', { class: 'toolbar' },
    els.layout,
    h('span', { class: 'sep' }),
    h('button', { title: 'Fit the whole sheet (F)', onclick: () => fit() }, 'Fit'),
    h('button', { class: 'icon', title: 'Zoom out (-)', onclick: () => zoomBy(1 / 1.25) }, '−'), els.zoomTxt,
    h('button', { class: 'icon', title: 'Zoom in (+)', onclick: () => zoomBy(1.25) }, '+'),
    h('span', { class: 'sep' }),
    h('button', { title: 'Expand every branch', onclick: () => { view().collapsed.clear(); render(true); } }, 'Expand all'),
    els.level,
    h('span', { class: 'sep' }),
    els.search, els.hitTxt,
    h('span', { class: 'grow' }),
    els.exp, els.details);
  els.warn = h('div', { class: 'warnbar', hidden: true });
  els.svgHost = h('div', { class: 'svghost' });
  els.stage = h('div', { class: 'stage', tabindex: '0', 'aria-label': 'Mind map. Drag to move, Ctrl or Cmd + wheel to zoom, arrow keys to move between topics, Space to collapse.' }, els.svgHost);
  els.panel = h('aside', { class: 'details', hidden: true });
  els.toast = h('div', { id: 'toast', class: 'toast', hidden: true, role: 'status' });
  els.status = h('div', { class: 'status' });
  app.append(sheets.length > 1 ? els.tabs : h('div'), tb, els.warn, h('div', { class: 'main' }, els.stage, els.panel), els.status, els.toast);
  if (sheets.length <= 1) els.tabs.hidden = true;
  wireStage();
}

function warnings() {
  const sheet = S.model.sheets[S.sheet];
  const list = [...(S.model.notes || []), ...(sheet.notes || [])];
  if (sheet.layoutNote && view().layout === sheet.layout) list.unshift(sheet.layoutNote);
  if (!list.length || S.dismissed) { els.warn.hidden = true; return; }
  els.warn.innerHTML = '';
  for (const w of list) els.warn.append(h('span', { class: 'w', text: w }));
  els.warn.append(h('button', { class: 'close', title: 'Hide', onclick: () => { S.dismissed = true; els.warn.hidden = true; } }, '×'));
  els.warn.hidden = false;
}

function switchSheet(i) {
  if (i === S.sheet && S.last) return;
  S.sheet = i; S.selected = null; S.search.hits = []; S.search.idx = -1;
  vscode.setState({ sheet: i });
  render(true);
  if (S.search.q) runSearch(S.search.q);
}

function render(relayout) {
  const t0 = performance.now();
  const sheet = S.model.sheets[S.sheet];
  const v = view();
  fontFamily = theme().font + FONT_TAIL;
  [...els.tabs.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === S.sheet)));
  els.layout.value = v.layout;
  if (relayout || !S.last || S.last.sheet !== S.sheet) {
    S.last = computeLayout(sheet, v);
    S.last.sheet = S.sheet;
  }
  const b = S.last.box;
  S.last.W = Math.ceil(b.x1 - b.x0); S.last.H = Math.ceil(b.y1 - b.y0);
  els.svgHost.style.width = S.last.W + 'px';
  els.svgHost.style.height = S.last.H + 'px';
  if (!v.fitted) { initialView(true); v.fitted = true; } else applyTransform(true);
  draw();
  S.renderMs = Math.round(performance.now() - t0);
  requestImages();
  warnings();
  els.status.textContent = `${sheet.counts.topics.toLocaleString()} topics · ${S.last.nodes.length.toLocaleString()} shown · ${S.sizeText}`;
  if (!S.rendered) {
    S.rendered = true;
    S.firstRenderMs = Math.round(performance.now() - S.t0);
    vscode.postMessage({ type: 'rendered' });
  }
  if (S.detailsOpen) showDetails();
}

function draw() {
  const sheet = S.model.sheets[S.sheet];
  const rect = S.last.nodes.length > CULL_AT ? viewRect(1) : null;
  const d = drawSvg(S.last, sheet, false, rect);
  els.svgHost.innerHTML = d.svg;
  S.last.stats = d.stats; S.last.drawnRect = rect; S.last.drawnCount = d.count;
  markSelection();
  markHits();
}

/** The part of the map on screen, in map units, grown by `grow` screens on each side. */
function viewRect(grow) {
  const v = view(), r = els.stage.getBoundingClientRect(), b = S.last.box;
  const w = r.width / v.z, h = r.height / v.z;
  const x0 = b.x0 - v.tx / v.z, y0 = b.y0 - v.ty / v.z;
  return { x0: x0 - w * grow, y0: y0 - h * grow, x1: x0 + w * (1 + grow), y1: y0 + h * (1 + grow) };
}

// ---------- pan and zoom ----------
let drawTimer = null;
function applyTransform(noDraw) {
  const v = view();
  els.svgHost.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
  els.zoomTxt.textContent = Math.round(v.z * 100) + '%';
  const dr = S.last && S.last.drawnRect;
  if (!noDraw && dr) {
    const now = viewRect(0);
    const tooSmall = (now.x1 - now.x0) < (dr.x1 - dr.x0) / 8; // zoomed in a lot: draw less
    if (now.x0 < dr.x0 || now.y0 < dr.y0 || now.x1 > dr.x1 || now.y1 > dr.y1 || tooSmall) {
      clearTimeout(drawTimer);
      drawTimer = setTimeout(() => { if (S.last && S.last.drawnRect) draw(); }, 40);
    }
  }
}
function fitZoom() {
  const r = els.stage.getBoundingClientRect();
  return Math.max(0.02, Math.min(1.5, (r.width - 20) / S.last.W, (r.height - 20) / S.last.H));
}
function fit(noDraw) {
  const v = view(), r = els.stage.getBoundingClientRect();
  v.z = fitZoom();
  v.tx = (r.width - S.last.W * v.z) / 2; v.ty = (r.height - S.last.H * v.z) / 2;
  applyTransform(noDraw);
}
function centerOn(n, z, noDraw) {
  const v = view(), r = els.stage.getBoundingClientRect();
  if (z) v.z = z;
  const b = S.last.box;
  v.tx = r.width / 2 - (n.x + n.w / 2 - b.x0) * v.z;
  v.ty = r.height / 2 - (n.y + n.h / 2 - b.y0) * v.z;
  applyTransform(noDraw);
}
function initialView(noDraw) {
  const fz = fitZoom();
  if (fz >= 0.55) { fit(noDraw); if (view().z > 1) { view().z = 1; centerOn(S.last.root, 0, noDraw); } return; }
  centerOn(S.last.root, 0.8, noDraw);
}
function zoomAt(f, sx, sy) {
  const v = view();
  const nz = Math.max(0.02, Math.min(4, v.z * f));
  const k = nz / v.z;
  v.tx = sx - (sx - v.tx) * k; v.ty = sy - (sy - v.ty) * k; v.z = nz;
  applyTransform();
}
function zoomBy(f) { const r = els.stage.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); }

function wireStage() {
  const st = els.stage;
  st.addEventListener('wheel', e => {
    e.preventDefault();
    const r = st.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 3 : 1)), e.clientX - r.left, e.clientY - r.top);
    else { const v = view(); const k = e.deltaMode ? 30 : 1; v.tx -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k; v.ty -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k; applyTransform(); }
  }, { passive: false });
  let drag = null;
  st.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    st.focus({ preventScroll: true });
    drag = { x: e.clientX, y: e.clientY, tx: view().tx, ty: view().ty, moved: false, target: e.target };
    st.setPointerCapture(e.pointerId);
  });
  st.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; st.classList.add('panning');
    const v = view(); v.tx = drag.tx + dx; v.ty = drag.ty + dy; applyTransform();
  });
  const up = e => {
    if (!drag) return;
    const d = drag; drag = null; st.classList.remove('panning');
    try { st.releasePointerCapture(e.pointerId); } catch {}
    if (!d.moved && e.type === 'pointerup') clickAt(d.target, e);
  };
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', up);
  st.addEventListener('dblclick', e => {
    const g = e.target.closest && e.target.closest('g.tp');
    if (g) { const n = S.last.nodes[Number(g.dataset.i)]; if (n && n.depth > 0 && n.t.children.length) toggle(n); }
  });
  st.addEventListener('keydown', onKey);
  // The stage never scrolls: moving is done with the transform. Focus or find-in-page could scroll it otherwise.
  st.addEventListener('scroll', () => { st.scrollTop = 0; st.scrollLeft = 0; });
}

function clickAt(target, e) {
  const g = target.closest && target.closest('g.tp');
  if (!g) { if (S.selected) { S.selected = null; markSelection(); showDetails(); } return; }
  const n = S.last.nodes[Number(g.dataset.i)];
  if (!n) return;
  if (target.closest('g.tg')) { toggle(n); return; }
  const ico = target.closest('.ico');
  const act = ico ? ico.getAttribute('data-act') : '';
  S.lastClick = { id: n.t.id, act };
  select(n.t.id, false);
  if (act === 'link') openLink(n.t.href);
  if (act === 'note') { S.detailsOpen = true; showDetails(); }
}

function openLink(href) {
  const m = /^xmind:#(.+)$/i.exec(href || '');
  if (m) { jumpTo(decodeURIComponent(m[1])); return; }
  vscode.postMessage({ type: 'openLink', href });
}

function jumpTo(id) {
  for (let i = 0; i < S.model.sheets.length; i++) {
    const ix = indexSheet(S.model.sheets[i]);
    if (ix.byId.has(id)) {
      if (i !== S.sheet) switchSheet(i);
      reveal(id);
      select(id, true);
      return;
    }
    if (S.model.sheets[i].id === id) { switchSheet(i); return; }
  }
  notice('The linked topic is not in this file.');
}

function toggle(n) {
  const v = view();
  if (v.collapsed.has(n.t.id)) v.collapsed.delete(n.t.id); else v.collapsed.add(n.t.id);
  // keep the toggled topic still on screen
  const before = { x: n.x, y: n.y };
  const b0 = S.last.box;
  render(true);
  const m = S.last.byId.get(n.t.id);
  if (m) {
    const b1 = S.last.box;
    v.tx += ((before.x - b0.x0) - (m.x - b1.x0)) * v.z;
    v.ty += ((before.y - b0.y0) - (m.y - b1.y0)) * v.z;
    applyTransform();
  }
}

function collapseTo(level) {
  const sheet = S.model.sheets[S.sheet], ix = indexSheet(sheet), v = view();
  v.collapsed.clear();
  for (const t of ix.all) if (ix.depth.get(t.id) >= level && t.children.length) v.collapsed.add(t.id);
  v.fitted = false;
  render(true);
}

function reveal(id) {
  const sheet = S.model.sheets[S.sheet], ix = indexSheet(sheet), v = view();
  let changed = false;
  let p = ix.parent.get(id);
  while (p) { if (v.collapsed.delete(p.id)) changed = true; p = ix.parent.get(p.id); }
  if (changed) render(true);
}

function select(id, center) {
  S.selected = id;
  markSelection();
  const n = S.last.byId.get(id);
  if (n && center) {
    const v = view(), r = els.stage.getBoundingClientRect();
    const b = S.last.box;
    const sx = v.tx + (n.x - b.x0) * v.z, sy = v.ty + (n.y - b.y0) * v.z;
    if (sx < 20 || sy < 20 || sx + n.w * v.z > r.width - 20 || sy + n.h * v.z > r.height - 20) centerOn(n, Math.max(v.z, 0.6));
  }
  showDetails();
}

function markSelection() {
  const old = els.svgHost.querySelector('g.tp.sel');
  if (old) old.classList.remove('sel');
  if (!S.selected || !S.last) return;
  const n = S.last.byId.get(S.selected);
  if (!n) return;
  const g = els.svgHost.querySelector(`g.tp[data-i="${n.i}"]`);
  if (g) g.classList.add('sel');
}

function onKey(e) {
  if (e.target !== els.stage) return;
  const v = view();
  const k = e.key;
  if (k === 'f' || k === 'F') { fit(); e.preventDefault(); return; }
  if (k === '+' || k === '=') { zoomBy(1.25); e.preventDefault(); return; }
  if (k === '-' || k === '_') { zoomBy(0.8); e.preventDefault(); return; }
  if (k === '0') { v.z = 1; centerOn(S.selected && S.last.byId.get(S.selected) || S.last.root); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'f') { els.search.focus(); els.search.select(); e.preventDefault(); return; }
  const cur = S.selected && S.last.byId.get(S.selected);
  if (!cur) { if (k.startsWith('Arrow')) { select(S.last.root.t.id, true); e.preventDefault(); } return; }
  let next = null;
  const sib = d => { const p = cur.parent; if (!p) return null; const list = p.kids.includes(cur) ? p.kids : null; if (!list) return null; return list[list.indexOf(cur) + d] || null; };
  const dir = cur.dir;
  const vertical = dir === 2 || dir === 3 || dir === 4;
  const toChild = () => cur.kids[0] || null;
  const toParent = () => cur.parent;
  if (k === 'ArrowUp') next = vertical ? (dir === 4 ? sib(-1) || toParent() : toParent()) : sib(-1);
  else if (k === 'ArrowDown') next = vertical ? (dir === 4 ? toChild() || sib(1) : toChild()) : sib(1);
  else if (k === 'ArrowLeft') next = vertical ? (dir === 4 ? toParent() : sib(-1)) : (cur.depth === 0 ? cur.kids.find(c => c.dir === -1) : (dir === -1 ? toChild() : toParent()));
  else if (k === 'ArrowRight') next = vertical ? (dir === 4 ? toChild() : sib(1)) : (cur.depth === 0 ? cur.kids.find(c => c.dir !== -1) : (dir === -1 ? toParent() : toChild()));
  else if (k === ' ' || k === 'Enter') { if (cur.depth > 0 && cur.t.children.length) toggle(cur); e.preventDefault(); return; }
  else if (k === 'Escape') { S.selected = null; markSelection(); showDetails(); return; }
  if (next) { select(next.t.id, true); e.preventDefault(); }
}

// ---------- search ----------
function runSearch(q) {
  S.search.q = q;
  const sheet = S.model.sheets[S.sheet], ix = indexSheet(sheet);
  const needle = q.trim().toLowerCase();
  S.search.hits = [];
  S.search.idx = -1;
  if (needle) {
    for (const t of ix.all) {
      if (String(t.title).toLowerCase().includes(needle) || (t.note && t.note.toLowerCase().includes(needle)) || t.labels.some(l => l.toLowerCase().includes(needle)) || (t.equation && t.equation.toLowerCase().includes(needle))) S.search.hits.push(t.id);
    }
    // keep the map order: preorder of the sheet
    const pos = new Map();
    let i = 0;
    const st = [sheet.root, ...sheet.detached.slice().reverse()];
    while (st.length) { const t = st.pop(); pos.set(t.id, i++); const nx = [...t.children, ...t.summaries.map(s => s.topic).filter(Boolean)]; for (let j = nx.length - 1; j >= 0; j--) st.push(nx[j]); }
    S.search.hits.sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
  }
  els.hitTxt.textContent = needle ? (S.search.hits.length ? `${S.search.hits.length} found` : 'no match') : '';
  if (S.search.hits.length) stepHit(1); else markHits();
}
function stepHit(d) {
  const hs = S.search.hits;
  if (!hs.length) return;
  S.search.idx = (S.search.idx + d + hs.length) % hs.length;
  const id = hs[S.search.idx];
  reveal(id);
  markHits();
  select(id, true);
  els.hitTxt.textContent = `${S.search.idx + 1} of ${hs.length}`;
}
function markHits() {
  for (const g of els.svgHost.querySelectorAll('g.tp.hit')) g.classList.remove('hit');
  if (!S.search.hits.length || !S.last) return;
  for (const id of S.search.hits) {
    const n = S.last.byId.get(id);
    if (!n) continue;
    const g = els.svgHost.querySelector(`g.tp[data-i="${n.i}"]`);
    if (g) g.classList.add('hit');
  }
}

// ---------- details panel ----------
function showDetails() {
  els.details.setAttribute('aria-pressed', String(S.detailsOpen));
  els.panel.hidden = !S.detailsOpen;
  if (!S.detailsOpen) return;
  const p = els.panel;
  p.innerHTML = '';
  const sheet = S.model.sheets[S.sheet];
  const t = S.selected ? indexSheet(sheet).byId.get(S.selected) : null;
  if (!t) {
    p.append(h('h3', { text: sheet.title }), h('p', { class: 'muted', text: 'Click a topic to see its notes, labels, markers and link here.' }));
    const c = sheet.counts;
    p.append(h('ul', { class: 'facts' }, ...[['Topics', c.topics], ['Relationships', c.relationships], ['Boundaries', c.boundaries], ['Summaries', c.summaries], ['Markers', c.markers], ['Notes', c.notes], ['Pictures', c.images], ['Equations', c.equations]].map(([k, v]) => h('li', {}, h('span', { text: k }), h('b', { text: String(v) })))));
    return;
  }
  p.append(h('h3', { text: t.title || '(no title)' }));
  if (t.equation) {
    const box = h('div', { class: 'eqpanel' });
    try { box.innerHTML = window.katex.renderToString(t.equation, { throwOnError: false, displayMode: true, strict: 'ignore' }); } catch { box.textContent = t.equation; }
    p.append(box, h('code', { class: 'latex', text: t.equation }));
  }
  if (t.markers.length) p.append(h('div', { class: 'row' }, ...t.markers.map(m => h('span', { class: 'chip', text: markerGlyph(m).label }))));
  if (t.labels.length) p.append(h('div', { class: 'row' }, ...t.labels.map(l => h('span', { class: 'chip label', text: l }))));
  if (t.href) p.append(h('div', { class: 'row' }, h('button', { title: t.href, onclick: () => openLink(t.href) }, 'Open link…'), h('span', { class: 'href', text: t.href })));
  if (t.imageRefused) p.append(h('p', { class: 'muted', text: `Picture not read: ${t.imageRefused}.` }));
  if (t.note) p.append(h('div', { class: 'note', text: t.note }));
  p.append(h('div', { class: 'row' }, h('button', { onclick: () => vscode.postMessage({ type: 'copy', text: t.title, what: 'the topic title' }) }, 'Copy title'),
    h('button', { onclick: () => vscode.postMessage({ type: 'copy', text: sheetMarkdown({ title: t.title || 'Topic', root: t, detached: [], relationships: [] }, 2), what: 'the branch as Markdown' }) }, 'Copy branch')));
}

// ---------- images ----------
function requestImages() {
  if (!S.last) return;
  for (const n of S.last.nodes) {
    const src = n.t.image && n.t.image.src;
    if (!src || S.images.has(src)) continue;
    S.images.set(src, 'pending');
    S.imgQueue.push(src);
  }
  pumpImages();
}
function pumpImages() {
  while (S.imgBusy < 3 && S.imgQueue.length) {
    const src = S.imgQueue.shift();
    S.imgBusy++; S.imgStats.requested++;
    vscode.postMessage({ type: 'image', src });
  }
}
function onImage(m) {
  S.imgBusy = Math.max(0, S.imgBusy - 1);
  if (m.error) { S.images.set(m.src, 'error'); S.imgStats.failed++; }
  else {
    S.images.set(m.src, m.url); S.imgStats.loaded++;
    for (const im of els.svgHost.querySelectorAll('image[data-src]')) if (im.getAttribute('data-src') === m.src) im.setAttribute('href', m.url);
    for (const ph of els.svgHost.querySelectorAll('rect.imgph')) if (ph.getAttribute('data-src') === m.src) ph.remove();
  }
  pumpImages();
}

// ---------- export ----------
function exportSvgText(kind) {
  const d = drawSvg(S.last, S.model.sheets[S.sheet], kind || 'svg');
  return { text: '<?xml version="1.0" encoding="UTF-8"?>\n' + d.svg, W: d.W, H: d.H };
}
function sheetSuffix() {
  const s = S.model.sheets.length > 1 ? ' - ' + S.model.sheets[S.sheet].title.replace(/[^\w .()-]+/g, '').trim().slice(0, 40) : '';
  return s.trim() === '-' ? '' : s;
}
async function svgToPng(text, W, H) {
  const MAX_SIDE = 16000, MAX_AREA = 100e6;
  let scale = Math.min(2, MAX_SIDE / W, MAX_SIDE / H, Math.sqrt(MAX_AREA / (W * H)));
  scale = Math.max(0.05, scale);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('The picture could not be drawn.')); img.src = url; });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * scale)); c.height = Math.max(1, Math.round(H * scale));
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res, rej) => { try { c.toBlob(b => (b ? res(b) : rej(new Error('The canvas is too large.'))), 'image/png'); } catch (e) { rej(e); } });
    return { blob, scale, w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}
function b64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
async function doExport(kind) {
  try {
    if (kind === 'svg') {
      const { text } = exportSvgText();
      S.lastExport = { kind, bytes: text.length };
      vscode.postMessage({ type: 'save', kind: 'svg', text, suffix: sheetSuffix() });
    } else if (kind === 'png') {
      const { text, W, H } = exportSvgText('png');
      let r;
      try { r = await svgToPng(text, W, H); }
      catch (e) {
        // Equations travel as MathML in a foreignObject; if the canvas refuses that, draw them as LaTeX text.
        const plain = text.replace(/<foreignObject[\s\S]*?<\/foreignObject>/g, '');
        r = await svgToPng(plain, W, H);
      }
      const data = b64(await r.blob.arrayBuffer());
      S.lastExport = { kind, w: r.w, h: r.h, bytes: r.blob.size };
      vscode.postMessage({ type: 'save', kind: 'png', base64: data, suffix: sheetSuffix() });
    } else if (kind === 'mdcopy') {
      const text = sheetMarkdown(S.model.sheets[S.sheet], 1);
      S.lastExport = { kind, bytes: text.length, text };
      vscode.postMessage({ type: 'copy', text, what: 'the sheet as Markdown' });
    } else if (kind === 'md') {
      const text = mapMarkdown(S.model, S.name.replace(/\.[^.]+$/, ''));
      S.lastExport = { kind, bytes: text.length, text };
      vscode.postMessage({ type: 'save', kind: 'md', text, suffix: '' });
    }
  } catch (e) {
    S.lastExport = { kind, error: String(e && e.message || e) };
    notice('Export failed: ' + (e && e.message ? e.message : e));
  }
}

// ---------- messages ----------
function showError(msg, code) {
  S.error = msg; S.errorCode = code || '';
  app.innerHTML = '';
  const hint = code === 'bomb' ? 'The file was not unpacked. Nothing was written to disk.'
    : code === 'password' ? ''
      : code === 'notzip' ? 'XMind files (.xmind) are ZIP packages. This one is not.'
        : 'The file was not changed.';
  app.append(h('div', { class: 'error' },
    h('h2', { text: `${S.name} could not be opened` }),
    h('p', { class: 'msg', text: msg }),
    hint ? h('p', { class: 'muted', text: hint }) : null,
    h('p', { class: 'muted', text: 'XMind Viewer opens XMind 2020 and later, XMind Zen, XMind 8, FreeMind (.mm) and OPML files.' })));
  if (!S.failedSent) { S.failedSent = true; vscode.postMessage({ type: 'failed' }); }
}

window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') { S.name = m.name; S.size = m.size; S.sizeText = m.sizeText; S.settings = m.settings || {}; }
  else if (m.type === 'model') {
    S.model = unflatten(m.model); S.readMs = m.readMs; S.views = []; S.last = null; S.measureCache.clear();
    S.error = null; S.dismissed = false;
    const st = vscode.getState();
    S.sheet = st && st.sheet < S.model.sheets.length ? st.sheet : 0;
    try { buildChrome(); render(true); }
    catch (err) { showError('The map could not be drawn: ' + (err && err.message ? err.message : err), 'draw'); }
  } else if (m.type === 'image') onImage(m);
  else if (m.type === 'error') showError(m.message, m.code);
  else if (m.type === 'notice') notice(m.message);
  else if (m.type === 'linkAsked' || m.type === 'linkAnswer') S.link = { ...(S.link || {}), [m.type]: m.type === 'linkAsked' ? m.href : m.open };
});

// Redraw with the new colors when the VS Code theme changes.
new MutationObserver(() => { if (S.model && S.last && !S.error) { S.measureCache.clear(); render(false); } })
  .observe(document.body, { attributes: true, attributeFilter: ['class'] });
let resizeT = null;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (S.last && !S.error) applyTransform(); }, 100); });

// Test hook for the real VS Code gate: read-only facts about what is on screen.
window.xmindProbe = () => {
  const sheet = S.model && S.model.sheets[S.sheet];
  return {
    ready: !!S.rendered, error: S.error, errorCode: S.errorCode, name: S.name, format: S.model && S.model.format,
    sheet: S.sheet, sheetTitles: S.model ? S.model.sheets.map(s => s.title) : [],
    counts: S.model ? S.model.sheets.map(s => ({ title: s.title, ...s.counts, layout: s.layout })) : [],
    layout: sheet ? view().layout : '', nodes: S.last ? S.last.nodes.length : 0, drawn: S.last ? S.last.stats : null, culled: !!(S.last && S.last.drawnRect), drawnCount: S.last ? S.last.drawnCount : 0,
    domNodes: els.svgHost ? els.svgHost.querySelectorAll('g.tp').length : 0,
    katex: els.svgHost ? els.svgHost.querySelectorAll('.katex').length : 0,
    renderMs: S.renderMs, firstRenderMs: S.firstRenderMs, readMs: S.readMs,
    images: { ...S.imgStats, shown: els.svgHost ? [...els.svgHost.querySelectorAll('image[href]')].length : 0 },
    zoom: sheet ? view().z : 0, collapsed: sheet ? view().collapsed.size : 0,
    search: { q: S.search.q, hits: S.search.hits.length, idx: S.search.idx }, selected: S.selected,
    notes: S.model ? [...(S.model.notes || []), ...(sheet ? sheet.notes : [])] : [], warnShown: els.warn ? !els.warn.hidden : false,
    notices: S.notices.slice(-5), lastExport: S.lastExport ? { ...S.lastExport, text: undefined } : null,
    lastClick: S.lastClick || null, link: S.link || null, light: isLight(), size: S.last ? [S.last.W, S.last.H] : null,
  };
};
window.xmindTest = {
  markdown: () => sheetMarkdown(S.model.sheets[S.sheet], 1),
  rootTitle: () => S.model.sheets[S.sheet].root.title,
  firstTopicWith: pred => { const ix = indexSheet(S.model.sheets[S.sheet]); const t = ix.all.find(pred); return t ? t.id : null; },
  openLink: href => openLink(href),
  nodeIndex: id => { const n = S.last && S.last.byId.get(id); return n ? n.i : -1; },
};

vscode.postMessage({ type: 'ready' });
