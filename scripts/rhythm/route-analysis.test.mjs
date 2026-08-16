import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeEdgeSweepWindow,
  analyzeRouteGraph,
  findLiteralMGestures,
} from './route-analysis.mjs';

test('counts every globally viable target as a real route branch', () => {
  const analysis = analyzeRouteGraph([
    { timeSeconds: 0.5, kind: 'target', obstacles: [1, 0, 1, 0, 0] },
    { timeSeconds: 1, kind: 'target', obstacles: [1, 0, 1, 0, 0] },
  ]);

  assert.equal(analysis.feasible, true);
  assert.equal(analysis.pathCountCapped, 4);
  assert.deepEqual(analysis.globallyViableLanesByRow, [[0, 2], [0, 2]]);
  assert.deepEqual(analysis.globallyViableTransitionsByRow, [[], [
    { fromLane: 0, toLane: 0 },
    { fromLane: 0, toLane: 2 },
    { fromLane: 2, toLane: 0 },
    { fromLane: 2, toLane: 2 },
  ]]);
  assert.deepEqual(analysis.meaningfulChoiceRows, [0, 1]);
  assert.equal(analysis.multiTargetChoiceRowCount, 2);
  assert.equal(analysis.wideChoiceRowCount, 2);
  assert.equal(analysis.maximumConsecutiveChoiceRows, 2);
  assert.equal(analysis.consecutiveChoicePairs.length, 1);
  assert.deepEqual(analysis.deadChoiceCells, []);
});

test('reports a displayed target that cannot belong to any full-combo route', () => {
  const analysis = analyzeRouteGraph([
    { timeSeconds: 0.1, kind: 'target', obstacles: [0, 0, 1, 0, 1] },
    { timeSeconds: 0.2, kind: 'target', obstacles: [0, 0, 1, 0, 0] },
  ]);

  assert.equal(analysis.feasible, true);
  assert.deepEqual(analysis.globallyViableLanesByRow, [[2], [2]]);
  assert.deepEqual(analysis.deadChoiceCells, [{ rowIndex: 0, lane: 4 }]);
  assert.deepEqual(analysis.deadAllowedCells, [{ rowIndex: 0, lane: 4 }]);
  assert.equal(analysis.meaningfulChoiceRows.length, 0);
});

test('treats a hazard-only gate as safe lanes and a target row as any-of lanes', () => {
  const analysis = analyzeRouteGraph([
    { timeSeconds: 0.3, kind: 'dodge', obstacles: [2, 2, 2, 0, 0] },
    { timeSeconds: 0.53, kind: 'target', obstacles: [1, 0, 0, 1, 0] },
  ]);

  assert.equal(analysis.feasible, true);
  assert.deepEqual(analysis.globallyViableLanesByRow, [[3], [3]]);
  assert.deepEqual(analysis.deadChoiceCells, [{ rowIndex: 1, lane: 0 }]);
  assert.deepEqual(analysis.referenceRoute, [3, 3]);
});

test('finds only literal uninterrupted M rows from the visible core event stream', () => {
  const makeM = (tokens) => tokens.map((token, index) => ({
    timeSeconds: 1 + index,
    kind: index % 2 === 0 ? 'dodge' : 'target',
    layer: 'core',
    pattern: 'm',
    obstacles: [...token].map(Number),
  }));
  const identity = ['00222', '00001', '22200', '00001', '00222', '00001'];
  const mirror = identity.map((token) => [...token].reverse().join(''));

  assert.deepEqual(findLiteralMGestures(makeM(identity)).map((gesture) => gesture.orientation), ['identity']);
  assert.deepEqual(findLiteralMGestures(makeM(mirror)).map((gesture) => gesture.orientation), ['mirror']);

  const interrupted = makeM(identity);
  interrupted.splice(3, 0, {
    timeSeconds: 3.5,
    kind: 'target',
    layer: 'overlay',
    pattern: 'melody',
    obstacles: [1, 0, 0, 0, 0],
  });
  assert.deepEqual(findLiteralMGestures(interrupted), []);
});

test('measures forced edge-to-edge strokes across intermediate safe rows', () => {
  const events = [
    { timeSeconds: 0.3, kind: 'target', obstacles: [1, 0, 0, 0, 0] },
    { timeSeconds: 0.5, kind: 'dodge', obstacles: [0, 0, 0, 0, 0] },
    { timeSeconds: 0.8, kind: 'target', obstacles: [0, 0, 0, 0, 1] },
    { timeSeconds: 1, kind: 'dodge', obstacles: [0, 0, 0, 0, 0] },
    { timeSeconds: 1.3, kind: 'target', obstacles: [1, 0, 0, 0, 0] },
  ];
  const routes = analyzeRouteGraph(events, { secondsPerLane: 0.1, requireCombo: true });
  const sweep = analyzeEdgeSweepWindow(events, routes, {
    startSeconds: 0,
    endSeconds: 2,
    maxStrokeSeconds: 0.6,
  });

  assert.equal(routes.feasible, true);
  assert.deepEqual(sweep.forcedEdgeRows.map((row) => row.lane), [0, 4, 0]);
  assert.equal(sweep.edgeToEdgeStrokes.length, 2);
  assert.equal(sweep.maximumAlternatingEdgeHits, 3);
  assert.equal(sweep.maximumAlternatingEdgeStrokeCount, 2);
  assert.equal(sweep.centerOnlyRouteExists, false);
});

test('does not mistake optional edge notes for a forced full-width sweep', () => {
  const events = [
    { timeSeconds: 0.3, kind: 'target', obstacles: [1, 0, 1, 0, 0] },
    { timeSeconds: 0.8, kind: 'target', obstacles: [0, 0, 1, 0, 1] },
    { timeSeconds: 1.3, kind: 'target', obstacles: [1, 0, 1, 0, 0] },
  ];
  const routes = analyzeRouteGraph(events, { secondsPerLane: 0.1, requireCombo: true });
  const sweep = analyzeEdgeSweepWindow(events, routes, {
    startSeconds: 0,
    endSeconds: 2,
    maxStrokeSeconds: 0.6,
  });

  assert.equal(routes.feasible, true);
  assert.deepEqual(sweep.forcedEdgeRows, []);
  assert.equal(sweep.edgeToEdgeStrokes.length, 0);
  assert.equal(sweep.centerOnlyRouteExists, true);
});

test('keeps an alternating run readable across repeated hits on one edge', () => {
  const events = [
    { timeSeconds: 0.3, kind: 'target', obstacles: [1, 0, 0, 0, 0] },
    { timeSeconds: 0.7, kind: 'target', obstacles: [0, 0, 0, 0, 1] },
    { timeSeconds: 0.8, kind: 'target', obstacles: [0, 0, 0, 0, 1] },
    { timeSeconds: 1.2, kind: 'target', obstacles: [1, 0, 0, 0, 0] },
  ];
  const routes = analyzeRouteGraph(events, { secondsPerLane: 0.1, requireCombo: true });
  const sweep = analyzeEdgeSweepWindow(events, routes, {
    startSeconds: 0,
    endSeconds: 2,
    maxStrokeSeconds: 0.6,
  });

  assert.equal(sweep.maximumAlternatingEdgeHits, 3);
  assert.deepEqual(sweep.alternatingRuns[0].map((row) => row.rowIndex), [0, 2, 3]);
  assert.equal(sweep.edgeToEdgeStrokes.length, 2);
});
