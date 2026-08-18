import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE4_ROLES = ['vocals', 'drums', 'bass', 'other'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

function separatorIdentity(separator) {
  const identity = {
    id: String(separator?.id ?? ''),
    model: String(separator?.model ?? ''),
    version: String(separator?.version ?? ''),
    checksum: String(separator?.checksum ?? ''),
  };
  if (Object.values(identity).some((value) => !value)) {
    throw new Error('Core-4 separator identity is incomplete.');
  }
  return identity;
}

function identityChecksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createDemucsCore4Separator(options = {}) {
  const version = '4.0.1';
  const model = 'htdemucs';
  const device = 'cpu';
  const pythonPath = resolve(options.pythonPath ?? resolve(
    root,
    '.venv-separation',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3',
  ));
  const identity = { id: 'demucs-core4', model, version, device, stems: CORE4_ROLES };
  return {
    ...identity,
    checksum: identityChecksum(identity),
    async separate({ audioPath, outputDirectory }) {
      const resultPath = resolve(outputDirectory, 'separation-result.json');
      const args = [
        resolve(root, 'scripts', 'separate-stems.py'),
        '--audio', audioPath,
        '--output-directory', outputDirectory,
        '--result', resultPath,
        '--model', model,
        '--device', device,
      ];
      await new Promise((fulfil, reject) => {
        const child = spawn(pythonPath, args, {
          cwd: root,
          env: { ...process.env, PYTHONUTF8: '1', CUDA_VISIBLE_DEVICES: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const report = options.onProgress ?? ((message) => process.stderr.write(`[core4] ${message}\n`));
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          for (const line of chunk.split(/\r?\n/).filter(Boolean)) report(line);
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
          for (const line of chunk.split(/\r?\n/).filter(Boolean)) report(line);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) fulfil();
          else reject(new Error(`Demucs core-4 exited with ${code}: ${stderr.trim()}`));
        });
      });
      return JSON.parse(await readFile(resultPath, 'utf8'));
    },
  };
}

async function hydrateManifest(manifest, cacheDirectory, hit) {
  const stems = {};
  for (const role of CORE4_ROLES) {
    const cached = manifest.stems?.[role];
    if (!cached?.file || cached.status !== 'ready') throw new Error(`Cached ${role} stem is invalid.`);
    const path = resolve(cacheDirectory, cached.file);
    if (await sha256File(path) !== cached.checksum) throw new Error(`Cached ${role} checksum changed.`);
    stems[role] = { ...cached, path };
  }
  return {
    ...manifest,
    stems,
    cache: {
      ...manifest.cache,
      hit,
      manifestPath: resolve(cacheDirectory, 'manifest.json'),
    },
  };
}

async function readCachedManifest(cacheDirectory, cacheKey) {
  try {
    const manifest = JSON.parse(await readFile(resolve(cacheDirectory, 'manifest.json'), 'utf8'));
    if (
      manifest?.schemaVersion !== '1.0.0'
      || manifest?.status !== 'ready'
      || manifest?.cache?.key !== cacheKey
      || manifest?.timeOriginSeconds !== 0
    ) return null;
    return await hydrateManifest(manifest, cacheDirectory, true);
  } catch {
    return null;
  }
}

export async function ensureCore4Evidence(audioPath, options) {
  const resolvedAudioPath = resolve(audioPath);
  const workDirectory = resolve(options?.workDirectory ?? '.');
  const separator = options?.separator ?? createDemucsCore4Separator(options);
  const separatorMetadata = separatorIdentity(separator);
  const audioChecksum = await sha256File(resolvedAudioPath);
  const cacheKey = createHash('sha256')
    .update(JSON.stringify({ audioChecksum, separator: separatorMetadata }))
    .digest('hex');
  const cacheParent = resolve(workDirectory, 'core4', audioChecksum.slice(0, 16));
  const cacheDirectory = resolve(cacheParent, cacheKey.slice(0, 24));
  const cached = await readCachedManifest(cacheDirectory, cacheKey);
  if (cached) return cached;

  await mkdir(cacheParent, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(cacheParent, '.separating-'));
  try {
    const result = await separator.separate({
      audioPath: resolvedAudioPath,
      outputDirectory: temporaryDirectory,
    });
    if (Number(result?.timeOriginSeconds) !== 0) {
      throw new Error('Core-4 stems must share the original audio zero point.');
    }

    const stems = {};
    for (const role of CORE4_ROLES) {
      const sourcePath = resolve(String(result?.stems?.[role] ?? ''));
      if (!sourcePath || basename(sourcePath) === '.') throw new Error(`Separator did not produce ${role}.`);
      const destinationPath = resolve(temporaryDirectory, `${role}.wav`);
      if (sourcePath !== destinationPath) await copyFile(sourcePath, destinationPath);
      const details = await stat(destinationPath);
      if (!details.isFile() || details.size === 0) throw new Error(`Separator produced an empty ${role} stem.`);
      stems[role] = {
        status: 'ready',
        file: `${role}.wav`,
        checksum: await sha256File(destinationPath),
        bytes: details.size,
      };
    }

    const manifest = {
      kind: 'core4-separation-manifest',
      schemaVersion: '1.0.0',
      status: 'ready',
      audioFingerprint: audioChecksum.slice(0, 16),
      audioChecksum,
      separator: separatorMetadata,
      timeOriginSeconds: 0,
      sampleRate: Number(result.sampleRate),
      durationSeconds: Number(result.durationSeconds),
      stems,
      cache: { key: cacheKey, hit: false },
    };
    await writeFile(resolve(temporaryDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    try {
      await rename(temporaryDirectory, cacheDirectory);
    } catch (error) {
      const concurrent = await readCachedManifest(cacheDirectory, cacheKey);
      if (concurrent) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        return concurrent;
      }
      // Windows can reject an otherwise valid directory rename while an
      // audio decoder or virus scanner still has a transient handle. Copy the
      // immutable stem payload first and publish manifest.json last; readers
      // treat the manifest as the cache commit marker.
      if (error?.code !== 'EPERM' && error?.code !== 'EXDEV') throw error;
      await mkdir(cacheDirectory, { recursive: true });
      for (const role of CORE4_ROLES) {
        await copyFile(
          resolve(temporaryDirectory, `${role}.wav`),
          resolve(cacheDirectory, `${role}.wav`),
        );
      }
      await writeFile(
        resolve(cacheDirectory, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await rm(temporaryDirectory, { recursive: true, force: true });
      return hydrateManifest(manifest, cacheDirectory, false);
    }
    return hydrateManifest(manifest, cacheDirectory, false);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    return {
      kind: 'core4-separation-manifest',
      schemaVersion: '1.0.0',
      status: 'unavailable',
      audioFingerprint: audioChecksum.slice(0, 16),
      audioChecksum,
      separator: separatorMetadata,
      timeOriginSeconds: 0,
      sampleRate: null,
      durationSeconds: null,
      stems: Object.fromEntries(CORE4_ROLES.map((role) => [
        role,
        { role, status: 'unavailable' },
      ])),
      cache: { key: cacheKey, hit: false, manifestPath: null },
      diagnostics: {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
    };
  }
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--audio') options.audioPath = argv[++index];
    else if (argument === '--work-directory') options.workDirectory = argv[++index];
    else if (argument === '--python') options.pythonPath = argv[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown core-4 separation argument: ${argument}`);
  }
  return options;
}

async function runCli() {
  const options = cliOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/rhythm/stem-separation.mjs --audio <game-audio> --work-directory <work> [--python <path>]\n',
    );
    return;
  }
  if (!options.audioPath || !options.workDirectory) {
    throw new Error('--audio and --work-directory are required.');
  }
  const result = await ensureCore4Evidence(options.audioPath, {
    workDirectory: options.workDirectory,
    pythonPath: options.pythonPath,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    audioFingerprint: result.audioFingerprint,
    manifestPath: result.cache?.manifestPath ?? null,
    cacheHit: Boolean(result.cache?.hit),
    diagnostics: result.diagnostics ?? {},
  }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`[core4] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
