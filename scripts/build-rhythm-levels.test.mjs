import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { transcribePerformance } from './rhythm/performance-transcriber.mjs';

const root = resolve(import.meta.dirname, '..');

function measuredAnalysis() {
  const beats = Array.from({ length: 32 }, (_, index) => ({
    index,
    timeSeconds: index,
    confidence: index % 4 === 0 ? 1 : 0.72,
    isDownbeat: index % 4 === 0,
    barIndex: Math.floor(index / 4),
    beatInBar: index % 4 + 1,
  }));
  return {
    song: {
      id: 'editor-builder-fixture',
      title: 'Editor Builder Fixture',
      artist: 'Fixture Artist',
      audioUrl: './audio.mp3',
      durationSeconds: 32,
      bpm: 60,
      audioFingerprint: 'editor-builder-fixture-audio',
    },
    waveform: { peaks: [0.12, 0.18, 0.28, 0.34, 0.88, 0.94, 0.75, 0.64, 0.5, 0.42] },
    eventSources: [
      { id: 'beat-this', events: beats },
      {
        id: 'librosa-onset',
        events: [2.02, 6.01, 10.01, 14.01, 18.02, 22.01, 26.02, 30.01]
          .map((timeSeconds) => ({ timeSeconds, confidence: 0.82 })),
      },
      {
        id: 'basic-pitch',
        events: [1.2, 3.4, 5.5, 9.2, 10.8, 13.4, 17.2, 19.4, 25.2, 29.5]
          .map((timeSeconds, index) => ({
            timeSeconds,
            confidence: 0.76,
            midiPitch: 60 + index,
            durationSeconds: 0.25,
            polyphony: 1,
          })),
      },
    ],
    continuousPitch: {
      schemaVersion: '1.0.0',
      algorithm: 'librosa-pyin-harmonic-v1',
      sourceRole: 'estimated-melody',
      traces: [{
        id: 'f0-trace-001',
        startSeconds: 4.2,
        endSeconds: 4.8,
        confidence: 0.91,
        points: [
          { id: 'f0-00001', timeSeconds: 4.2, pitchMidi: 60, confidence: 0.9 },
          { id: 'f0-00002', timeSeconds: 4.5, pitchMidi: 64, confidence: 0.92 },
          { id: 'f0-00003', timeSeconds: 4.8, pitchMidi: 67, confidence: 0.91 },
        ],
      }],
      diagnostics: { voicedFrameCount: 3 },
    },
    musicalStructure: {
      beats,
      downbeats: beats.filter((beat) => beat.isDownbeat),
      sections: [
        { index: 0, id: 'S01', startSeconds: 0, endSeconds: 8, intensity: 0.18 },
        { index: 1, id: 'S02', startSeconds: 8, endSeconds: 16, intensity: 0.95 },
        { index: 2, id: 'S03', startSeconds: 16, endSeconds: 24, intensity: 0.58 },
        { index: 3, id: 'S04', startSeconds: 24, endSeconds: 32, intensity: 0.24 },
      ],
      phrases: [
        { index: 0, id: 'P01', familyId: 'FA', sectionIndex: 0, startSeconds: 0, endSeconds: 8, intensity: 0.2 },
        { index: 1, id: 'P02', familyId: 'FB', sectionIndex: 1, startSeconds: 8, endSeconds: 16, intensity: 0.9 },
        { index: 2, id: 'P03', familyId: 'FA', sectionIndex: 2, startSeconds: 16, endSeconds: 24, intensity: 0.55 },
        { index: 3, id: 'P04', familyId: 'FC', sectionIndex: 3, startSeconds: 24, endSeconds: 32, intensity: 0.25 },
      ],
      families: [
        { id: 'FA', kind: 'repeated', phraseIds: ['P01', 'P03'], occurrenceCount: 2, confidence: 0.94 },
        { id: 'FB', kind: 'unique-low-confidence', phraseIds: ['P02'], occurrenceCount: 1, confidence: 0.58 },
        { id: 'FC', kind: 'unique-low-confidence', phraseIds: ['P04'], occurrenceCount: 1, confidence: 0.61 },
      ],
      overlappingPhrases: [],
      overlappingPhraseFamilies: [],
      phraseLinks: [],
    },
  };
}

function analysisWithStemEvidence() {
  const analysis = measuredAnalysis();
  const unavailable = (role) => ({
    role,
    status: 'unavailable',
    checksum: '',
    timingEvents: [],
    pitchTraces: [],
    pitchLandmarks: [],
    accentEvents: [],
    diagnostics: ['fixture unavailable'],
  });
  analysis.stemEvidence = {
    kind: 'core4-stem-evidence',
    schemaVersion: '1.0.0',
    audioFingerprint: analysis.song.audioFingerprint,
    evidenceFingerprint: 'fixture-core4-evidence',
    timeOriginSeconds: 0,
    separator: { id: 'fixture', model: 'fixture-core4', version: '1', checksum: 'fixture' },
    manifest: { path: 'work/fixture/manifest.json' },
    stems: {
      vocals: {
        role: 'vocals',
        status: 'ready',
        checksum: 'vocals-fixture',
        timingEvents: [
          { id: 'syllable-a', timeSeconds: 7.25, confidence: 0.92, pitchMidi: 69 },
          { id: 'syllable-b', timeSeconds: 11.125, confidence: 0.88, pitchMidi: 71 },
        ],
        pitchTraces: [{
          id: 'vocal-f0',
          points: [{ id: 'f0-only', timeSeconds: 7.5, confidence: 0.9, pitchMidi: 70 }],
        }],
        pitchLandmarks: [{ id: 'turn-a', timeSeconds: 7.75, confidence: 0.84, pitchMidi: 72 }],
        accentEvents: [{ id: 'accent-only', timeSeconds: 7.6, confidence: 0.95 }],
        diagnostics: [],
      },
      drums: {
        role: 'drums',
        status: 'ready',
        checksum: 'drums-fixture',
        timingEvents: [{ id: 'kick-same-time', timeSeconds: 7.25, confidence: 0.96 }],
        pitchTraces: [],
        pitchLandmarks: [],
        accentEvents: [],
        diagnostics: [],
      },
      bass: unavailable('bass'),
      other: unavailable('other'),
    },
  };
  return analysis;
}

test('writes a compact editable base chart from measured attacks and isolated beat points', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-editor-builder-'));
  try {
    const analysis = measuredAnalysis();
    const expected = transcribePerformance(analysis, { travelSecondsPerLane: 0.08 });
    const inputPath = join(directory, 'analysis.json');
    const outputPath = join(directory, 'level.json');
    const authoringPath = join(directory, 'authoring.json');
    await writeFile(inputPath, `${JSON.stringify(analysis)}\n`);
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/build-rhythm-levels.mjs'), inputPath, outputPath, authoringPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const source = await readFile(outputPath, 'utf8');
    const level = JSON.parse(source);
    const authoring = JSON.parse(await readFile(authoringPath, 'utf8'));
    assert.equal(level.generation.algorithm, 'region-authoring-base-v1');
    assert.equal(authoring.kind, 'authoring-score');
    assert.equal(authoring.schemaVersion, '2.0.0');
    assert.equal(authoring.audioFingerprint, analysis.song.audioFingerprint);
    assert.ok(authoring.regions.length > 0);
    assert.ok(authoring.sources.some((candidate) => (
      candidate.id === 'melody-contour' && candidate.availability !== 'unavailable'
    )));
    assert.deepEqual(
      level.events.map((event) => event.timeSeconds),
      expected.attackEvents.map((event) => event.timeSeconds),
    );
    assert.deepEqual(
      level.events.map((event) => event.obstacles.indexOf(1)),
      expected.attackEvents.map((event) => event.lane),
    );
    assert.ok(level.rhythmPoints.length > level.events.length, 'isolated Beat This points remain editable');
    assert.ok(level.rhythmPoints.some((point) => point.kind === 'downbeat' && !point.hasBaseRow));
    const discreteTiming = authoring.evidenceStreams.timing
      .find((stream) => stream.id === 'discrete-melody')?.events[0];
    assert.ok(discreteTiming);
    assert.ok(level.rhythmPoints.some((point) => point.timeSeconds === discreteTiming.timeSeconds));
    assert.ok(!level.rhythmPoints.some((point) => point.timeSeconds === 4.5), 'lane-only F0 does not create a timing anchor');
    const rhythmPointTimes = new Set(level.rhythmPoints.map((point) => point.timeSeconds.toFixed(5)));
    const timingAnchorStreams = [
      ...authoring.evidenceStreams.timing,
      ...authoring.evidenceStreams.metric,
    ];
    for (const sourceCandidate of timingAnchorStreams.filter((candidate) => candidate.availability !== 'unavailable')) {
      for (const event of sourceCandidate.events) {
        assert.ok(
          rhythmPointTimes.has(event.timeSeconds.toFixed(5)),
          `${sourceCandidate.id}:${event.id} must have an editable Rhythm Point`,
        );
      }
    }
    assert.ok(level.events.every((event) => {
      const intent = event.hitSound;
      return event.kind === 'target'
        && typeof intent?.sourceRole === 'string'
        && Number.isInteger(intent.pitchClass)
        && intent.pitchClass >= 0
        && intent.pitchClass < 12
        && Number.isFinite(intent.velocity)
        && intent.velocity >= 0
        && intent.velocity <= 1
        && Number.isFinite(intent.gain)
        && intent.gain >= 0
        && intent.gain <= 1
        && Number.isFinite(intent.brightness)
        && intent.brightness >= 0
        && intent.brightness <= 1;
    }), 'every base Target keeps one compact HitSoundIntent');
    const pitchedTarget = level.events.find((event) => Number.isFinite(event.hitSound?.pitchMidi));
    if (pitchedTarget) {
      assert.equal(
        pitchedTarget.hitSound.pitchClass,
        ((Math.round(pitchedTarget.hitSound.pitchMidi) % 12) + 12) % 12,
      );
    }
    assert.ok(!Object.hasOwn(level.generation, 'performanceScore'));
    assert.ok(!Object.hasOwn(level.generation, 'directorScore'));
    assert.ok(!Object.hasOwn(level.generation, 'authoringScore'));
    assert.equal(level.generation.authoringAlgorithm, authoring.algorithm);
    assert.equal(level.generation.authoringRegionCount, authoring.regions.length);
    assert.equal(
      level.generation.authoringEventCount,
      authoring.sources.reduce((count, candidate) => count + candidate.events.length, 0),
    );
    assert.ok(source.length < 100_000, 'fixture output should stay compact');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writes authoring.json beside the level when no explicit path is supplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-default-authoring-'));
  try {
    const inputPath = join(directory, 'analysis.json');
    const outputPath = join(directory, 'level.json');
    await writeFile(inputPath, `${JSON.stringify(measuredAnalysis())}\n`);

    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/build-rhythm-levels.mjs'), inputPath, outputPath],
      { cwd: root, encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const authoring = JSON.parse(await readFile(join(directory, 'authoring.json'), 'utf8'));
    assert.equal(authoring.kind, 'authoring-score');
    assert.equal(authoring.audioFingerprint, measuredAnalysis().song.audioFingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('adds every separated-stem timing anchor without turning lane or accent evidence into Rhythm Points', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-stem-builder-'));
  try {
    const analysis = analysisWithStemEvidence();
    const inputPath = join(directory, 'analysis.json');
    const outputPath = join(directory, 'level.json');
    const authoringPath = join(directory, 'authoring.json');
    await writeFile(inputPath, `${JSON.stringify(analysis)}\n`);

    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/build-rhythm-levels.mjs'), inputPath, outputPath, authoringPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const level = JSON.parse(await readFile(outputPath, 'utf8'));
    const authoring = JSON.parse(await readFile(authoringPath, 'utf8'));
    assert.equal(authoring.evidenceFingerprint, 'fixture-core4-evidence');
    assert.ok(authoring.evidenceStreams.timing.some((stream) => stream.id === 'stem:vocals:timing'));
    assert.ok(authoring.evidenceStreams.lane.some((stream) => stream.id === 'stem:vocals:pitch'));
    const pointsAt = (timeSeconds) => level.rhythmPoints.filter((point) => point.timeSeconds === timeSeconds);
    assert.equal(pointsAt(7.25).length, 1, 'two stem sources at one attack remain one editable anchor');
    assert.equal(pointsAt(7.75).length, 1, 'pitch landmarks explicitly classified as timing are anchors');
    assert.equal(pointsAt(11.125).length, 1);
    assert.equal(pointsAt(7.5).length, 0, 'continuous F0 lane samples cannot create Targets');
    assert.equal(pointsAt(7.6).length, 0, 'accent-only evidence attaches to a Target instead of creating one');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('level check rejects a Target created only from an F0 lane sample', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-stem-level-check-'));
  try {
    const analysis = analysisWithStemEvidence();
    const inputPath = join(directory, 'analysis.json');
    const levelPath = join(directory, 'level.json');
    const authoringPath = join(directory, 'authoring.json');
    const editsPath = join(directory, 'edits.json');
    await writeFile(inputPath, `${JSON.stringify(analysis)}\n`);
    const built = spawnSync(
      process.execPath,
      [join(root, 'scripts/build-rhythm-levels.mjs'), inputPath, levelPath, authoringPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);
    await writeFile(editsPath, JSON.stringify({
      version: 3,
      levelId: 'editor-builder-fixture-flow',
      baseFingerprint: analysis.song.audioFingerprint,
      evidenceFingerprint: analysis.stemEvidence.evidenceFingerprint,
      arrangements: [],
      rowOverrides: [],
      colorRanges: [],
    }));

    const valid = spawnSync(
      process.execPath,
      [join(root, 'scripts/level-check.mjs'), levelPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);

    const invalid = JSON.parse(await readFile(levelPath, 'utf8'));
    invalid.rhythmPoints.push({
      id: 'illegal-f0-row',
      timeSeconds: 7.5,
      suggestedLane: 2,
      kind: 'pitch',
      strength: 0.9,
      pitchMidi: 70,
      sourceRole: 'vocals',
      hasBaseRow: true,
    });
    invalid.rhythmPoints.sort((left, right) => left.timeSeconds - right.timeSeconds);
    invalid.events.push({
      timeSeconds: 7.5,
      obstacles: [0, 0, 1, 0, 0],
      kind: 'target',
      hitSound: {
        sourceRole: 'vocals', pitchMidi: 70, pitchClass: 10,
        velocity: 0.9, gain: 0.5, brightness: 0.65,
      },
    });
    invalid.events.sort((left, right) => left.timeSeconds - right.timeSeconds);
    invalid.generation.noteCount = invalid.events.length;
    invalid.generation.rhythmPointCount = invalid.rhythmPoints.length;
    await writeFile(levelPath, `${JSON.stringify(invalid)}\n`);
    const rejected = spawnSync(
      process.execPath,
      [join(root, 'scripts/level-check.mjs'), levelPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stderr}\n${rejected.stdout}`, /timing anchor/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
