'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { openMap, LoadError } = require('./core/load');
const { bufferReader, fileReader } = require('./core/zip');
const { validateWebviewMessage, linkAction, fmtSize } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { flatten } = require('./core/flat');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'xmindViewer.map';
const EXT_ID = 'zovo.xmind-mind-map-viewer';
const MAX_NON_FILE_MB = 512;
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('xmindViewer');
  return {
    maxFileMB: c.get('maxFileMB', 1024),
    defaultLayout: c.get('defaultLayout', 'file'),
    collapseLevel: c.get('collapseLevel', 0),
    useMapColors: c.get('useMapColors', true),
  };
}

class MindMapEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('xmindViewer') };
    const name = path.posix.basename(uri.path);
    const asUri = p => panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, ...p.split('/'))).toString();
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: asUri('dist/webview.js'),
      katexUri: asUri('media/katex/katex.min.js'),
      katexCssUri: asUri('media/katex/katex.min.css'),
      styleUri: asUri('media/webview.css'),
      title: name,
      showSupportLinks: showLinks(vscode, 'xmindViewer'),
    });
    let disposed = false;
    let counted = false;
    let failed = false;
    let map = null;
    const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));
    const onFail = () => { if (!failed && !counted) { failed = true; rating.failure(); } };

    const load = async () => {
      const t0 = Date.now();
      const s = settings();
      let stat;
      try { stat = await vscode.workspace.fs.stat(uri); } catch (e) { await post({ type: 'error', code: 'stat', message: `The file could not be read: ${e.message || e}` }); onFail(); return; }
      await post({ type: 'init', name, size: stat.size, sizeText: fmtSize(stat.size), settings: { defaultLayout: s.defaultLayout, collapseLevel: s.collapseLevel, useMapColors: s.useMapColors } });
      if (stat.size > s.maxFileMB * 1024 * 1024) {
        await post({ type: 'error', code: 'size', message: `This file is ${fmtSize(stat.size)}, above the limit of ${s.maxFileMB} MB (setting xmindViewer.maxFileMB).` });
        return;
      }
      let reader;
      try {
        if (uri.scheme === 'file') reader = await fileReader(uri.fsPath);
        else {
          if (stat.size > MAX_NON_FILE_MB * 1024 * 1024) { await post({ type: 'error', code: 'remote', message: `Files that are not on a local disk are read into memory, up to ${MAX_NON_FILE_MB} MB. This one is ${fmtSize(stat.size)}.` }); return; }
          reader = bufferReader(Buffer.from(await vscode.workspace.fs.readFile(uri)));
        }
        if (map) map.close();
        map = await openMap(reader, name);
        if (disposed) { map.close(); return; }
        await post({ type: 'model', model: flatten(map.model), readMs: Date.now() - t0 });
      } catch (e) {
        if (reader && !map) reader.close().catch(() => {});
        const code = e instanceof LoadError ? e.code : 'error';
        await post({ type: 'error', code, message: e && e.message ? e.message : String(e) });
        onFail();
      }
    };

    // Read the map again when XMind saves it.
    let reloadTimer = null;
    let watcher = null;
    if (uri.scheme === 'file') {
      try {
        watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
        const changed = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (!disposed) load(); }, 700); };
        watcher.onDidChange(changed);
        watcher.onDidCreate(changed);
      } catch { watcher = null; }
    }

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        switch (msg.type) {
          case 'ready': await load(); return;
          case 'rendered': if (!counted && !failed) { counted = true; rating.success(); } return;
          case 'failed': onFail(); return;
          case 'image': {
            if (!map) return;
            try {
              const img = await map.image(msg.src);
              await post({ type: 'image', src: msg.src, url: `data:${img.mime};base64,${img.data.toString('base64')}` });
            } catch (e) {
              await post({ type: 'image', src: msg.src, error: e && e.message ? e.message : String(e) });
            }
            return;
          }
          case 'openLink': {
            const act = linkAction(msg.href);
            if (act.kind === 'refuse') { await post({ type: 'notice', message: act.reason }); return; }
            const shown = act.target.length > 200 ? act.target.slice(0, 200) + '…' : act.target;
            post({ type: 'linkAsked', href: act.target });
            const pick = await vscode.window.showWarningMessage('Open this link from the mind map?', { modal: true, detail: shown }, 'Open');
            post({ type: 'linkAnswer', open: pick === 'Open' });
            if (pick !== 'Open') return;
            if (act.kind === 'external') await vscode.env.openExternal(vscode.Uri.parse(act.target, true));
            else {
              const base = uri.with({ path: path.posix.dirname(uri.path) });
              const target = act.kind === 'file' ? vscode.Uri.file(act.target) : vscode.Uri.joinPath(base, act.target);
              try { await vscode.workspace.fs.stat(target); } catch { await post({ type: 'notice', message: `The linked file was not found: ${act.target}` }); return; }
              await vscode.commands.executeCommand('vscode.open', target);
            }
            return;
          }
          case 'copy': await vscode.env.clipboard.writeText(msg.text); await post({ type: 'notice', message: msg.what ? `Copied ${msg.what}.` : 'Copied.' }); return;
          case 'save': {
            const base = name.replace(/\.[^.]+$/, '');
            const ext = msg.kind;
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(uri.with({ path: path.posix.dirname(uri.path) }), `${base}${msg.suffix || ''}.${ext}`),
              filters: { [ext.toUpperCase()]: [ext] }, saveLabel: `Export ${ext.toUpperCase()}`,
            });
            if (!target) return;
            if (target.toString() === uri.toString() || !target.path.toLowerCase().endsWith('.' + ext)) {
              await post({ type: 'notice', message: `Choose a file name that ends in .${ext}. The mind map file is never changed.` });
              return;
            }
            const bytes = msg.base64 !== undefined ? Buffer.from(msg.base64, 'base64') : Buffer.from(msg.text, 'utf8');
            await vscode.workspace.fs.writeFile(target, bytes);
            await post({ type: 'notice', message: `Saved ${path.posix.basename(target.path)} (${fmtSize(bytes.length)}).`, saved: target.fsPath || target.path });
            return;
          }
          case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'xmindViewer'); return;
        }
      } catch (e) {
        await post({ type: 'notice', message: e && e.message ? e.message : String(e) });
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      clearTimeout(reloadTimer);
      if (watcher) watcher.dispose();
      if (map) map.close();
    });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'xmindViewer', name: 'XMind Viewer' });
  registerSupport({ vscode, context, prefix: 'xmindViewer', selfId: EXT_ID });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new MindMapEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('xmindViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#xmindViewer.start`, false)),
    vscode.commands.registerCommand('xmindViewer.openWith', async uri => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, MindMapEditorProvider, VIEW_TYPE, EXT_ID };
