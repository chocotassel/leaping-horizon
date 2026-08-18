import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { COLOR_SCHEME_IDS } from './rhythm/color-timeline.mjs';

const root = resolve(import.meta.dirname, '..');
const requested = process.argv[2] ? [resolve(root, process.argv[2])] : null;
const songDirectories = requested ?? (await readdir(resolve(root, 'src/songs'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(root, 'src/songs', entry.name, 'level.json'));

function timeKey(value) {
  return Number(value).toFixed(5);
}

for (const levelPath of songDirectories) {
  const level = JSON.parse(await readFile(levelPath, 'utf8'));
  assert.equal(level.version, 3);
  assert.equal(level.generation.algorithm, 'measured-pitch-base-v1');
  assert.ok(Array.isArray(level.rhythmPoints) && level.rhythmPoints.length > 0);
  assert.ok(Array.isArray(level.events) && level.events.length > 0);
  assert.ok(Array.isArray(level.colorSchemeEvents) && level.colorSchemeEvents.length > 0);
  assert.ok(!Object.hasOwn(level, 'visualAccentEvents'));
  assert.ok(!Object.hasOwn(level.generation, 'directorScore'));
  assert.ok(!Object.hasOwn(level.generation, 'performanceScore'));

  const pointTimes = new Set();
  let previousPointTime = -Infinity;
  for (const point of level.rhythmPoints) {
    assert.ok(Number.isFinite(point.timeSeconds) && point.timeSeconds > previousPointTime);
    assert.ok(point.timeSeconds >= 0 && point.timeSeconds <= level.song.durationSeconds);
    assert.ok(Number.isInteger(point.suggestedLane) && point.suggestedLane >= 0 && point.suggestedLane <= 4);
    assert.ok(['attack', 'beat', 'downbeat'].includes(point.kind));
    assert.ok(!pointTimes.has(timeKey(point.timeSeconds)));
    pointTimes.add(timeKey(point.timeSeconds));
    previousPointTime = point.timeSeconds;
  }

  let previousEventTime = -Infinity;
  for (const event of level.events) {
    assert.ok(event.timeSeconds > previousEventTime);
    assert.ok(pointTimes.has(timeKey(event.timeSeconds)));
    assert.ok(Array.isArray(event.obstacles) && event.obstacles.length === 5);
    assert.ok(event.obstacles.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 2));
    assert.ok(event.obstacles.some((cell) => cell !== 0));
    assert.ok(!Object.hasOwn(event, 'hitSound'));
    previousEventTime = event.timeSeconds;
  }
  assert.equal(level.generation.noteCount, level.events.filter((event) => event.kind === 'target').length);
  assert.equal(level.generation.rhythmPointCount, level.rhythmPoints.length);

  let previousColorTime = -Infinity;
  let previousColor = null;
  for (const event of level.colorSchemeEvents) {
    assert.ok(event.timeSeconds > previousColorTime);
    assert.ok(COLOR_SCHEME_IDS.includes(event.colorSchemeId));
    assert.notEqual(event.colorSchemeId, previousColor);
    previousColorTime = event.timeSeconds;
    previousColor = event.colorSchemeId;
  }

  const editsPath = levelPath.replace(/level\.json$/, 'edits.json');
  const edits = JSON.parse(await readFile(editsPath, 'utf8'));
  assert.equal(edits.version, 1);
  assert.equal(edits.levelId, level.id);
  assert.ok(Array.isArray(edits.rowOverrides));
  assert.ok(Array.isArray(edits.colorRanges));
  console.log(`${level.id}: ${level.rhythmPoints.length} rhythm points, ${level.events.length} base rows, ${edits.rowOverrides.length} manual rows.`);
}
