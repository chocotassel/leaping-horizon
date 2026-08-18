import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import { ensureCore4Evidence } from './rhythm/stem-separation.mjs';

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

function prepareGameAudio(source, destination) {
  if (resolve(source) === resolve(destination)) return;
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source, '-vn', '-map_metadata', '-1',
    '-ar', '32000', '-c:a', 'libmp3lame', '-b:a', '96k',
    destination,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function writeCover(sourceAudio, explicitCover, destination) {
  const temporary = resolve(destination, '..', 'cover.tmp.jpeg');
  await mkdir(resolve(destination, '..'), { recursive: true });
  await rm(temporary, { force: true });
  const input = explicitCover ?? sourceAudio;
  const args = explicitCover
    ? ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-q:v', '2', temporary]
    : ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:v:0', '-frames:v', '1', '-q:v', '2', temporary];
  const result = spawnSync('ffmpeg', args, { cwd: root, stdio: explicitCover ? 'inherit' : 'ignore' });
  if (result.status !== 0) {
    await rm(temporary, { force: true });
    if (!explicitCover && existsSync(destination)) {
      console.log(`Cover: keeping ${destination} (source audio has no embedded artwork).`);
      return;
    }
    if (result.error) throw result.error;
    throw new Error('No embedded cover found. Pass --cover "path/to/cover.png".');
  }
  await rm(destination, { force: true });
  await rename(temporary, destination);
  console.log(`Cover: ${destination}`);
}

function parseArguments(values) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--title' || value === '--artist' || value === '--id' || value === '--cover') {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else if (!value.startsWith('--')) {
      positionals.push(value);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (positionals.length > 4) throw new Error(`Too many positional arguments: ${positionals.slice(4).join(', ')}`);
  return {
    input: positionals[0] ?? null,
    options: {
      title: options.title ?? positionals[1],
      artist: options.artist ?? positionals[2],
      id: options.id ?? positionals[3],
      cover: options.cover,
    },
  };
}

function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'track';
}

const { input, options } = parseArguments(process.argv.slice(2));
if (!input) {
  throw new Error('Usage: npm run generate -- "path/to/song.wav" ["Song title"] ["Artist"] [song-id]');
}
const sourceAudio = resolve(input);
if (!existsSync(sourceAudio)) throw new Error(`Audio input does not exist: ${sourceAudio}`);

const inferredTitle = basename(sourceAudio, extname(sourceAudio));
const title = options.title ?? inferredTitle;
const artist = options.artist ?? 'Unknown Artist';
const songId = options.id ?? slugify(inferredTitle);
const songDirectory = resolve(root, `src/songs/${songId}`);
const gameAudioPath = resolve(songDirectory, 'audio.mp3');
const coverPath = resolve(songDirectory, 'cover.jpeg');
const analysisPath = resolve(root, `work/${songId}/analysis.json`);
const levelPath = resolve(songDirectory, 'level.json');
const cover = options.cover ? resolve(options.cover) : null;
if (cover && !existsSync(cover)) throw new Error(`Cover input does not exist: ${cover}`);

await writeCover(sourceAudio, cover, coverPath);

// Prepare the exact MP3 used by the game before separation. Every detector and
// every stem therefore shares one decoded time origin.
await mkdir(songDirectory, { recursive: true });
prepareGameAudio(sourceAudio, gameAudioPath);
const separation = await ensureCore4Evidence(gameAudioPath, {
  workDirectory: resolve(root, `work/${songId}`),
});
if (separation.status === 'ready') {
  console.log(`Core-4 stems: ${separation.cache.hit ? 'cached' : 'generated'}.`);
} else {
  console.warn(`Core-4 stems unavailable; keeping mixed evidence. ${separation.diagnostics?.error ?? ''}`);
}

const analyzerArgs = [
  'scripts/analyze-rhythm.py',
  '--audio', gameAudioPath,
  '--audio-output', gameAudioPath,
  '--audio-url', 'audio.mp3',
  '--output', analysisPath,
  '--song-id', songId,
  '--title', title,
  '--artist', artist,
];
if (separation.status === 'ready' && separation.cache.manifestPath) {
  analyzerArgs.push('--stems-manifest', separation.cache.manifestPath);
}
run(python, analyzerArgs);
run(process.execPath, ['scripts/build-rhythm-levels.mjs', analysisPath, levelPath]);
console.log(`Game audio: ${gameAudioPath}`);
console.log(`Cover art: ${coverPath}`);
console.log(`Level data: ${levelPath}`);
