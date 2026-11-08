#!/usr/bin/env python3 -I
"""Reference reader for the XMind viewer tests. Written apart from the extension's own reader, so the two can be compared.

usage: python3 -I scripts/ref_xmind.py <file>

Prints JSON: {"format": "xmind-json|xmind-xml|freemind|opml|error", "sheets": [...], "error": null or text}.
Per sheet: title, rootTitle, topics, relationships, boundaries, summaries, markers, images, imagesOk, notes, labels, equations.

Counting rules (the viewer must report the same numbers):
  topics        root + attached + detached + summary topics, recursively (.mm: every <node>; .opml: 1 root + every <outline>)
  relationships both ends exist in the sheet (.mm: arrowlinks whose DESTINATION exists)
  boundaries    range "(a,b)" with 0 <= a <= b < number of attached children, or "(master)"
  summaries     range "(a,b)" as above
  markers       marker refs with a non-empty id (.mm: <icon BUILTIN>)
  images        topics with an image reference; imagesOk: those whose path is safe and exists in the zip
  notes         topics with a non-empty note; labels: all labels; equations: topics with a LaTeX (mathJax) extension
No entry is ever inflated past 64 MB, so a zip bomb is reported as an error.
"""
import json, os, re, struct, sys, threading, zipfile, zlib
import xml.etree.ElementTree as ET

MAX_ENTRY = 64 * 1024 * 1024
RANGE = re.compile(r'^\((\d+),(\d+)\)$')


class RefError(Exception):
    pass


def safe_name(name):
    if not name or name.startswith('/') or '\\' in name or ':' in name.split('/')[0] or '\x00' in name:
        return False
    return all(seg not in ('..',) for seg in name.split('/'))


def read_entry(path, zf, info):
    """Inflate one entry ourselves, with a hard output limit (the header sizes may lie)."""
    with open(path, 'rb') as f:
        f.seek(info.header_offset)
        h = f.read(30)
        if len(h) < 30 or h[:4] != b'PK\x03\x04':
            raise RefError('bad local header for %s' % info.filename)
        nlen, xlen = struct.unpack('<HH', h[26:30])
        f.seek(info.header_offset + 30 + nlen + xlen)
        left = info.compress_size
        if info.compress_type == zipfile.ZIP_STORED:
            if left > MAX_ENTRY:
                raise RefError('%s is larger than 64 MB' % info.filename)
            return f.read(left)
        if info.compress_type != zipfile.ZIP_DEFLATED:
            raise RefError('unsupported compression %d' % info.compress_type)
        d = zlib.decompressobj(-15)
        out = bytearray()
        while left > 0 or d.unconsumed_tail:
            buf = d.unconsumed_tail
            if not buf:
                buf = f.read(min(left, 1 << 16))
                left -= len(buf)
                if not buf:
                    break
            out += d.decompress(buf, MAX_ENTRY + 1 - len(out))
            if len(out) > MAX_ENTRY:
                raise RefError('%s inflates to more than 64 MB (zip bomb?)' % info.filename)
            if d.eof:
                break
        if len(out) != info.file_size:
            raise RefError('%s: header says %d bytes, data has %d' % (info.filename, info.file_size, len(out)))
        return bytes(out)


def ranges_ok(r, n, allow_master):
    if not isinstance(r, str):
        return False
    r = r.strip()
    if allow_master and r == '(master)':
        return True
    m = RANGE.match(r.replace(' ', ''))
    if not m:
        return False
    a, b = int(m.group(1)), int(m.group(2))
    return 0 <= a <= b < n


def text(v):
    if v is None:
        return ''
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    return v if isinstance(v, str) else ''


# ---------------------------------------------------------------- content.json

def zen_children(t):
    ch = t.get('children')
    if not isinstance(ch, dict):
        return [], []
    att = [c for c in ch.get('attached') or [] if isinstance(c, dict)] if isinstance(ch.get('attached'), list) else []
    other = []
    for k in ('detached', 'summary'):
        v = ch.get(k)
        if isinstance(v, list):
            other += [c for c in v if isinstance(c, dict)]
    return att, other


def zen_sheet(s, names):
    root = s.get('rootTopic')
    out = {'title': text(s.get('title')), 'rootTitle': '', 'topics': 0, 'relationships': 0, 'boundaries': 0, 'summaries': 0,
           'markers': 0, 'images': 0, 'imagesOk': 0, 'notes': 0, 'labels': 0, 'equations': 0}
    if not isinstance(root, dict):
        return out
    out['rootTitle'] = text(root.get('title'))
    ids = set()
    stack = [root]
    while stack:
        t = stack.pop()
        out['topics'] += 1
        if isinstance(t.get('id'), str):
            ids.add(t['id'])
        att, other = zen_children(t)
        stack += att + other
        for b in t.get('boundaries') or [] if isinstance(t.get('boundaries'), list) else []:
            if isinstance(b, dict) and ranges_ok(b.get('range'), len(att), True):
                out['boundaries'] += 1
        for b in t.get('summaries') or [] if isinstance(t.get('summaries'), list) else []:
            if isinstance(b, dict) and ranges_ok(b.get('range'), len(att), False):
                out['summaries'] += 1
        for m in t.get('markers') or [] if isinstance(t.get('markers'), list) else []:
            if isinstance(m, dict) and isinstance(m.get('markerId'), str) and m['markerId']:
                out['markers'] += 1
        img = t.get('image')
        if isinstance(img, dict) and isinstance(img.get('src'), str) and img['src']:
            out['images'] += 1
            src = img['src']
            if src.startswith('xap:') and safe_name(src[4:]) and src[4:] in names:
                out['imagesOk'] += 1
        n = t.get('notes')
        if isinstance(n, dict):
            p = n.get('plain') if isinstance(n.get('plain'), dict) else {}
            h = n.get('realHTML') if isinstance(n.get('realHTML'), dict) else {}
            if text(p.get('content')).strip() or text(h.get('content')).strip():
                out['notes'] += 1
        if isinstance(t.get('labels'), list):
            out['labels'] += sum(1 for l in t['labels'] if isinstance(l, str) and l)
        for e in t.get('extensions') or [] if isinstance(t.get('extensions'), list) else []:
            if isinstance(e, dict) and re.search(r'math|latex', str(e.get('provider', '')), re.I):
                out['equations'] += 1
                break
    for r in s.get('relationships') or [] if isinstance(s.get('relationships'), list) else []:
        if isinstance(r, dict) and r.get('end1Id') in ids and r.get('end2Id') in ids:
            out['relationships'] += 1
    return out


# ---------------------------------------------------------------- content.xml (XMind 8)

NS = '{urn:xmind:xmap:xmlns:content:2.0}'
XH = '{http://www.w3.org/1999/xhtml}'


def x8_title(el):
    t = el.find(NS + 'title')
    return (t.text or '') if t is not None else ''


def x8_sheet(sh, names):
    out = {'title': x8_title(sh), 'rootTitle': '', 'topics': 0, 'relationships': 0, 'boundaries': 0, 'summaries': 0,
           'markers': 0, 'images': 0, 'imagesOk': 0, 'notes': 0, 'labels': 0, 'equations': 0}
    root = sh.find(NS + 'topic')
    if root is None:
        return out
    out['rootTitle'] = x8_title(root)
    ids = set()
    stack = [root]
    while stack:
        t = stack.pop()
        out['topics'] += 1
        if t.get('id'):
            ids.add(t.get('id'))
        att = []
        ch = t.find(NS + 'children')
        if ch is not None:
            for g in ch.findall(NS + 'topics'):
                kids = g.findall(NS + 'topic')
                if g.get('type') == 'attached':
                    att += kids
                stack += kids
        bs = t.find(NS + 'boundaries')
        if bs is not None:
            out['boundaries'] += sum(1 for b in bs.findall(NS + 'boundary') if ranges_ok(b.get('range'), len(att), True))
        ss = t.find(NS + 'summaries')
        if ss is not None:
            out['summaries'] += sum(1 for b in ss.findall(NS + 'summary') if ranges_ok(b.get('range'), len(att), False))
        mr = t.find(NS + 'marker-refs')
        if mr is not None:
            out['markers'] += sum(1 for m in mr.findall(NS + 'marker-ref') if m.get('marker-id'))
        img = t.find(XH + 'img')
        if img is not None and img.get(XH + 'src'):
            out['images'] += 1
            src = img.get(XH + 'src')
            if src.startswith('xap:') and safe_name(src[4:]) and src[4:] in names:
                out['imagesOk'] += 1
        n = t.find(NS + 'notes')
        if n is not None and ''.join(n.itertext()).strip():
            out['notes'] += 1
        lb = t.find(NS + 'labels')
        if lb is not None:
            out['labels'] += sum(1 for l in lb.findall(NS + 'label') if (l.text or ''))
    rels = sh.find(NS + 'relationships')
    if rels is not None:
        out['relationships'] = sum(1 for r in rels.findall(NS + 'relationship') if r.get('end1') in ids and r.get('end2') in ids)
    return out


# ---------------------------------------------------------------- FreeMind and OPML

def freemind(path):
    root = ET.parse(path).getroot()
    top = root.find('node')
    out = {'title': os.path.splitext(os.path.basename(path))[0], 'rootTitle': top.get('TEXT', '') if top is not None else '',
           'topics': 0, 'relationships': 0, 'boundaries': 0, 'summaries': 0, 'markers': 0, 'images': 0, 'imagesOk': 0,
           'notes': 0, 'labels': 0, 'equations': 0}
    nodes = list(root.iter('node'))
    out['topics'] = len(nodes)
    ids = {n.get('ID') for n in nodes if n.get('ID')}
    for n in nodes:
        out['markers'] += sum(1 for i in n.findall('icon') if i.get('BUILTIN'))
        out['relationships'] += sum(1 for a in n.findall('arrowlink') if a.get('DESTINATION') in ids)
        if any(r.get('TYPE') == 'NOTE' and ''.join(r.itertext()).strip() for r in n.findall('richcontent')):
            out['notes'] += 1
    return out


def opml(path):
    root = ET.parse(path).getroot()
    head = root.find('head')
    t = head.find('title') if head is not None else None
    title = (t.text or '').strip() if t is not None and t.text else os.path.splitext(os.path.basename(path))[0]
    outlines = list(root.iter('outline'))
    return {'title': title, 'rootTitle': title, 'topics': 1 + len(outlines), 'relationships': 0, 'boundaries': 0, 'summaries': 0,
            'markers': 0, 'images': 0, 'imagesOk': 0, 'notes': sum(1 for o in outlines if (o.get('_note') or '').strip()),
            'labels': 0, 'equations': 0}


# ---------------------------------------------------------------- main

def read(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.mm':
        return {'format': 'freemind', 'sheets': [freemind(path)], 'error': None}
    if ext == '.opml':
        return {'format': 'opml', 'sheets': [opml(path)], 'error': None}
    with open(path, 'rb') as f:
        if f.read(4)[:2] != b'PK':
            raise RefError('not a zip file')
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise RefError('bad zip: %s' % e)
    with zf:
        infos = {i.filename: i for i in zf.infolist() if safe_name(i.filename)}
        names = set(infos)
        if 'content.json' in infos:
            data = json.loads(read_entry(path, zf, infos['content.json']).decode('utf-8'))
            if isinstance(data, list):
                return {'format': 'xmind-json', 'sheets': [zen_sheet(s, names) for s in data if isinstance(s, dict)], 'error': None}
        if 'content.xml' in infos:
            root = ET.fromstring(read_entry(path, zf, infos['content.xml']))
            return {'format': 'xmind-xml', 'sheets': [x8_sheet(s, names) for s in root.findall(NS + 'sheet')], 'error': None}
        raise RefError('no content.json or content.xml')


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    res = {}

    def run():
        try:
            res['v'] = read(sys.argv[1])
        except (RefError, ValueError, ET.ParseError, OSError, UnicodeDecodeError) as e:
            res['v'] = {'format': 'error', 'sheets': [], 'error': str(e)}

    # The 2,000-deep hostile file needs a deep JSON parse: more recursion and a bigger thread stack.
    sys.setrecursionlimit(200000)
    threading.stack_size(512 * 1024 * 1024)
    th = threading.Thread(target=run)
    th.start()
    th.join()
    print(json.dumps(res['v'], ensure_ascii=False))


if __name__ == '__main__':
    main()
