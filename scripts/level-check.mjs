import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const level = JSON.parse(await readFile(new URL('../src/levels/slice-at-two.level.json', import.meta.url)));
assert.equal(level.ticksPerBeat, 2);
const tickDuration = 60 / level.song.bpm / level.ticksPerBeat;
const expectedRows = Math.ceil((level.song.durationSeconds - level.song.beatOffsetSeconds) / tickDuration);
assert.equal(level.obstacles.length, expectedRows);
await access(new URL(`../public${level.song.audioUrl}`, import.meta.url));

let previousBeat = -1;
let previousLane = 2;
let lastObstacleBeat = -1;
let breakables = 0;
const spikeRows = [0, 0, 0, 0];
const laneVisits = [0, 0, 0, 0, 0];
let directionChanges = 0;
let previousDirection = 0;
let obstacleRows = 0;
let currentImpactRun = 0;
let maxImpactRun = 0;
let currentObstacleRun = 0;
let maxObstacleRun = 0;
let reachableLanes = new Set([2]);
for (let beatIndex = 0; beatIndex < level.obstacles.length; beatIndex += 1) {
  const row = level.obstacles[beatIndex];
  assert.equal(row.length, 5);
  assert.ok(row.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 2));
  const targetLanes = row.flatMap((cell, lane) => cell === 1 ? [lane] : []);
  const spikes = row.flatMap((cell, lane) => cell === 2 ? [lane] : []);
  assert.ok(targetLanes.length <= 1, `Beat ${beatIndex} has multiple target blocks.`);
  if (spikes.length > 1) {
    assert.equal(spikes.at(-1) - spikes[0], spikes.length - 1, `Beat ${beatIndex} spikes are not adjacent.`);
  }
  const nextReachableLanes = new Set();
  for (const previousReachableLane of reachableLanes) {
    for (let lane = 0; lane < row.length; lane += 1) {
      if (Math.abs(lane - previousReachableLane) > 1 || row[lane] === 2) continue;
      if (targetLanes.length && lane !== targetLanes[0]) continue;
      nextReachableLanes.add(lane);
    }
  }
  assert.ok(nextReachableLanes.size, `Beat ${beatIndex} leaves no reachable lane.`);
  reachableLanes = nextReachableLanes;
  if (targetLanes.length) {
    const lane = targetLanes[0];
    assert.ok(spikes.every((spikeLane) => Math.abs(spikeLane - lane) >= 2), `Beat ${beatIndex} target touches a spike.`);
    assert.ok(Math.abs(lane - previousLane) <= beatIndex - previousBeat, `Beat ${beatIndex} is unreachable.`);
    previousBeat = beatIndex;
    const direction = Math.sign(lane - previousLane);
    if (direction && previousDirection && direction !== previousDirection) directionChanges += 1;
    if (direction) previousDirection = direction;
    previousLane = lane;
    laneVisits[lane] += 1;
    breakables += 1;
    currentImpactRun += 1;
    maxImpactRun = Math.max(maxImpactRun, currentImpactRun);
  } else {
    currentImpactRun = 0;
  }
  spikeRows[row.filter((cell) => cell === 2).length] += 1;
  if (row.some((cell) => cell !== 0)) {
    obstacleRows += 1;
    lastObstacleBeat = beatIndex;
    currentObstacleRun += 1;
    maxObstacleRun = Math.max(maxObstacleRun, currentObstacleRun);
  } else {
    currentObstacleRun = 0;
  }
}
assert.equal(level.generation.algorithm, 'strong-beat-sustained-lane-path-v4');
assert.ok(level.generation.minImpactStrength >= 0.8);
assert.equal(breakables, level.generation.noteCount);
assert.equal(obstacleRows, level.generation.noteCount + level.generation.guideRowCount);
assert.equal(level.generation.onsetNoteCount + level.generation.accentNoteCount, breakables);
assert.ok(level.generation.accentNoteCount >= level.accents.length);
assert.ok(level.generation.sustainGuideCount >= 20);
assert.ok(level.generation.maxOnsetOffsetMs <= 50);
assert.ok(breakables / level.song.durationSeconds <= 0.8);
assert.equal(spikeRows.reduce((total, rows, count) => total + rows * count, 0), level.generation.spikeCount);
assert.ok(breakables >= 70 && breakables <= 130);
assert.ok(maxImpactRun >= 2 && maxImpactRun <= 12);
assert.ok(maxObstacleRun >= 3);
assert.ok(spikeRows[1] > 100 && spikeRows[2] > 35 && spikeRows[3] >= 9);
assert.ok(directionChanges >= 20);
assert.ok(laneVisits.every((count) => count >= 10));
const pizzaAccents = level.accents.filter((accent) => accent.label === 'pizza');
assert.equal(pizzaAccents.length, 9);
for (const accent of pizzaAccents) {
  assert.ok(accent.durationTicks >= 2);
  for (let offset = 0; offset < accent.durationTicks; offset += 1) {
    const row = level.obstacles[accent.tick + offset];
    assert.ok(row.some((cell) => cell !== 0), `Missing sustained obstacle at pizza tick ${accent.tick + offset}.`);
    if (offset === 0 || row.includes(1)) {
      assert.equal(row.filter((cell) => cell === 1).length, 1, `Missing target at pizza tick ${accent.tick + offset}.`);
      assert.equal(row.filter((cell) => cell === 2).length, 3, `Pizza impact ${accent.tick + offset} is not maximum difficulty.`);
    }
  }
}
const lastObstacleTime = level.song.beatOffsetSeconds + lastObstacleBeat * tickDuration;
assert.ok(level.song.durationSeconds - lastObstacleTime >= 2);
console.log(`level check passed: ${breakables} rhythm points, spikes ${spikeRows.slice(1).join('/')}, ${directionChanges} turns`);
