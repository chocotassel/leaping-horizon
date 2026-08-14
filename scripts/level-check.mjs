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
for (let beatIndex = 0; beatIndex < level.obstacles.length; beatIndex += 1) {
  const row = level.obstacles[beatIndex];
  assert.equal(row.length, 5);
  assert.ok(row.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 2));
  const targetLanes = row.flatMap((cell, lane) => cell === 1 ? [lane] : []);
  assert.ok(targetLanes.length <= 1, `Beat ${beatIndex} has multiple target blocks.`);
  if (targetLanes.length) {
    const lane = targetLanes[0];
    assert.ok(Math.abs(lane - previousLane) <= beatIndex - previousBeat, `Beat ${beatIndex} is unreachable.`);
    previousBeat = beatIndex;
    const direction = Math.sign(lane - previousLane);
    if (direction && previousDirection && direction !== previousDirection) directionChanges += 1;
    if (direction) previousDirection = direction;
    previousLane = lane;
    laneVisits[lane] += 1;
    breakables += 1;
  }
  spikeRows[row.filter((cell) => cell === 2).length] += 1;
  if (row.some((cell) => cell !== 0)) lastObstacleBeat = beatIndex;
}
assert.ok(breakables > 100);
assert.ok(spikeRows[1] > 50 && spikeRows[2] > 35 && spikeRows[3] > 20);
assert.ok(directionChanges >= 20);
assert.ok(laneVisits.every((count) => count >= 10));
const pizzaAccents = level.accents.filter((accent) => accent.label === 'pizza');
assert.equal(pizzaAccents.length, 9);
for (const accent of pizzaAccents) {
  const row = level.obstacles[accent.tick];
  assert.equal(row.filter((cell) => cell === 1).length, 1, `Missing target at pizza tick ${accent.tick}.`);
  assert.equal(row.filter((cell) => cell === 2).length, 3, `Pizza tick ${accent.tick} is not maximum difficulty.`);
}
const lastObstacleTime = level.song.beatOffsetSeconds + lastObstacleBeat * tickDuration;
assert.ok(level.song.durationSeconds - lastObstacleTime >= 2);
console.log(`level check passed: ${breakables} rhythm points, spikes ${spikeRows.slice(1).join('/')}, ${directionChanges} turns`);
