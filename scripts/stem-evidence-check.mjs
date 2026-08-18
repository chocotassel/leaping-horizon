import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const candidates = process.platform === 'win32'
  ? [resolve(root, '.venv-analysis/Scripts/python.exe')]
  : [
      resolve(root, '.venv-analysis/bin/python3'),
      resolve(root, '.venv-analysis/bin/python'),
    ];
const python = process.env.RHYTHM_PYTHON || candidates.find(existsSync);
if (!python) throw new Error('Rhythm Python environment is not available. Run npm run setup:rhythm first.');

const result = spawnSync(python, ['scripts/analyze-rhythm.test.py'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
