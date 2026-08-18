import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

import { parseLevelEdits, type LevelEdits } from './src/levelEdits';
import { compilePerformance } from './src/regionArrangement';
import type { Level } from './src/types';

const STEM_PREVIEW_PATH = '/__level-editor/stem-preview';
const STEM_ROLES = ['vocals', 'drums', 'bass', 'other'] as const;

interface StemPreviewOptions {
  workspaceRoot?: string;
}

function previewWorkRoot(options?: StemPreviewOptions): string {
  return resolve(options?.workspaceRoot ?? import.meta.dirname, 'work');
}

function assertInside(rootPath: string, targetPath: string, label: string): void {
  const child = relative(rootPath, targetPath);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`${label} is outside workspace work.`);
  }
}

async function readVerifiedStem(
  manifestPath: string,
  role: string,
  options?: StemPreviewOptions,
): Promise<{ data: Buffer; contentType: string; checksum: string }> {
  const workRoot = previewWorkRoot(options);
  const resolvedManifest = resolve(manifestPath);
  assertInside(workRoot, resolvedManifest, 'Stem manifest');
  const manifest = JSON.parse(await readFile(resolvedManifest, 'utf8')) as {
    kind?: unknown;
    status?: unknown;
    stems?: Record<string, { status?: unknown; file?: unknown; checksum?: unknown }>;
  };
  if (manifest.kind !== 'core4-separation-manifest' || manifest.status !== 'ready') {
    throw new Error('Stem manifest is not a ready core-4 separation manifest.');
  }
  if (!(STEM_ROLES as readonly string[]).includes(role)) throw new Error('Unknown stem preview role.');
  const stem = manifest.stems?.[role];
  if (stem?.status !== 'ready' || typeof stem.file !== 'string' || typeof stem.checksum !== 'string') {
    throw new Error(`${role} stem is unavailable for preview.`);
  }
  const stemPath = resolve(dirname(resolvedManifest), stem.file);
  assertInside(dirname(resolvedManifest), stemPath, 'Stem file');
  assertInside(workRoot, stemPath, 'Stem file');
  const data = await readFile(stemPath);
  const checksum = createHash('sha256').update(data).digest('hex');
  if (checksum !== stem.checksum) throw new Error(`${role} stem checksum changed.`);
  const contentType = extname(stemPath).toLowerCase() === '.mp3'
    ? 'audio/mpeg'
    : extname(stemPath).toLowerCase() === '.ogg'
      ? 'audio/ogg'
      : 'audio/wav';
  return { data, contentType, checksum };
}

/** Resolve editor-only URLs without exposing absolute cache or model paths. */
export async function resolveEditorStemPreviewUrls(
  manifestPath: string,
  options?: StemPreviewOptions,
): Promise<Partial<Record<typeof STEM_ROLES[number], string>>> {
  const workRoot = previewWorkRoot(options);
  const resolvedManifest = resolve(manifestPath);
  assertInside(workRoot, resolvedManifest, 'Stem manifest');
  const manifestRelative = relative(workRoot, resolvedManifest).replaceAll('\\', '/');
  const urls: Partial<Record<typeof STEM_ROLES[number], string>> = {};
  for (const role of STEM_ROLES) {
    try {
      const preview = await readVerifiedStem(resolvedManifest, role, options);
      const params = new URLSearchParams({
        manifest: manifestRelative,
        role,
        checksum: preview.checksum,
      });
      urls[role] = `${STEM_PREVIEW_PATH}?${params}`;
    } catch (error) {
      if (error instanceof Error && /unavailable for preview/.test(error.message)) continue;
      throw error;
    }
  }
  return urls;
}

/** Read one URL produced by resolveEditorStemPreviewUrls after revalidating containment and checksum. */
export async function readEditorStemPreview(
  requestUrl: string,
  options?: StemPreviewOptions,
): Promise<{ data: Buffer; contentType: string }> {
  const url = new URL(requestUrl, 'http://editor.local');
  if (url.pathname !== STEM_PREVIEW_PATH) throw new Error('Unknown editor stem preview URL.');
  const manifest = url.searchParams.get('manifest');
  const role = url.searchParams.get('role');
  const expectedChecksum = url.searchParams.get('checksum');
  if (!manifest || !role || !expectedChecksum) throw new Error('Incomplete editor stem preview URL.');
  const manifestPath = resolve(previewWorkRoot(options), manifest);
  const preview = await readVerifiedStem(manifestPath, role, options);
  if (preview.checksum !== expectedChecksum) throw new Error('Stem preview URL checksum is stale.');
  return { data: preview.data, contentType: preview.contentType };
}

export function base64AssetPlugin(): Plugin {
  const prefix = '\0base64:';
  return {
    name: 'base64-assets',
    enforce: 'pre',
    resolveId(source, importer) {
      const queryIndex = source.indexOf('?');
      if (queryIndex < 0 || !new URLSearchParams(source.slice(queryIndex + 1)).has('base64')) return null;
      const file = source.slice(0, queryIndex);
      if (isAbsolute(file)) return `${prefix}${file}`;
      if (!importer) return null;
      return `${prefix}${resolve(dirname(importer), file)}`;
    },
    async load(id) {
      if (!id.startsWith(prefix)) return null;
      return `export default ${JSON.stringify((await readFile(id.slice(prefix.length))).toString('base64'))}`;
    },
  };
}

export function runtimeLevelPlugin(): Plugin {
  return {
    name: 'runtime-levels',
    enforce: 'pre',
    async transform(code, id) {
      const levelPath = id.split('?')[0];
      if (!/\/src\/songs\/[^/]+\/level\.json$/.test(levelPath.replaceAll('\\', '/'))) return null;
      const level = JSON.parse(code) as Level;
      const editor = new URLSearchParams(id.split('?')[1] ?? '').has('editor');
      if (editor) return `export default ${JSON.stringify(level)};`;

      const songDirectory = dirname(levelPath);
      const authoringPath = resolve(songDirectory, 'authoring.json');
      const editsPath = resolve(songDirectory, 'edits.json');
      this.addWatchFile?.(authoringPath);
      this.addWatchFile?.(editsPath);
      const authoringScore = await readRequiredJson(
        authoringPath,
        'Authoring Score (authoring.json)',
      );
      const editValue = await readOptionalJson(editsPath);
      const edits = parseLevelEdits(editValue, level);
      const compiled = compilePerformance(level, authoringScore, edits).level;
      const finalTimes = [...new Set(compiled.events.map((event) => event.timeSeconds.toFixed(5)))]
        .map(Number)
        .sort((left, right) => left - right);
      const runtimeLevel = {
        ...compiled,
        generation: {
          algorithm: compiled.generation.algorithm,
          noteCount: compiled.generation.noteCount,
        },
        rhythmPoints: finalTimes.map((timeSeconds) => ({ timeSeconds })),
        events: compactRuntimeEvents(compiled, authoringScore),
      };
      return JSON.stringify(runtimeLevel);
    },
  };
}

async function readRequiredJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`Missing ${label} beside the base level: ${path}`);
    }
    throw new Error(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

interface CompactHitSoundIntent {
  sourceRole: string;
  pitchMidi?: number;
  pitchClass: number;
  velocity: number;
  gain: number;
  brightness: number;
}

function finiteControl(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function compactSourceRole(value: unknown): string {
  const safe = String(value ?? 'mixed').replace(/[^a-z0-9+_-]/gi, '').slice(0, 48);
  return safe || 'mixed';
}

function compactHitSoundIntent(value: unknown, fallback: Partial<CompactHitSoundIntent> = {}): CompactHitSoundIntent {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const inputPitch = Number(input.pitchMidi ?? fallback.pitchMidi);
  const pitchMidi = Number.isFinite(inputPitch) ? Math.max(0, Math.min(127, inputPitch)) : undefined;
  const inputPitchClass = Number(input.pitchClass ?? fallback.pitchClass);
  const pitchClass = Number.isFinite(inputPitchClass)
    ? ((Math.round(inputPitchClass) % 12) + 12) % 12
    : pitchMidi == null
      ? 0
      : ((Math.round(pitchMidi) % 12) + 12) % 12;
  return {
    sourceRole: compactSourceRole(input.sourceRole ?? fallback.sourceRole),
    ...(pitchMidi == null ? {} : { pitchMidi }),
    pitchClass,
    velocity: finiteControl(input.velocity ?? fallback.velocity, 0.7),
    gain: finiteControl(input.gain ?? fallback.gain, 0.45),
    brightness: finiteControl(input.brightness ?? fallback.brightness, 0.55),
  };
}

function evidenceHitSoundAt(
  authoringScore: unknown,
  level: Level,
  timeSeconds: number,
): CompactHitSoundIntent {
  const score = authoringScore && typeof authoringScore === 'object'
    ? authoringScore as Record<string, unknown>
    : {};
  const evidenceStreams = score.evidenceStreams && typeof score.evidenceStreams === 'object'
    ? score.evidenceStreams as Record<string, unknown>
    : {};
  const timingStreams = Array.isArray(evidenceStreams.timing)
    ? evidenceStreams.timing as Array<Record<string, unknown>>
    : [];
  const nearby = timingStreams.flatMap((stream) => {
    if (stream.availability === 'unavailable' || !Array.isArray(stream.events)) return [];
    return (stream.events as Array<Record<string, unknown>>)
      .filter((event) => Math.abs(Number(event.timeSeconds) - timeSeconds) <= 0.055)
      .map((event) => ({
        event,
        role: compactSourceRole(stream.stemRole),
        distance: Math.abs(Number(event.timeSeconds) - timeSeconds),
        strength: finiteControl(event.strength, 0.5),
      }));
  });
  const stemSpecific = nearby.filter((candidate) => !['mix', 'metric', 'mixed'].includes(candidate.role));
  const candidates = stemSpecific.length ? stemSpecific : nearby;
  candidates.sort((left, right) => (
    left.distance - right.distance
    || right.strength - left.strength
    || left.role.localeCompare(right.role)
  ));
  const pitched = [...candidates]
    .filter((candidate) => Number.isFinite(Number(candidate.event.pitchMidi)))
    .sort((left, right) => right.strength - left.strength || left.distance - right.distance)[0];
  const roles = [...new Set(candidates.map((candidate) => candidate.role))].slice(0, 3);
  const rhythmPoint = level.rhythmPoints.find((point) => point.timeSeconds.toFixed(5) === timeSeconds.toFixed(5));
  const velocity = candidates.reduce((maximum, candidate) => Math.max(maximum, candidate.strength), 0)
    || finiteControl(rhythmPoint?.strength, 0.7);
  const brightnessByRole: Record<string, number> = {
    vocals: 0.66,
    drums: 0.82,
    percussion: 0.82,
    bass: 0.28,
    other: 0.58,
  };
  const brightness = candidates.length
    ? candidates.reduce((sum, candidate) => sum + (brightnessByRole[candidate.role] ?? 0.55), 0) / candidates.length
    : 0.55;
  return compactHitSoundIntent({}, {
    sourceRole: roles.join('+') || rhythmPoint?.sourceRole || 'mixed',
    pitchMidi: Number.isFinite(Number(pitched?.event.pitchMidi))
      ? Number(pitched?.event.pitchMidi)
      : rhythmPoint?.pitchMidi,
    velocity,
    gain: Math.min(1, 0.3 + velocity * 0.35 + Math.max(0, roles.length - 1) * 0.05),
    brightness,
  });
}

function compactRuntimeEvents(
  compiled: Level,
  authoringScore: unknown,
): Array<Record<string, unknown>> {
  return compiled.events.map((event) => {
    const eventWithSound = event as typeof event & { hitSound?: unknown };
    return {
      timeSeconds: event.timeSeconds,
      obstacles: event.obstacles,
      kind: event.kind,
      ...(event.kind === 'target'
        ? {
            hitSound: eventWithSound.hitSound
              ? compactHitSoundIntent(eventWithSound.hitSound)
              : evidenceHitSoundAt(authoringScore, compiled, event.timeSeconds),
          }
        : {}),
    };
  });
}

export async function normalizeLevelEditsForSave(
  songDirectory: string,
  value: unknown,
): Promise<LevelEdits> {
  const level = await readRequiredJson(resolve(songDirectory, 'level.json'), 'base level') as Level;
  const authoringScore = await readRequiredJson(
    resolve(songDirectory, 'authoring.json'),
    'Authoring Score (authoring.json)',
  );
  const edits = parseLevelEdits(value, level);
  compilePerformance(level, authoringScore, edits);
  return edits;
}

export function levelEditorPlugin(): Plugin {
  return {
    name: 'level-editor-save',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://editor.local');
        if (request.method !== 'GET' || url.pathname !== STEM_PREVIEW_PATH) {
          next();
          return;
        }
        try {
          const preview = await readEditorStemPreview(url.toString());
          response.statusCode = 200;
          response.setHeader('Content-Type', preview.contentType);
          response.setHeader('Content-Length', String(preview.data.byteLength));
          response.setHeader('Cache-Control', 'private, no-store');
          response.end(preview.data);
        } catch (error) {
          response.statusCode = 404;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      server.middlewares.use('/__level-editor/save', async (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        try {
          let body = '';
          for await (const chunk of request) {
            body += String(chunk);
            if (body.length > 1_000_000) throw new Error('编辑数据过大。');
          }
          const value = JSON.parse(body) as { levelId?: unknown };
          if (typeof value.levelId !== 'string' || !/^[a-z0-9-]+-flow$/.test(value.levelId)) {
            throw new Error('编辑数据格式无效。');
          }

          const songId = value.levelId.replace(/-flow$/, '');
          const songDirectory = resolve(import.meta.dirname, 'src', 'songs', songId);
          const edits = await normalizeLevelEditsForSave(songDirectory, value);
          await writeFile(
            resolve(songDirectory, 'edits.json'),
            `${JSON.stringify(edits, null, 2)}\n`,
          );
          server.moduleGraph.invalidateAll();
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ ok: true, version: edits.version }));
        } catch (error) {
          response.statusCode = 400;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    },
  };
}
