import assert from 'node:assert/strict';
import test from 'node:test';

import { densityFillCount, planDensityInterval } from './density-planner.mjs';

const event = (obstacles, pattern, pressure = 0.8, overrides = {}) => ({
  obstacles,
  pattern,
  pressure,
  phraseId: 'phrase-1',
  _sectionIndex: 2,
  ...overrides,
});

test('fills the safe bridge between two anchors without blocking either route', () => {
  assert.deepEqual(
    planDensityInterval(
      event([2, 2, 0, 0, 2], 's'),
      event([2, 0, 0, 2, 2], 's'),
    ),
    { kind: 'guide', mode: 'compact', obstacles: [2, 0, 0, 0, 2], allowedLanes: [1, 2, 3] },
  );
});

test('uses solid fill for waves and preserves intentionally sparse gestures', () => {
  const wave = planDensityInterval(
    event([2, 0, 0, 2, 2], 'wave', 0.2, { kind: 'dodge' }),
    event([2, 2, 0, 0, 2], 'wave', 0.2, { kind: 'dodge' }),
  );
  assert.equal(wave.mode, 'solid');
  assert.equal(planDensityInterval(event([2, 2, 2, 0, 0], 'm'), event([1, 0, 0, 0, 0], 'm')), null);
});

test('reserves solid fill for Wave Gates rather than ordinary rows named wave', () => {
  assert.equal(planDensityInterval(
    event([2, 0, 0, 2, 2], 'wave', 0.2, { kind: 'target' }),
    event([2, 2, 0, 0, 2], 'wave', 0.2, { kind: 'target' }),
  ), null);
});

test('does not extend solid fill beyond the end of a Wave Gate', () => {
  assert.equal(planDensityInterval(
    event([2, 0, 0, 2, 2], 'wave', 0.2, { kind: 'dodge' }),
    event([2, 2, 0, 0, 2], 'drive', 0.2, { kind: 'dodge' }),
  ), null);
});

test('allows an explicitly sustained wall to request solid guide rows', () => {
  const plan = planDensityInterval(
    event([2, 0, 0, 0, 2], 'hold', 0.2, { sustainedWall: true }),
    event([2, 2, 0, 0, 0], 'hold', 0.2, { sustainedWall: true }),
  );

  assert.equal(plan?.mode, 'solid');
});

test('keeps ordinary high-pressure passages compact instead of turning them into solid walls', () => {
  const plan = planDensityInterval(
    event([2, 0, 0, 0, 2], 'drive', 0.95),
    event([2, 2, 0, 0, 0], 'drive', 0.95),
  );

  assert.equal(plan?.mode, 'compact');
});

test('leaves ordinary medium-pressure passages free of interpolated guide rows', () => {
  assert.equal(planDensityInterval(
    event([2, 0, 0, 0, 2], 'drive', 0.6),
    event([2, 2, 0, 0, 0], 'drive', 0.6),
  ), null);
});

test('emits far fewer guide rows than the legacy 40/220 ms density fill', () => {
  assert.deepEqual({
    solid: densityFillCount(1, 'solid'),
    compact: densityFillCount(1, 'compact'),
  }, {
    solid: 8,
    compact: 2,
  });
});

test('widens a single middle safe lane to match collision width', () => {
  assert.deepEqual(
    planDensityInterval(event([2, 2, 0, 2, 2], 'pulse'), event([2, 2, 1, 2, 2], 'pulse')),
    { kind: 'guide', mode: 'compact', obstacles: [2, 0, 0, 2, 2], allowedLanes: [1, 2] },
  );
});
