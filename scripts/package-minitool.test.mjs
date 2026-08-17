import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('packages the minitool build on the current platform', () => {
  const vite = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(root, 'vite.minitool.config.ts')],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(vite.status, 0, vite.stderr || vite.stdout);

  const packaged = spawnSync(process.execPath, [join(root, 'scripts/package-minitool.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
});
