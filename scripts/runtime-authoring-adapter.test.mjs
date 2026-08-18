import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
let adapter;
let server;

before(async () => {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
  adapter = await server.ssrLoadModule('/vite.base64-plugin.ts');
});

after(async () => {
  await server?.close();
});

function baseLevel() {
  return {
    id: 'adapter-fixture-flow',
    version: 3,
    song: {
      title: 'Adapter Fixture',
      artist: 'Fixture',
      audioUrl: './audio.mp3',
      bpm: 60,
      durationSeconds: 4,
    },
    generation: {
      algorithm: 'region-authoring-base-v1',
      noteCount: 1,
      rhythmPointCount: 5,
      authoringRegionCount: 1,
    },
    rhythmPoints: [0.2, 0.23, 1, 2, 3].map((timeSeconds, index) => ({
      id: `point-${index}`,
      timeSeconds,
      suggestedLane: 2,
      kind: 'attack',
      strength: 0.9,
      sourceRole: 'fixture',
      hasBaseRow: timeSeconds === 0.2,
    })),
    colorSchemeEvents: [{
      timeSeconds: 0,
      colorSchemeId: 'cyanWhite',
      kind: 'section',
      source: 'base',
      strength: 0,
    }],
    events: [{
      timeSeconds: 0.2,
      obstacles: [0, 0, 1, 0, 0],
      kind: 'target',
      hitSound: {
        sourceRole: 'mixed',
        pitchClass: 0,
        velocity: 0.7,
        gain: 0.45,
        brightness: 0.55,
      },
    }],
  };
}

function authoringScore() {
  const stream = (id, kind, stemRole, events, capabilities) => ({
    id,
    label: id,
    kind,
    stemRole,
    identity: 'model-estimated',
    availability: 'estimated',
    capabilities,
    events,
  });
  return {
    kind: 'authoring-score',
    schemaVersion: '2.0.0',
    algorithm: 'fixture-authoring-v2',
    levelId: 'adapter-fixture-flow',
    audioFingerprint: 'fixture-audio',
    evidenceFingerprint: 'fixture-evidence',
    sources: [],
    evidenceStreams: {
      timing: [
        stream('stem:vocals:timing', 'timing', 'vocals', [
          { id: 'vocal-a', timeSeconds: 0.2, pitchMidi: 60, strength: 0.85 },
          { id: 'vocal-b', timeSeconds: 1, pitchMidi: 66, strength: 0.9 },
          { id: 'vocal-c', timeSeconds: 2, pitchMidi: 72, strength: 0.92 },
        ], { onsets: true, pitch: true, continuousPitch: false }),
        stream('stem:drums:timing', 'timing', 'drums', [
          { id: 'kick-near-vocal', timeSeconds: 0.23, strength: 1 },
          { id: 'kick-c', timeSeconds: 2, strength: 0.95 },
        ], { onsets: true, pitch: false, continuousPitch: false }),
      ],
      lane: [stream('stem:vocals:pitch', 'lane', 'vocals', [60, 66, 72].map((pitchMidi, index) => ({
        id: `pitch-${index}`,
        timeSeconds: [0.2, 1, 2][index],
        pitchMidi,
        strength: 0.9,
      })), { onsets: false, pitch: true, continuousPitch: true })],
      accent: [],
      metric: [],
    },
    regions: [{ id: 'region:verse', startSeconds: 0, endSeconds: 3 }],
    regionEvidence: [],
    repeatSets: [],
    suggestions: [],
  };
}

function arrangedEdits() {
  return {
    version: 3,
    levelId: 'adapter-fixture-flow',
    baseFingerprint: 'fixture-audio',
    evidenceFingerprint: 'fixture-evidence',
    arrangements: [{
      id: 'verse-contour',
      regionId: 'region:verse',
      mode: 'play',
      timingLayers: [
        { sourceId: 'stem:vocals:timing', role: 'target', weight: 1 },
        { sourceId: 'stem:drums:timing', role: 'target', weight: 0.7 },
      ],
      laneDriver: { kind: 'source', sourceId: 'stem:vocals:pitch', motion: 1 },
      density: 1,
      challenge: 0,
      feel: 'natural',
    }],
    rowOverrides: [],
    colorRanges: [],
  };
}

async function fixtureDirectory({ authoring = true, edits = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-runtime-adapter-'));
  const songDirectory = join(directory, 'src', 'songs', 'adapter-fixture');
  await mkdir(songDirectory, { recursive: true });
  const level = baseLevel();
  await writeFile(join(songDirectory, 'level.json'), `${JSON.stringify(level)}\n`);
  if (authoring) {
    await writeFile(join(songDirectory, 'authoring.json'), `${JSON.stringify(authoringScore())}\n`);
  }
  if (edits) {
    await writeFile(join(songDirectory, 'edits.json'), `${JSON.stringify(arrangedEdits())}\n`);
  }
  return { directory, songDirectory, level };
}

test('non-editor transform compiles sidecars and emits only final runtime rows', async () => {
  const fixture = await fixtureDirectory();
  try {
    const plugin = adapter.runtimeLevelPlugin();
    const transformed = await plugin.transform(
      JSON.stringify(fixture.level),
      join(fixture.songDirectory, 'level.json'),
    );
    const runtime = JSON.parse(typeof transformed === 'string' ? transformed : transformed.code);

    assert.deepEqual(runtime.events.map((event) => event.timeSeconds), [0.2, 1, 2]);
    assert.deepEqual(runtime.rhythmPoints, [
      { timeSeconds: 0.2 },
      { timeSeconds: 1 },
      { timeSeconds: 2 },
    ]);
    assert.deepEqual(runtime.generation, {
      algorithm: 'region-authoring-base-v1',
      noteCount: 3,
    });
    assert.ok(runtime.events.every((event) => (
      typeof event.hitSound?.sourceRole === 'string'
      && Number.isInteger(event.hitSound.pitchClass)
      && Number.isFinite(event.hitSound.velocity)
      && Number.isFinite(event.hitSound.gain)
      && Number.isFinite(event.hitSound.brightness)
    )), 'each compact Target keeps exactly one HitSoundIntent after multi-stem fusion');
    const runtimeSource = JSON.stringify(runtime);
    assert.ok(!runtimeSource.includes('stem:vocals'));
    assert.ok(!runtimeSource.includes('fixture-evidence'));
    assert.ok(!runtimeSource.includes('work/'));
    assert.ok(!Object.hasOwn(runtime, 'authoringScore'));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('?editor returns the complete unarranged base without requiring sidecars', async () => {
  const fixture = await fixtureDirectory({ authoring: false, edits: false });
  try {
    const plugin = adapter.runtimeLevelPlugin();
    const transformed = await plugin.transform(
      JSON.stringify(fixture.level),
      `${join(fixture.songDirectory, 'level.json')}?editor`,
    );
    const source = typeof transformed === 'string' ? transformed : transformed.code;
    const editorLevel = JSON.parse(source.replace(/^export default /, '').replace(/;$/, ''));

    assert.deepEqual(editorLevel, fixture.level);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('runtime compilation fails clearly when authoring.json is absent', async () => {
  const fixture = await fixtureDirectory({ authoring: false });
  try {
    const plugin = adapter.runtimeLevelPlugin();
    await assert.rejects(
      plugin.transform(JSON.stringify(fixture.level), join(fixture.songDirectory, 'level.json')),
      /authoring\.json|Authoring Score/i,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('save validation migrates v1 and rejects recipes against unavailable evidence', async () => {
  const fixture = await fixtureDirectory();
  try {
    const migrated = await adapter.normalizeLevelEditsForSave(fixture.songDirectory, {
      version: 1,
      levelId: fixture.level.id,
      rowOverrides: [{ timeSeconds: 0.2, obstacles: [0, 1, 0, 0, 0] }],
      colorRanges: [],
    });
    assert.equal(migrated.version, 3);
    assert.deepEqual(migrated.arrangements, []);
    assert.deepEqual(migrated.rowOverrides[0].obstacles, [0, 1, 0, 0, 0]);

    const invalid = arrangedEdits();
    invalid.arrangements[0].timingLayers[0].sourceId = 'missing-source';
    await assert.rejects(
      adapter.normalizeLevelEditsForSave(fixture.songDirectory, invalid),
      /unavailable evidence|missing-source/i,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('browser chart consumes transformed levels without importing authoring code or edits', async () => {
  const chartSource = await readFile(join(root, 'src', 'chart.ts'), 'utf8');

  assert.doesNotMatch(chartSource, /levelEdits|regionArrangement|edits\.json|authoring\.json/);
});

test('editor stem previews resolve only checksum-verified files below workspace work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-stem-preview-'));
  try {
    const cacheDirectory = join(directory, 'work', 'core4', 'audio', 'evidence');
    await mkdir(cacheDirectory, { recursive: true });
    const audio = Buffer.from('fixture-vocals');
    const checksum = createHash('sha256').update(audio).digest('hex');
    await writeFile(join(cacheDirectory, 'vocals.wav'), audio);
    const manifestPath = join(cacheDirectory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({
      kind: 'core4-separation-manifest',
      schemaVersion: '1.0.0',
      status: 'ready',
      stems: {
        vocals: { status: 'ready', file: 'vocals.wav', checksum },
      },
    }));

    const urls = await adapter.resolveEditorStemPreviewUrls(manifestPath, { workspaceRoot: directory });
    assert.deepEqual(Object.keys(urls), ['vocals']);
    assert.match(urls.vocals, /^\/__level-editor\/stem-preview\?/);
    assert.ok(!urls.vocals.includes(directory), 'the editor URL never exposes an absolute model/cache path');
    const preview = await adapter.readEditorStemPreview(urls.vocals, { workspaceRoot: directory });
    assert.equal(preview.contentType, 'audio/wav');
    assert.deepEqual(preview.data, audio);

    const outside = join(directory, 'outside-manifest.json');
    await writeFile(outside, '{}');
    await assert.rejects(
      adapter.resolveEditorStemPreviewUrls(outside, { workspaceRoot: directory }),
      /workspace work|outside/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
