'use strict';
// Checks every message from the webview before the extension acts on it. Pure: no vscode module.
const path = require('path');

const MAX_TEXT = 64 * 1024 * 1024;
const MAX_B64 = 400 * 1024 * 1024;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready': case 'rendered': case 'failed': case 'openSettings':
      return { ok: true, msg: { type: m.type } };
    case 'image':
      return isStr(m.src, 1000) && m.src ? { ok: true, msg: { type: 'image', src: m.src } } : { ok: false };
    case 'openLink':
      return isStr(m.href, 8000) && m.href ? { ok: true, msg: { type: 'openLink', href: m.href } } : { ok: false };
    case 'copy':
      return isStr(m.text, MAX_TEXT) ? { ok: true, msg: { type: 'copy', text: m.text, what: isStr(m.what, 100) ? m.what : '' } } : { ok: false };
    case 'save': {
      if (!['png', 'svg', 'md'].includes(m.kind)) return { ok: false };
      const suffix = isStr(m.suffix, 80) && /^[\w .()-]*$/.test(m.suffix) ? m.suffix : '';
      if (m.kind === 'png') return isStr(m.base64, MAX_B64) && /^[A-Za-z0-9+/=]*$/.test(m.base64.slice(0, 200)) ? { ok: true, msg: { type: 'save', kind: 'png', base64: m.base64, suffix } } : { ok: false };
      return isStr(m.text, MAX_TEXT) ? { ok: true, msg: { type: 'save', kind: m.kind, text: m.text, suffix } } : { ok: false };
    }
    default: return { ok: false };
  }
}

/**
 * What to do with a topic hyperlink. Links open only after a click and a confirm dialog.
 * -> { kind: 'external'|'file'|'relative', target } or { kind: 'refuse', reason }
 */
function linkAction(href) {
  const s = String(href || '').trim();
  if (!s) return { kind: 'refuse', reason: 'This topic has an empty link.' };
  if (/^(https?:|mailto:)/i.test(s)) return { kind: 'external', target: s };
  if (/^xmind:/i.test(s)) return { kind: 'refuse', reason: 'This link points into another XMind file. Open that file to follow it.' };
  if (/^file:/i.test(s)) {
    try { const u = new URL(s); return { kind: 'file', target: decodeURIComponent(u.pathname) }; } catch { return { kind: 'refuse', reason: 'The file link is not valid.' }; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return { kind: 'refuse', reason: `Links of the type "${s.split(':')[0]}:" are not opened.` };
  if (path.isAbsolute(s) || /^[a-z]:[\\/]/i.test(s)) return { kind: 'file', target: s };
  return { kind: 'relative', target: s.replace(/\\/g, '/') };
}

module.exports = { validateWebviewMessage, linkAction, fmtSize };
