import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveLayoutIntent } from './layout-intent.mjs';

function events(times, pitches) {
  return times.map((timeSeconds, index) => ({
    timeSeconds,
    confidence: 0.9,
    midiPitch: pitches?.[index],
    pitchMin: pitches?.[index],
    pitchMax: pitches?.[index],
  }));
}

function fixture({ includePitch = true } = {}) {
  const pitchEvents = includePitch ? [
    ...events([0.5, 2, 4, 6.5], [60, 63, 66, 69]),
    ...events([16.5, 18, 20, 22.5], [72, 75, 78, 81]),
    ...events([8.4, 9.8, 11.2, 12.6, 14.2], [62, 69, 62, 69, 62]),
    ...events([24.5, 26, 28, 30.5], [72, 68, 64, 60]),
  ] : [];
  const beatEvents = Array.from({ length: 80 }, (_, index) => ({ timeSeconds: index * 0.4 }));
  const onsetEvents = Array.from({ length: 36 }, (_, index) => ({ timeSeconds: index * 0.85 }));
  return {
    song: { durationSeconds: 32, bpm: 150, audioFingerprint: 'fixture-audio-1234' },
    waveform: { peaks: [0.15, 0.2, 0.34, 0.4, 0.75, 0.95, 0.7, 0.35] },
    eventSources: [
      { id: 'librosa-onset', events: onsetEvents },
      { id: 'basic-pitch', events: pitchEvents },
      { id: 'beat-this', events: beatEvents },
    ],
    musicalStructure: {
      sections: [
        { index: 0, id: 'S01', startSeconds: 0, endSeconds: 8, startBarIndex: 0, endBarIndex: 4, intensity: 0.2 },
        { index: 1, id: 'S02', startSeconds: 8, endSeconds: 16, startBarIndex: 4, endBarIndex: 8, intensity: 0.15 },
        { index: 2, id: 'S03', startSeconds: 16, endSeconds: 24, startBarIndex: 8, endBarIndex: 12, intensity: 0.95 },
        { index: 3, id: 'S04', startSeconds: 24, endSeconds: 32, startBarIndex: 12, endBarIndex: 16, intensity: 0.35 },
      ],
      phrases: [
        { id: 'P01', familyId: 'FA', sectionIndex: 0, startSeconds: 0, endSeconds: 8 },
        { id: 'P02', familyId: 'FB', sectionIndex: 1, startSeconds: 8, endSeconds: 16 },
        { id: 'P03', familyId: 'FA', sectionIndex: 2, startSeconds: 16, endSeconds: 24 },
        { id: 'P04', familyId: 'FC', sectionIndex: 3, startSeconds: 24, endSeconds: 32 },
      ],
    },
  };
}

test('derives continuous song weights and stable section roles from measured activity', () => {
  const analysis = fixture();
  const intent = deriveLayoutIntent(analysis);
  const weightTotal = Object.values(intent.songProfile.weights).reduce((sum, value) => sum + value, 0);

  assert.ok(Math.abs(weightTotal - 1) < 0.001);
  assert.match(intent.songProfile.dominantStyle, /^(melodic|percussive|rhythmic)-drive|balanced-flow$/);
  assert.equal(intent.sections[0].role, 'intro');
  assert.equal(intent.sections[2].role, 'peak');
  assert.equal(intent.sections[3].role, 'outro');
  assert.ok(intent.sections.every((section) => section.motifBias.length >= 4));
});

test('forms pitch-contour consensus per phrase family after removing transposition', () => {
  const intent = deriveLayoutIntent(fixture());
  const rising = intent.families.find((family) => family.familyId === 'FA');
  const oscillating = intent.families.find((family) => family.familyId === 'FB');
  const falling = intent.families.find((family) => family.familyId === 'FC');

  assert.deepEqual(rising.occurrencePhraseIds, ['P01', 'P03']);
  assert.equal(rising.contour.kind, 'rising');
  assert.equal(rising.contour.analyzedOccurrenceCount, 2);
  assert.ok(rising.contour.slope > 7);
  assert.equal(rising.preferredTransform, 'identity');
  assert.ok(rising.motifBias.includes('stairs'));

  assert.equal(oscillating.contour.kind, 'oscillating');
  assert.ok(oscillating.motifBias.includes('s'));

  assert.equal(falling.contour.kind, 'falling');
  assert.ok(falling.contour.slope < -10);
  assert.equal(falling.preferredTransform, 'mirror');
});

test('degrades deterministically when Basic Pitch has no usable pitch metadata', () => {
  const analysis = fixture({ includePitch: false });
  const before = JSON.stringify(analysis);
  const first = deriveLayoutIntent(analysis);
  const second = deriveLayoutIntent(analysis);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(analysis), before, 'deriveLayoutIntent must not mutate its input');
  assert.ok(first.families.every((family) => family.contour.kind === 'unknown'));
  assert.ok(first.families.every((family) => family.contour.confidence === 0));
  assert.ok(first.families.every((family) => ['identity', 'mirror'].includes(family.preferredTransform)));
  assert.ok(first.families.every((family) => family.transformReason === 'audio-fingerprint-fallback'));
  assert.ok(first.families.every((family) => family.motifBias.length > 0));
});

test('ignores display metadata while keeping audio identity as the deterministic tie-break', () => {
  const original = fixture({ includePitch: false });
  const renamed = structuredClone(original);
  renamed.song.id = 'another-id';
  renamed.song.title = 'Another title';

  assert.deepEqual(deriveLayoutIntent(renamed), deriveLayoutIntent(original));
});

test('derives the same family intent when phrase occurrences arrive out of order', () => {
  const original = fixture();
  const shuffled = structuredClone(original);
  shuffled.musicalStructure.phrases.reverse();

  assert.deepEqual(deriveLayoutIntent(shuffled).families, deriveLayoutIntent(original).families);
});

test('returns a safe empty intent for incomplete analysis', () => {
  assert.deepEqual(deriveLayoutIntent(null), {
    songProfile: {
      dominantStyle: 'balanced-flow',
      weights: { melodic: 0, percussive: 0, rhythmic: 0 },
      eventRatesPerMinute: { basicPitch: 0, librosaOnset: 0, beatThis: 0 },
    },
    sections: [],
    families: [],
  });
});
