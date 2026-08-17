import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWaveRows } from './wave-planner.mjs';

const tokens = (rows) => rows.map((row) => row.join(''));

test('generates the two-wall wave from the shared depth rule', () => {
  assert.deepEqual(tokens(buildWaveRows({ length: 5 })), [
    '20022', '22002', '22200', '22002', '20022',
  ]);
});

test('mirrors the wave without a second template', () => {
  assert.deepEqual(tokens(buildWaveRows({ length: 5, mirror: true })), [
    '22002', '20022', '00222', '20022', '22002',
  ]);
});

test('splices waves by extending the depth cycle through the shared trough', () => {
  assert.deepEqual(tokens(buildWaveRows({ length: 9 })), [
    '20022', '22002', '22200', '22002', '20022',
    '22002', '22200', '22002', '20022',
  ]);
});
