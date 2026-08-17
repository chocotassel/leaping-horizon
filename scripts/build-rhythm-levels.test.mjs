import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

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
      id: 'performance-builder-fixture',
      title: 'Performance Builder Fixture',
      artist: 'Fixture Artist',
      audioUrl: './audio.mp3',
      durationSeconds: 32,
      bpm: 60,
      audioFingerprint: 'performance-builder-fixture-audio',
    },
    primaryEventSourceId: 'beat-this',
    timingPolicy: 'measured-fixture-times',
    waveform: {
      peaks: [0.12, 0.18, 0.28, 0.34, 0.88, 0.94, 0.75, 0.64, 0.5, 0.42, 0.25, 0.18],
    },
    eventSources: [
      { id: 'beat-this', events: beats },
      {
        id: 'librosa-onset',
        events: [2.02, 6.01, 8.02, 10.01, 12.02, 14.01, 18.02, 22.01, 26.02, 30.01]
          .map((timeSeconds, index) => ({ timeSeconds, confidence: index === 2 ? 1 : 0.82 })),
      },
      {
        id: 'basic-pitch',
        events: [1.2, 3.4, 5.5, 9.2, 10.8, 13.4, 17.2, 19.4, 21.5, 25.2, 27.4, 29.5]
          .map((timeSeconds, index) => ({
            timeSeconds,
            confidence: 0.76,
            midiPitch: 60 + index,
            durationSeconds: 0.25,
            polyphony: 1,
          })),
      },
    ],
    musicalStructure: {
      algorithm: 'fixture-measured-structure-v1',
      timingPolicy: 'measured-boundaries',
      beats,
      downbeats: beats.filter((beat) => beat.isDownbeat),
      sections: [
        { index: 0, id: 'S01', startSeconds: 0, endSeconds: 8, intensity: 0.18, boundarySupport: 1 },
        { index: 1, id: 'S02', startSeconds: 8, endSeconds: 16, intensity: 0.95, boundarySupport: 0.96, harmonicNovelty: 0.9 },
        { index: 2, id: 'S03', startSeconds: 16, endSeconds: 24, intensity: 0.58, boundarySupport: 0.55 },
        { index: 3, id: 'S04', startSeconds: 24, endSeconds: 32, intensity: 0.24, boundarySupport: 0.9 },
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
      phraseLinks: [
        { sourcePhraseId: 'P01', targetPhraseId: 'P03', relationship: 'same-family', similarity: 0.94 },
      ],
    },
  };
}

function attackEvent(id, timeSeconds, lane, pitchMidi, traceIndex) {
  return {
    id,
    timeSeconds,
    lane,
    pitchMidi,
    pitchClass: pitchMidi % 12,
    sourceRole: 'melody',
    strength: 0.86,
    evidenceIds: [`basic-pitch:${id}`],
    phraseId: 'fixture-phrase',
    phraseIds: ['fixture-phrase'],
    continuity: {
      traceId: 'fixture-trace',
      index: traceIndex,
      length: 5,
      previousEventId: traceIndex > 0 ? `attack-${traceIndex}` : null,
      nextEventId: traceIndex < 4 ? `attack-${traceIndex + 2}` : null,
      direction: traceIndex % 2 === 0 ? 'up' : 'down',
      intervalSemitones: traceIndex === 0 ? 0 : (traceIndex % 2 === 0 ? -2 : 2),
      sustained: false,
    },
    hitSound: {
      pitchMidi,
      pitchClass: pitchMidi % 12,
      sourceRole: 'melody',
      velocity: 0.86,
      gain: 0.2,
      brightness: 0.62,
    },
  };
}

test('Performance Score is authoritative for core Target Row timing and lane contour', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-performance-builder-'));
  try {
    const analysis = measuredAnalysis();
    const expected = [
      attackEvent('attack-1', 10.12345, 0, 60, 0),
      attackEvent('attack-2', 10.25345, 1, 62, 1),
      attackEvent('attack-3', 10.38345, 0, 60, 2),
      attackEvent('attack-4', 10.51345, 1, 62, 3),
      attackEvent('attack-5', 10.64345, 0, 60, 4),
    ];
    analysis.performanceScore = {
      schemaVersion: '1.0.0',
      kind: 'performance-score',
      algorithm: 'fixture-performance-transcriber-v1',
      audioFingerprint: analysis.song.audioFingerprint,
      attackEvents: expected,
      melodicTraces: [{
        id: 'fixture-trace',
        phraseId: 'fixture-phrase',
        startSeconds: expected[0].timeSeconds,
        endSeconds: expected.at(-1).timeSeconds,
        sourceRole: 'melody',
        attackEventIds: expected.map((event) => event.id),
        laneContour: expected.map((event) => event.lane),
        pitchContour: expected.map((event) => event.pitchMidi),
        contourKind: 'oscillating',
        evidenceIds: expected.flatMap((event) => event.evidenceIds),
      }],
      diagnostics: {},
    };

    const inputPath = join(directory, 'analysis.json');
    const outputPath = join(directory, 'level.json');
    await writeFile(inputPath, `${JSON.stringify(analysis)}\n`);
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'build-rhythm-levels.mjs'), inputPath, outputPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const level = JSON.parse(await readFile(outputPath, 'utf8'));
    const targets = level.events.filter((event) => event.kind === 'target');
    assert.deepEqual(targets.map((event) => event.performanceEventId), expected.map((event) => event.id));
    assert.deepEqual(targets.map((event) => event.timeSeconds), expected.map((event) => event.timeSeconds));
    assert.deepEqual(targets.map((event) => event.obstacles.indexOf(1)), expected.map((event) => event.lane));
    assert.ok(targets.every((event) => event.obstacles.filter((cell) => cell === 1).length === 1));
    assert.deepEqual(targets.map((event) => event.melodicTraceId), Array(5).fill('fixture-trace'));
    assert.deepEqual(targets.map((event) => event.hitSound), expected.map((event) => event.hitSound));
    assert.ok(level.events.every((event) => event.kind !== 'guide' || !event.obstacles.includes(1)));
    assert.equal(level.generation.performanceAttackEventCount, 5);
    assert.equal(level.generation.performanceTargetRowCount, 5);
    assert.equal(level.generation.performanceScore.diagnostics.compilation.omittedAttackEventCount, 0);
    assert.equal(level.generation.realizationReceipt.targetAuthority, 'performance-score');
    assert.ok(level.generation.realizationReceipt.phraseIdentities.every((identity) => (
      identity.supersededByPerformanceScore === true
    )));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('automatically transcribes real analysis without dropping or adding core Target Rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-performance-fallback-'));
  try {
    const inputPath = join(directory, 'analysis.json');
    const outputPath = join(directory, 'level.json');
    await writeFile(inputPath, `${JSON.stringify(measuredAnalysis())}\n`);
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'build-rhythm-levels.mjs'), inputPath, outputPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const level = JSON.parse(await readFile(outputPath, 'utf8'));
    const performanceScore = level.generation.performanceScore;
    const targets = level.events.filter((event) => event.kind === 'target');
    assert.equal(performanceScore.kind, 'performance-score');
    assert.equal(performanceScore.diagnostics.compilation.omittedAttackEventCount, 0);
    assert.equal(performanceScore.diagnostics.compilation.mergedAttackEventCount, 0);
    assert.equal(targets.length, performanceScore.attackEvents.length);
    assert.deepEqual(
      targets.map((event) => event.performanceEventId),
      performanceScore.attackEvents.map((event) => event.id),
    );
    assert.deepEqual(
      targets.map((event) => event.timeSeconds),
      performanceScore.attackEvents.map((event) => event.timeSeconds),
    );
    assert.deepEqual(
      targets.map((event) => event.obstacles.indexOf(1)),
      performanceScore.attackEvents.map((event) => event.lane),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
