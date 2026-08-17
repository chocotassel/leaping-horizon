import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const environment = resolve(root, '.venv-analysis');
const python = resolve(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
const env = {
  ...process.env,
  UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? resolve(root, '.cache/uv'),
  UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? resolve(root, '.cache/uv-python'),
};
const packages = [
  'setuptools<81',
  'librosa==0.11.0',
  'scikit-learn==1.7.1',
  'beat-this==1.1.0',
  'onnxruntime==1.28.0',
  'mir_eval==0.8.2',
  'pretty_midi==0.2.11.post0',
  'resampy==0.4.2',
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const hasUv = spawnSync('uv', ['--version'], { env, stdio: 'ignore' }).status === 0;
if (!existsSync(python)) {
  if (hasUv) run('uv', ['venv', '--python', '3.11', environment]);
  else run(process.platform === 'win32' ? 'python' : 'python3.11', ['-m', 'venv', environment]);
}

if (hasUv) {
  run('uv', ['pip', 'install', '--python', python, ...packages]);
  run('uv', ['pip', 'install', '--python', python, 'basic-pitch==0.4.0', '--no-deps']);
} else {
  run(python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(python, ['-m', 'pip', 'install', ...packages]);
  run(python, ['-m', 'pip', 'install', 'basic-pitch==0.4.0', '--no-deps']);
}

console.log('Rhythm environment is ready.');
