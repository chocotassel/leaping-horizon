import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const source = await readFile(resolve('node_modules/.cache/leaping-horizon-physics-check/physics.js'), 'utf8');
const physics = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

assert.equal(physics.overlapsPlayer(0, 0), true);
assert.equal(physics.overlapsPlayer(0, 0.949), true);
assert.equal(physics.overlapsPlayer(0, 0.95), false);
assert.equal(physics.overlapsPlayer(-1.9999999999999998, -1), false);
assert.equal(physics.moveTowards(0, 2, 0.4), 0.4);
assert.equal(physics.moveTowards(2, -2, 0.5), 1.5);
assert.equal(physics.moveTowards(0, 0.2, 0.4), 0.2);
assert.ok(physics.getObstacleZ(-0.1) - physics.PLAYER_Z > 2);
assert.equal(physics.shouldRenderObstacle('miss'), true);
assert.equal(physics.shouldRenderObstacle('hit'), false);
assert.equal(physics.getRingApproach(38, 40.5, 38.1), 0);
assert.equal(physics.getRingApproach(38.1, 40.5, 38.1), 0);
assert.equal(physics.getRingApproach(40.5, 40.5, 38.1), 1);
assert.equal(physics.getRingApproach(38.49, 40.5, 40), 0);
assert.ok(physics.getRingApproach(39.5, 40.5, 40) > 0);

const vite = await createServer({
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});
try {
  const { countChoiceRows, resolveEventRow } = await vite.ssrLoadModule('/src/game/GameController.ts');
  const initialRun = { score: 0, combo: 0, maxCombo: 0, hits: 0, dodges: 0 };
  const resolution = resolveEventRow({
    event: {
      timeSeconds: 1,
      kind: 'target',
      obstacles: [1, 0, 1, 0, 0],
    },
    states: ['pending', null, 'pending', null, null],
    playerX: 0,
    run: initialRun,
  });
  assert.equal(resolution.outcome, 'target-hit');
  assert.deepEqual(resolution.states, ['hit', null, 'hit', null, null]);
  assert.deepEqual(resolution.run, { score: 104, combo: 1, maxCombo: 1, hits: 1, dodges: 0 });
  const repeatedResolution = resolveEventRow({
    event: {
      timeSeconds: 1,
      kind: 'target',
      obstacles: [1, 0, 1, 0, 0],
    },
    states: resolution.states,
    playerX: 0,
    run: resolution.run,
  });
  assert.equal(repeatedResolution.outcome, 'none');
  assert.deepEqual(repeatedResolution.run, resolution.run);

  const consecutiveResolution = resolveEventRow({
    event: {
      timeSeconds: 1.01,
      kind: 'target',
      obstacles: [0, 1, 1, 0, 0],
    },
    states: [null, 'pending', 'pending', null, null],
    playerX: -0.5,
    run: resolution.run,
  });
  assert.deepEqual(
    consecutiveResolution.run,
    { score: 212, combo: 2, maxCombo: 2, hits: 2, dodges: 0 },
  );

  const missedResolution = resolveEventRow({
    event: {
      timeSeconds: 2,
      kind: 'target',
      obstacles: [1, 1, 0, 0, 0],
    },
    states: ['pending', 'pending', null, null, null],
    playerX: 2,
    run: { score: 300, combo: 7, maxCombo: 7, hits: 3, dodges: 0 },
  });
  assert.equal(missedResolution.outcome, 'target-miss');
  assert.deepEqual(missedResolution.states, ['miss', 'miss', null, null, null]);
  assert.deepEqual(
    missedResolution.run,
    { score: 300, combo: 0, maxCombo: 7, hits: 3, dodges: 0 },
  );

  const hazardPriorityResolution = resolveEventRow({
    event: {
      timeSeconds: 3,
      kind: 'target',
      obstacles: [1, 2, 0, 0, 0],
    },
    states: ['pending', 'pending', null, null, null],
    playerX: -1.5,
    run: { score: 400, combo: 4, maxCombo: 5, hits: 4, dodges: 0 },
  });
  assert.equal(hazardPriorityResolution.outcome, 'crash');
  assert.equal(hazardPriorityResolution.impactX, -1);
  assert.deepEqual(hazardPriorityResolution.states, ['pending', 'hit', null, null, null]);
  assert.deepEqual(
    hazardPriorityResolution.run,
    { score: 400, combo: 0, maxCombo: 5, hits: 4, dodges: 0 },
  );

  const dodgeResolution = resolveEventRow({
    event: {
      timeSeconds: 4,
      kind: 'dodge',
      obstacles: [2, 0, 0, 0, 0],
    },
    states: ['pending', null, null, null, null],
    playerX: 0,
    run: initialRun,
  });
  assert.equal(dodgeResolution.outcome, 'dodge');
  assert.deepEqual(dodgeResolution.states, ['miss', null, null, null, null]);
  assert.deepEqual(dodgeResolution.run, { score: 72, combo: 1, maxCombo: 1, hits: 0, dodges: 1 });
  const repeatedDodgeResolution = resolveEventRow({
    event: {
      timeSeconds: 4,
      kind: 'dodge',
      obstacles: [2, 0, 0, 0, 0],
    },
    states: dodgeResolution.states,
    playerX: 0,
    run: dodgeResolution.run,
  });
  assert.equal(repeatedDodgeResolution.outcome, 'none');
  assert.deepEqual(repeatedDodgeResolution.run, dodgeResolution.run);

  assert.equal(countChoiceRows([
    { timeSeconds: 1, kind: 'target', obstacles: [1, 0, 1, 0, 0] },
    { timeSeconds: 2, kind: 'dodge', obstacles: [2, 2, 0, 0, 0] },
    { timeSeconds: 3, kind: 'target', obstacles: [0, 1, 0, 0, 0] },
  ]), 2);
} finally {
  await vite.close();
}
console.log('physics check passed');
