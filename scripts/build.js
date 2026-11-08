'use strict';
// Bundles the extension host and the webview with esbuild.
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
(async () => {
  await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
    esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
  ]);
  const kb = f => (fs.statSync(path.join(root, 'dist', f)).size / 1024).toFixed(0);
  console.log(`built: extension ${kb('extension.js')} KB, webview ${kb('webview.js')} KB`);
})().catch(e => { console.error(e); process.exit(1); });
