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
assert.ok(physics.APPROACH_SECONDS >= 5);
assert.equal(physics.RING_SPAWN_Z, -64);
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
  const {
    countChoiceRows,
    countMultiTargetRows,
    getCrashEffectProgress,
    getCrashSceneTime,
    resolveEventRow,
  } = await vite.ssrLoadModule('/src/game/GameController.ts');
  const { getEarnedStars } = await vite.ssrLoadModule('/src/game/stars.ts');
  const { getResultPresentation } = await vite.ssrLoadModule('/src/components/ResultScreen.tsx');
  const { LocalDataManager, isLevelUnlocked, recordLevelResult } = await vite.ssrLoadModule('/src/data/localData.ts');
  const { formatNumber, locale, t } = await vite.ssrLoadModule('/src/i18n/index.ts');
  assert.equal(locale, 'zh-CN');
  assert.equal(t('songSelect.positionLabel', { current: 1, total: 2 }), '第 1 首，共 2 首');
  assert.equal(formatNumber(12345), '12,345');
  assert.equal(getResultPresentation('complete').tone, 'success');
  assert.equal(getResultPresentation('crashed').tone, 'danger');
  assert.equal(getCrashEffectProgress(100, 675), 0.5);
  assert.ok(getCrashSceneTime(10, 1000) < 10.08);
  const initialRun = { score: 0, combo: 0, maxCombo: 0, hits: 0, doubleHitRows: 0, dodges: 0 };
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
  assert.deepEqual(resolution.states, ['miss', null, 'hit', null, null]);
  assert.deepEqual(resolution.run, { score: 104, combo: 1, maxCombo: 1, hits: 1, doubleHitRows: 0, dodges: 0 });
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

  const overlappingResolution = resolveEventRow({
    event: {
      timeSeconds: 1,
      kind: 'target',
      obstacles: [0, 1, 1, 1, 0],
    },
    states: [null, 'pending', 'pending', 'pending', null],
    playerX: -0.5,
    run: initialRun,
  });
  assert.equal(overlappingResolution.outcome, 'target-hit');
  assert.deepEqual(overlappingResolution.states, [null, 'hit', 'hit', 'miss', null]);
  assert.deepEqual(
    overlappingResolution.run,
    { score: 104, combo: 1, maxCombo: 1, hits: 1, doubleHitRows: 1, dodges: 0 },
  );

  const splitTargetResolution = resolveEventRow({
    event: {
      timeSeconds: 1,
      kind: 'target',
      obstacles: [1, 0, 1, 0, 0],
    },
    states: ['pending', null, 'pending', null, null],
    playerX: -1,
    run: initialRun,
  });
  assert.deepEqual(splitTargetResolution.states, ['hit', null, 'hit', null, null]);
  assert.equal(splitTargetResolution.run.doubleHitRows, 1);

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
    { score: 212, combo: 2, maxCombo: 2, hits: 2, doubleHitRows: 1, dodges: 0 },
  );

  const missedResolution = resolveEventRow({
    event: {
      timeSeconds: 2,
      kind: 'target',
      obstacles: [1, 1, 0, 0, 0],
    },
    states: ['pending', 'pending', null, null, null],
    playerX: 2,
    run: { score: 300, combo: 7, maxCombo: 7, hits: 3, doubleHitRows: 1, dodges: 0 },
  });
  assert.equal(missedResolution.outcome, 'target-miss');
  assert.deepEqual(missedResolution.states, ['miss', 'miss', null, null, null]);
  assert.deepEqual(
    missedResolution.run,
    { score: 300, combo: 0, maxCombo: 7, hits: 3, doubleHitRows: 1, dodges: 0 },
  );

  const hazardPriorityResolution = resolveEventRow({
    event: {
      timeSeconds: 3,
      kind: 'target',
      obstacles: [1, 2, 0, 0, 0],
    },
    states: ['pending', 'pending', null, null, null],
    playerX: -1.5,
    run: { score: 400, combo: 4, maxCombo: 5, hits: 4, doubleHitRows: 1, dodges: 0 },
  });
  assert.equal(hazardPriorityResolution.outcome, 'crash');
  assert.equal(hazardPriorityResolution.impactX, -1);
  assert.deepEqual(hazardPriorityResolution.states, ['pending', 'hit', null, null, null]);
  assert.deepEqual(
    hazardPriorityResolution.run,
    { score: 400, combo: 0, maxCombo: 5, hits: 4, doubleHitRows: 1, dodges: 0 },
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
  assert.deepEqual(dodgeResolution.run, { score: 72, combo: 1, maxCombo: 1, hits: 0, doubleHitRows: 0, dodges: 1 });
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
  assert.equal(countMultiTargetRows([
    { timeSeconds: 1, kind: 'target', obstacles: [1, 0, 1, 0, 0] },
    { timeSeconds: 2, kind: 'dodge', obstacles: [2, 2, 0, 0, 0] },
    { timeSeconds: 3, kind: 'target', obstacles: [0, 1, 0, 0, 0] },
  ]), 1);

  const starResult = {
    score: 1000,
    maxCombo: 10,
    hits: 10,
    total: 10,
    doubleHitRows: 2,
    totalMultiTargetRows: 2,
    dodges: 3,
    totalDodges: 3,
  };
  assert.equal(getEarnedStars(starResult, false), 0);
  assert.equal(getEarnedStars({ ...starResult, hits: 0, total: 0 }, true), 1);
  assert.equal(getEarnedStars({ ...starResult, hits: 6 }, true), 1);
  assert.equal(getEarnedStars({ ...starResult, hits: 7 }, true), 2);
  assert.equal(getEarnedStars({ ...starResult, hits: 9 }, true), 3);
  assert.equal(getEarnedStars({ ...starResult, doubleHitRows: 1 }, true), 4);
  assert.equal(getEarnedStars(starResult, true), 5);

  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  const manager = new LocalDataManager('test', { ok: false }, (value) => (
    Boolean(value) && typeof value === 'object' && typeof value.ok === 'boolean'
  ), storage);
  manager.write({ ok: true });
  assert.deepEqual(manager.read(), { ok: true });
  stored.set('test', '{broken');
  assert.deepEqual(manager.read(), { ok: false });

  const levelOne = recordLevelResult({ levels: {} }, 'one', starResult, 5);
  assert.equal(levelOne.levels.one.stars, 5);
  assert.equal(isLevelUnlocked([{ id: 'one' }, { id: 'two' }], 'two', levelOne), true);
} finally {
  await vite.close();
}
console.log('physics check passed');
