import assert from 'node:assert/strict';
import { getStarProgress } from '../node_modules/.cache/leaping-horizon-stars-check/game/stars.js';

assert.deepEqual(
  getStarProgress({ hits: 10, total: 100, doubleHitRows: 1, totalMultiTargetRows: 10 }, 0.1),
  [1 / 7, 0, 0, 0, 0],
  'only the leftmost pending star should show the fastest progress',
);

assert.deepEqual(
  getStarProgress({ hits: 70, total: 100, doubleHitRows: 7, totalMultiTargetRows: 10 }, 0.7),
  [1, 7 / 9, 0, 0, 0],
  'the next star should start only after the previous star reaches 100%',
);

assert.deepEqual(
  getStarProgress({ hits: 100, total: 100, doubleHitRows: 5, totalMultiTargetRows: 10 }, 1),
  [1, 1, 1, 1, 0.5],
  'completed stars should stay full while the next-fastest goal fills the next slot',
);

