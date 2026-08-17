import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function hitSound(pitchMidi) {
  return {
    pitchMidi,
    pitchClass: pitchMidi % 12,
    sourceRole: 'melody',
    velocity: 0.8,
    gain: 0.16,
    brightness: 0.55,
  };
}

function attack(id, timeSeconds, lane, pitchMidi) {
  return {
    id,
    timeSeconds,
    lane,
    pitchMidi,
    evidenceIds: [`evidence:${id}`],
    hitSound: hitSound(pitchMidi),
  };
}

function target(source) {
  const obstacles = [0, 0, 0, 0, 0];
  obstacles[source.lane] = 1;
  return {
    timeSeconds: source.timeSeconds,
    obstacles,
    kind: 'target',
    layer: 'core',
    pattern: 'performance',
    performanceEventId: source.id,
    performanceEventIds: [source.id],
    melodicTraceId: 'trace-1',
    hitSound: source.hitSound,
  };
}

function performanceLevel() {
  const attacks = [
    attack('attack-1', 1, 0, 60),
    attack('attack-2', 1.2, 1, 62),
    attack('attack-3', 1.4, 0, 60),
  ];
  return {
    id: 'contract-fixture',
    version: 3,
    song: {
      title: 'Fixture', artist: 'Fixture', audioUrl: './audio.mp3', bpm: 120, durationSeconds: 4,
    },
    generation: {
      performanceAttackEventCount: attacks.length,
      performanceTargetRowCount: attacks.length,
      performanceScore: {
        kind: 'performance-score',
        attackEvents: attacks,
        melodicTraces: [{
          id: 'trace-1',
          attackEventIds: attacks.map((entry) => entry.id),
          pitchContour: attacks.map((entry) => entry.pitchMidi),
          laneContour: attacks.map((entry) => entry.lane),
        }],
        diagnostics: {
          compilation: {
            inputAttackEventCount: attacks.length,
            selectedTargetRowCount: attacks.length,
            representedAttackEventCount: attacks.length,
            mergedAttackEventCount: 0,
            omittedAttackEventCount: 0,
            mergedGroups: [],
            omittedAttackEvents: [],
          },
        },
      },
    },
    colorSchemeEvents: [],
    events: attacks.map(target),
  };
}

async function check(level) {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-performance-contract-'));
  try {
    const levelPath = join(directory, 'level.json');
    await writeFile(levelPath, `${JSON.stringify(level)}\n`);
    return spawnSync(
      process.execPath,
      [join(root, 'scripts', 'level-check.mjs'), '--performance-contract-only', levelPath],
      { cwd: root, encoding: 'utf8' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('accepts an evidence-grounded Performance Score and keeps legacy levels compatible', async () => {
  const performanceResult = await check(performanceLevel());
  assert.equal(performanceResult.status, 0, performanceResult.stderr || performanceResult.stdout);

  const legacy = performanceLevel();
  delete legacy.generation.performanceScore;
  delete legacy.generation.performanceAttackEventCount;
  delete legacy.generation.performanceTargetRowCount;
  const legacyResult = await check(legacy);
  assert.equal(legacyResult.status, 0, legacyResult.stderr || legacyResult.stdout);
});

test('rejects template targets and any movement away from measured attack time or lane', async () => {
  const extra = performanceLevel();
  extra.events.push({
    ...extra.events.at(-1),
    timeSeconds: 1.6,
    pattern: 'pulse',
    performanceEventId: undefined,
    performanceEventIds: undefined,
  });
  extra.generation.performanceTargetRowCount += 1;
  extra.generation.performanceScore.diagnostics.compilation.selectedTargetRowCount += 1;
  const extraResult = await check(extra);
  assert.notEqual(extraResult.status, 0, 'An extra beat-template Target Row must be rejected.');

  const moved = performanceLevel();
  moved.events[1].timeSeconds += 0.01;
  moved.events[1].obstacles = [0, 0, 1, 0, 0];
  const movedResult = await check(moved);
  assert.notEqual(movedResult.status, 0, 'A retimed or retargeted Attack Event must be rejected.');
});

test('rejects unsafe Hit Voices and inverted Melodic Trace lanes', async () => {
  const unsafeVoice = performanceLevel();
  unsafeVoice.events[0].hitSound.gain = 1.5;
  const unsafeVoiceResult = await check(unsafeVoice);
  assert.notEqual(unsafeVoiceResult.status, 0, 'An out-of-range Hit Voice must be rejected.');

  const inverted = performanceLevel();
  inverted.generation.performanceScore.attackEvents[1].lane = 0;
  inverted.generation.performanceScore.attackEvents[2].lane = 1;
  inverted.generation.performanceScore.melodicTraces[0].laneContour = [0, 0, 1];
  inverted.events[1].obstacles = [1, 0, 0, 0, 0];
  inverted.events[2].obstacles = [0, 1, 0, 0, 0];
  const invertedResult = await check(inverted);
  assert.notEqual(invertedResult.status, 0, 'A lane contour that reverses pitch direction must be rejected.');
});

test('rejects a generic Hit Voice that is not derived from its Attack Event', async () => {
  const genericVoice = performanceLevel();
  genericVoice.events[0].hitSound = hitSound(72);
  const result = await check(genericVoice);
  assert.notEqual(result.status, 0, 'A substituted generic Hit Voice must be rejected.');
});

test('rejects charts whose density is primarily decorative hazards', async () => {
  const hazardDominated = performanceLevel();
  for (const event of hazardDominated.events) {
    const targetLane = event.obstacles.indexOf(1);
    event.obstacles = event.obstacles.map((_, lane) => lane === targetLane ? 1 : 2);
  }
  const result = await check(hazardDominated);
  assert.notEqual(result.status, 0, 'Hazard-dominated density must be rejected.');
});
