import { build, context } from 'esbuild';
import { readFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile('manifest.json', 'utf8'));
const options = {
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', platform: 'browser', target: 'es2022', outfile: 'main.js',
  sourcemap: false, minify: false, logLevel: 'info',
  banner: { js: `/* AI 问答日记 ${version} — generated from TypeScript */` }
};
if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
