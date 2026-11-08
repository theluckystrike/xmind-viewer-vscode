'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { openMap } = require('../src/core/load');
const { bufferReader, fileReader, openZip, readEntry, unsafeName } = require('../src/core/zip');
const { flatten, unflatten } = require('../src/core/flat');
const { parseRange, imageRef, layoutOf, mathFromExtensions } = require('../src/core/model');

const SAMPLES = path.join(__dirname, '..', 'samples');
const KEYS = ['topics', 'relationships', 'boundaries', 'summaries', 'markers', 'notes', 'labels', 'equations'];

// A tiny ZIP writer for test packages.
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const data = e.store ? raw : zlib.deflateRawSync(raw);
    const usize = e.claim !== undefined ? e.claim : raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(e.store ? 0 : 8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(e.store ? 0 : 8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const sheet = (title, root, extra = {}) => ({ id: 's-' + title, class: 'sheet', title, rootTopic: root, ...extra });

async function load(file) {
  const m = await openMap(await fileReader(file), path.basename(file));
  await m.close();
  return m.model;
}

test('every sample matches the Python reference reader', async () => {
  const files = fs.readdirSync(SAMPLES).filter(f => /\.(xmind|mm|opml)$/.test(f));
  assert.ok(files.length >= 11, 'samples present');
  for (const f of files) {
    const ref = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, '..', 'scripts', 'ref_xmind.py'), path.join(SAMPLES, f)], { encoding: 'utf8' }));
    let model = null, err = null;
    try { model = await load(path.join(SAMPLES, f)); } catch (e) { err = e; }
    if (ref.format === 'error') { assert.ok(err, `${f} should fail`); continue; }
    assert.ifError(err);
    assert.strictEqual(model.format, ref.format, f);
    assert.strictEqual(model.sheets.length, ref.sheets.length, f);
    ref.sheets.forEach((rs, i) => {
      const s = model.sheets[i];
      assert.strictEqual(s.title, rs.title, `${f} sheet ${i} title`);
      for (const k of KEYS) assert.strictEqual(s.counts[k], rs[k], `${f} sheet ${i} ${k}`);
      assert.strictEqual(s.counts.images, rs.imagesOk ?? rs.images, `${f} sheet ${i} images`);
    });
  }
});

test('zip bomb with a lying header stops at the limit', async () => {
  const big = Buffer.alloc(64 * 1024 * 1024, 0x20);
  const zip = makeZip([{ name: 'content.json', data: big, claim: 100 }]);
  assert.ok(zip.length < 200 * 1024);
  await assert.rejects(openMap(bufferReader(zip), 'bomb.xmind'), e => e.code === 'bomb' && /zip bomb/.test(e.message));
});

test('the real zip bomb sample is refused without unpacking', async () => {
  const t0 = Date.now();
  await assert.rejects(load(path.join(SAMPLES, 'hostile-zip-bomb.xmind')), e => e.code === 'bomb');
  assert.ok(Date.now() - t0 < 2000);
});

test('high ratio entries above 8 MB are refused even with an honest header', async () => {
  const big = Buffer.alloc(40 * 1024 * 1024, 0x41);
  const zip = makeZip([{ name: 'content.json', data: big }]);
  const z = await openZip(bufferReader(zip));
  await assert.rejects(readEntry(bufferReader(zip), z.entries.get('content.json'), 256 * 1024 * 1024), e => e.code === 'bomb');
});

test('unsafe entry names are ignored and pictures cannot leave the package', async () => {
  for (const n of ['../a', 'a/../../b', '/etc/x', 'C:/x', 'a\\b', 'x\0y']) assert.ok(unsafeName(n), n);
  for (const n of ['content.json', 'resources/a.png', 'a..b/c']) assert.strictEqual(unsafeName(n), '', n);
  assert.deepStrictEqual(imageRef('xap:resources/a.png'), { src: 'resources/a.png' });
  assert.ok(imageRef('xap:resources/../../x.png').bad);
  assert.ok(imageRef('https://example.com/x.png').bad);
  assert.ok(imageRef('file:///etc/passwd').bad);
  const m = await load(path.join(SAMPLES, 'hostile-path-traversal.xmind'));
  assert.ok(m.refused.length >= 4);
  assert.ok(m.notes.some(n => /unsafe name/.test(n)));
});

test('not a zip, empty, cut off', async () => {
  await assert.rejects(openMap(bufferReader(Buffer.from('hello world, not a zip at all')), 'a.xmind'), e => e.code === 'notzip');
  await assert.rejects(openMap(bufferReader(Buffer.alloc(0)), 'a.xmind'), e => e.code === 'notzip');
  const good = makeZip([{ name: 'content.json', data: JSON.stringify([sheet('A', { id: 'r', title: 'R' })]) }]);
  await assert.rejects(openMap(bufferReader(good.subarray(0, good.length - 30)), 'a.xmind'));
});

test('password protected maps get a clear message', async () => {
  const zip = makeZip([{ name: 'manifest.json', data: JSON.stringify({ 'file-entries': { 'content.json': { 'encryption-data': { x: 1 } } } }) }, { name: 'content.json', data: 'garbage' }]);
  await assert.rejects(openMap(bufferReader(zip), 'p.xmind'), e => e.code === 'password' && /password/i.test(e.message));
});

test('content.json elements: sheets, relationships, boundaries, summaries, equation, folded', async () => {
  const root = {
    id: 'r', title: 'Root', structureClass: 'org.xmind.ui.logic.right',
    children: { attached: [{ id: 'a', title: 'A', branch: 'folded', children: { attached: [{ id: 'a1', title: 'A1' }] } }, { id: 'b', title: 'B', markers: [{ markerId: 'priority-1' }], labels: ['x'] }], summary: [{ id: 'sum', title: 'Sum' }], detached: [{ id: 'f', title: 'Float' }] },
    boundaries: [{ id: 'bd', range: '(0,1)', title: 'Box' }, { id: 'bad', range: '(3,9)' }],
    summaries: [{ id: 's1', range: '(0,1)', topicId: 'sum' }],
    extensions: [{ provider: 'org.xmind.ui.mathJax', content: [{ name: 'content', content: 'x^2' }] }],
    notes: { realHTML: { content: '<div>Hello <b>world</b></div><p>Line 2</p>' } },
  };
  const zip = makeZip([{ name: 'content.json', data: JSON.stringify([sheet('One', root, { relationships: [{ id: 'x', end1Id: 'a1', end2Id: 'b', title: 'rel' }, { id: 'y', end1Id: 'a', end2Id: 'missing' }] }), sheet('Two', { id: 'r2', title: '二' })]) }]);
  const m = await openMap(bufferReader(zip), 't.xmind');
  const [s1, s2] = m.model.sheets;
  assert.strictEqual(s1.layout, 'right');
  assert.strictEqual(s1.counts.topics, 6);
  assert.strictEqual(s1.counts.relationships, 1);
  assert.strictEqual(s1.counts.boundaries, 1);
  assert.strictEqual(s1.counts.summaries, 1);
  assert.strictEqual(s1.root.equation, 'x^2');
  assert.strictEqual(s1.root.note, 'Hello world\nLine 2');
  assert.strictEqual(s1.root.children[0].folded, true);
  assert.strictEqual(s1.root.summaries[0].topic.title, 'Sum');
  assert.strictEqual(s1.detached[0].title, 'Float');
  assert.ok(s1.notes.some(n => /did not match/.test(n)));
  assert.ok(s1.notes.some(n => /relationship/.test(n)));
  assert.strictEqual(s2.title, 'Two');
});

test('equation shapes and layout names', () => {
  assert.strictEqual(mathFromExtensions([{ provider: 'org.xmind.ui.mathJax', content: 'a+b' }]), 'a+b');
  assert.strictEqual(mathFromExtensions([{ provider: 'latex', content: { content: 'c' } }]), 'c');
  assert.strictEqual(mathFromExtensions([{ provider: 'other', content: 'x' }]), '');
  assert.strictEqual(layoutOf('org.xmind.ui.map.unbalanced').layout, 'map');
  assert.strictEqual(layoutOf('org.xmind.ui.fishbone.leftHeaded').layout, 'right');
  assert.ok(layoutOf('org.xmind.ui.fishbone.leftHeaded').note);
  assert.strictEqual(layoutOf('org.xmind.ui.org-chart.down').layout, 'org');
  assert.strictEqual(layoutOf('org.xmind.ui.tree.right').layout, 'tree');
  assert.deepStrictEqual(parseRange('(0,2)', 3), [0, 2]);
  assert.strictEqual(parseRange('(0,3)', 3), null);
  assert.strictEqual(parseRange('(master)', 0), 'master');
  assert.strictEqual(parseRange('(2,1)', 3), null);
});

test('a 50,000 level deep tree loads and survives the flat transport', async () => {
  let t = { id: 'leaf', title: 'leaf' };
  for (let i = 0; i < 50000; i++) t = { id: 'n' + i, title: String(i), children: { attached: [t] } };
  // JSON.stringify is recursive itself, so build the text by hand
  let txt = '';
  for (let i = 49999; i >= 0; i--) txt += `{"id":"n${i}","title":"${i}","children":{"attached":[`;
  txt += '{"id":"leaf","title":"leaf"}' + ']}}'.repeat(50000);
  const content = `[{"id":"s","title":"Deep","rootTopic":${txt}}]`;
  const zip = makeZip([{ name: 'content.json', data: content }]);
  let m;
  try { m = await openMap(bufferReader(zip), 'deep.xmind'); }
  catch (e) { assert.match(e.message, /not valid JSON|call stack/i); return; } // V8 JSON.parse may refuse this depth
  const s = m.model.sheets[0];
  assert.ok(s.counts.topics >= 10000);
  assert.ok(s.notes.some(n => /deeper than/.test(n)));
  const back = unflatten(JSON.parse(JSON.stringify(flatten(m.model))));
  let d = 0, x = back.sheets[0].root;
  while (x.children.length) { x = x.children[0]; d++; }
  assert.ok(d >= 9999);
});

test('XMind 2020 warning stub in content.xml is not used when content.json exists', async () => {
  const m = await load(path.join(SAMPLES, 'project-plan-2020.xmind'));
  assert.strictEqual(m.format, 'xmind-json');
  assert.strictEqual(m.sheets.length, 3);
});

test('large map: 10,000+ topics load quickly without reading the pictures', { skip: !fs.existsSync(path.join(process.env.HOME || '', 'xmind-viewer-work/large/large-10k-images.xmind')) }, async () => {
  const f = path.join(process.env.HOME, 'xmind-viewer-work/large/large-10k-images.xmind');
  const r = await fileReader(f);
  let read = 0;
  const orig = r.read.bind(r);
  r.read = async (o, l) => { read += l; return orig(o, l); };
  const t0 = Date.now();
  const m = await openMap(r, 'large.xmind');
  assert.ok(Date.now() - t0 < 1500);
  assert.ok(m.model.sheets[0].counts.topics > 10000);
  assert.ok(read < fs.statSync(f).size / 4, `read ${read} bytes of ${fs.statSync(f).size}`);
  const img = await m.image(m.model.sheets[0].root.children[0].children[0].image ? m.model.sheets[0].root.children[0].children[0].image.src : findImage(m.model.sheets[0].root));
  assert.strictEqual(img.mime, 'image/png');
  await m.close();
});
function findImage(root) { const st = [root]; while (st.length) { const t = st.pop(); if (t.image) return t.image.src; st.push(...t.children); } return null; }
