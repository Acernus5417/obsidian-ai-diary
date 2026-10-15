import { ItemView, WorkspaceLeaf } from 'obsidian';
import type AIDiaryPlugin from '../main';
import { DiaryScreen } from './screen';
export const VIEW_TYPE = 'ai-diary-conversation';
export class DiaryView extends ItemView {
  private screen?: DiaryScreen;
  constructor(leaf: WorkspaceLeaf, private plugin: AIDiaryPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'AI 问答日记'; }
  getIcon(): string { return 'book-heart'; }
  async onOpen(): Promise<void> {
    await this.plugin.diary.refresh();
    this.screen = new DiaryScreen(this.contentEl, this.plugin.diary, {
      settings: () => this.plugin.openSettings(),
      openFile: path => { void this.app.workspace.openLinkText(path, '', true); }
    });
    this.registerDomEvent(document, 'visibilitychange', () => { if (document.hidden) void this.screen?.persist(); });
  }
  async onClose(): Promise<void> { await this.screen?.dispose(); this.screen = undefined; }
}
