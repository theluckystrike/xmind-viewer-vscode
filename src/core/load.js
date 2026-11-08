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
  try { zip = await openZip(reader); } catch (e) { throw new LoadError(e.message, e.code); }
  const { entries, refused } = zip;
  const notes = [];
  if (refused.length) notes.push(`${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} in the package had an unsafe name (for example "${refused[0].name}": ${refused[0].reason}) and ${refused.length === 1 ? 'was' : 'were'} ignored. Nothing is written to disk.`);
  const get = async (name, max) => {
    const e = entries.get(name);
    if (!e) return null;
    try { return await readEntry(reader, e, max); } catch (err) { throw new LoadError(err.message, err.code); }
  };
  // Password: XMind keeps the encryption data in manifest.json (2020+) or META-INF/manifest.xml (XMind 8).
  const manifest = await get('manifest.json', 4 * 1024 * 1024).catch(() => null);
  const manifestXml = manifest ? null : await get('META-INF/manifest.xml', 4 * 1024 * 1024).catch(() => null);
  const mtext = manifest ? manifest.toString('utf8') : manifestXml ? manifestXml.toString('utf8') : '';
  if (/encryption-data|"encryption"|password-hint/i.test(mtext)) {
    throw new LoadError('This map has a password. XMind encrypts the content of such files, so it can only be opened in XMind. Remove the password in XMind (File > Password) to view it here.', 'password');
  }
  let m = null;
  const json = entries.has('content.json') ? await get('content.json', MAX_CONTENT) : null;
  if (json) {
    try { m = model.fromContentJson(decodeText(json)); } catch (e) { throw new LoadError(e.message, 'format'); }
  } else {
    const xml = await get('content.xml', MAX_CONTENT);
    if (!xml) {
      throw new LoadError(entries.size === 0 && refused.length
        ? 'Every entry in this package had an unsafe name, so nothing was read. It is not a normal XMind file.'
        : 'This package has no content.json and no content.xml, so it is not an XMind map.', 'format');
    }
    const text = decodeText(xml);
    if (model.isWarningStub(text) && !entries.has('content.json')) throw new LoadError('This XMind file has only the warning stub and no map content. It may be damaged.', 'format');
    try { m = model.fromContentXml(text); } catch (e) { throw new LoadError(e.message, 'format'); }
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

function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  if (/^\s*<(\?xml|svg)/.test(b.subarray(0, 100).toString('utf8'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

module.exports = { openMap, kindOf, LoadError, ZipError, MAX_CONTENT, MAX_IMAGE };
