import assert from 'node:assert/strict';
import test from 'node:test';

import { densityFillCount, planDensityInterval } from './density-planner.mjs';

const event = (obstacles, pattern, pressure = 0.5) => ({
  obstacles,
  pattern,
  pressure,
  phraseId: 'phrase-1',
  _sectionIndex: 2,
});

test('fills the safe bridge between two anchors without blocking either route', () => {
  assert.deepEqual(
    planDensityInterval(
      event([2, 2, 0, 0, 2], 's'),
      event([2, 0, 0, 2, 2], 's'),
    ),
    { mode: 'compact', obstacles: [2, 0, 0, 0, 2], allowedLanes: [1, 2, 3] },
  );
});

test('uses solid fill for waves and preserves intentionally sparse gestures', () => {
  const wave = planDensityInterval(
    event([2, 0, 0, 2, 2], 'wave', 0.2),
    event([2, 2, 0, 0, 2], 'wave', 0.2),
  );
  assert.equal(wave.mode, 'solid');
  assert.equal(densityFillCount(0.4, wave.mode), 9);
  assert.equal(planDensityInterval(event([2, 2, 2, 0, 0], 'm'), event([1, 0, 0, 0, 0], 'm')), null);
});

test('widens a single middle safe lane to match collision width', () => {
  assert.deepEqual(
    planDensityInterval(event([2, 2, 0, 2, 2], 'pulse'), event([2, 2, 1, 2, 2], 'pulse')),
    { mode: 'compact', obstacles: [2, 0, 0, 2, 2], allowedLanes: [1, 2] },
  );
});
