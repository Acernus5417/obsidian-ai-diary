// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import AIDiaryPlugin from '../../src/main';
import { host } from '../fixtures/obsidian';
import manifest from '../../manifest.json';
it('loads in a clean simulated host, reuses one tab, unloads listeners, stores no key in settings', async () => {
  const h = host(); const p = new AIDiaryPlugin(h.app, manifest);
  await p.onload(); expect(h.refs.size).toBe(4);
  h.secrets.set(p.settings.credentialRef, 'HOST-SECRET-NOT-IN-CONFIG');
  expect(JSON.stringify(await p.loadData())).not.toContain('HOST-SECRET');
  await p.openDiary(); await p.openDiary(); expect(h.app.workspace.leaves).toHaveLength(1);
  expect(document.querySelectorAll('.ai-diary')).toHaveLength(1);
  expect(manifest.isDesktopOnly).toBe(false);
  p.unload(); await new Promise(r => setTimeout(r, 10));
  expect(h.refs.size).toBe(0); expect(h.app.workspace.leaves).toHaveLength(0);
});
