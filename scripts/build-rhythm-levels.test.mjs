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

test('writes a compact editable base chart from measured attacks and isolated beat points', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-editor-builder-'));
  try {
    const analysis = measuredAnalysis();
    const expected = transcribePerformance(analysis, { travelSecondsPerLane: 0.08 });
    const inputPath = join(directory, 'analysis.json');
    const outputPath = join(directory, 'level.json');
    await writeFile(inputPath, `${JSON.stringify(analysis)}\n`);
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/build-rhythm-levels.mjs'), inputPath, outputPath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const source = await readFile(outputPath, 'utf8');
    const level = JSON.parse(source);
    assert.equal(level.generation.algorithm, 'measured-pitch-base-v1');
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
    assert.ok(level.events.every((event) => !Object.hasOwn(event, 'hitSound')));
    assert.ok(!Object.hasOwn(level.generation, 'performanceScore'));
    assert.ok(!Object.hasOwn(level.generation, 'directorScore'));
    assert.ok(source.length < 100_000, 'fixture output should stay compact');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
