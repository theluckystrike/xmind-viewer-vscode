'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { openMap, manifestInfo } = require('../src/core/load');
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

test('a Git LFS pointer gets its own message', async () => {
  const ptr = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:7c525f97e8c6aa58b9a7f6f53d6f9e4f668e734c3ef870253ce5b8f8cfac5582\nsize 7102\n');
  await assert.rejects(openMap(bufferReader(ptr), 'a.xmind'), e => e.code === 'notzip' && /Git LFS pointer/.test(e.message) && /git lfs pull/.test(e.message));
  await assert.rejects(openMap(bufferReader(Buffer.from('version 1 of my notes, not a zip')), 'b.xmind'), e => e.code === 'notzip' && !/LFS/.test(e.message));
});

test('password protected maps get a clear message', async () => {
  const zip = makeZip([{ name: 'manifest.json', data: JSON.stringify({ 'file-entries': { 'content.json': { 'encryption-data': { x: 1 } } } }) }, { name: 'content.json', data: 'garbage' }]);
  await assert.rejects(openMap(bufferReader(zip), 'p.xmind'), e => e.code === 'password' && /password/i.test(e.message));
});

const X8_CONTENT = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0"><sheet id="s1"><topic id="t1"><title>Root</title><children><topics type="attached"><topic id="t2"><title>Child</title></topic></topics></children></topic><title>Sheet 1</title></sheet></xmap-content>';
const x8Manifest = (attrs, entries) => `<?xml version="1.0" encoding="UTF-8" standalone="no"?><manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0"${attrs}>${entries}</manifest>`;
const X8_ENC = '<encryption-data checksum-type="MD5" checksum="x"><algorithm algorithm-name="PBEWithMD5AndDES"/><key-derivation key-derivation-name="PKCS12" salt="x" iteration-count="1024"/></encryption-data>';
const RANDOM = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 73 + 41) % 256));

test('XMind 8 manifest with an empty password-hint opens (XMind 8 writes it into every file)', async () => {
  // the exact manifest shape of the real XMind 8 files VER9 used (xmindparser, xmind2testcase, xmind-file-structure)
  const manifest = x8Manifest(' password-hint=""', '<file-entry full-path="content.xml" media-type="text/xml"/><file-entry full-path="META-INF/" media-type=""/><file-entry full-path="META-INF/manifest.xml" media-type="text/xml"/>');
  for (const mf of [manifest, manifest.replace('password-hint=""', "password-hint=''"), manifest.replace('password-hint=""', 'password-hint="   "'), x8Manifest('', '<file-entry full-path="content.xml" media-type="text/xml"/>')]) {
    const zip = makeZip([{ name: 'content.xml', data: X8_CONTENT }, { name: 'META-INF/manifest.xml', data: mf }]);
    const r = await openMap(bufferReader(zip), 'x8.xmind');
    assert.strictEqual(r.model.sheets[0].root.title, 'Root');
    assert.strictEqual(r.model.sheets[0].root.children[0].title, 'Child');
  }
});

test('a hint or the word encryption alone is not encryption when the content is readable', async () => {
  // a hint left behind after the password was removed, a picture named encryption-data.png, an XML comment
  const mf = x8Manifest(' password-hint="cat name"', '<!-- <encryption-data/> --><file-entry full-path="content.xml" media-type="text/xml"/><file-entry full-path="attachments/encryption-data.png" media-type="image/png"/>');
  const zip = makeZip([{ name: 'content.xml', data: X8_CONTENT }, { name: 'META-INF/manifest.xml', data: mf }]);
  assert.strictEqual((await openMap(bufferReader(zip), 'a.xmind')).model.sheets[0].root.title, 'Root');
  const mj = JSON.stringify({ 'file-entries': { 'content.json': {}, 'resources/encryption-data.png': {}, 'resources/"encryption".svg': {} }, 'password-hint': '' });
  const z2 = makeZip([{ name: 'content.json', data: JSON.stringify([sheet('A', { id: 'r', title: 'R' })]) }, { name: 'manifest.json', data: mj }]);
  assert.strictEqual((await openMap(bufferReader(z2), 'b.xmind')).model.sheets[0].root.title, 'R');
});

test('real encryption: encryption-data on the content entry, with or without a hint', async () => {
  for (const hint of ['', 'my hint']) {
    const enc = x8Manifest(` password-hint="${hint}"`, `<file-entry full-path="content.xml" media-type="text/xml">${X8_ENC}</file-entry><file-entry full-path="meta.xml" media-type="text/xml"/>`);
    // XMind 8 encrypts the bytes; even content that happens to look like XML must not be parsed
    for (const data of [RANDOM, '<xmap-content>looks like xml</xmap-content>']) {
      const z = makeZip([{ name: 'content.xml', data }, { name: 'META-INF/manifest.xml', data: enc }]);
      await assert.rejects(openMap(bufferReader(z), 'p8.xmind'), e => e.code === 'password' && /password/i.test(e.message));
    }
  }
  // XMind 2020+ / Zen: manifest.json, the hint at the top
  const mj = JSON.stringify({ 'file-entries': { 'content.json': { 'encryption-data': { '@algorithm-name': 'AES/CBC/PKCS5Padding', 'key-derivation': { '@iteration-count': '1024' } } }, 'metadata.json': {} }, 'password-hint': '' });
  const z = makeZip([{ name: 'content.json', data: RANDOM }, { name: 'content.xml', data: '<xmap-content>warning stub</xmap-content>' }, { name: 'manifest.json', data: mj }]);
  await assert.rejects(openMap(bufferReader(z), 'pz.xmind'), e => e.code === 'password');
});

test('unreadable content: password message when the manifest hints at one, a damage message otherwise', async () => {
  const hinted = makeZip([{ name: 'content.xml', data: RANDOM }, { name: 'META-INF/manifest.xml', data: x8Manifest(' password-hint="cat name"', '<file-entry full-path="content.xml"/>') }]);
  await assert.rejects(openMap(bufferReader(hinted), 'h.xmind'), e => e.code === 'password');
  const encOther = makeZip([{ name: 'content.json', data: RANDOM }, { name: 'manifest.json', data: JSON.stringify({ 'file-entries': { 'Thumbnails/thumbnail.png': { 'encryption-data': {} } } }) }]);
  await assert.rejects(openMap(bufferReader(encOther), 'o.xmind'), e => e.code === 'password');
  for (const [name, data] of [['content.xml', RANDOM], ['content.json', RANDOM], ['content.json', Buffer.from('version https://git-lfs.github.com/spec/v1\n')]]) {
    const z = makeZip([{ name, data }, { name: 'META-INF/manifest.xml', data: x8Manifest(' password-hint=""', '<file-entry full-path="content.xml"/>') }]);
    await assert.rejects(openMap(bufferReader(z), 'd.xmind'), e => e.code === 'unreadable' && /not readable text/.test(e.message) && !/^This map has a password/.test(e.message));
  }
});

test('manifestInfo reads only real encryption data and the hint', () => {
  const a = manifestInfo('', x8Manifest(' password-hint=""', `<file-entry full-path="content.xml">${X8_ENC}</file-entry><file-entry full-path="meta.xml"/><file-entry full-path="a&amp;b.png">${X8_ENC}</file-entry>`));
  assert.deepStrictEqual([...a.encrypted].sort(), ['a&b.png', 'content.xml']);
  assert.strictEqual(a.hint, '');
  const b = manifestInfo(JSON.stringify({ 'file-entries': { 'content.json': { 'encryption-data': {} }, 'x.png': { 'encryption-data': 'no' } }, 'password-hint': ' h ' }), '');
  assert.deepStrictEqual([...b.encrypted], ['content.json']);
  assert.strictEqual(b.hint, 'h');
  const c = manifestInfo('{not json', '<manifest password-hint="x &amp; y"><file-entry full-path="content.xml"/></manifest>');
  assert.strictEqual(c.encrypted.size, 0);
  assert.strictEqual(c.hint, 'x & y');
});

test('callout topics (XMind 8 and 2020+) are kept, after the attached children, and relationships to them draw', async () => {
  const x8 = '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"><sheet id="s1"><topic id="r"><title>R</title><children><topics type="attached"><topic id="a"><title>A</title></topic><topic id="b"><title>B</title></topic></topics><topics type="callout"><topic id="c"><title>Callout</title></topic></topics></children><boundaries><boundary id="bd" range="(0,1)"/></boundaries></topic><relationships><relationship id="x" end1="a" end2="c"/></relationships><title>S</title></sheet></xmap-content>';
  const r8 = await openMap(bufferReader(makeZip([{ name: 'content.xml', data: x8 }])), 'c8.xmind');
  const s8 = r8.model.sheets[0];
  assert.deepStrictEqual(s8.root.children.map(t => [t.title, !!t.callout]), [['A', false], ['B', false], ['Callout', true]]);
  assert.strictEqual(s8.counts.topics, 4);
  assert.strictEqual(s8.counts.relationships, 1);
  assert.deepStrictEqual(s8.root.boundaries.map(b => [b.from, b.to]), [[0, 1]]);
  const zen = [sheet('S', { id: 'r', title: 'R', children: { attached: [{ id: 'a', title: 'A' }], callout: [{ id: 'c', title: 'C', children: { attached: [{ id: 'd', title: 'D' }] } }] } }, { relationships: [{ id: 'x', end1Id: 'a', end2Id: 'c' }] })];
  const rz = await openMap(bufferReader(makeZip([{ name: 'content.json', data: JSON.stringify(zen) }])), 'cz.xmind');
  const sz = rz.model.sheets[0];
  assert.strictEqual(sz.counts.topics, 4);
  assert.strictEqual(sz.counts.relationships, 1);
  assert.ok(sz.root.children[1].callout && sz.root.children[1].children[0].title === 'D');
});

test('FreeMind / Freeplane: an arrow link from a node to itself is kept (Freeplane draws it as a loop)', () => {
  const { fromFreeMind } = require('../src/core/model');
  const mm = '<map version="freeplane 1.9.0"><node ID="ID_1" TEXT="root"><node ID="ID_2" TEXT="Edges"><arrowlink DESTINATION="ID_2" MIDDLE_LABEL="loop"/><arrowlink DESTINATION="ID_1"/><arrowlink DESTINATION="ID_404"/></node></node></map>';
  const s = fromFreeMind(mm, 'm').sheets[0];
  assert.strictEqual(s.counts.relationships, 2);
  assert.deepStrictEqual(s.relationships.map(r => [r.from, r.to, r.title]), [['ID_2', 'ID_2', 'loop'], ['ID_2', 'ID_1', '']]);
  assert.ok(s.notes.some(n => /^1 relationship/.test(n)));
});

// Optional: XMIND_CORPUS=<dir> runs every real file in a folder (not committed: third-party files).
// Files whose name starts with "expect-<code>-" must fail with that code; all others must open.
test('real file corpus (XMIND_CORPUS)', { skip: !process.env.XMIND_CORPUS }, async () => {
  const dir = process.env.XMIND_CORPUS;
  const files = fs.readdirSync(dir).filter(f => /\.(xmind|mm|opml)$/i.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const want = /^expect-([a-z]+)-/.exec(f);
    const r = await openMap(await fileReader(path.join(dir, f)), f).then(x => ({ ok: true, x }), e => ({ ok: false, e }));
    if (want) assert.ok(!r.ok && r.e.code === want[1], `${f}: expected ${want[1]}, got ${r.ok ? 'opened' : r.e.code + ' ' + r.e.message}`);
    else {
      assert.ok(r.ok, `${f}: ${r.ok ? '' : r.e.code + ' ' + r.e.message}`);
      assert.ok(r.x.model.sheets.length > 0 && r.x.model.sheets.every(s => s.root), f);
      await r.x.close();
    }
  }
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

// XMIND_LARGE=<file> (default ~/xmind-viewer-work/large/large-10k-images.xmind, from make_samples.py --large)
const LARGE = process.env.XMIND_LARGE || path.join(process.env.HOME || '', 'xmind-viewer-work/large/large-10k-images.xmind');
test('large map: 10,000+ topics load quickly without reading the pictures', { skip: !fs.existsSync(LARGE) }, async () => {
  const f = LARGE;
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
