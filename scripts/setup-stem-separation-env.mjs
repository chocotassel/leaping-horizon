import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const environment = resolve(root, '.venv-separation');
const python = resolve(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
const rhythmPython = resolve(
  root,
  '.venv-analysis',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3',
);
const env = {
  ...process.env,
  UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? resolve(root, '.cache/uv'),
  UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? resolve(root, '.cache/uv-python'),
};
const packages = [
  'setuptools<81',
  'demucs==4.0.1',
  'soundfile==0.13.1',
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const hasUv = spawnSync('uv', ['--version'], { env, stdio: 'ignore' }).status === 0;
if (!existsSync(python)) {
  if (hasUv) run('uv', ['venv', '--python', '3.11', environment]);
  else if (existsSync(rhythmPython)) run(rhythmPython, ['-m', 'venv', environment]);
  else run(process.platform === 'win32' ? 'python' : 'python3.11', ['-m', 'venv', environment]);
}

if (hasUv) run('uv', ['pip', 'install', '--python', python, ...packages]);
else {
  run(python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(python, ['-m', 'pip', 'install', ...packages]);
}

console.log('CPU stem-separation environment is ready.');
