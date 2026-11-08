// Release gate in a real VS Code: installs the .vsix into an isolated profile, opens every sample, compares the
// counts on screen with the Python reference reader (scripts/ref_xmind.py), drives the viewer with real mouse and
// key events (sheet tabs, collapse, search, link confirm, export), checks the hostile files, records network
// requests of the webviews, and writes screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson> [largeXmind] [theme]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [work0, port, vsix, samples0, shotDir, outJson, large, theme] = process.argv.slice(2);
const work = path.resolve(work0);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const R = { theme: theme || 'Default Dark Modern', install: null, steps: [], console: [], network: [], files: {}, outside: null };
const tag = R.theme.includes('Light') ? 'light' : 'dark';
// Work copy of the samples: the gate exports into it, the originals stay untouched.
const ws = path.join(work, 'ws');
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
for (const f of fs.readdirSync(samples0)) if (fs.statSync(path.join(samples0, f)).isFile()) fs.copyFileSync(path.join(samples0, f), path.join(ws, f));
let largeName = null;
if (large) { largeName = path.basename(large); fs.symlinkSync(path.resolve(large), path.join(ws, largeName)); }
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const hashes = {};
for (const f of fs.readdirSync(ws)) hashes[f] = hash(path.join(ws, f));
// Places a path traversal entry could land in.
const evilSpots = [path.join(work, 'evil.txt'), path.join(path.dirname(work), 'evil.txt'), path.join(os.homedir(), 'evil.txt'), '/abs/evil.txt', path.join(ws, 'evil.txt'), path.join(path.dirname(ws), 'x.png')];
const before = Object.fromEntries(evilSpots.map(p => [p, fs.existsSync(p)]));

fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, {
  'workbench.colorTheme': R.theme, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'workbench.editor.enablePreview': false,
});
// network log of every webview frame
vs.s.on(m => {
  if (m.method === 'Target.attachedToTarget') vs.s.send('Network.enable', {}, m.params.sessionId).catch(() => {});
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    const info = vs.attached.get(m.sessionId);
    if (info && info.type === 'iframe') R.network.push(u.slice(0, 200));
  }
});
const shots = [];
const NOSHOT = !!process.env.GATE_NOSHOT; // old Electron builds can time out on screenshots of a background window
const shot = async name => { if (NOSHOT) return name; const f = path.join(shotDir, `${tag}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log(v === false ? 'FAIL' : 'PASS', name, JSON.stringify(v).slice(0, 400)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 1500), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 700)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.xmindProbe ? window.xmindProbe() : null)`));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 30000);
const open = async file => {
  const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(300);
  wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file);
  const p = await vs.waitFor(async () => { const p = await probe(); return p && (p.ready || p.error) ? p : null; }, 60000, 100);
  if (!p) throw new Error('not ready: ' + JSON.stringify(await probe()).slice(0, 400));
  return { ms: Date.now() - t0, p };
};
const tabCount = () => vs.wbEval(`document.querySelectorAll('.tabs-container .tab').length`);
const closeEditor = async () => {
  const n0 = await tabCount();
  await vs.wbEval(`(() => { const t = document.querySelector('.tabs-container .tab.active'); const b = t && t.querySelector('.tab-actions .action-label'); if (b) b.click(); })()`);
  if (await vs.waitFor(async () => (await tabCount()) < n0, 2000, 100)) { await sleep(200); return; }
  await vs.command('View: Close Editor'); await sleep(300);
};
const ref = file => JSON.parse(execFileSync('python3', ['-I', path.join(HERE, 'ref_xmind.py'), path.join(ws, file)], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000 }));
const KEYS = ['topics', 'relationships', 'boundaries', 'summaries', 'markers'];
const compare = (p, rf) => {
  const bad = [];
  if (rf.sheets.length !== p.counts.length) bad.push(`sheets ${p.counts.length} != ${rf.sheets.length}`);
  rf.sheets.forEach((s, i) => {
    const q = p.counts[i] || {};
    if (q.title !== s.title) bad.push(`sheet ${i} title "${q.title}" != "${s.title}"`);
    for (const k of KEYS) if (q[k] !== s[k]) bad.push(`sheet ${i} ${k} ${q[k]} != ${s[k]}`);
  });
  return bad;
};
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
const extHostRss = () => {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
    let best = 0;
    for (const ln of out.split('\n')) if (ln.includes(vs.ud) && /extensionHost|Code Helper \(Plugin\)|utility-sub-type=node.mojom.NodeService/.test(ln)) best = Math.max(best, Number(ln.trim().split(/\s+/)[1]) || 0);
    return Math.round(best / 1024);
  } catch { return -1; }
};

const files = fs.readdirSync(ws).filter(f => /\.(xmind|mm|opml)$/i.test(f) && f !== largeName).sort();
const hostile = f => f.startsWith('hostile-');
await sleep(1500);

// 1. Every sample: counts against the reference reader, every sheet by a real click on its tab.
for (const f of files) {
  await step(`open ${f}`, async () => {
    const rf = ref(f);
    const { ms, p } = await open(f);
    R.files[f] = { ms, first: p };
    if (rf.format === 'error') {
      must(p.error, 'expected an error message, got a map');
      must(!p.ready, 'error file should not render');
      await shot(f.replace(/\W+/g, '_'));
      await closeEditor();
      return { ms, error: p.error, code: p.errorCode, ref: rf.error };
    }
    must(!p.error, 'error: ' + p.error);
    const bad = compare(p, rf);
    const perSheet = [];
    for (let i = 0; i < p.counts.length; i++) {
      if (i > 0) {
        await vs.wvClick(wv, `document.querySelectorAll('.tab')[${i}]`);
        await vs.waitFor(async () => (await probe()).sheet === i, 5000, 100);
      }
      await sleep(i === 0 ? 400 : 250);
      // branches folded in the file hide some elements: expand all before counting what is drawn
      if ((await probe()).collapsed) { await vs.wvClick(wv, btn('Expand all')); await sleep(300); }
      const q = await probe();
      must(q.sheet === i, `tab ${i} did not switch`);
      perSheet.push({ title: q.sheetTitles[i], layout: q.layout, nodes: q.nodes, dom: q.domNodes, drawn: q.drawn, katex: q.katex, renderMs: q.renderMs });
      if (q.domNodes !== q.nodes) bad.push(`sheet ${i}: ${q.domNodes} drawn of ${q.nodes}`);
      const rs = rf.sheets[i];
      if (rs && q.drawn) {
        if (q.drawn.relationships !== rs.relationships) bad.push(`sheet ${i} drawn relationships ${q.drawn.relationships} != ${rs.relationships}`);
        if (q.drawn.boundaries !== rs.boundaries) bad.push(`sheet ${i} drawn boundaries ${q.drawn.boundaries} != ${rs.boundaries}`);
        if (q.drawn.summaries !== rs.summaries) bad.push(`sheet ${i} drawn summaries ${q.drawn.summaries} != ${rs.summaries}`);
        if (rs.equations && q.katex < rs.equations) bad.push(`sheet ${i} katex ${q.katex} < ${rs.equations}`);
      }
      if (rs && rs.images) {
        const ok = await vs.waitFor(async () => { const z = await probe(); return z.images.shown >= (rs.imagesOk ?? rs.images) ? z.images : null; }, 15000, 200);
        if (!ok) bad.push(`sheet ${i} pictures shown ${(await probe()).images.shown} < ${rs.imagesOk ?? rs.images}`);
      }
      await shot(`${f.replace(/\W+/g, '_')}-s${i + 1}`);
    }
    if (p.counts.length > 1) { await vs.wvClick(wv, `document.querySelectorAll('.tab')[0]`); await sleep(200); }
    must(!bad.length, bad.join('; '));
    const fin = await probe();
    await closeEditor();
    return { ms, format: p.format, sheets: perSheet, notes: fin.notes, warnShown: fin.warnShown };
  });
}

// 2. Interaction on project-plan-2020.xmind
const firstSheet = async () => { if ((await probe()).sheet !== 0) { await vs.wvClick(wv, `document.querySelectorAll('.tab')[0]`); await vs.waitFor(async () => (await probe()).sheet === 0, 5000, 100); } };
await step('interaction: collapse, search, link confirm, keyboard, details', async () => {
  await open('project-plan-2020.xmind');
  await firstSheet();
  const p0 = await probe();
  // collapse the first main topic by clicking its toggle
  const i1 = await E(`(() => { const g = [...document.querySelectorAll('g.tp')].find(g => g.querySelector('g.tg')); return g ? g.dataset.i : null; })()`);
  must(i1 !== null, 'no collapse toggle');
  await vs.wvClick(wv, `document.querySelector('g.tp[data-i="${i1}"] g.tg')`);
  await sleep(300);
  const p1 = await probe();
  must(p1.nodes < p0.nodes && p1.collapsed === 1, `collapse did not hide topics (${p0.nodes} -> ${p1.nodes})`);
  const collapsedShot = await shot('collapsed');
  // expand all
  await vs.wvClick(wv, btn('Expand all')); await sleep(300);
  const p2 = await probe();
  must(p2.nodes === p0.nodes, 'expand all did not restore');
  // search: real typing
  await vs.wvClick(wv, `document.querySelector('input.search')`);
  await vs.type('budget'); await sleep(400);
  const p3 = await probe();
  must(p3.search.hits >= 1 && p3.selected, 'search found nothing for "budget": ' + JSON.stringify(p3.search));
  await vs.key('Enter', 'Enter'); await sleep(250);
  const searchShot = await shot('search');
  await E(`(() => { const i = document.querySelector('input.search'); i.value = ''; i.dispatchEvent(new Event('input')); return 1; })()`);
  // keyboard: select root by arrow, then move right
  await vs.wvClick(wv, `document.querySelector('g.tp.root rect.frame')`);
  const p4 = await probe();
  await vs.key('ArrowRight', 'ArrowRight'); await sleep(200);
  const p5 = await probe();
  must(p4.selected && p5.selected && p4.selected !== p5.selected, 'arrow key did not move the selection');
  await vs.key(' ', 'Space', 0, 32); await sleep(300);
  const p6 = await probe();
  must(p6.collapsed >= 1, 'Space did not collapse');
  await vs.key(' ', 'Space', 0, 32); await sleep(300);
  // link: click the link icon -> modal confirm appears -> cancel
  await vs.wvClick(wv, `[...document.querySelectorAll('.ico.link')].find(e => !/xmind:/.test(e.textContent + (e.querySelector('title') || {}).textContent))`);
  const dlg = await vs.waitFor(() => vs.wbEval(`(() => { const d = document.querySelector('.monaco-dialog-box'); return d ? d.textContent.slice(0, 300) : null; })()`), 5000, 150);
  must(dlg && /Open this link/.test(dlg), 'no confirm dialog for the link: ' + dlg + ' ' + JSON.stringify((await probe()).lastClick));
  const dlgShot = await shot('link-confirm');
  await vs.key('Escape', 'Escape'); await sleep(400);
  const gone = await vs.wbEval(`!document.querySelector('.monaco-dialog-box')`);
  must(gone, 'dialog did not close');
  // details panel with a note
  await vs.wvClick(wv, btn('Details')); await sleep(200);
  const noteId = await E(`window.xmindTest.firstTopicWith(t => !!t.note)`);
  const ni = await E(`window.xmindTest.nodeIndex(${JSON.stringify(noteId)})`);
  await vs.wvClick(wv, `document.querySelector('g.tp[data-i="${ni}"] rect.frame')`); await sleep(200);
  const det = await E(`document.querySelector('.details .note') ? document.querySelector('.details .note').textContent : ''`);
  must(det.length > 3, 'details panel shows no note');
  const detShot = await shot('details-note');
  await vs.wvClick(wv, btn('Details'));
  // wheel zoom (Ctrl) and drag pan
  const off = await vs.wvOffset();
  const z0 = (await probe()).zoom;
  await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: off.x + off.w / 2, y: off.y + off.h / 2, deltaX: 0, deltaY: -240, modifiers: 2 }, vs.wb); await sleep(300);
  const z1 = (await probe()).zoom;
  must(z1 > z0, `ctrl+wheel did not zoom in (${z0} -> ${z1})`);
  await vs.wvClick(wv, btn('Fit')); await sleep(200);
  await closeEditor();
  return { nodes: p0.nodes, collapsedTo: p1.nodes, search: p3.search, dialog: dlg.slice(0, 120), zoom: [z0, z1], note: det.slice(0, 60), shots: [collapsedShot, searchShot, dlgShot, detShot].map(s => path.basename(s)) };
});

// 3. Exports through the real save dialog (simple dialog: Enter accepts the default name next to the map)
const acceptSave = async () => {
  const ok = await vs.waitFor(() => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent !== null); })()`), 8000, 150);
  if (!ok) throw new Error('save dialog did not open');
  await sleep(300); await vs.key('Enter', 'Enter'); await sleep(800);
  // "file exists, replace?" from an earlier run
  const again = await vs.wbEval(`!!document.querySelector('.monaco-dialog-box')`);
  if (again) { await vs.key('Enter', 'Enter'); await sleep(600); }
};
const exportVia = async value => { await E(`(() => { const s = [...document.querySelectorAll('select')].find(s => s.title === 'Export'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return 1; })()`); };
await step('export PNG, SVG and Markdown', async () => {
  await open('project-plan-2020.xmind');
  await firstSheet();
  await sleep(1500);
  const out = {};
  for (const [kind, ext] of [['png', 'png'], ['svg', 'svg'], ['md', 'md']]) {
    await exportVia(kind);
    await acceptSave();
    const cand = fs.readdirSync(ws).filter(f => f.startsWith('project-plan-2020') && f.endsWith('.' + ext));
    must(cand.length, `${ext} not written`);
    const fp = path.join(ws, cand[0]);
    const b = fs.readFileSync(fp);
    if (ext === 'png') { must(b[0] === 0x89 && b[1] === 0x50, 'not a PNG'); out.png = { file: cand[0], bytes: b.length, w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; fs.mkdirSync(shotDir, { recursive: true }); fs.copyFileSync(fp, path.join(shotDir, `${tag}-export.png`)); }
    if (ext === 'svg') { const s = b.toString('utf8'); must(s.includes('<svg') && (s.match(/<text/g) || []).length > 30, 'SVG has no map'); out.svg = { file: cand[0], bytes: b.length, mathml: s.includes('<math'), texts: (s.match(/<text/g) || []).length }; }
    if (ext === 'md') { const s = b.toString('utf8'); must(/^# /m.test(s) && /^\s*- /m.test(s), 'markdown has no outline'); out.md = { file: cand[0], bytes: b.length, head: s.split('\n').slice(0, 6).join(' | ') }; }
  }
  await exportVia('mdcopy'); await sleep(500);
  const p = await probe();
  must(p.notices.some(n => /Copied the sheet as Markdown/.test(n)), 'no copy notice: ' + JSON.stringify(p.notices));
  out.copy = p.lastExport;
  await closeEditor();
  return out;
});

// 4. Large map: first view time, collapse/expand time, memory
if (largeName) {
  await step(`large ${largeName}`, async () => {
    const rf = ref(largeName);
    let peak = extHostRss();
    const iv = setInterval(() => { peak = Math.max(peak, extHostRss()); }, 250);
    const { ms, p } = await open(largeName);
    must(!p.error, p.error);
    const bad = compare(p, rf);
    must(!bad.length, bad.join('; '));
    const img = await vs.waitFor(async () => { const z = await probe(); return z.images.loaded >= 60 ? z.images : null; }, 60000, 300);
    const shotA = await shot('large-first-view');
    // collapse a main topic with a real click on its toggle, then expand it again
    const i1 = await E(`(() => { const t = [...document.querySelectorAll('g.tp:not(.root) g.tg')].find(t => { const b = t.getBoundingClientRect(); return b.width > 4 && b.left > 40 && b.top > 120 && b.right < innerWidth - 40 && b.bottom < innerHeight - 60; }); return t ? t.closest('g.tp').dataset.i : null; })()`);
    must(i1 !== null, 'no visible collapse toggle');
    const t1 = Date.now();
    await vs.wvClick(wv, `document.querySelector('g.tp[data-i="${i1}"] g.tg')`);
    const p1 = await vs.waitFor(async () => { const z = await probe(); return z.collapsed >= 1 ? z : null; }, 10000, 50);
    const collapseMs = Date.now() - t1;
    const i2 = await E(`(() => { const t = document.querySelector('g.tg.on'); return t ? t.closest('g.tp').dataset.i : null; })()`);
    const t2 = Date.now();
    await vs.wvClick(wv, `document.querySelector('g.tp[data-i="${i2}"] g.tg')`);
    const p2 = await vs.waitFor(async () => { const z = await probe(); return z.collapsed === 0 ? z : null; }, 10000, 50);
    const expandMs = Date.now() - t2;
    // pan with a real drag
    const off = await vs.wvOffset();
    const t3 = Date.now();
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: off.x + 300, y: off.y + 300, button: 'left', clickCount: 1 }, vs.wb);
    for (let k = 1; k <= 10; k++) await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: off.x + 300 + k * 20, y: off.y + 300 + k * 10, button: 'left', buttons: 1 }, vs.wb);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: off.x + 500, y: off.y + 400, button: 'left', clickCount: 1 }, vs.wb);
    const panMs = Date.now() - t3;
    // search in the large map
    await vs.wvClick(wv, `document.querySelector('input.search')`);
    const t4 = Date.now();
    await vs.type('Item 7.3.42'); await sleep(200);
    const ps = await vs.waitFor(async () => { const z = await probe(); return z.search.hits ? z : null; }, 10000, 50);
    const searchMs = Date.now() - t4;
    const shotB = await shot('large-search');
    const t5 = Date.now();
    await vs.wvClick(wv, btn('Fit'));
    const pf = await vs.waitFor(async () => { const z = await probe(); return z.zoom < 0.2 ? z : null; }, 10000, 50);
    const fitMs = Date.now() - t5;
    await sleep(300);
    const shotC = await shot('large-fit');
    clearInterval(iv);
    peak = Math.max(peak, extHostRss());
    await closeEditor();
    must(ms < 3000, `first view took ${ms} ms (limit 3000)`);
    return { firstViewMs: ms, renderMs: p.renderMs, readMs: p.readMs, nodes: p.nodes, images: img, collapseMs, collapsedNodes: p1 && p1.nodes, expandMs, expandedNodes: p2 && p2.nodes, panMs, search: ps && ps.search, searchMs, fitMs, fitDrawn: pf && pf.drawnCount, culled: p.culled, firstDrawn: p.drawnCount, extHostPeakMB: peak, shots: [shotA, shotB, shotC].map(s => path.basename(s)) };
  });
}

// 5. Nothing written outside the work copy, samples unchanged, no network
await step('no files outside, samples unchanged', async () => {
  const after = Object.fromEntries(evilSpots.map(p => [p, fs.existsSync(p)]));
  const created = evilSpots.filter(p => !before[p] && after[p]);
  const changed = Object.keys(hashes).filter(f => fs.existsSync(path.join(ws, f)) && hash(path.join(ws, f)) !== hashes[f]);
  const extra = fs.readdirSync(ws).filter(f => !(f in hashes));
  R.outside = { created, changed, extra };
  must(!created.length, 'files created outside: ' + created.join(', '));
  must(!changed.length, 'samples changed: ' + changed.join(', '));
  must(extra.every(f => /^project-plan-2020.*\.(png|svg|md)$/.test(f)), 'unexpected files: ' + extra.join(', '));
  return R.outside;
});
await step('network: webviews loaded only local resources', async () => {
  const outside = R.network.filter(u => !/^(vscode-webview:|https:\/\/file\+\.vscode-resource\.vscode-cdn\.net\/|data:|blob:|vscode-file:)/.test(u));
  must(!outside.length, 'outside requests: ' + outside.slice(0, 5).join(' '));
  return { requests: R.network.length, outside: outside.length };
});

R.console = vs.console.filter(c => !/Extension Host|ExtensionService|update|telemetry|marketplace|gallery|CodeExpectedError|ENOENT|punycode|net::ERR|chat|copilot|Ignoring|Failed to load resource/i.test(c.text)).slice(0, 60);
await step('no webview errors in the console', async () => {
  const wvErr = R.console.filter(c => c.where !== 'workbench' && (c.type === 'error' || c.type === 'exception'));
  must(!wvErr.length, JSON.stringify(wvErr.slice(0, 5)));
  return { workbenchMessages: R.console.length };
});
R.shots = shots.map(s => path.basename(s));
R.pass = R.steps.filter(s => s.ok).length; R.fail = R.steps.filter(s => !s.ok).length;
fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
console.log(`RESULT ${R.pass}/${R.steps.length} pass`);
await vs.close();
process.exit(0);
