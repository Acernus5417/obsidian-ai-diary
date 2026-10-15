// Deliberately small simulated host. This is not an Obsidian runtime.
export class Notice { static messages: string[] = []; constructor(text: string) { Notice.messages.push(text); } }
export class TFile { stat = { mtime: Date.now(), size: 0 }; constructor(public path: string) {} get basename() { return this.path.split('/').at(-1)!.replace(/\.md$/, ''); } }
export class TFolder { constructor(public path: string) {} }
export class ItemView {
  contentEl = document.createElement('div');
  private disposers: (() => void)[] = [];
  app: any;
  constructor(public leaf: any) { this.app = leaf.app; document.body.append(this.contentEl); }
  registerDomEvent(target: EventTarget, type: string, cb: EventListener) { target.addEventListener(type, cb); this.disposers.push(() => target.removeEventListener(type, cb)); }
  async onClose() {}
  async unload() { await this.onClose(); this.disposers.forEach(f => f()); this.contentEl.remove(); }
}
export class PluginSettingTab { containerEl = document.createElement('div'); constructor(public app: any, public plugin: any) {} hide() {} }
export class Setting {
  settingEl: HTMLDivElement; nameEl: HTMLDivElement; descEl: HTMLDivElement; controlEl: HTMLDivElement;
  constructor(parent: HTMLElement) {
    this.settingEl = document.createElement('div'); this.settingEl.className = 'setting-item';
    this.nameEl = document.createElement('div'); this.nameEl.className = 'setting-item-name';
    this.descEl = document.createElement('div'); this.controlEl = document.createElement('div');
    this.settingEl.append(this.nameEl, this.descEl, this.controlEl); parent.append(this.settingEl);
  }
  setName(name: string) { this.nameEl.textContent = name; return this; }
  setDesc(desc: string) { this.descEl.textContent = desc; return this; }
  addText(cb: (component: any) => void) { return this.text('input', cb); }
  addTextArea(cb: (component: any) => void) { return this.text('textarea', cb); }
  private text(tag: 'input' | 'textarea', cb: (component: any) => void) {
    const inputEl = document.createElement(tag); this.controlEl.append(inputEl);
    const component = { inputEl,
      setValue(v: string) { inputEl.value = v; return component; },
      setPlaceholder(v: string) { inputEl.placeholder = v; return component; },
      onChange(fn: (v: string) => void) { inputEl.addEventListener('input', () => fn(inputEl.value)); return component; }
    }; cb(component); return this;
  }
  addButton(cb: (component: any) => void) {
    const buttonEl = document.createElement('button'); this.controlEl.append(buttonEl);
    const component = { buttonEl,
      setButtonText(v: string) { buttonEl.textContent = v; return component; },
      setDisabled(v: boolean) { buttonEl.disabled = v; return component; },
      setCta() { return component; },
      onClick(fn: () => void) { buttonEl.addEventListener('click', fn); return component; }
    }; cb(component); return this;
  }
  addDropdown(cb: (component: any) => void) {
    const selectEl = document.createElement('select'); this.controlEl.append(selectEl);
    const component = {
      addOption(value: string, label: string) { const o = document.createElement('option'); o.value = value; o.textContent = label; selectEl.append(o); return component; },
      setValue(v: string) { selectEl.value = v; return component; },
      onChange(fn: (v: string) => void) { selectEl.addEventListener('change', () => fn(selectEl.value)); return component; }
    }; cb(component); return this;
  }
  addToggle(cb: (component: any) => void) {
    const inputEl = document.createElement('input'); inputEl.type = 'checkbox'; this.controlEl.append(inputEl);
    const component = {
      setValue(v: boolean) { inputEl.checked = v; return component; },
      onChange(fn: (v: boolean) => void) { inputEl.addEventListener('change', () => fn(inputEl.checked)); return component; }
    }; cb(component); return this;
  }
}
export function requestUrl() { throw new Error('No network in simulated host'); }
export class Plugin {
  data: any = null; commands: any[] = []; settingsTabs: any[] = []; refs: any[] = [];
  constructor(public app: any, public manifest: any) {}
  async loadData() { return this.data; }
  async saveData(data: any) { this.data = structuredClone(data); }
  registerView(type: string, factory: any) { this.app.workspace.factories.set(type, factory); }
  addSettingTab(tab: any) { this.settingsTabs.push(tab); }
  addRibbonIcon() { return document.createElement('div'); }
  addCommand(command: any) { this.commands.push(command); }
  registerEvent(ref: any) { this.refs.push(ref); }
  onunload() {}
  unload() { this.onunload(); for (const ref of this.refs) this.app.vault.refs.delete(ref); }
}
export function host() {
  const contents = new Map<string, string>(), folders = new Set<string>(), locals = new Map(), secrets = new Map();
  const refs = new Set<any>();
  const app: any = {
    loadLocalStorage: (k: string) => locals.get(k), saveLocalStorage: (k: string, v: unknown) => locals.set(k, v),
    secretStorage: { getSecret: (k: string) => secrets.get(k) ?? null, setSecret: (k: string, v: string) => secrets.set(k, v) },
    vault: {
      refs, getMarkdownFiles: () => [...contents.keys()].map(p => new TFile(p)),
      getAbstractFileByPath: (p: string) => contents.has(p) ? new TFile(p) : folders.has(p) ? new TFolder(p) : null,
      read: async (f: TFile) => contents.get(f.path),
      create: async (p: string, t: string) => { if (contents.has(p)) throw new Error('exists'); contents.set(p, t); return new TFile(p); },
      process: async (f: TFile, fn: (t: string) => string) => { contents.set(f.path, fn(contents.get(f.path)!)); },
      createFolder: async (p: string) => { folders.add(p); },
      on: (name: string, cb: any) => { const ref = { name, cb }; refs.add(ref); return ref; }
    },
    workspace: {
      factories: new Map(), leaves: [] as any[],
      getActiveFile: () => null,
      getLeavesOfType: (t: string) => app.workspace.leaves.filter((l: any) => l.type === t),
      getLeaf: () => {
        const leaf: any = { app, type: '', view: null,
          setViewState: async ({ type }: { type: string }) => { leaf.type = type; leaf.view = app.workspace.factories.get(type)(leaf); await leaf.view.onOpen(); },
          detach: () => { app.workspace.leaves = app.workspace.leaves.filter((l: any) => l !== leaf); void leaf.view?.unload(); }
        }; app.workspace.leaves.push(leaf); return leaf;
      },
      revealLeaf: async () => {}, openLinkText: async () => {}
    }
  };
  return { app, contents, secrets, refs };
}
