import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type AIDiaryPlugin from '../main';
import { errorText } from '../domain/types';
import { id } from '../domain/util';
import { SettingsEditor } from './settings-editor';

export class DiarySettingsTab extends PluginSettingTab {
  private editor?: SettingsEditor;
  constructor(app: App, private plugin: AIDiaryPlugin) { super(app, plugin); }
  display(): void {
    const el = this.containerEl; el.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'AI 问答日记'; el.append(heading);
    const intro = document.createElement('p'); intro.textContent = '使用一组服务地址、模型和 API Key 完成问答、日记、观察和周月回顾。获准参考的相关记录会发送到你配置的服务。'; el.append(intro);
    if (!this.editor?.hasPendingEdits) { this.editor?.cancelTimer(); this.editor = new SettingsEditor(this.plugin); }
    const editor = this.editor, draft = editor.draft;
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = editor.modelDirty ? '地址和模型尚未保存。' : '地址和模型自动保存，其他设置请点击下方“保存设置”。'; el.append(status);
    const conflict = document.createElement('div'); el.append(conflict);
    editor.onStatus = text => {
      status.textContent = text; conflict.replaceChildren();
      if (editor.stale) {
        const reload = document.createElement('button'); reload.textContent = '载入最新设置（替换本页填写）';
        reload.addEventListener('click', () => { editor.cancelTimer(); this.editor = undefined; this.display(); });
        conflict.append(reload);
      }
    };
    const field = (name: string, desc: string, key: 'baseUrl' | 'modelId' | 'diaryFolder' | 'transcriptFolder' | 'weeklyFolder' | 'monthlyFolder') => new Setting(el).setName(name).setDesc(desc).addText(t => t.setValue(draft[key]).onChange(v => {
      if (key === 'baseUrl' || key === 'modelId') editor.changeModel(key, v);
      else draft[key] = v.trim();
    }));
    field('服务地址', 'Chat Completions API 根地址，例如 https://服务地址/v1；保留代理前缀。', 'baseUrl');
    field('模型名称', '填写服务提供的完整模型 ID。首版仅支持文本 Chat Completions 兼容接口。', 'modelId');
    let key = '';
    const credential = new Setting(el).setName('本设备 API Key').setDesc(this.plugin.secrets.get(draft.credentialRef) ? '已配置。留空表示保持现有凭据；不会显示保存的密钥。' : '尚未配置。每台设备单独填写，密钥不进入普通设置和笔记。');
    credential.addText(t => {
      t.inputEl.type = 'password'; t.inputEl.autocomplete = 'new-password'; t.inputEl.spellcheck = false;
      t.setPlaceholder('填写或替换密钥').onChange(v => { key = v; });
      credential.addButton(b => b.setButtonText('保存凭据').onClick(() => {
        if (!key.trim()) { new Notice('请先填写 API Key。'); return; }
        try { this.plugin.secrets.set(draft.credentialRef, key.trim()); this.plugin.diary.configurationChanged(); key = ''; t.setValue(''); new Notice('凭据已保存到本设备。'); }
        catch (e) { new Notice(errorText(e)); }
      }));
    });
    new Setting(el).setName('测试连接').setDesc('先保存当前填写的地址和模型，再用已保存的本设备凭据发送一句测试文本。').addButton(b => b.setButtonText('测试连接').onClick(async () => {
      b.setDisabled(true);
      try { await editor.flushModel(); await this.plugin.gateway.test(); new Notice('连接成功：此地址、模型和凭据可以完成文本请求。'); }
      catch (e) { new Notice(errorText(e)); } finally { b.setDisabled(false); }
    }));
    new Setting(el).setName('正文风格').addDropdown(d => d.addOption('natural', '自然随笔 · 保留口语').addOption('narrative', '连贯叙事 · 整理脉络').setValue(draft.style).onChange(v => { draft.style = v === 'narrative' ? v : 'natural'; }));
    const sub = document.createElement('h3'); sub.textContent = '回顾入口'; el.append(sub);
    const topicsEl = document.createElement('div'); el.append(topicsEl);
    const renderTopics = () => {
      topicsEl.replaceChildren();
      draft.topics.forEach((t, i) => new Setting(topicsEl).addText(v => v.setValue(t.name).onChange(name => { t.name = name; })).addToggle(v => v.setValue(t.enabled).onChange(v => { t.enabled = v; }))
        .addButton(b => b.setButtonText('上移').setDisabled(i === 0).onClick(() => { [draft.topics[i - 1], draft.topics[i]] = [draft.topics[i]!, draft.topics[i - 1]!]; renderTopics(); }))
        .addButton(b => b.setButtonText('删除').onClick(() => { draft.topics.splice(i, 1); renderTopics(); })));
    }; renderTopics();
    new Setting(el).addButton(b => b.setButtonText('新增入口').onClick(() => { draft.topics.push({ id: id(), name: '新的方面', enabled: true }); renderTopics(); }));
    field('日记目录', '正式日记按 年/月/日期.md 保存。已有记录后修改目录需先手动迁移，首版不自动移动文件。', 'diaryFolder');
    field('原始问答目录', '保存可读问答、接续数据和恢复副本。请用与日记分开的普通目录。', 'transcriptFolder');
    new Setting(el).setName('自动生成周记和月记').setDesc('开启后，按自然周和月份回顾已结束周期，使用获准参考的日记正文并发送到所选服务。已有周月笔记不会被自动覆盖；补齐后可再次检查。').addToggle(t => t.setValue(draft.periodicEnabled).onChange(v => { draft.periodicEnabled = v; }));
    field('周记目录', '每个自然周一篇，默认保存在 周记/年份/开始日期_结束日期.md。', 'weeklyFolder');
    field('月记目录', '每个自然月一篇，默认保存在 月记/年份/年-月.md。', 'monthlyFolder');
    new Setting(el).setName('允许参考历史资料').setDesc('只有下面指定的 Markdown 文件或文件夹会被读取；相关片段可能发送到所配置服务。').addToggle(t => t.setValue(draft.historyEnabled).onChange(v => { draft.historyEnabled = v; }));
    new Setting(el).setName('允许的文件 / 文件夹').setDesc('每行一个仓库内路径，例如 日记 或 项目/创作.md。留空不读取历史；原始问答和备份不参与检索。').addTextArea(t => {
      t.inputEl.rows = 5; t.setValue(draft.allowedPaths.join('\n')).onChange(v => { draft.allowedPaths = v.split(/\r?\n/).map(v => v.trim()).filter(Boolean); });
    });
    new Setting(el).setName('保存普通设置').setDesc('保存后后续请求立即使用新配置；修改写作风格不会重写已保存日记。').addButton(b => b.setButtonText('保存设置').setCta().onClick(async () => {
      try { await editor.saveAll(); new Notice('设置已保存。'); }
      catch (e) { new Notice(errorText(e)); }
    }));
  }
  hide(): void {
    if (this.editor?.modelDirty) void this.editor.flushModel().catch(e => new Notice(errorText(e)));
    else this.editor?.cancelTimer();
    super.hide();
  }
}
