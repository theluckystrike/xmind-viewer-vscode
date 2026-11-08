'use strict';
// Builds the webview HTML. Kept free of the vscode module so tests can check the CSP.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {{cspSource:string, scriptUri:string, katexUri:string, katexCssUri:string, styleUri:string, title:string, nonce?:string, showSupportLinks?:boolean}} p
 */
function buildHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  const footer = footerHtml('xmindViewer', p.showSupportLinks !== false, 'zovo-support-fixed');
  // No network: nothing may load from outside the extension. Data comes only through postMessage.
  const csp = [
    "default-src 'none'", `style-src ${p.cspSource} 'unsafe-inline'`, `script-src 'nonce-${n}'`,
    `img-src ${p.cspSource} data: blob:`, `font-src ${p.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.katexCssUri)}">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
${footer ? `<style>${FOOTER_CSS}</style>` : ''}
<title>${escapeAttr(p.title)}</title>
</head>
<body>
<div id="app"><p class="loading">Opening the mind map...</p></div>
<div id="measure" class="eqbox measure" aria-hidden="true"></div>
${footer}
<script nonce="${n}" src="${escapeAttr(p.katexUri)}"></script>
<script nonce="${n}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, escapeAttr };
