'use strict';
// A small read-only ZIP reader for .xmind files. It reads the central directory from the end of the file with
// range reads, so a 30 MB map with pictures is never read whole. Each entry is inflated with a hard output
// limit (zlib maxOutputLength), so a zip bomb or a header that lies about the size stops at the limit.
// Entry names with "..", an absolute path, a drive letter or a backslash are refused. Nothing is ever written
// to disk: entries go to memory only.
const zlib = require('zlib');

class ZipError extends Error {
  constructor(message, code) { super(message); this.code = code || 'zip'; }
}

const MAX_ENTRIES = 50000;
const MAX_CD_BYTES = 32 * 1024 * 1024;
const MAX_RATIO = 1000; // uncompressed / compressed, checked once an entry is above 8 MB

/** A reader over a Buffer, for tests and for files that are not on a local disk. */
function bufferReader(buf) {
  return {
    size: buf.length,
    async read(offset, length) {
      if (offset < 0 || offset > buf.length) throw new ZipError('Read outside the file.', 'range');
      return buf.subarray(offset, Math.min(buf.length, offset + length));
    },
    async close() {},
  };
}

/** A reader over a local file with range reads. */
async function fileReader(fsPath) {
  const fsp = require('fs').promises;
  const fh = await fsp.open(fsPath, 'r');
  const st = await fh.stat();
  return {
    size: st.size,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, st.size - offset));
      const b = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(b, got, len - got, offset + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return got === len ? b : b.subarray(0, got);
    },
    async close() { await fh.close().catch(() => {}); },
  };
}

/** Why an entry name is not safe, or '' when it is fine. */
function unsafeName(name) {
  if (!name) return 'empty name';
  if (name.includes('\0')) return 'NUL in name';
  if (name.includes('\\')) return 'backslash in name';
  if (name.startsWith('/')) return 'absolute path';
  if (/^[a-zA-Z]:/.test(name)) return 'drive letter';
  if (name.split('/').some(s => s === '..')) return '".." in path';
  return '';
}

function isZipMagic(b) {
  return b && b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
}

function decodeName(raw, utf8) {
  // XMind always writes UTF-8 names. Old tools may not set bit 11; UTF-8 decoding is still the best guess.
  return raw.toString('utf8');
}

/**
 * Reads the central directory. Returns { entries: Map(name -> entry), refused: [{name, reason}], count }.
 */
async function openZip(reader) {
  const size = reader.size;
  if (size < 22) throw new ZipError('The file is too small to be a ZIP package.', 'notzip');
  const head = await reader.read(0, 4);
  if (!isZipMagic(head)) throw new ZipError('This file is not a ZIP package, so it is not an XMind map. It may be damaged or an older XMind 3 file.', 'notzip');
  const tailLen = Math.min(size, 22 + 65535);
  const tail = await reader.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('The end of the ZIP directory is missing. The file may be cut off.', 'damaged');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    // ZIP64: find the ZIP64 end record through its locator.
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new ZipError('The ZIP64 directory is damaged.', 'damaged');
    const z64off = Number(tail.readBigUInt64LE(loc + 8));
    const z = await reader.read(z64off, 56);
    if (z.length < 56 || z.readUInt32LE(0) !== 0x06064b50) throw new ZipError('The ZIP64 directory is damaged.', 'damaged');
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdOff = Number(z.readBigUInt64LE(48));
  }
  if (count > MAX_ENTRIES) throw new ZipError(`The package has ${count} entries. More than ${MAX_ENTRIES} is not an XMind map.`, 'limit');
  if (cdSize > MAX_CD_BYTES || cdOff + cdSize > size) throw new ZipError('The ZIP directory is damaged or too large.', 'damaged');
  const cd = await reader.read(cdOff, cdSize);
  const entries = new Map();
  const refused = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    let off = cd.readUInt32LE(p + 42);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0);
    // ZIP64 extra field
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend && x + 4 <= cd.length) {
      const id = cd.readUInt16LE(x), sz = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff && q + 8 <= x + 4 + sz) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff && q + 8 <= x + 4 + sz) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (off === 0xffffffff && q + 8 <= x + 4 + sz) { off = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      x += 4 + sz;
    }
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue; // folder
    const why = unsafeName(name);
    if (why) { refused.push({ name: name.slice(0, 200), reason: why }); continue; }
    entries.set(name, { name, flags, method, csize, usize, offset: off, encrypted: (flags & 1) !== 0 });
  }
  return { entries, refused, count };
}

/**
 * Reads one entry into memory. maxBytes is the most this entry may inflate to; past it the read stops with
 * a ZipError (code 'bomb'). The declared size is not trusted.
 */
async function readEntry(reader, entry, maxBytes) {
  if (entry.encrypted) throw new ZipError(`${entry.name} is encrypted.`, 'encrypted');
  if (entry.usize > maxBytes) throw new ZipError(`${entry.name} unpacks to ${entry.usize} bytes, more than the limit of ${maxBytes}.`, 'limit');
  const lh = await reader.read(entry.offset, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`The entry ${entry.name} is damaged.`, 'damaged');
  const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (start + entry.csize > reader.size) throw new ZipError(`The entry ${entry.name} is cut off.`, 'damaged');
  const data = await reader.read(start, entry.csize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new ZipError(`${entry.name} uses ZIP method ${entry.method}, which is not supported.`, 'method');
  // Inflate at most maxBytes + 1 bytes: one byte more than allowed proves the entry is too large.
  // The central directory size is trusted only as an upper bound: past it (plus a little slack) the entry lied.
  const limit = entry.usize > 0 ? Math.min(maxBytes, entry.usize + 65536) : maxBytes;
  let out;
  try {
    out = zlib.inflateRawSync(data, { maxOutputLength: limit + 1 });
  } catch (e) {
    if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer/i.test(String(e.message)))) {
      throw new ZipError(`${entry.name} unpacks to more than ${limit} bytes (the header said ${entry.usize}). This looks like a zip bomb, so it was not opened.`, 'bomb');
    }
    throw new ZipError(`${entry.name} could not be unpacked: ${e && e.message ? e.message : e}`, 'damaged');
  }
  if (out.length > limit) throw new ZipError(`${entry.name} unpacks to more than ${limit} bytes (the header said ${entry.usize}). This looks like a zip bomb, so it was not opened.`, 'bomb');
  if (out.length > 8 * 1024 * 1024 && entry.csize > 0 && out.length / entry.csize > MAX_RATIO) {
    throw new ZipError(`${entry.name} is packed ${Math.round(out.length / entry.csize)} times smaller than its content. This looks like a zip bomb, so it was not opened.`, 'bomb');
  }
  if (out.length !== entry.usize && entry.usize !== 0) {
    // A lying header. Small differences mean damage; the content is still used, with a note.
    entry.sizeMismatch = true;
  }
  return out;
}

module.exports = { openZip, readEntry, bufferReader, fileReader, unsafeName, isZipMagic, ZipError, MAX_RATIO };
