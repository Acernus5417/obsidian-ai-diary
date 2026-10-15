import { it, expect, describe } from 'vitest';
import { Gateway, type HttpPort } from '../../src/ai/gateway';
import { loadSettings } from '../../src/domain/settings';
const config = () => loadSettings({ baseUrl: 'https://example.invalid/prefix/v1', modelId: 'one-model' });
const ok = (text: string) => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: text } }] }) });
describe('text Chat Completions gateway', () => {
  it('uses one model, protocol, key and correct proxy path', async () => {
    let request: Parameters<HttpPort>[0] | undefined;
    const g = new Gateway(config, { get: () => 'test-secret-marker' }, async r => { request = r; return ok('{"understanding":"可能","patterns":[]}'); });
    await g.run('observations', { text: '我的一天' });
    expect(request!.url).toBe('https://example.invalid/prefix/v1/chat/completions');
    expect(request!.headers.Authorization).toBe('Bearer test-secret-marker');
    expect(JSON.parse(request!.body)).toMatchObject({ model: 'one-model', stream: false });
    expect(request!.body).not.toContain('test-secret-marker');
  });
  it.each([[401, '鉴权'], [429, '限流'], [500, 'HTTP 500'], [413, '上下文']])('handles HTTP %s without exposing sensitive body', async (status, message) => {
    const g = new Gateway(config, { get: () => 'not-for-display' }, async () => ({ status: status as number, text: 'PRIVATE SECRET DIARY' }));
    await expect(g.test()).rejects.toThrow(message as string);
  });
  it('repairs malformed writing JSON once, never loops', async () => {
    let calls = 0;
    const g = new Gateway(config, { get: () => 'k' }, async () => { calls++; return ok('invalid-json'); });
    await expect(g.run('write-natural', {})).rejects.toThrow('格式'); expect(calls).toBe(2);
  });
  it('accepts natural conversation text without JSON repair', async () => {
    let calls = 0; const g = new Gateway(config, { get: () => 'k' }, async () => { calls++; return ok('今天早上做了什么？'); });
    await expect(g.run('conversation', {})).resolves.toBe('今天早上做了什么？'); expect(calls).toBe(1);
  });
  it('times out without applying late response', async () => {
    const g = new Gateway(config, { get: () => 'k' }, async () => { await new Promise(r => setTimeout(r, 50)); return ok('{}'); }, 5);
    await expect(g.run('conversation', {})).rejects.toThrow('超时');
  });
  it('reports missing credentials before making an HTTP call', async () => {
    let called = false; const g = new Gateway(config, { get: () => null }, async () => { called = true; return ok('{}'); });
    await expect(g.test()).rejects.toThrow('API Key'); expect(called).toBe(false);
  });
  it('ignores response when configuration authorization is revoked', async () => {
    let valid = true;
    const g = new Gateway(config, { get: () => 'k' }, async () => { valid = false; return ok('{}'); });
    await expect(g.run('conversation', {}, () => valid)).rejects.toThrow('停止等待');
  });
});
