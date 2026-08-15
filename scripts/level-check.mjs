import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const collection = JSON.parse(await readFile(new URL('../src/levels/slice-at-two.levels.json', import.meta.url)));
assert.equal(collection.kind, 'rhythm-level-collection');
assert.ok(collection.levels[collection.primaryTrackId]);

for (const [trackId, level] of Object.entries(collection.levels)) {
  assert.equal(level.version, 3, `${trackId} must be Level v3.`);
  assert.equal('ticksPerBeat' in level, false, `${trackId} must not contain a tick grid.`);
  assert.equal('beatOffsetSeconds' in level.song, false, `${trackId} must not contain a beat offset.`);
  await access(new URL(`../public${level.song.audioUrl}`, import.meta.url));

  let previousTime = -Infinity;
  let previousLane = 2;
  let previousLaneTime = 0;
  let breakables = 0;
  for (let eventIndex = 0; eventIndex < level.events.length; eventIndex += 1) {
    const event = level.events[eventIndex];
    assert.ok(event.timeSeconds > previousTime, `${trackId} event ${eventIndex} is not ordered.`);
    assert.ok(event.timeSeconds >= 0 && event.timeSeconds <= level.song.durationSeconds);
    assert.equal(event.obstacles.length, 5);
    assert.ok(event.obstacles.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 2));
    const targets = event.obstacles.flatMap((cell, lane) => cell === 1 ? [lane] : []);
    const spikes = event.obstacles.flatMap((cell, lane) => cell === 2 ? [lane] : []);
    assert.equal(targets.length, 1, `${trackId} event ${eventIndex} must have one target.`);
    assert.ok(spikes.every((lane) => Math.abs(lane - targets[0]) >= 2));
    const allowedSteps = Math.max(0, Math.floor((event.timeSeconds - previousLaneTime + 1e-6) / 0.2));
    assert.ok(Math.abs(targets[0] - previousLane) <= allowedSteps, `${trackId} event ${eventIndex} lane is unreachable.`);
    previousLane = targets[0];
    previousLaneTime = event.timeSeconds;
    previousTime = event.timeSeconds;
    breakables += 1;
  }
  assert.equal(level.generation.noteCount, breakables);
  assert.ok(breakables > 0, `${trackId} produced no playable events.`);
}

console.log(`Validated ${Object.keys(collection.levels).length} arbitrary-time Level v3 charts.`);
