'use strict';
// Loads extension.js and the settings-panel HTML outside VS Code (with a stub
// `vscode` module) and checks that the webview script is valid JavaScript.
// Run: node test/panel.test.js
const Module = require('module');
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Minimal stub: these tests only load modules, they never call the VS Code API.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'vscode') return 'vscode-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: {} };

const extension = require('../extension.js');
assert.strictEqual(typeof extension.activate, 'function');
assert.strictEqual(typeof extension.deactivate, 'function');
console.log('ok - extension.js loads and exports activate/deactivate');

// html() is internal to panel.js; evaluate the module source with it exported.
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'panel.js'), 'utf8');
const mod = { exports: {} };
const localRequire = (p) => require(p.startsWith('./') ? path.join(__dirname, '..', 'lib', p.slice(2)) : p);
new Function('module', 'exports', 'require', `${source};module.exports.html=html;`)(mod, mod.exports, localRequire);
const page = mod.exports.html('NONCE', 'csp');
const script = page.split('<script nonce="NONCE">')[1].split('</script>')[0];
new vm.Script(script); // throws on a syntax error
console.log('ok - panel webview script parses');

for (const id of ['setup', 'trust', 'refresh', 'reload', 'remove', 'hookTable', 'device', 'saveDevice', 'enc', 'saveEnc', 'testWindows', 'testBark', 'recent']) {
  assert(page.includes(`id="${id}"`), `missing #${id}`);
}
assert(page.includes("default-src 'none'"), 'CSP missing');
console.log('ok - panel has all controls and a strict CSP');
console.log('\n3 passed');
