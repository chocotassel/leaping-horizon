import assert from 'node:assert/strict';
import test from 'node:test';

import { adoptAuthoringSuggestions } from './adopt-authoring-suggestions.mjs';

test('adopts v2 presets in Region order while preserving manual rows and colors', () => {
  const level = {
    id: 'fixture-flow',
    song: { durationSeconds: 8 },
    rhythmPoints: [{ timeSeconds: 1 }],
  };
  const score = {
    kind: 'authoring-score',
    schemaVersion: '2.0.0',
    levelId: 'fixture-flow',
    audioFingerprint: 'audio-1',
    evidenceFingerprint: 'evidence-1',
    regions: [
      { id: 'region-b', startSeconds: 4, endSeconds: 8 },
      { id: 'region-a', startSeconds: 0, endSeconds: 4 },
    ],
    suggestions: [
      { regionId: 'region-a', preset: { mode: 'rest' }, reasonCodes: [] },
      {
        regionId: 'region-b',
        preset: {
          mode: 'play',
          timingLayers: [{ sourceId: 'stem:drums:timing', role: 'target', weight: 1 }],
          laneDriver: { kind: 'gesture', pattern: 'alternating', motion: 0.7 },
          density: 0.7,
          challenge: 0.3,
          feel: 'natural',
          maxGapBeats: 2,
        },
        reasonCodes: [],
      },
    ],
  };
  const oldEdits = {
    version: 2,
    levelId: 'fixture-flow',
    arrangements: [{ id: 'old', regionId: 'region-a' }],
    rowOverrides: [{ timeSeconds: 1, obstacles: [0, 0, 1, 0, 0] }],
    colorRanges: [{ id: 'color', startSeconds: 0, endSeconds: 8, colorSchemeId: 'redWhite' }],
  };

  const adopted = adoptAuthoringSuggestions(level, score, oldEdits);

  assert.equal(adopted.version, 3);
  assert.equal(adopted.baseFingerprint, 'audio-1');
  assert.equal(adopted.evidenceFingerprint, 'evidence-1');
  assert.deepEqual(adopted.arrangements.map((recipe) => [recipe.id, recipe.regionId, recipe.mode]), [
    ['recipe:region-a', 'region-a', 'rest'],
    ['recipe:region-b', 'region-b', 'play'],
  ]);
  assert.deepEqual(adopted.rowOverrides, oldEdits.rowOverrides);
  assert.deepEqual(adopted.colorRanges, oldEdits.colorRanges);
  assert.notEqual(adopted.rowOverrides, oldEdits.rowOverrides);
});
