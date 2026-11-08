'use strict';
// A small non-validating XML parser (from the Zovo PPTX viewer). It builds a plain tree:
// { name, attrs, children: [node | string] }. No DTDs, no external entities, no network.
// Shared design with the DOCX viewer: only depends on this file.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
      try { return String.fromCodePoint(cp); } catch { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { pushText(stack, text.slice(i)); break; }
    if (lt > i) pushText(stack, text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const cdata = text.slice(lt + 9, end < 0 ? n : end);
      stack[stack.length - 1].children.push(cdata);
      i = end < 0 ? n : end + 3;
    } else if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const end = text.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      const name = text.slice(lt + 2, end < 0 ? n : end).trim();
      // Pop up to the matching element; tolerate bad nesting.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = end < 0 ? n : end + 1;
    } else {
      const end = findTagEnd(text, lt + 1);
      let body = text.slice(lt + 1, end);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const sp = body.search(/[\s]/);
      const name = sp < 0 ? body : body.slice(0, sp);
      const attrs = {};
      if (sp >= 0) {
        ATTR_RE.lastIndex = 0;
        const rest = body.slice(sp);
        let m;
        while ((m = ATTR_RE.exec(rest))) attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
      }
      const node = { name, attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
      i = end + 1;
    }
  }
  return root;
}

function findTagEnd(text, from) {
  let q = null;
  for (let k = from; k < text.length; k++) {
    const c = text[k];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') return k;
  }
  return text.length;
}

function pushText(stack, raw) {
  if (!raw) return;
  stack[stack.length - 1].children.push(decodeEntities(raw));
}

// Local name without the namespace prefix: "a:t" -> "t".
function local(name) {
  const c = name.indexOf(':');
  return c < 0 ? name : name.slice(c + 1);
}

function elements(node) {
  return node && node.children ? node.children.filter((c) => typeof c !== 'string') : [];
}

// First child element with the given qualified name (e.g. "p:spTree").
function child(node, name) {
  return elements(node).find((c) => c.name === name) || null;
}

// Depth-first search for all descendants with the given qualified name.
function findAll(node, name, out = []) {
  for (const c of elements(node)) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

function find(node, name) {
  for (const c of elements(node)) {
    if (c.name === name) return c;
    const f = find(c, name);
    if (f) return f;
  }
  return null;
}

function textOf(node) {
  let s = '';
  for (const c of node.children || []) s += typeof c === 'string' ? c : textOf(c);
  return s;
}

module.exports = { parseXml, decodeEntities, local, elements, child, find, findAll, textOf };
