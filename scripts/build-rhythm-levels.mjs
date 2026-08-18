import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { deriveLayoutIntent } from './rhythm/layout-intent.mjs';
import { planColorSchemeEvents } from './rhythm/color-timeline.mjs';
import { transcribePerformance } from './rhythm/performance-transcriber.mjs';

const root = resolve(import.meta.dirname, '..');
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('build-rhythm-levels.mjs is an internal step; run npm run generate instead.');
}

const inputPath = resolve(root, process.argv[2]);
const levelPath = resolve(root, process.argv[3]);
const analysis = JSON.parse(await readFile(inputPath, 'utf8'));
const performance = analysis.performanceScore?.kind === 'performance-score'
  ? analysis.performanceScore
  : transcribePerformance(analysis, { travelSecondsPerLane: 0.08 });

const EMPTY = 0;
const BREAKABLE = 1;
const LANE_COUNT = 5;
const FUSION_WINDOW_SECONDS = 0.055;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function eventRow(lane) {
  const row = Array(LANE_COUNT).fill(EMPTY);
  row[Math.max(0, Math.min(LANE_COUNT - 1, Math.round(finite(lane, 2))))] = BREAKABLE;
  return row;
}

function buildBaseEvents() {
  return performance.attackEvents
    .filter((attack) => (
      Number.isFinite(attack.timeSeconds)
      && attack.timeSeconds >= 0
      && attack.timeSeconds <= analysis.song.durationSeconds
    ))
    .sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id))
    .map((attack) => ({
      timeSeconds: Number(attack.timeSeconds.toFixed(5)),
      obstacles: eventRow(attack.lane),
      kind: 'target',
    }));
}

function nearestAttack(attacks, timeSeconds) {
  let nearest = null;
  for (const attack of attacks) {
    const distance = Math.abs(attack.timeSeconds - timeSeconds);
    if (distance <= FUSION_WINDOW_SECONDS && (!nearest || distance < nearest.distance)) {
      nearest = { attack, distance };
    }
  }
  return nearest?.attack ?? null;
}

function buildRhythmPoints(events) {
  // ponytail: linear lookups are simpler for song-sized inputs; index only if charts exceed ~50k points.
  const attacks = performance.attackEvents
    .filter((attack) => Number.isFinite(attack.timeSeconds))
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
  const points = attacks.map((attack) => ({
    id: attack.id,
    timeSeconds: Number(attack.timeSeconds.toFixed(5)),
    suggestedLane: Math.max(0, Math.min(4, Math.round(finite(attack.lane, 2)))),
    kind: 'attack',
    strength: finite(attack.strength, 0.5),
    pitchMidi: Number.isFinite(attack.pitchMidi) ? attack.pitchMidi : undefined,
    sourceRole: attack.sourceRole ?? 'attack',
  }));

  const beatSource = analysis.eventSources?.find((source) => source.id === 'beat-this');
  let previousLane = 2;
  for (const beat of beatSource?.events ?? []) {
    const timeSeconds = finite(beat.timeSeconds, Number.NaN);
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > analysis.song.durationSeconds) continue;
    const attack = nearestAttack(attacks, timeSeconds);
    if (attack) continue;
    const previous = [...attacks].reverse().find((candidate) => candidate.timeSeconds < timeSeconds);
    if (previous) previousLane = Math.max(0, Math.min(4, Math.round(finite(previous.lane, previousLane))));
    points.push({
      id: `beat-${String(beat.index ?? points.length + 1).padStart(5, '0')}`,
      timeSeconds: Number(timeSeconds.toFixed(5)),
      suggestedLane: previousLane,
      kind: beat.isDownbeat ? 'downbeat' : 'beat',
      strength: finite(beat.confidence, beat.isDownbeat ? 1 : 0.7),
      sourceRole: 'rhythm',
    });
  }

  const unique = new Map();
  for (const point of points.sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id))) {
    const key = point.timeSeconds.toFixed(5);
    const current = unique.get(key);
    if (!current || (current.kind !== 'attack' && point.kind === 'attack')) unique.set(key, point);
  }
  const eventTimes = new Set(events.map((event) => event.timeSeconds.toFixed(5)));
  return [...unique.values()].map((point) => ({
    ...point,
    hasBaseRow: eventTimes.has(point.timeSeconds.toFixed(5)),
  }));
}

const events = buildBaseEvents();
const layoutIntent = deriveLayoutIntent(analysis);
const colorSchemeEvents = planColorSchemeEvents(analysis, layoutIntent);
const rhythmPoints = buildRhythmPoints(events);
const level = {
  id: `${analysis.song.id}-flow`,
  version: 3,
  song: {
    title: analysis.song.title,
    artist: analysis.song.artist,
    audioUrl: analysis.song.audioUrl,
    bpm: analysis.song.bpm,
    durationSeconds: analysis.song.durationSeconds,
  },
  generation: {
    algorithm: 'measured-pitch-base-v1',
    noteCount: events.length,
    rhythmPointCount: rhythmPoints.length,
    pitchedEventCount: performance.attackEvents.filter((event) => Number.isFinite(event.pitchMidi)).length,
    performanceAlgorithm: performance.algorithm,
  },
  rhythmPoints,
  colorSchemeEvents,
  events,
};

await mkdir(dirname(levelPath), { recursive: true });
await writeFile(levelPath, `${JSON.stringify(level, null, 2)}\n`);
console.log(
  `Generated ${level.id}: ${events.length} base blocks across ${rhythmPoints.length} editable rhythm points.`,
);
