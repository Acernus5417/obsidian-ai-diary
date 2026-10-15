import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
const code = await readFile('dist/ai-diary/main.js', 'utf8');
const runtimeImports = [...code.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]);
assert(runtimeImports.every(n => n === 'obsidian'), 'unexpected runtime module');
const local = new Map(), references = new Set(), factories = new Map();
const app = {
  loadLocalStorage: k => local.get(k), saveLocalStorage: (k, v) => local.set(k, v),
  vault: { getMarkdownFiles: () => [], on: (name, callback) => { const ref = { name, callback }; references.add(ref); return ref; } },
  workspace: { getLeavesOfType: () => [] }
};
class Plugin {
  commands = [];
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  async loadData() { return undefined; }
  async saveData(value) { this.data = structuredClone(value); }
  registerView(type, factory) { factories.set(type, factory); }
  addSettingTab() {} addRibbonIcon() {} registerEvent() {}
  addCommand(c) { this.commands.push(c); }
}
const stub = { Plugin, ItemView: class {}, PluginSettingTab: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, Setting: class {}, requestUrl() { throw new Error('network forbidden in bundle smoke test'); } };
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, require: name => { assert.equal(name, 'obsidian'); return stub; }, crypto: webcrypto, URL, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval }, { timeout: 3000 });
const manifest = JSON.parse(await readFile('dist/ai-diary/manifest.json', 'utf8'));
const PluginClass = module.exports.default; assert.equal(typeof PluginClass, 'function');
const plugin = new PluginClass(app, manifest); await plugin.onload();
assert.equal(factories.size, 1); assert.equal(plugin.commands.length, 2); assert.equal(references.size, 4);
assert.equal('apiKey' in plugin.data, false); plugin.onunload();
console.log('PASS: Packaged CommonJS bundle loads in a clean simulated host, registers one view and two commands; only obsidian external. Not real Obsidian.');
