import { Notice, Plugin } from 'obsidian';
import { DiaryError, errorText, type Settings } from './domain/types';
import { loadSettings, validateSettings } from './domain/settings';
import { id, dateKey } from './domain/util';
import { ObsidianVault, ObsidianSecrets, obsidianHttp } from './adapters/obsidian';
import { Gateway } from './ai/gateway';
import { EventStore } from './storage/store';
import { DiaryApp } from './application/diary';
import { DiaryView, VIEW_TYPE } from './ui/view';
import { DiarySettingsTab } from './ui/settings';

export default class AIDiaryPlugin extends Plugin {
  settings!: Settings;
  settingsRevision = 0;
  secrets!: ObsidianSecrets;
  gateway!: Gateway;
  diary!: DiaryApp;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData()); validateSettings(this.settings);
    await this.saveData(this.settings);
    this.secrets = new ObsidianSecrets(this.app);
    this.gateway = new Gateway(() => this.settings, this.secrets, obsidianHttp);
    let device: unknown = this.app.loadLocalStorage('ai-diary-device');
    if (typeof device !== 'string' || !/^[\w-]+$/.test(device)) { device = id(); this.app.saveLocalStorage('ai-diary-device', device); }
    this.diary = new DiaryApp(new EventStore(new ObsidianVault(this.app), this.settings.transcriptFolder, device as string), this.gateway, () => this.settings);
    await this.diary.initialize();
    this.registerView(VIEW_TYPE, leaf => new DiaryView(leaf, this));
    this.addSettingTab(new DiarySettingsTab(this.app, this));
    this.addRibbonIcon('book-heart', '打开 AI 问答日记', () => { void this.openDiary(); });
    this.addCommand({ id: 'open-diary', name: '打开日记对话', callback: () => { void this.openDiary(); } });
    this.addCommand({ id: 'supplement-active-diary', name: '补记当前日期笔记', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile(), match = file?.basename.match(/^\d{4}-\d{2}-\d{2}$/);
      if (!match) return false;
      if (!checking) void this.openDiary(match[0]); return true;
    } });
    for (const event of ['create', 'modify', 'delete', 'rename'] as const) this.registerEvent(this.app.vault.on(event as 'modify', file => {
      if (!file.path.startsWith(`${this.settings.transcriptFolder}/_数据/`)) return;
      this.diary.store.invalidate(file.path);
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => { void this.diary.refresh().catch(e => new Notice(errorText(e))); }, 250);
    }));
    void this.diary.reviewPeriods(dateKey()).catch(e => new Notice(errorText(e)));
  }
  async openDiary(date?: string): Promise<void> {
    try {
      if (date) await this.diary.open(date);
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      const leaf = existing ?? this.app.workspace.getLeaf('tab');
      if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    } catch (e) { new Notice(errorText(e)); }
  }
  openSettings(): void {
    // Obsidian exposes no public method for opening a plugin settings tab.
    const app = this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } };
    if (app.setting) { app.setting.open(); app.setting.openTabById(this.manifest.id); }
    else new Notice('请打开 Obsidian 设置 → AI 问答日记。');
  }
  async updateSettings(next: Settings, expectedRevision: number): Promise<void> {
    next = structuredClone(next);
    if (this.diary.isSaving) throw new DiaryError('busy', '正在归档，请完成后再保存设置。');
    if (this.settingsRevision !== expectedRevision) throw new DiaryError('conflict', '设置已由另一设备改变，请重新打开设置页后编辑。当前输入未保存覆盖。');
    validateSettings(next);
    if (next.topics.some(t => !t.name.trim())) throw new DiaryError('settings', '入口名称不能为空。');
    const moved = next.diaryFolder !== this.settings.diaryFolder || next.transcriptFolder !== this.settings.transcriptFolder;
    if (moved && this.diary.store.events.length) throw new DiaryError('migration', '已有记录时需要先迁移目录。首版请保持目录，以免接续数据被遗忘。');
    this.diary.cancel();
    await this.saveData(next); this.settings = structuredClone(next); this.settingsRevision++;
    if (moved) {
      const previous = this.diary.store;
      const replacement = new EventStore(previous.vault, next.transcriptFolder, previous.deviceId);
      // Existing screens keep the same application instance; redirect its store in place.
      Object.assign(previous, { root: replacement.root, writerId: replacement.writerId });
      await this.diary.refresh();
    }
    this.diary.configurationChanged();
  }
  async onExternalSettingsChange(): Promise<void> {
    try {
      const next = loadSettings(await this.loadData()); validateSettings(next);
      if (next.transcriptFolder !== this.settings.transcriptFolder || next.diaryFolder !== this.settings.diaryFolder) {
        new Notice('另一设备改变了归档目录。请重载插件核对迁移，当前记录已保留。'); this.diary.cancel(); return;
      }
      this.settings = next; this.settingsRevision++; this.diary.configurationChanged();
    } catch (e) { new Notice(errorText(e)); }
  }
  onunload(): void {
    clearTimeout(this.reloadTimer); this.diary?.shutdown();
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => leaf.detach());
  }
}
