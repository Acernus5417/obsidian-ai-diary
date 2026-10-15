import { describe, it, expect } from 'vitest';
import { fixture, note, MemoryVault } from '../fixtures/helpers';
import { bodyOf, BODY_START, BODY_END } from '../../src/application/archive';
import { dayPath } from '../../src/domain/util';
import { retrieve, evidenceStillValid } from '../../src/memory/retrieval';
import { session } from '../../src/storage/projections';
import { EventStore } from '../../src/storage/store';

describe('journal lifecycle and edit authority', () => {
  it('saves an answer before failed network and restores it without resending', async () => {
    const f = fixture(); f.model.fail = 'conversation'; await f.app.send('吃了面包。');
    const b = fixture('b', f.vault); await b.app.refresh(); expect(b.app.state.messages.filter(m => m.role === 'user')).toHaveLength(1); expect(b.app.error).toBe('');
  });
  it('unsent input is restored but never treated as fact', async () => { const f = fixture(); await f.app.input('未发送的秘密'); await f.app.generate(); expect(f.model.calls).toHaveLength(0); const b = fixture('b', f.vault); await b.app.refresh(); expect(b.app.state.input).toBe('未发送的秘密'); });
  it('one durable message clears the consumed input without a second write', async () => {
    const f = fixture(); await f.app.input('一条草稿'); f.model.fail = 'conversation';
    await f.app.send('一条草稿'); const b = fixture('b', f.vault); await b.app.refresh(); expect(b.app.state.input).toBe(''); expect(b.app.state.messages.filter(m => m.role === 'user')).toHaveLength(1);
  });
  it('keeps edited preview plus new answers and excludes older deleted answers', async () => {
    const f = fixture(); await note(f, '和同事争执了。'); await f.app.editDraft('今天平静地回家。', '');
    await f.app.send('路上买了面包。'); await f.app.generate();
    const call = f.model.calls.filter(c => c.task === 'write-natural').at(-1)!;
    expect(JSON.stringify(call.input)).not.toContain('争执'); expect(f.app.state.draft?.body).toContain('平静'); expect(f.app.state.draft?.body).toContain('面包');
  });
  it('uses current formal body after manual deletion, preserving metadata', async () => {
    const f = fixture(); await note(f, '我买了面包。\n\n我和同事争执。'); await f.app.save();
    const path = dayPath(f.s.diaryFolder, f.app.date);
    f.vault.files.set(path, f.vault.files.get(path)!.replace('我和同事争执。', '').replace('类型:', '额外字段: 保留\n类型:'));
    await f.app.send('晚上看书。'); await f.app.generate('reintegrate');
    expect(f.app.state.draft?.body).not.toContain('争执'); await f.app.save(); expect(f.vault.files.get(path)).toContain('额外字段: 保留');
  });
  it('append is idempotent and retains original body byte for byte', async () => {
    const f = fixture(); await note(f); await f.app.save(); const path = f.app.state.draft!.diaryPath;
    const old = bodyOf(f.vault.files.get(path)!); await f.app.send('又喝了一杯茶。'); await f.app.generate('append');
    await Promise.all([f.app.save(), f.app.save()]); await f.app.save();
    const body = bodyOf(f.vault.files.get(path)!); expect(body.startsWith(old)).toBe(true); expect(body.split('又喝了一杯茶。')).toHaveLength(2);
  });
  it('detects concurrent formal edits and keeps both', async () => {
    const f = fixture(); await note(f); await f.app.save(); await f.app.send('晚上看书。'); await f.app.generate('reintegrate');
    const path = f.app.state.draft!.diaryPath; const current = f.vault.files.get(path)! + '\n人工新加内容'; f.vault.files.set(path, current);
    await f.app.save(); expect(f.vault.files.get(path)).toBe(current); expect(f.app.error).toContain('变化'); expect(f.app.state.draft?.body).toContain('看书');
  });
  it('refuses to reinterpret deleted region markers', async () => {
    const f = fixture(); await note(f); await f.app.save(); const path = f.app.state.draft!.diaryPath;
    const current = f.vault.files.get(path)!.replace(BODY_START, '').replace(BODY_END, ''); f.vault.files.set(path, current);
    await f.app.send('看书。'); await f.app.generate('reintegrate'); await f.app.save(); expect(f.vault.files.get(path)).toBe(current);
  });
  it('preserves body if observations fail', async () => { const f = fixture(); f.model.fail = 'observations'; await note(f); expect(f.app.state.draft?.body).toContain('面包'); expect(f.app.state.draft?.observationError).toBeTruthy(); });
  it('carries the answering question into facts and full writing and restores the fact document', async () => {
    const f = fixture(); f.model.reply = '那次开会让你烦吗？'; await f.app.send('早上开了个会。'); await f.app.send('有一点。'); await f.app.generate();
    const facts = f.model.calls.find(c => c.task === 'facts')!, writing = f.model.calls.find(c => c.task === 'write-natural')!;
    expect(facts.input.exchanges.find((e: any) => e.answer === '有一点。').questionContext).toBe('那次开会让你烦吗？');
    expect(writing.input.factDocument.facts.length).toBe(2);
    const b = fixture('device-b', f.vault); await b.app.refresh(); expect(b.app.state.draft?.factDocument).toEqual(f.app.state.draft?.factDocument);
  });
  it('does not reintroduce deleted answers through old questions after editing', async () => {
    const f = fixture(); f.model.reply = 'DELETED_DETAIL那件事呢？'; await note(f, 'DELETED_DETAIL旧事。');
    await f.app.editDraft('今天平静地整理材料。', ''); f.model.reply = '后来呢？'; await f.app.send('路上买了面包。');
    const reply = f.model.calls.filter(c => c.task === 'conversation').at(-1)!;
    expect(reply.input.currentDiary).toBe('今天平静地整理材料。'); expect(JSON.stringify(reply.input)).not.toContain('DELETED_DETAIL');
    await f.app.generate();
    expect(JSON.stringify(f.model.calls.filter(c => c.task === 'facts').at(-1)!.input)).not.toContain('DELETED_DETAIL');
    expect(JSON.stringify(f.model.calls.filter(c => c.task === 'write-natural').at(-1)!.input)).not.toContain('DELETED_DETAIL');
    expect(f.app.state.messages.some(m => m.text.includes('DELETED_DETAIL'))).toBe(true);
  });
  it('does not start writing when historical question context changes during fact extraction', async () => {
    const f = fixture(); f.s.historyEnabled = true; f.s.allowedPaths = ['日记'];
    const path = '日记/2026/10/2026-10-01.md'; f.vault.files.set(path, '面包店 HISTORICAL_DETAIL。');
    f.model.reply = '上次HISTORICAL_DETAIL，这次呢？'; await f.app.send('今天在面包店。');
    const run = f.model.run.bind(f.model); f.model.run = async (task, input) => { const out = await run(task, input); if (task === 'facts') f.vault.files.set(path, '人工已经删除历史材料。'); return out; };
    await f.app.generate(); expect(f.model.calls.some(c => c.task === 'facts')).toBe(true);
    expect(f.model.calls.some(c => c.task === 'write-natural')).toBe(false); expect(f.app.state.draft).toBeUndefined();
    expect(f.app.error).toContain('依据'); expect(f.app.state.messages.filter(m => m.role === 'user')).toHaveLength(1);
  });
  it('does not mix other dates into a session', async () => { const f = fixture(); await f.app.send('昨天'); await f.app.open('2026-10-13'); expect(f.app.state.messages).toHaveLength(0); await f.app.open('2026-10-12'); expect(f.app.state.messages[0]?.text).toBe('昨天'); });
  it('includes newly arrived remote messages in readable transcript without consuming them into an older draft', async () => {
    const f = fixture(); await note(f); const b = fixture('b', f.vault); await b.app.send('手机刚来的记录');
    await f.app.save(); expect(f.vault.files.get(f.app.state.draft!.transcriptPath)).toContain('手机刚来的记录');
    const remote = f.app.state.messages.find(m => m.text === '手机刚来的记录')!;
    expect(f.app.state.consumedIds).not.toContain(remote.id);
  });
});
describe('archive crash recovery', () => {
  it.each(['diary', 'transcript', 'completion'])('recovers failure at %s without double append', async stage => {
    const f = fixture(); await note(f);
    let thrown = false;
    f.vault.fail = (path, text) => {
      const match = stage === 'diary' ? path.startsWith('日记/') : stage === 'transcript' ? /原始问答\/2026/.test(path) : text.includes('archive-completed');
      if (match && !thrown) { thrown = true; return true; } return false;
    };
    await f.app.save(); expect(thrown).toBe(true);
    f.vault.fail = undefined;
    const b = fixture('b', f.vault); await b.app.refresh(); await b.app.recover();
    expect(b.app.state.pending).toHaveLength(0); expect(b.vault.files.get('日记/2026/10/2026-10-12.md')).toContain('面包');
    expect(b.vault.files.get('原始问答/2026/10/2026-10-12.md')).toContain('[[日记/2026/10/2026-10-12]]');
  });
  it('backs up manually edited readable transcript before updating', async () => {
    const f = fixture(); await note(f); await f.app.save(); const path = f.app.state.draft!.transcriptPath;
    f.vault.files.set(path, '人工改过的问答汇总'); await f.app.send('补一条'); await f.app.generate('append'); await f.app.save();
    expect([...f.vault.files.values()]).toContain('人工改过的问答汇总');
  });
  it.each(['prepare', 'backup'])('keeps existing journal intact at %s failure, then recovers', async stage => {
    const f = fixture(); await note(f); await f.app.save(); const path = f.app.state.draft!.diaryPath;
    const old = f.vault.files.get(path); await f.app.send('新增一小段'); await f.app.generate('append');
    let injected = false;
    f.vault.fail = (p, text) => {
      const match = stage === 'prepare' ? text.includes(f.app.state.draft!.id) && text.includes('archive-prepared') : p.includes('/_版本/');
      if (match && !injected) { injected = true; return true; } return false;
    };
    await f.app.save(); expect(injected).toBe(true); expect(f.vault.files.get(path)).toBe(old);
    f.vault.fail = undefined; if (stage === 'prepare') await f.app.save(); else await f.app.recover();
    expect(f.vault.files.get(path)).toContain('新增一小段');
  });
});
describe('sync simulation, permissions and stale responses', () => {
  it('resumes on another device and preserves concurrent draft branches', async () => {
    const f = fixture(); await f.app.send('一天的开头'); const vaultB = new MemoryVault(); f.vault.copyTo(vaultB);
    const b = fixture('b', vaultB); await b.app.refresh(); await b.app.send('手机补的'); await b.app.generate();
    await f.app.send('电脑补的'); await f.app.generate(); b.vault.copyTo(f.vault); await f.app.refresh();
    expect(f.app.state.drafts).toHaveLength(2); expect(f.app.state.messages.filter(m => m.role === 'user')).toHaveLength(3);
  });
  it('corrupt or future schema files are retained and stop writes', async () => {
    const f = fixture(); await f.app.send('已有素材'); const path = f.vault.list().find(p => p.includes('_数据'))!;
    const broken = f.vault.files.get(path)! + '\n<!-- ai-diary-event:partial'; f.vault.files.set(path, broken);
    await expect(f.app.input('不能覆盖')).rejects.toThrow(); expect(f.vault.files.get(path)).toBe(broken);
  });
  it('reads only allowed files and strips observations, backups and current date', async () => {
    const f = fixture(); Object.assign(f.s, { historyEnabled: true, allowedPaths: ['日记', '项目'] });
    f.vault.files.set('日记/2026-10-01.md', '工作修改\n\n## AI 观察\n模型推测'); f.vault.files.set('私人/秘密.md', '秘密'); f.vault.files.set('原始问答/_版本/a.md', '备份');
    f.vault.files.set('项目/论文.md', '论文修改');
    const ev = await retrieve(f.vault, f.s, '修改', f.app.date, []);
    expect(ev).toHaveLength(2); expect(JSON.stringify(ev)).not.toContain('模型推测'); expect(f.vault.reads).not.toContain('私人/秘密.md');
    f.s.allowedPaths = []; expect(await evidenceStillValid(f.vault, f.s, ev)).toBe(false);
  });
  it('does not apply a late response after cancellation', async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.model.run = () => new Promise(r => { resolve = r; });
    const running = f.app.reply(); await new Promise(r => setTimeout(r, 10)); f.app.cancel();
    resolve({ action: 'ask', text: '', question: '迟到的问题？', topicId: 'daily', thread: null }); await running;
    expect(f.app.state.messages).toHaveLength(0);
  });
  it('waits for the matching archive watermark if formal Markdown arrives first', async () => {
    const f = fixture(); await note(f); await f.app.save();
    const early = new MemoryVault(); const path = f.app.state.draft!.diaryPath;
    early.files.set(path, f.vault.files.get(path)!); const b = fixture('b', early);
    await b.app.send('手机新增'); await b.app.generate('reintegrate'); expect(b.app.state.draft).toBeUndefined(); expect(b.app.error).toContain('同步完整');
  });
  it('does not claim local saved state after a failed storage append', async () => {
    const f = fixture(); f.vault.fail = () => true;
    await expect(f.app.input('不能假装保存')).rejects.toThrow(); expect(f.app.state.input).toBe('');
  });
});
