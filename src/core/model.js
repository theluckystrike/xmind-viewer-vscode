'use strict';
// Turns XMind 2020+ (content.json), XMind 8 (content.xml), FreeMind (.mm) and OPML into one plain model that
// the webview draws. Every walk is iterative, so a topic tree 100,000 levels deep cannot overflow the stack.
// Topic: { id, title, children[], markers[], labels[], note, href, image, equation, boundaries[], summaries[],
//          folded, fill, position, side }
// Sheet: { id, title, layout, structure, layoutNote, root, detached[], relationships[], counts, notes[] }
const { parseXml, local, textOf } = require('./xml');
const { unsafeName } = require('./zip');

const MAX_DEPTH = 10000;
const MAX_TITLE = 5000;
const MAX_NOTE = 20000;

const LAYOUTS = ['map', 'right', 'left', 'tree', 'org', 'orgup'];

/** XMind structure class -> { layout, note } */
function layoutOf(structure) {
  const s = String(structure || '').toLowerCase();
  if (!s) return { layout: 'map', note: '' };
  if (s.includes('.map')) return { layout: 'map', note: '' };
  if (s.includes('logic.left')) return { layout: 'left', note: '' };
  if (s.includes('logic.right')) return { layout: 'right', note: '' };
  if (s.includes('tree.')) return { layout: 'tree', note: '' };
  if (s.includes('org-chart.up')) return { layout: 'orgup', note: '' };
  if (s.includes('org-chart')) return { layout: 'org', note: '' };
  if (s.includes('fishbone')) return { layout: 'right', note: 'This sheet is a fishbone chart in XMind. It is shown as a Logic chart (right).' };
  if (s.includes('timeline')) return { layout: 'org', note: 'This sheet is a timeline in XMind. It is shown as an Org chart.' };
  if (s.includes('spreadsheet') || s.includes('treetable') || s.includes('matrix')) return { layout: 'right', note: 'This sheet is a matrix (tree table) in XMind. It is shown as a Logic chart (right).' };
  if (s.includes('brace')) return { layout: 'right', note: 'This sheet is a brace map in XMind. It is shown as a Logic chart (right).' };
  return { layout: 'map', note: '' };
}

function str(v, max) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  const s = String(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** "(0,2)" -> [0,2]; "(master)" or "master" -> 'master'; anything else -> null */
function parseRange(r, n) {
  const s = String(r || '').trim();
  if (/^\(?master\)?$/i.test(s)) return 'master';
  const m = /^\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (a > b || b >= n) return null;
  return [a, b];
}

/** "xap:resources/a.png" -> { src:'resources/a.png' } or { bad: reason } */
function imageRef(src) {
  let s = String(src || '').trim();
  if (!s) return null;
  if (/^xap:/i.test(s)) s = s.slice(4);
  else if (/^(https?:|data:|file:)/i.test(s)) return { bad: 'not inside the file (pictures are only read from inside the .xmind package)' };
  const why = unsafeName(s);
  if (why) return { bad: why };
  return { src: s };
}

function mathFromExtensions(ext) {
  if (!Array.isArray(ext)) return '';
  for (const e of ext) {
    if (!e || typeof e !== 'object' || !/math|latex|equation/i.test(String(e.provider || ''))) continue;
    const c = e.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const hit = c.find(x => x && typeof x === 'object' && (x.name === 'content' || x.name === 'latex')) || c.find(x => x && typeof x.content === 'string');
      if (hit && typeof hit.content === 'string') return hit.content;
    }
    if (c && typeof c === 'object' && typeof c.content === 'string') return c.content;
  }
  return '';
}

class Builder {
  constructor() { this.ids = new Set(); this.seq = 0; this.notes = []; this.counts = { topics: 0, relationships: 0, boundaries: 0, summaries: 0, markers: 0, images: 0, notes: 0, labels: 0, equations: 0, links: 0 }; this.badImages = 0; this.badRanges = 0; this.depthCut = 0; this.dupIds = 0; }
  id(raw) {
    let id = typeof raw === 'string' && raw ? raw.slice(0, 200) : '';
    if (!id) id = '_t' + (++this.seq);
    if (this.ids.has(id)) { this.dupIds++; id = id + '_' + (++this.seq); }
    this.ids.add(id);
    return id;
  }
  topic(o) {
    const t = {
      id: this.id(o.id), title: str(o.title, MAX_TITLE), children: [],
      markers: [], labels: [], note: '', href: '', image: null, equation: '', boundaries: [], summaries: [], folded: !!o.folded,
    };
    this.counts.topics++;
    if (o.fill) t.fill = o.fill;
    if (o.color) t.color = o.color;
    if (o.position) t.position = o.position;
    if (o.side) t.side = o.side;
    for (const m of o.markers || []) { const id = str(m, 100); if (id) { t.markers.push(id); this.counts.markers++; } }
    for (const l of o.labels || []) { const s = str(l, 200); if (s) { t.labels.push(s); this.counts.labels++; } }
    if (o.note) { t.note = str(o.note, MAX_NOTE); if (t.note) this.counts.notes++; }
    if (o.href) { t.href = str(o.href, 4000); if (t.href) this.counts.links++; }
    if (o.image) {
      const r = imageRef(o.image.src);
      if (r && r.src) { t.image = { src: r.src, w: num(o.image.w), h: num(o.image.h) }; this.counts.images++; }
      else if (r && r.bad) { this.badImages++; t.imageRefused = r.bad; }
    }
    if (o.equation) { t.equation = str(o.equation, 4000); if (t.equation) this.counts.equations++; }
    return t;
  }
  finishNotes(sheetTitle) {
    if (this.badImages) this.notes.push(`${this.badImages} picture link(s) pointed outside the package and were not read.`);
    if (this.badRanges) this.notes.push(`${this.badRanges} boundary or summary range(s) did not match the topics and were left out.`);
    if (this.depthCut) this.notes.push(`Topics deeper than ${MAX_DEPTH} levels are not shown.`);
    if (this.dupIds) this.notes.push(`${this.dupIds} topic id(s) were used twice; the copies got new ids.`);
    return this.notes;
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 100000 ? n : 0; }

/**
 * Generic iterative tree build. src nodes are read through an adapter:
 *   a.fields(node) -> topic fields (title, markers, ...)
 *   a.attached(node) -> array of child src nodes
 *   a.detached(node) -> array (root only), a.summaryTopics(node) -> array
 *   a.boundaries(node) -> [{range,title}], a.summaries(node) -> [{range, topicId}]
 */
function buildTree(B, rootSrc, a) {
  const root = B.topic(a.fields(rootSrc, 0));
  const detached = [];
  const stack = [{ src: rootSrc, dst: root, depth: 0 }];
  while (stack.length) {
    const { src, dst, depth } = stack.pop();
    if (depth >= MAX_DEPTH) { B.depthCut++; continue; }
    const kids = a.attached(src);
    const pending = [];
    for (const k of kids) {
      const t = B.topic(a.fields(k, depth + 1));
      dst.children.push(t);
      pending.push({ src: k, dst: t, depth: depth + 1 });
    }
    // summary topics: built here, linked to the summary entries by id
    const sumTopics = new Map();
    for (const k of a.summaryTopics(src)) {
      const t = B.topic(a.fields(k, depth + 1));
      sumTopics.set(a.rawId(k), t);
      pending.push({ src: k, dst: t, depth: depth + 1 });
    }
    const n = dst.children.length;
    for (const b of a.boundaries(src)) {
      const r = parseRange(b.range, n);
      if (!r || (r !== 'master' && n === 0)) { B.badRanges++; continue; }
      dst.boundaries.push({ from: r === 'master' ? -1 : r[0], to: r === 'master' ? -1 : r[1], title: str(b.title, 500) });
      B.counts.boundaries++;
    }
    const usedSum = new Set();
    for (const s of a.summaries(src)) {
      const r = parseRange(s.range, n);
      if (!r || r === 'master') { B.badRanges++; continue; }
      const t = sumTopics.get(s.topicId) || null;
      if (t) usedSum.add(s.topicId);
      dst.summaries.push({ from: r[0], to: r[1], topic: t });
      B.counts.summaries++;
    }
    // A summary topic that no summary points to still shows, over all children.
    for (const [id, t] of sumTopics) if (!usedSum.has(id) && n > 0) dst.summaries.push({ from: 0, to: n - 1, topic: t, orphan: true });
    if (depth === 0) {
      for (const k of a.detached(src)) {
        const t = B.topic(a.fields(k, 1));
        detached.push(t);
        pending.push({ src: k, dst: t, depth: 1 });
      }
    }
    for (let i = pending.length - 1; i >= 0; i--) stack.push(pending[i]);
  }
  return { root, detached };
}

function finishSheet(B, raw) {
  const all = new Set();
  const walk = [raw.root, ...raw.detached];
  while (walk.length) {
    const t = walk.pop();
    all.add(t.id);
    for (const c of t.children) walk.push(c);
    for (const s of t.summaries) if (s.topic) walk.push(s.topic);
  }
  const rels = [];
  let badRels = 0;
  for (const r of raw.relationships || []) {
    if (!r || !all.has(r.from) || !all.has(r.to) || r.from === r.to) { badRels++; continue; }
    rels.push({ id: str(r.id, 200) || 'r' + rels.length, from: r.from, to: r.to, title: str(r.title, 500) });
  }
  B.counts.relationships = rels.length;
  const notes = B.finishNotes();
  if (badRels) notes.push(`${badRels} relationship(s) point to a topic that is not in this sheet and are not drawn.`);
  const lay = layoutOf(raw.structure);
  return {
    id: raw.id, title: raw.title, structure: raw.structure || '', layout: raw.layoutOverride || lay.layout, layoutNote: lay.note,
    root: raw.root, detached: raw.detached, relationships: rels, counts: B.counts, notes,
  };
}

// ---------- XMind 2020+ (content.json) ----------

const jsonAdapter = {
  rawId: o => (o && typeof o.id === 'string' ? o.id : ''),
  kids(o, key) {
    const c = o && o.children;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
    const v = c[key];
    return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];
  },
  attached(o) { return jsonAdapter.kids(o, 'attached'); },
  detached(o) { return jsonAdapter.kids(o, 'detached'); },
  summaryTopics(o) { return jsonAdapter.kids(o, 'summary'); },
  boundaries(o) { return Array.isArray(o.boundaries) ? o.boundaries.filter(b => b && typeof b === 'object').map(b => ({ range: b.range, title: b.title })) : []; },
  summaries(o) { return Array.isArray(o.summaries) ? o.summaries.filter(b => b && typeof b === 'object').map(b => ({ range: b.range, topicId: b.topicId })) : []; },
  fields(o) {
    const notes = o.notes && typeof o.notes === 'object' ? o.notes : null;
    let note = '';
    if (notes) {
      if (notes.plain && typeof notes.plain.content === 'string') note = notes.plain.content;
      else if (notes.realHTML && typeof notes.realHTML.content === 'string') note = htmlToText(notes.realHTML.content);
      else if (notes.html && typeof notes.html === 'object') note = htmlToText(JSON.stringify(notes.html));
    }
    const props = o.style && o.style.properties && typeof o.style.properties === 'object' ? o.style.properties : {};
    const img = o.image && typeof o.image === 'object' ? { src: o.image.src, w: o.image.width, h: o.image.height } : null;
    const pos = o.position && typeof o.position === 'object' && Number.isFinite(Number(o.position.x)) && Number.isFinite(Number(o.position.y)) ? { x: Number(o.position.x), y: Number(o.position.y) } : null;
    return {
      id: o.id, title: o.title, folded: o.branch === 'folded',
      markers: Array.isArray(o.markers) ? o.markers.map(m => (m && typeof m === 'object' ? m.markerId : m)) : [],
      labels: Array.isArray(o.labels) ? o.labels : [],
      note, href: typeof o.href === 'string' ? o.href : '', image: img,
      equation: mathFromExtensions(o.extensions),
      fill: colorOk(props['svg:fill']), color: colorOk(props['fo:color']), position: pos,
    };
  },
};

function colorOk(c) {
  return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : '';
}

function fromContentJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('content.json is not valid JSON: ' + (e && e.message ? e.message : e)); }
  if (data && !Array.isArray(data) && Array.isArray(data.sheets)) data = data.sheets;
  if (!Array.isArray(data)) throw new Error('content.json has no list of sheets.');
  const sheets = [];
  data.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !s.rootTopic || typeof s.rootTopic !== 'object') return;
    const B = new Builder();
    const { root, detached } = buildTree(B, s.rootTopic, jsonAdapter);
    const rels = Array.isArray(s.relationships) ? s.relationships.filter(r => r && typeof r === 'object').map(r => ({ id: r.id, from: r.end1Id, to: r.end2Id, title: r.title })) : [];
    sheets.push(finishSheet(B, { id: str(s.id, 200) || 's' + i, title: str(s.title, 300) || `Sheet ${i + 1}`, structure: s.rootTopic.structureClass, root, detached, relationships: rels }));
  });
  if (!sheets.length) throw new Error('content.json has no sheet with a central topic.');
  return { format: 'xmind-json', sheets };
}

// ---------- XMind 8 (content.xml) ----------

const el = n => (n && n.children ? n.children.filter(c => typeof c !== 'string') : []);
const kid = (n, name) => el(n).find(c => local(c.name) === name) || null;
const kidsNamed = (n, name) => el(n).filter(c => local(c.name) === name);
const attr = (n, name) => { if (!n) return undefined; for (const k of Object.keys(n.attrs)) if (k === name || local(k) === name) return n.attrs[k]; return undefined; };

function xmlTopicsOfType(n, type) {
  const ch = kid(n, 'children');
  if (!ch) return [];
  const out = [];
  for (const ts of kidsNamed(ch, 'topics')) {
    if ((attr(ts, 'type') || 'attached') !== type) continue;
    for (const t of kidsNamed(ts, 'topic')) out.push(t);
  }
  return out;
}

const xmlAdapter = {
  rawId: n => attr(n, 'id') || '',
  attached: n => xmlTopicsOfType(n, 'attached'),
  detached: n => xmlTopicsOfType(n, 'detached'),
  summaryTopics: n => xmlTopicsOfType(n, 'summary'),
  boundaries: n => { const b = kid(n, 'boundaries'); return b ? kidsNamed(b, 'boundary').map(x => ({ range: attr(x, 'range'), title: kid(x, 'title') ? textOf(kid(x, 'title')) : '' })) : []; },
  summaries: n => { const b = kid(n, 'summaries'); return b ? kidsNamed(b, 'summary').map(x => ({ range: attr(x, 'range'), topicId: attr(x, 'topic-id') })) : []; },
  fields(n) {
    const tt = kid(n, 'title');
    const notes = kid(n, 'notes');
    let note = '';
    if (notes) {
      const plain = kid(notes, 'plain');
      const html = kid(notes, 'html');
      note = plain ? textOf(plain) : html ? xmlBlocksText(html) : '';
    }
    const mr = kid(n, 'marker-refs');
    const labels = kid(n, 'labels');
    const img = kid(n, 'img');
    const pos = kid(n, 'position');
    let equation = '';
    const exts = kid(n, 'extensions');
    if (exts) for (const e of kidsNamed(exts, 'extension')) if (/math|latex|equation/i.test(attr(e, 'provider') || '')) { const c = kid(e, 'content'); equation = c ? textOf(c).trim() : textOf(e).trim(); }
    return {
      id: attr(n, 'id'), title: tt ? textOf(tt) : '', folded: attr(n, 'branch') === 'folded',
      markers: mr ? kidsNamed(mr, 'marker-ref').map(m => attr(m, 'marker-id')) : [],
      labels: labels ? kidsNamed(labels, 'label').map(l => textOf(l)) : [],
      note, href: attr(n, 'href') || '',
      image: img ? { src: attr(img, 'src'), w: attr(img, 'width'), h: attr(img, 'height') } : null,
      equation,
      position: pos && Number.isFinite(Number(attr(pos, 'x'))) ? { x: Number(attr(pos, 'x')), y: Number(attr(pos, 'y')) } : null,
    };
  },
};

function xmlBlocksText(n) {
  // Iterative text with line breaks between block elements.
  let s = '';
  const st = [n];
  while (st.length) {
    const x = st.pop();
    if (typeof x === 'string') { s += x; continue; }
    if (x === '\n') { s += '\n'; continue; }
    const ln = local(x.name);
    if (ln === 'p' || ln === 'div' || ln === 'li' || ln === 'br') st.push('\n');
    for (let i = x.children.length - 1; i >= 0; i--) st.push(x.children[i]);
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function fromContentXml(text) {
  const doc = parseXml(text);
  const top = el(doc).find(c => local(c.name) === 'xmap-content');
  if (!top) throw new Error('content.xml has no xmap-content element.');
  const sheets = [];
  kidsNamed(top, 'sheet').forEach((s, i) => {
    const rt = kid(s, 'topic');
    if (!rt) return;
    const B = new Builder();
    const { root, detached } = buildTree(B, rt, xmlAdapter);
    const relsEl = kid(s, 'relationships');
    const rels = relsEl ? kidsNamed(relsEl, 'relationship').map(r => ({ id: attr(r, 'id'), from: attr(r, 'end1'), to: attr(r, 'end2'), title: kid(r, 'title') ? textOf(kid(r, 'title')) : '' })) : [];
    const title = kid(s, 'title');
    sheets.push(finishSheet(B, { id: attr(s, 'id') || 's' + i, title: (title ? textOf(title) : '') || `Sheet ${i + 1}`, structure: attr(rt, 'structure-class'), root, detached, relationships: rels }));
  });
  if (!sheets.length) throw new Error('content.xml has no sheet with a central topic.');
  return { format: 'xmind-xml', sheets };
}

/** XMind 2020+ also writes a content.xml that only holds a warning. */
function isWarningStub(xmlText) {
  return /can ?not be opened normally|please do not modify and save/i.test(xmlText.slice(0, 4000));
}

// ---------- FreeMind / Freeplane (.mm) ----------

const FM_ICONS = { 'full-1': 'priority-1', 'full-2': 'priority-2', 'full-3': 'priority-3', 'full-4': 'priority-4', 'full-5': 'priority-5', 'full-6': 'priority-6', 'full-7': 'priority-7', 'full-8': 'priority-8', 'full-9': 'priority-9', button_ok: 'task-done', button_cancel: 'symbol-wrong', flag: 'flag-red', 'flag-green': 'flag-green', 'flag-blue': 'flag-blue', 'flag-yellow': 'flag-yellow', 'flag-orange': 'flag-orange', 'flag-black': 'flag-gray', idea: 'fm-idea', help: 'symbol-question', yes: 'star-yellow', messagebox_warning: 'symbol-exclam', stop: 'fm-stop', ksmiletris: 'smiley-smile', smiley_bad: 'smiley-cry', 'smily_bad': 'smiley-cry', go: 'fm-go', back: 'arrow-left', forward: 'arrow-right', up: 'arrow-up', down: 'arrow-down', clanbomber: 'fm-bomb', bookmark: 'fm-bookmark', info: 'fm-info', attach: 'fm-attach', password: 'fm-key', pencil: 'fm-pencil', calendar: 'fm-calendar', list: 'fm-list', 'very_positive': 'smiley-laugh', positive: 'smiley-smile', negative: 'smiley-cry', 'very_negative': 'smiley-angry' };

const fmAdapter = {
  rawId: n => attr(n, 'ID') || '',
  attached: n => kidsNamed(n, 'node'),
  detached: () => [],
  summaryTopics: () => [],
  boundaries: n => (kid(n, 'cloud') ? [{ range: 'master', title: '' }] : []),
  summaries: () => [],
  fields(n, depth) {
    let title = attr(n, 'TEXT');
    let note = '';
    for (const rc of kidsNamed(n, 'richcontent')) {
      const type = (attr(rc, 'TYPE') || '').toUpperCase();
      if (type === 'NOTE' || type === 'DETAILS') note = (note ? note + '\n' : '') + xmlBlocksText(rc);
      else if (type === 'NODE' && (title === undefined || title === '')) title = xmlBlocksText(rc);
    }
    const pos = (attr(n, 'POSITION') || '').toLowerCase();
    return {
      id: attr(n, 'ID'), title: title || '', folded: attr(n, 'FOLDED') === 'true',
      markers: kidsNamed(n, 'icon').map(i => { const b = attr(i, 'BUILTIN') || ''; return FM_ICONS[b] || (b ? 'fm-' + b : ''); }),
      labels: [], note, href: attr(n, 'LINK') || '', image: null, equation: '',
      side: depth === 1 && (pos === 'left' || pos === 'right') ? pos : '',
      fill: colorOk(attr(n, 'BACKGROUND_COLOR')), color: colorOk(attr(n, 'COLOR')),
    };
  },
};

function fromFreeMind(text, fileTitle) {
  const doc = parseXml(text);
  const map = el(doc).find(c => local(c.name) === 'map');
  const rn = map ? kid(map, 'node') : null;
  if (!rn) throw new Error('This .mm file has no <map><node> root, so it is not a FreeMind or Freeplane map.');
  const B = new Builder();
  const { root, detached } = buildTree(B, rn, fmAdapter);
  // arrow links: walk the source tree iteratively
  const rels = [];
  const st = [rn];
  while (st.length) {
    const n = st.pop();
    for (const a of kidsNamed(n, 'arrowlink')) rels.push({ id: attr(a, 'ID') || '', from: attr(n, 'ID'), to: attr(a, 'DESTINATION'), title: attr(a, 'MIDDLE_LABEL') || '' });
    for (const c of kidsNamed(n, 'node')) st.push(c);
  }
  return { format: 'freemind', sheets: [finishSheet(B, { id: 's0', title: fileTitle || 'Map', structure: '', root, detached, relationships: rels })] };
}

// ---------- OPML ----------

const opmlAdapter = {
  rawId: n => attr(n, 'id') || '',
  attached: n => kidsNamed(n, 'outline'),
  detached: () => [], summaryTopics: () => [], boundaries: () => [], summaries: () => [],
  fields(n) {
    if (n.synthetic) return { title: n.synthetic };
    return {
      title: attr(n, 'text') || attr(n, 'title') || '', note: attr(n, '_note') || attr(n, 'note') || '',
      href: attr(n, 'htmlUrl') || attr(n, 'url') || attr(n, 'xmlUrl') || '', markers: [], labels: [], folded: false,
    };
  },
};

function fromOpml(text, fileTitle) {
  const doc = parseXml(text);
  const opml = el(doc).find(c => local(c.name) === 'opml');
  const body = opml ? kid(opml, 'body') : null;
  if (!body) throw new Error('This file has no <opml><body>, so it is not an OPML outline.');
  const head = kid(opml, 'head');
  const ht = head ? kid(head, 'title') : null;
  const title = (ht ? textOf(ht).trim() : '') || fileTitle || 'Outline';
  const rootSrc = { name: 'outline', attrs: {}, children: body.children, synthetic: title };
  const B = new Builder();
  const { root, detached } = buildTree(B, rootSrc, opmlAdapter);
  return { format: 'opml', sheets: [finishSheet(B, { id: 's0', title, structure: '', layoutOverride: 'right', root, detached, relationships: [] })] };
}

module.exports = { fromContentJson, fromContentXml, fromFreeMind, fromOpml, isWarningStub, layoutOf, parseRange, imageRef, htmlToText, mathFromExtensions, LAYOUTS, MAX_DEPTH };
