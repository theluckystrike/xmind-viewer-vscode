'use strict';
// Opens one mind map file. .xmind is read through the range-reading ZIP reader; .mm and .opml are text.
const path = require('path');
const { openZip, readEntry, ZipError } = require('./zip');
const model = require('./model');

const MAX_CONTENT = 256 * 1024 * 1024; // content.json / content.xml after unpacking
const MAX_IMAGE = 32 * 1024 * 1024;    // one picture
const MAX_TEXT_FILE = 128 * 1024 * 1024; // .mm / .opml

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };

class LoadError extends Error {
  constructor(message, code) { super(message); this.code = code || 'load'; }
}

function kindOf(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.xmind' || ext === '.xmt' || ext === '.xmap') return 'xmind';
  if (ext === '.mm') return 'mm';
  if (ext === '.opml') return 'opml';
  return 'xmind';
}

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8');
}

/**
 * reader: { size, read(off,len), close() } (see zip.js). Returns
 * { model: {format, sheets, notes, refused}, image(src) -> Promise<{mime, data:Buffer}>, close() }
 */
async function openMap(reader, fileName) {
  const kind = kindOf(fileName);
  const title = path.basename(String(fileName || 'map')).replace(/\.[^.]+$/, '');
  if (kind === 'mm' || kind === 'opml') {
    if (reader.size > MAX_TEXT_FILE) throw new LoadError(`This file is ${Math.round(reader.size / 1048576)} MB. Outline files above ${MAX_TEXT_FILE / 1048576} MB are not opened.`, 'size');
    const text = decodeText(await reader.read(0, reader.size));
    if (!/^\s*</.test(text.slice(0, 200).replace(/^﻿/, ''))) throw new LoadError(kind === 'mm' ? 'This .mm file is not XML, so it is not a FreeMind map.' : 'This file is not XML, so it is not an OPML outline.', 'format');
    const m = kind === 'mm' ? model.fromFreeMind(text, title) : model.fromOpml(text, title);
    m.notes = []; m.refused = [];
    return { model: m, async image() { throw new LoadError('No pictures in this file.'); }, close: () => reader.close() };
  }
  let zip;
  try { zip = await openZip(reader); } catch (e) {
    // A repository that keeps maps in Git LFS checks out a small text pointer when LFS is not installed.
    if (e.code === 'notzip' && reader.size > 0 && reader.size < 1024) {
      const head = (await reader.read(0, Math.min(reader.size, 200)).catch(() => Buffer.alloc(0))).toString('latin1');
      if (/^version https:\/\/git-lfs\.github\.com\/spec\//.test(head)) throw new LoadError('This file is a Git LFS pointer, not the map itself. The repository stores .xmind files in Git LFS. Run "git lfs install" and "git lfs pull" in the repository to download the map.', 'notzip');
    }
    throw new LoadError(e.message, e.code);
  }
  const { entries, refused } = zip;
  const notes = [];
  if (refused.length) notes.push(`${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} in the package had an unsafe name (for example "${refused[0].name}": ${refused[0].reason}) and ${refused.length === 1 ? 'was' : 'were'} ignored. Nothing is written to disk.`);
  const get = async (name, max) => {
    const e = entries.get(name);
    if (!e) return null;
    try { return await readEntry(reader, e, max); } catch (err) { throw new LoadError(err.message, err.code); }
  };
  // Password: XMind keeps the encryption data in manifest.json (2020+) or META-INF/manifest.xml (XMind 8).
  // XMind 8 writes password-hint="" into the manifest of every file, also without a password, so a hint alone
  // proves nothing. A map counts as encrypted only when the manifest marks the content entry with encryption
  // data, or when the content cannot be read and the manifest says something is encrypted or has a hint.
  const manifest = await get('manifest.json', 4 * 1024 * 1024).catch(() => null);
  const manifestXml = await get('META-INF/manifest.xml', 4 * 1024 * 1024).catch(() => null);
  const info = manifestInfo(manifest ? decodeText(manifest) : '', manifestXml ? decodeText(manifestXml) : '');
  const contentName = entries.has('content.json') ? 'content.json' : 'content.xml';
  if (info.encrypted.has(contentName)) throw passwordError();
  const unreadable = what => (info.encrypted.size || info.hint)
    ? passwordError()
    : new LoadError(`${what} in this package is not readable text. The file may be damaged, or it was saved with a password by an XMind version that does not mark this in the manifest.`, 'unreadable');
  let m = null;
  const json = entries.has('content.json') ? await get('content.json', MAX_CONTENT) : null;
  if (json) {
    const text = decodeText(json);
    if (!looksLikeText(text, '{[')) throw unreadable('content.json');
    try { m = model.fromContentJson(text); } catch (e) { if (info.encrypted.size || info.hint) throw passwordError(); throw new LoadError(e.message, 'format'); }
  } else {
    const xml = await get('content.xml', MAX_CONTENT);
    if (!xml) {
      throw new LoadError(entries.size === 0 && refused.length
        ? 'Every entry in this package had an unsafe name, so nothing was read. It is not a normal XMind file.'
        : 'This package has no content.json and no content.xml, so it is not an XMind map.', 'format');
    }
    const text = decodeText(xml);
    if (!looksLikeText(text, '<')) throw unreadable('content.xml');
    if (model.isWarningStub(text) && !entries.has('content.json')) throw new LoadError('This XMind file has only the warning stub and no map content. It may be damaged.', 'format');
    try { m = model.fromContentXml(text); } catch (e) { if (info.encrypted.size || info.hint) throw passwordError(); throw new LoadError(e.message, 'format'); }
  }
  for (const e of entries.values()) if (e.sizeMismatch) notes.push(`The size stored for ${e.name} did not match its content. The file may be damaged.`);
  m.notes = notes;
  m.refused = refused;
  return {
    model: m,
    async image(src) {
      const name = String(src || '');
      const ext = path.extname(name).slice(1).toLowerCase();
      const mime = IMAGE_TYPES[ext];
      const e = entries.get(name);
      if (!e) throw new LoadError(`The picture ${name} is not in the package.`, 'missing');
      const data = await readEntry(reader, e, MAX_IMAGE).catch(err => { throw new LoadError(err.message, err.code); });
      return { mime: mime || sniff(data), data };
    },
    close: () => reader.close(),
  };
}

function passwordError() {
  return new LoadError('This map has a password. XMind encrypts the content of such files, so it can only be opened in XMind. Remove the password in XMind (File > Password) to view it here.', 'password');
}

const xmlUnescape = v => String(v).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Reads the XMind manifests. Returns { encrypted: Set of entry paths that carry encryption data, hint: string }.
 * manifest.json (XMind 2020+): {"file-entries": {"content.json": {"encryption-data": {...}}}, "password-hint": "..."}
 * META-INF/manifest.xml (XMind 8): <manifest password-hint=""><file-entry full-path="content.xml"><encryption-data .../></file-entry>
 * Only real encryption-data objects or elements count; names, attribute values and an empty hint do not.
 */
function manifestInfo(jsonText, xmlText) {
  const encrypted = new Set();
  let hint = '';
  if (jsonText) {
    let j = null;
    try { j = JSON.parse(jsonText); } catch { j = null; }
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const fe = j['file-entries'];
      if (fe && typeof fe === 'object') {
        for (const [name, v] of Object.entries(fe)) {
          if (v && typeof v === 'object' && ((v['encryption-data'] && typeof v['encryption-data'] === 'object') || (v.encryption && typeof v.encryption === 'object'))) encrypted.add(name);
        }
      }
      if (typeof j['password-hint'] === 'string') hint = j['password-hint'].trim();
    }
  }
  if (xmlText) {
    const x = xmlText.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    const root = /<(?:[\w.-]+:)?manifest\b([^>]*)>/.exec(x);
    if (root) {
      const h = /\spassword-hint\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(root[1]);
      if (h && !hint) hint = xmlUnescape(h[1] != null ? h[1] : h[2]).trim();
    }
    const re = /<(?:[\w.-]+:)?file-entry\b([^>]*?)(\/?)>/g;
    let mt;
    while ((mt = re.exec(x))) {
      if (mt[2] === '/') continue;
      const p = /\sfull-path\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(mt[1]);
      const end = x.indexOf('file-entry>', re.lastIndex);
      const body = x.slice(re.lastIndex, end < 0 ? x.length : end);
      if (p && /<(?:[\w.-]+:)?encryption-data\b/.test(body)) encrypted.add(xmlUnescape(p[1] != null ? p[1] : p[2]));
    }
  }
  return { encrypted, hint };
}

// The content is readable when its first non-space character is one the format starts with and the start
// has no control bytes. Encrypted content is random bytes.
function looksLikeText(text, firstChars) {
  const head = text.slice(0, 512).replace(/^\uFEFF/, '');
  const t = head.trimStart();
  if (!t || !firstChars.includes(t[0])) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000E-\u001F\uFFFD]/.test(head);
}

function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  if (/^\s*<(\?xml|svg)/.test(b.subarray(0, 100).toString('utf8'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

module.exports = { openMap, kindOf, manifestInfo, LoadError, ZipError, MAX_CONTENT, MAX_IMAGE };
