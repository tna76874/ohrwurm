// Unit-Tests ohne zusätzliche Abhängigkeit: esbuild (kommt mit Vite) bündelt
// alle src/**/*.test.ts, ausgeführt werden sie mit dem eingebauten node:test.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

function find(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? find(p) : p.endsWith('.test.ts') ? [p] : [];
  });
}

const entries = find('src');
if (!entries.length) {
  console.log('Keine Tests gefunden.');
  process.exit(0);
}
const out = mkdtempSync(join(tmpdir(), 'ohrwurm-test-'));
await build({ entryPoints: entries, bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: out, outbase: 'src', outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
const files = entries.map((e) => join(out, relative('src', e)).replace(/\.ts$/, '.mjs'));
const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
process.exit(res.status ?? 1);
