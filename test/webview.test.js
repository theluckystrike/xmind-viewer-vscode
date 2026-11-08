'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateWebviewMessage, linkAction, fmtSize } = require('../src/core/protocol');
const { buildHtml } = require('../src/html');
const { sheetMarkdown } = require('../src/webview/outline');
const { markerGlyph } = require('../src/webview/markers');
const { layout, preorder } = require('../src/webview/layout');

test('webview messages are checked', () => {
  assert.strictEqual(validateWebviewMessage({ type: 'nope' }).ok, false);
  assert.strictEqual(validateWebviewMessage(null).ok, false);
  assert.strictEqual(validateWebviewMessage({ type: 'image', src: '' }).ok, false);
  assert.strictEqual(validateWebviewMessage({ type: 'save', kind: 'exe', text: 'x' }).ok, false);
  assert.strictEqual(validateWebviewMessage({ type: 'save', kind: 'png', base64: '%%%' }).ok, false);
  assert.strictEqual(validateWebviewMessage({ type: 'save', kind: 'svg', text: '<svg/>', suffix: '../../x' }).msg.suffix, '');
  assert.strictEqual(validateWebviewMessage({ type: 'openLink', href: 'https://a.b' }).ok, true);
});

test('links: web and mail open after a confirm, scripts never', () => {
  assert.strictEqual(linkAction('https://example.com').kind, 'external');
  assert.strictEqual(linkAction('mailto:a@b.c').kind, 'external');
  assert.strictEqual(linkAction('javascript:alert(1)').kind, 'refuse');
  assert.strictEqual(linkAction('command:workbench.action.terminal.new').kind, 'refuse');
  assert.strictEqual(linkAction('vscode://x').kind, 'refuse');
  assert.strictEqual(linkAction('docs/a.md').kind, 'relative');
  assert.strictEqual(linkAction('file:///tmp/a.txt').kind, 'file');
  assert.strictEqual(fmtSize(2048), '2.0 KB');
});

test('CSP: no network, scripts by nonce only', () => {
  const html = buildHtml({ cspSource: 'vscode-res:', scriptUri: 's.js', katexUri: 'k.js', katexCssUri: 'k.css', styleUri: 'w.css', title: '<x>', nonce: 'abc' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.doesNotMatch(csp, /connect-src|https?:|\*/);
  assert.strictEqual((html.match(/<script /g) || []).length, (html.match(/nonce="abc"/g) || []).length);
  assert.ok(html.includes('&lt;x&gt;'));
});

test('Markdown outline', () => {
  const t = (title, children = [], extra = {}) => ({ id: title, title, children, summaries: [], labels: [], markers: [], ...extra });
  const root = t('Root', [t('A [x]', [t('A1')], { note: 'n1\nn2', labels: ['l'] }), t('B', [], { href: 'https://e.com/a(b)' })]);
  const md = sheetMarkdown({ title: 'S', root, detached: [t('F')], relationships: [{ from: 'A1', to: 'B', title: 'r' }] }, 1);
  assert.match(md, /^# S\n\n- Root\n  - A \\\[x\\\] `l`\n    > n1\n    > n2\n    - A1\n  - \[B\]\(https:\/\/e.com\/a\(b%29\)/);
  assert.match(md, /## Floating topics\n\n- F/);
  assert.match(md, /- A1 → B: r/);
});

test('markers', () => {
  assert.strictEqual(markerGlyph('priority-3').text, '3');
  assert.strictEqual(markerGlyph('task-half').frac, 0.5);
  assert.strictEqual(markerGlyph('flag-green').kind, 'text');
  assert.match(markerGlyph('unknown-thing').label, /unknown-thing/);
});

test('layouts place every node without overlap between siblings', () => {
  for (const mode of ['map', 'right', 'left', 'tree', 'org', 'orgup']) {
    const mk = (d) => ({ t: { side: '' }, w: 80, h: 24, kids: d < 3 ? [mk(d + 1), mk(d + 1), mk(d + 1)] : [] });
    const root = mk(0);
    layout(root, mode);
    const all = preorder(root);
    assert.strictEqual(all.length, 40);
    for (const n of all) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), mode);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${mode}: nodes ${i} and ${j} overlap`);
    }
  }
});
