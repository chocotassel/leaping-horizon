import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const candidates = process.platform === 'win32'
  ? [resolve(root, '.venv-analysis/Scripts/python.exe')]
  : [resolve(root, '.venv-analysis/bin/python3'), resolve(root, '.venv-analysis/bin/python')];
const python = process.env.RHYTHM_PYTHON || candidates.find(existsSync);

if (!python) {
  throw new Error(
    'Rhythm Python environment not found. Create .venv-analysis or set RHYTHM_PYTHON to its Python executable.',
  );
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Mature audio models create real, non-quantized candidates; the build step only
// turns those timestamps into playable lanes and never moves them onto a beat grid.
run(python, ['scripts/analyze-rhythm.py', ...process.argv.slice(2)]);
run(process.execPath, ['scripts/build-rhythm-levels.mjs']);
