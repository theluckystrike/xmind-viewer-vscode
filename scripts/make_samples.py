#!/usr/bin/env python3 -I
"""Writes the sample and hostile files for the XMind viewer tests and the real VS Code gate.

usage: python3 -I scripts/make_samples.py <samplesDir> [--large <dir>]

Stdlib only and deterministic (fixed seeds), so the same files come out on every run.
--large writes large-10k-images.xmind (10,111 topics, about 30 MB of incompressible images) into <dir>.
Keep that one out of the temp folder and out of the repo.
"""
import json, os, random, struct, sys, zipfile, zlib

RND = random.Random(20261108)


def uid():
    return ''.join(RND.choice('0123456789abcdef') for _ in range(26))


# ---------------------------------------------------------------- PNG

def png(width, height, pixel_rows, level=9):
    """pixel_rows: bytes of RGB rows without filter bytes."""
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += pixel_rows[y * stride:(y + 1) * stride]
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), level)) + chunk(b'IEND', b''))


def gradient_png(width=120, height=80, a=(40, 110, 200), b=(250, 170, 60)):
    rows = bytearray()
    for y in range(height):
        for x in range(width):
            t = x / max(1, width - 1)
            u = y / max(1, height - 1)
            rows += bytes((int(a[0] + (b[0] - a[0]) * t), int(a[1] + (b[1] - a[1]) * u), int(a[2] + (b[2] - a[2]) * (t + u) / 2)))
    return png(width, height, bytes(rows))


def noise_png(width, height, seed):
    r = random.Random(seed)
    return png(width, height, r.randbytes(width * height * 3), level=0)


# ---------------------------------------------------------------- XMind 2020 (content.json)

STUB_XML = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" '
            'version="2.0"><sheet id="warn" ><topic id="w"><title>Warning: This file can not be opened normally, please do not '
            'modify and save, otherwise the contents will be permanently lost!</title></topic><title>Sheet 1</title></sheet></xmap-content>')


def T(title, *kids, **kw):
    """A content.json topic. kw: markers, labels, note, html, href, image, equation, detached, summary_kids,
    boundaries, summaries, structure, id."""
    t = {'id': kw.get('id') or uid(), 'class': 'topic', 'title': title}
    if kw.get('structure'):
        t['structureClass'] = kw['structure']
    ch = {}
    if kids:
        ch['attached'] = list(kids)
    if kw.get('detached'):
        ch['detached'] = kw['detached']
    if kw.get('summary_kids'):
        ch['summary'] = kw['summary_kids']
    if ch:
        t['children'] = ch
    if kw.get('markers'):
        t['markers'] = [{'markerId': m} for m in kw['markers']]
    if kw.get('labels'):
        t['labels'] = kw['labels']
    if kw.get('note') or kw.get('html'):
        n = {}
        if kw.get('note'):
            n['plain'] = {'content': kw['note']}
        if kw.get('html'):
            n['realHTML'] = {'content': kw['html']}
        t['notes'] = n
    if kw.get('href'):
        t['href'] = kw['href']
    if kw.get('image'):
        src, w, h = kw['image']
        t['image'] = {'src': src, 'width': w, 'height': h}
    if kw.get('equation'):
        t['extensions'] = [{'provider': 'org.xmind.ui.mathJax', 'content': [{'name': 'content', 'content': kw['equation']}]}]
    if kw.get('boundaries'):
        t['boundaries'] = [{'id': uid(), 'range': r, 'title': ti} for r, ti in kw['boundaries']]
    if kw.get('summaries'):
        t['summaries'] = [{'id': uid(), 'range': r, 'topicId': tid} for r, tid in kw['summaries']]
    return t


def sheet(title, root, rels=()):
    return {'id': uid(), 'class': 'sheet', 'title': title, 'rootTopic': root,
            'relationships': [{'id': uid(), 'end1Id': a, 'end2Id': b, 'title': ti} for a, b, ti in rels],
            'topicPositioning': 'fixed'}


def write_zen(path, sheets, resources=None, stored=False):
    resources = resources or {}
    content = json.dumps(sheets, ensure_ascii=False, separators=(',', ':')) if not isinstance(sheets, str) else sheets
    manifest = {'file-entries': {'content.json': {}, 'metadata.json': {}, **{k: {} for k in resources}}}
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('content.json', content)
        z.writestr('metadata.json', json.dumps({'creator': {'name': 'Vana', 'version': '24.01'}}))
        z.writestr('manifest.json', json.dumps(manifest))
        z.writestr('content.xml', STUB_XML)
        for name, data in resources.items():
            z.writestr(zipfile.ZipInfo(name, (2026, 11, 8, 9, 0, 0)), data,
                       compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED)


def project_plan(out):
    research = T('Research', T('User interviews', markers=['task-done']), T('Competitor review', markers=['task-half']),
                 T('Analytics audit', id='analytics-audit'), T('Survey (n=420)'),
                 markers=['priority-1'], labels=['Q1'],
                 note='Talk to 12 customers before the design starts.\nSummaries go to the shared folder.')
    design = T('Design', T('Wireframes'), T('Visual style', image=('xap:resources/visual-style.png', 120, 80)),
               T('Prototype', id='prototype'), T('Usability test', id='usability-test'),
               markers=['priority-2'], boundaries=[('(0,1)', 'Phase A')])
    core = T('Core engineering', id='core-eng')
    build = T('Build', T('Frontend', T('React app'), T('Accessibility')), T('Backend API', T('Auth'), T('Search')),
              T('CMS migration'), T('Performance budget', id='perf-budget'),
              T('Load time model', equation='E = mc^2 + \\frac{a}{b}'),
              markers=['priority-3'], summary_kids=[core], summaries=[('(1,2)', 'core-eng')])
    launch = T('Launch', T('Beta', id='beta'), T('Press kit', href='https://example.com/press'),
               T('Go live', markers=['smiley-laugh']), T('Retrospective', href='xmind:#research-main'),
               markers=['flag-red', 'star-yellow'])
    research['id'] = 'research-main'
    budget = T('Budget', T('Design 30%'), T('Build 50%'), T('Marketing 20%'), labels=['finance'],
               html='<div>Budget is <b>approved</b> for <i>Q1 to Q3</i>.</div>')
    team = T('Team', T('PM'), T('Designers'), T('Engineers'), T('QA'))
    parking = T('Parking lot ideas', T('Dark mode'), T('i18n'))
    root = T('Website relaunch 2026', research, design, build, launch, budget, team,
             structure='org.xmind.ui.map.unbalanced', detached=[parking], boundaries=[('(4,5)', 'Support')])
    s1 = sheet('Project plan', root, [('analytics-audit', 'perf-budget', 'sets targets'), ('beta', 'usability-test', 'feedback loop')])

    r_vendor = T('Vendor delay', id='vendor-delay', markers=['flag-orange'])
    risks = T('Risks', T('Schedule', r_vendor, T('Holidays')), T('Technical', T('Legacy CMS export', id='legacy-cms'), T('Third-party API limits')),
              T('People', T('Key person leaves')), structure='org.xmind.ui.logic.right')
    s2 = sheet('Risks', risks, [('legacy-cms', 'vendor-delay', 'can cause')])

    org = T('Director', T('Design lead', T('UI designer'), T('UX researcher')),
            T('Eng lead', T('Frontend dev'), T('Backend dev'), T('DevOps')), T('QA lead', T('Tester')),
            structure='org.xmind.ui.org-chart.down')
    s3 = sheet('Team', org)
    write_zen(os.path.join(out, 'project-plan-2020.xmind'), [s1, s2, s3], {'resources/visual-style.png': gradient_png()})


def research_cjk(out):
    collect = T('数据收集', T('アンケート調査'), T('インタビュー'), id='collect')
    analyse = T('データ分析', T('統計分析'), T('テキストマイニング'), id='analyse')
    root = T('研究计划 Research plan', T('文献综述', T('国内研究'), T('海外研究')), collect, analyse, T('まとめ'),
             T('연구 일정', T('1월 준비'), T('3월 발표')), T('🚀 Launch'), T('✅ Done'),
             T('第一行标题\nSecond line of a long title that goes on\n第三行 三行目'),
             structure='org.xmind.ui.logic.right', boundaries=[('(0,1)', '前期 準備')])
    s1 = sheet('研究计划', root, [('collect', 'analyse', '数据→分析')])
    root2 = T('研究テーマ', T('背景'), T('目的', T('仮説を立てる'), T('検証する')), T('方法'), T('まとめ 😀'),
              structure='org.xmind.ui.tree.right')
    s2 = sheet('研究テーマ', root2)
    write_zen(os.path.join(out, 'research-cjk.xmind'), [s1, s2])


def fishbone_timeline(out):
    fish = T('Late deliveries', T('People', T('Training'), T('Shift gaps')), T('Process', T('Manual checks'), T('No SLA')),
             T('Tools', T('Old scanner')), T('Suppliers', T('Single source'), T('Long lead time')),
             structure='org.xmind.ui.fishbone.leftHeaded')
    tl = T('2026 roadmap', T('Jan: kickoff'), T('Mar: alpha', T('Internal demo')), T('Jun: beta', T('Public signup')),
           T('Sep: 1.0'), T('Nov: review'), T('Dec: plan 2027', T('Budget'), T('Hiring')), T('Holiday freeze'),
           T('Postmortem'), structure='org.xmind.ui.timeline.horizontal')
    sp = T('Feature matrix', T('Free', T('Viewer'), T('Export')), T('Pro', T('Sync'), T('Teams')),
           T('Enterprise', T('SSO'), T('Audit log'), T('SLA')), T('Notes'), T('Open items'),
           structure='org.xmind.ui.spreadsheet')
    write_zen(os.path.join(out, 'fishbone-timeline.xmind'), [sheet('Fishbone', fish), sheet('Timeline', tl), sheet('Matrix', sp)])


def big_map(out, path=None, a=8, b=10, c=24, images=0, title='Big map'):
    """Map with a*b*c leaves. images: how many leaves carry a big noise PNG."""
    res = {}
    img_every = (a * b * c) // images if images else 0
    leaf_n = 0
    mains = []
    for i in range(a):
        subs = []
        for j in range(b):
            leaves = []
            for k in range(c):
                kw = {}
                if images and leaf_n % img_every == 0 and len(res) < images:
                    name = 'resources/noise-%03d.png' % len(res)
                    res[name] = None
                    kw['image'] = ('xap:' + name, 160, 120)
                leaves.append(T('Item %d.%d.%d' % (i + 1, j + 1, k + 1), **kw))
                leaf_n += 1
            subs.append(T('Group %d.%d' % (i + 1, j + 1), *leaves))
        mains.append(T('Area %d' % (i + 1), *subs))
    root = T(title, *mains, structure='org.xmind.ui.map.unbalanced')
    content = json.dumps([sheet(title, root)], separators=(',', ':'))
    p = path or os.path.join(out, 'big-2000-topics.xmind')
    with zipfile.ZipFile(p, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('content.json', content)
        z.writestr('metadata.json', json.dumps({'creator': {'name': 'Vana', 'version': '24.01'}}))
        z.writestr('manifest.json', json.dumps({'file-entries': {'content.json': {}, 'metadata.json': {}, **{k: {} for k in res}}}))
        z.writestr('content.xml', STUB_XML)
        for n, name in enumerate(res):
            # 400 x 420 RGB random pixels, stored: about 504 KB each, does not compress.
            z.writestr(zipfile.ZipInfo(name, (2026, 11, 8, 9, 0, 0)), noise_png(400, 420, 1000 + n), compress_type=zipfile.ZIP_STORED)
    return p


# ---------------------------------------------------------------- XMind 8 (content.xml)

def xesc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def X(title, *kids, **kw):
    """Builds an XMind 8 <topic> string."""
    tid = kw.get('id') or uid()
    attrs = ' id="%s"' % tid
    if kw.get('structure'):
        attrs += ' structure-class="%s"' % kw['structure']
    if kw.get('href'):
        attrs += ' xlink:href="%s"' % xesc(kw['href'])
    body = '<title>%s</title>' % xesc(title)
    if kw.get('img'):
        body += '<xhtml:img xhtml:src="%s" svg:width="100" svg:height="60"/>' % kw['img']
    groups = ''
    if kids:
        groups += '<topics type="attached">%s</topics>' % ''.join(kids)
    if kw.get('detached'):
        groups += '<topics type="detached">%s</topics>' % ''.join(kw['detached'])
    if kw.get('summary_kids'):
        groups += '<topics type="summary">%s</topics>' % ''.join(kw['summary_kids'])
    if groups:
        body += '<children>%s</children>' % groups
    if kw.get('markers'):
        body += '<marker-refs>%s</marker-refs>' % ''.join('<marker-ref marker-id="%s"/>' % m for m in kw['markers'])
    if kw.get('labels'):
        body += '<labels>%s</labels>' % ''.join('<label>%s</label>' % xesc(l) for l in kw['labels'])
    if kw.get('note'):
        body += '<notes><plain>%s</plain><html><xhtml:p>%s</xhtml:p></html></notes>' % (xesc(kw['note']), xesc(kw['note']))
    if kw.get('boundaries'):
        body += '<boundaries>%s</boundaries>' % ''.join('<boundary id="%s" range="%s"><title>%s</title></boundary>' % (uid(), r, xesc(t)) for r, t in kw['boundaries'])
    if kw.get('summaries'):
        body += '<summaries>%s</summaries>' % ''.join('<summary id="%s" range="%s" topic-id="%s"/>' % (uid(), r, t) for r, t in kw['summaries'])
    return '<topic%s>%s</topic>' % (attrs, body)


def xmind8(out):
    ns = ('xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format" '
          'xmlns:svg="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"')
    root = X('Product Roadmap',
             X('Discovery', X('Customer calls', markers=['task-done']), X('Market sizing'), X('Pricing study', id='pricing'),
               markers=['priority-1'], labels=['Q1'], note='Start here. Owners are in the team sheet.',
               boundaries=[('(0,1)', 'Group')]),
             X('Delivery', X('Mobile app', X('iOS'), X('Android')), X('Web app', id='webapp'), X('API v2'),
               markers=['priority-2'], summary_kids=[X('Engineering', id='s1')], summaries=[('(0,1)', 's1')]),
             X('Go to market', X('Launch event', href='https://example.org/launch'), X('Partner program'), X('Docs site', id='docs'),
               markers=['flag-green', 'star-red']),
             X('日本語のトピック 中文主题', X('ユーザー調査'), X('市场推广')),
             X('Screenshots', img='xap:attachments/pic.png'),
             X('Metrics', X('Activation'), X('Retention'), X('Revenue'), labels=['kpi', 'board']),
             structure='org.xmind.ui.map.clockwise', href='https://example.org/roadmap',
             detached=[X('Loose idea', X('Dark theme'))])
    sheet1 = '<sheet id="%s">%s<relationships><relationship id="%s" end1="pricing" end2="webapp"><title>depends on</title></relationship>' \
             '<relationship id="%s" end1="docs" end2="webapp"/></relationships><title>Classic map</title></sheet>' % (uid(), root, uid(), uid())
    root2 = X('Hiring plan', X('Engineering', X('2 backend'), X('1 frontend')), X('Design', X('1 product designer')),
              X('Sales', X('2 AEs')), X('Support'), structure='org.xmind.ui.logic.right')
    sheet2 = '<sheet id="%s">%s<title>Second sheet</title></sheet>' % (uid(), root2)
    content = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content %s timestamp="1700000000000" version="2.0">%s%s</xmap-content>' % (ns, sheet1, sheet2)
    manifest = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?><manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">'
                '<file-entry full-path="content.xml" media-type="text/xml"/><file-entry full-path="META-INF/" media-type=""/>'
                '<file-entry full-path="META-INF/manifest.xml" media-type="text/xml"/><file-entry full-path="attachments/pic.png" media-type="image/png"/></manifest>')
    meta = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><meta xmlns="urn:xmind:xmap:xmlns:meta:2.0" version="2.0"><Creator><Name>XMind</Name><Version>R3.7.9</Version></Creator></meta>'
    styles = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-styles xmlns="urn:xmind:xmap:xmlns:style:2.0" version="2.0"/>'
    with zipfile.ZipFile(os.path.join(out, 'xmind8-classic.xmind'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('content.xml', content)
        z.writestr('META-INF/manifest.xml', manifest)
        z.writestr('meta.xml', meta)
        z.writestr('styles.xml', styles)
        z.writestr('attachments/pic.png', gradient_png(100, 60, (30, 160, 90), (240, 240, 120)))


# ---------------------------------------------------------------- FreeMind and OPML

def freemind(out):
    nid = [0]

    def N(text, *kids, **kw):
        nid[0] += 1
        i = kw.get('id') or 'ID_%d' % (1000 + nid[0])
        a = ' TEXT="%s" ID="%s"' % (xesc(text), i)
        if kw.get('pos'):
            a += ' POSITION="%s"' % kw['pos']
        if kw.get('folded'):
            a += ' FOLDED="true"'
        if kw.get('link'):
            a += ' LINK="%s"' % xesc(kw['link'])
        body = ''.join('<icon BUILTIN="%s"/>' % ic for ic in kw.get('icons', []))
        if kw.get('note'):
            body += '<richcontent TYPE="NOTE"><html><head/><body><p>%s</p></body></html></richcontent>' % xesc(kw['note'])
        if kw.get('arrow'):
            body += '<arrowlink DESTINATION="%s" STARTARROW="None" ENDARROW="Default"/>' % kw['arrow']
        return '<node%s>%s%s</node>' % (a, body, ''.join(kids))

    root = N('Product roadmap 2027',
             N('Q1', N('Plan', icons=['idea']), N('Hire', N('Backend'), N('Design')), N('Budget', note='Approved in December.'), pos='right'),
             N('Q2', N('Alpha', id='ID_ALPHA'), N('Docs'), N('Feedback', arrow='ID_ALPHA'), pos='right', folded=True),
             N('Q3', N('Beta', icons=['messagebox_warning']), N('Pricing'), N('Website', link='https://example.com/site'), pos='left'),
             N('Q4', N('1.0 release', icons=['button_ok', 'full-1']), N('Retro'), N('中文节点 日本語ノード'), pos='left'),
             N('Risks', N('Scope creep'), N('Vendor'), N('Budget cut'), pos='right'),
             N('Team', N('Ana'), N('Bo'), N('Chen'), N('Dee'), pos='left'))
    with open(os.path.join(out, 'freemind-roadmap.mm'), 'w', encoding='utf-8') as f:
        f.write('<map version="1.0.1">\n<!-- To view this file, download free mind mapping software FreeMind from http://freemind.sourceforge.net -->\n')
        f.write(root + '\n</map>\n')


def opml(out):
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', '<head><title>Course outline</title></head>', '<body>']
    for i in range(1, 5):
        lines.append('<outline text="Module %d: %s">' % (i, ['Basics', 'Data', 'Models', 'Shipping'][i - 1]))
        for j in range(1, 4):
            lines.append('<outline text="Lesson %d.%d"%s>' % (i, j, ' _note="Read chapter %d before class."' % j if j == 1 else ''))
            for k in range(1, 3):
                lines.append('<outline text="Exercise %d.%d.%d"/>' % (i, j, k))
            lines.append('</outline>')
        lines.append('</outline>')
    lines += ['</body>', '</opml>']
    with open(os.path.join(out, 'outline.opml'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


# ---------------------------------------------------------------- hostile files

def zip_bomb(out):
    """content.json inflates to more than 1 GiB, but both headers say 2,000 bytes."""
    name = b'content.json'
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    parts = [co.compress(b'[{"id":"s","class":"sheet","title":"')]
    chunk = b' ' * (1 << 20)
    for _ in range(1100):  # 1,100 MiB
        parts.append(co.compress(chunk))
    parts.append(co.compress(b'"}]'))
    parts.append(co.flush())
    data = b''.join(parts)
    lie = 2000
    local = struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0, 8, 0, 0x5968, 0, len(data), lie, len(name), 0) + name
    meta_name = b'metadata.json'
    meta = b'{"creator":{"name":"Vana","version":"24.01"}}'
    local2_off = len(local) + len(data)
    local2 = struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0, 0, 0, 0x5968, zlib.crc32(meta) & 0xffffffff, len(meta), len(meta), len(meta_name), 0) + meta_name
    cd_off = local2_off + len(local2) + len(meta)
    cd = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0, 8, 0, 0x5968, 0, len(data), lie, len(name), 0, 0, 0, 0, 0, 0) + name
    cd += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0, 0, 0, 0x5968, zlib.crc32(meta) & 0xffffffff, len(meta), len(meta),
                      len(meta_name), 0, 0, 0, 0, 0, local2_off) + meta_name
    eocd = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, 2, 2, len(cd), cd_off, 0)
    with open(os.path.join(out, 'hostile-zip-bomb.xmind'), 'wb') as f:
        f.write(local + data + local2 + meta + cd + eocd)


def path_traversal(out):
    root = T('Path test', T('Escapes with ..', image=('xap:resources/../../../evil.png', 80, 60)),
             T('Absolute path', image=('xap:/etc/hosts', 80, 60)), T('Good image', image=('xap:resources/ok.png', 60, 40)),
             T('Plain topic'), structure='org.xmind.ui.map.unbalanced')
    content = json.dumps([sheet('Paths', root)], separators=(',', ':'))
    with zipfile.ZipFile(os.path.join(out, 'hostile-path-traversal.xmind'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('content.json', content)
        z.writestr('metadata.json', '{}')
        for bad in ('../../evil.txt', '/abs/evil.txt', 'resources/../../../x.png', 'C:\\Windows\\evil.txt'):
            zi = zipfile.ZipInfo('x', (2026, 11, 8, 9, 0, 0))
            zi.filename = bad  # raw name, as a hostile writer would store it
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, b'this entry must never be written to disk\n')
        z.writestr('resources/ok.png', gradient_png(60, 40))


def deep_broken(out):
    """2,000-deep chain plus broken references. Written by hand: json.dumps refuses this depth."""
    depth = 2000
    head = []
    for i in range(1, depth):
        title = '"Level %d"' % i
        if i == 3:
            title = '42'
        elif i == 4:
            title = 'null'
        extra = ''
        if i == 5:
            extra = ',"markers":[{"markerId":"unknown-marker-xyz"},{"markerId":"priority-1"}]'
        head.append('{"id":"c%d","class":"topic","title":%s%s,"children":{"attached":[' % (i, title, extra))
    leaf = '{"id":"c%d","class":"topic","title":"Bottom of the chain","children":"this should be an object"}' % depth
    content = ''.join(head) + leaf + ']}}' * (depth - 1)
    root = ('{"id":"root","class":"topic","title":"Deep and broken","structureClass":"org.xmind.ui.logic.right",'
            '"boundaries":[{"id":"b1","range":"(master)","title":"Whole map"},{"id":"b2","range":"(x,y)","title":"Bad range"}],'
            '"summaries":[{"id":"sm1","range":"(5,99)"}],'
            '"children":{"attached":[' + content + ',{"id":"side","class":"topic","title":"Side branch"}]}}')
    sheetj = ('[{"id":"sh1","class":"sheet","title":"Deep",'
              '"relationships":[{"id":"r1","end1Id":"c10","end2Id":"does-not-exist","title":"dangling"},'
              '{"id":"r2","end1Id":"side","end2Id":"c3","title":"ok"}],"rootTopic":' + root + '}]')
    write_zen(os.path.join(out, 'hostile-deep-broken.xmind'), sheetj)


def not_a_zip(out):
    r = random.Random(4096)
    with open(os.path.join(out, 'hostile-not-a-zip.xmind'), 'wb') as f:
        f.write(r.randbytes(4096))


def main(argv):
    if not argv or argv[0].startswith('-'):
        print(__doc__)
        return 2
    out = argv[0]
    os.makedirs(out, exist_ok=True)
    project_plan(out)
    research_cjk(out)
    xmind8(out)
    fishbone_timeline(out)
    big_map(out)
    freemind(out)
    opml(out)
    zip_bomb(out)
    path_traversal(out)
    deep_broken(out)
    not_a_zip(out)
    if '--large' in argv:
        d = argv[argv.index('--large') + 1]
        os.makedirs(d, exist_ok=True)
        big_map(None, os.path.join(d, 'large-10k-images.xmind'), 10, 10, 100, images=60, title='Large map')
    for f in sorted(os.listdir(out)):
        p = os.path.join(out, f)
        if os.path.isfile(p):
            print('%10d  %s' % (os.path.getsize(p), f))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
