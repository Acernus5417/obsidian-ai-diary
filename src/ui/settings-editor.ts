import { DiaryError, errorText, type Settings } from '../domain/types';

interface SettingsPort {
  readonly settings: Settings;
  readonly settingsRevision: number;
  updateSettings(next: Settings, expectedRevision: number): Promise<void>;
}

/** Owns an editable form; model-only autosaves cannot commit unrelated fields. */
export class SettingsEditor {
  readonly draft: Settings;
  onStatus: (text: string) => void = () => {};
  private baseline: Settings;
  private version: number;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private pending = 0;
  constructor(private port: SettingsPort) {
    this.draft = structuredClone(port.settings);
    this.baseline = structuredClone(port.settings);
    this.version = port.settingsRevision;
  }
  get modelDirty(): boolean { return this.draft.baseUrl !== this.baseline.baseUrl || this.draft.modelId !== this.baseline.modelId; }
  get stale(): boolean { return this.port.settingsRevision !== this.version; }
  get hasPendingEdits(): boolean { return this.pending > 0 || JSON.stringify(this.draft) !== JSON.stringify(this.baseline); }
  changeModel(key: 'baseUrl' | 'modelId', value: string): void {
    this.draft[key] = value.trim(); this.onStatus('地址和模型正在保存…');
    this.cancelTimer();
    this.timer = setTimeout(() => { void this.flushModel().catch(() => {}); }, 350);
  }
  cancelTimer(): void { clearTimeout(this.timer); this.timer = undefined; }
  flushModel(): Promise<void> { return this.commit('model'); }
  saveAll(): Promise<void> { return this.commit('all'); }
  private commit(scope: 'model' | 'all'): Promise<void> {
    this.cancelTimer();
    const snapshot = structuredClone(this.draft); this.pending++;
    const work = this.queue.then(async () => {
      if (this.port.settingsRevision !== this.version)
        throw new DiaryError('conflict', '设置已由另一处改变，未覆盖。填写内容仍保留，请核对最新设置后再保存。');
      const next = scope === 'all' ? snapshot : { ...structuredClone(this.port.settings), baseUrl: snapshot.baseUrl, modelId: snapshot.modelId };
      if (JSON.stringify(next) !== JSON.stringify(this.port.settings)) await this.port.updateSettings(next, this.version);
      this.version = this.port.settingsRevision;
      this.baseline = scope === 'all' ? snapshot : { ...this.baseline, baseUrl: snapshot.baseUrl, modelId: snapshot.modelId };
      if (this.draft.baseUrl === snapshot.baseUrl && this.draft.modelId === snapshot.modelId)
        this.onStatus(scope === 'all' ? '设置已保存。' : '地址和模型已保存。');
    });
    this.queue = work.catch(() => {});
    return work.catch(e => { this.onStatus(`设置未保存：${errorText(e)}`); throw e; }).finally(() => { this.pending--; });
  }
}
