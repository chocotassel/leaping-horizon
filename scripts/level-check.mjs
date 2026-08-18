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

function assertHitSoundIntent(intent) {
  assert.ok(intent && typeof intent === 'object');
  assert.equal(typeof intent.sourceRole, 'string');
  assert.ok(intent.sourceRole.length > 0 && intent.sourceRole.length <= 48);
  if (intent.pitchMidi != null) assert.ok(Number.isFinite(intent.pitchMidi));
  assert.ok(Number.isInteger(intent.pitchClass) && intent.pitchClass >= 0 && intent.pitchClass < 12);
  for (const key of ['velocity', 'gain', 'brightness']) {
    assert.ok(Number.isFinite(intent[key]) && intent[key] >= 0 && intent[key] <= 1);
  }
}

for (const levelPath of songDirectories) {
  const level = JSON.parse(await readFile(levelPath, 'utf8'));
  const authoringPath = levelPath.replace(/level\.json$/, 'authoring.json');
  const authoring = JSON.parse(await readFile(authoringPath, 'utf8'));
  assert.equal(level.version, 3);
  assert.equal(level.generation.algorithm, 'region-authoring-base-v1');
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
    assert.ok(['attack', 'beat', 'downbeat', 'pitch'].includes(point.kind));
    assert.ok(!pointTimes.has(timeKey(point.timeSeconds)));
    pointTimes.add(timeKey(point.timeSeconds));
    previousPointTime = point.timeSeconds;
  }


  assert.equal(authoring.kind, 'authoring-score');
  assert.ok(authoring.schemaVersion === '1.0.0' || authoring.schemaVersion === '2.0.0');
  assert.equal(authoring.levelId, level.id);
  assert.equal(typeof authoring.audioFingerprint, 'string');
  assert.ok(authoring.audioFingerprint.length > 0);
  assert.ok(Array.isArray(authoring.sources) && authoring.sources.length >= 5);
  assert.ok(Array.isArray(authoring.regions) && authoring.regions.length > 0);

  const evidenceGroups = authoring.schemaVersion === '2.0.0'
    ? authoring.evidenceStreams
    : null;
  if (evidenceGroups) {
    assert.equal(typeof authoring.evidenceFingerprint, 'string');
    assert.ok(authoring.evidenceFingerprint.length > 0);
    for (const kind of ['timing', 'lane', 'accent', 'metric']) {
      assert.ok(Array.isArray(evidenceGroups[kind]));
      for (const stream of evidenceGroups[kind]) {
        assert.equal(stream.kind, kind);
        assert.ok(['measured', 'estimated', 'unavailable'].includes(stream.availability));
        assert.ok(Array.isArray(stream.events));
      }
    }
  }
  const timingStreams = evidenceGroups
    ? [...evidenceGroups.timing, ...evidenceGroups.metric]
    : authoring.sources;
  const timingAnchorTimes = new Set(timingStreams
    .filter((stream) => stream.availability !== 'unavailable')
    .flatMap((stream) => stream.events)
    .map((event) => timeKey(event.timeSeconds)));
  for (const stream of timingStreams.filter((candidate) => candidate.availability !== 'unavailable')) {
    for (const event of stream.events) {
      assert.ok(pointTimes.has(timeKey(event.timeSeconds)), `${stream.id}:${event.id} is missing a timing anchor`);
    }
  }

  let previousEventTime = -Infinity;
  const eventTimes = new Set();
  for (const event of level.events) {
    assert.ok(event.timeSeconds > previousEventTime);
    assert.ok(pointTimes.has(timeKey(event.timeSeconds)));
    assert.ok(Array.isArray(event.obstacles) && event.obstacles.length === 5);
    assert.ok(event.obstacles.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 2));
    assert.ok(event.obstacles.some((cell) => cell !== 0));
    if (event.kind === 'target' && authoring.schemaVersion === '2.0.0') {
      assert.ok(timingAnchorTimes.has(timeKey(event.timeSeconds)), 'Target time must come from a timing anchor.');
      assertHitSoundIntent(event.hitSound);
    } else if (Object.hasOwn(event, 'hitSound')) {
      assertHitSoundIntent(event.hitSound);
    }
    eventTimes.add(timeKey(event.timeSeconds));
    previousEventTime = event.timeSeconds;
  }
  assert.equal(level.generation.noteCount, level.events.filter((event) => event.kind === 'target').length);
  assert.equal(level.generation.rhythmPointCount, level.rhythmPoints.length);

  assert.equal(authoring.suggestions.length, authoring.regions.length);
  const sourceIds = new Set(authoring.sources.map((source) => source.id));
  const regionIds = new Set(authoring.regions.map((region) => region.id));
  for (const source of authoring.sources) {
    assert.ok(['measured', 'estimated', 'unavailable'].includes(source.availability));
    assert.ok(Array.isArray(source.events));
    if (source.availability !== 'unavailable' && authoring.schemaVersion === '1.0.0') {
      for (const event of source.events) assert.ok(pointTimes.has(timeKey(event.timeSeconds)));
    }
  }
  for (const suggestion of authoring.suggestions) {
    assert.ok(regionIds.has(suggestion.regionId));
    if (authoring.schemaVersion === '1.0.0') {
      assert.ok(sourceIds.has(suggestion.sourceId));
      assert.ok(['pulse', 'alternating', 'pitch-contour', 'rest'].includes(suggestion.mapping));
      for (const key of ['density', 'motion', 'challenge']) {
        assert.ok(Number.isFinite(suggestion[key]) && suggestion[key] >= 0 && suggestion[key] <= 1);
      }
    } else {
      assert.ok(suggestion.preset?.mode === 'play' || suggestion.preset?.mode === 'rest');
      assert.ok(Array.isArray(suggestion.reasonCodes));
    }
  }
  if (evidenceGroups) {
    for (const stream of evidenceGroups.lane) {
      if (stream.availability === 'unavailable') continue;
      for (const event of stream.events) {
        const key = timeKey(event.timeSeconds);
        if (!timingAnchorTimes.has(key)) {
          assert.ok(!eventTimes.has(key), `Lane-only evidence ${stream.id}:${event.id} created a Target.`);
        }
      }
    }
  }

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
  assert.ok(edits.version === 1 || edits.version === 2 || edits.version === 3);
  assert.equal(edits.levelId, level.id);
  if (edits.version >= 2) assert.ok(Array.isArray(edits.arrangements));
  if (edits.version === 3 && edits.evidenceFingerprint) {
    assert.equal(edits.evidenceFingerprint, authoring.evidenceFingerprint);
  }
  assert.ok(Array.isArray(edits.rowOverrides));
  assert.ok(Array.isArray(edits.colorRanges));
  console.log(`${level.id}: ${level.rhythmPoints.length} rhythm points, ${authoring.regions.length} regions, ${level.events.length} base rows, ${edits.rowOverrides.length} manual rows.`);
}
