import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { deriveLayoutIntent } from './rhythm/layout-intent.mjs';
import { buildAuthoringScore } from './rhythm/authoring-score.mjs';
import { planColorSchemeEvents } from './rhythm/color-timeline.mjs';
import { transcribePerformance } from './rhythm/performance-transcriber.mjs';

const root = resolve(import.meta.dirname, '..');
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('build-rhythm-levels.mjs is an internal step; run npm run generate instead.');
}

const inputPath = resolve(root, process.argv[2]);
const levelPath = resolve(root, process.argv[3]);
const authoringPath = process.argv[4]
  ? resolve(root, process.argv[4])
  : resolve(dirname(levelPath), 'authoring.json');
const analysis = JSON.parse(await readFile(inputPath, 'utf8'));
const performance = analysis.performanceScore?.kind === 'performance-score'
  ? analysis.performanceScore
  : transcribePerformance(analysis, { travelSecondsPerLane: 0.08 });
const authoringScore = buildAuthoringScore(analysis);

const EMPTY = 0;
const BREAKABLE = 1;
const LANE_COUNT = 5;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function eventRow(lane) {
  const row = Array(LANE_COUNT).fill(EMPTY);
  row[Math.max(0, Math.min(LANE_COUNT - 1, Math.round(finite(lane, 2))))] = BREAKABLE;
  return row;
}

function clamp01(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function pitchClassFor(pitchMidi, sourceRole) {
  if (Number.isFinite(pitchMidi)) return ((Math.round(pitchMidi) % 12) + 12) % 12;
  if (sourceRole === 'bass') return 7;
  if (sourceRole === 'vocal-like' || sourceRole === 'vocals') return 9;
  return 0;
}

function hitSoundIntent(attack) {
  const sourceRole = typeof attack.sourceRole === 'string' && attack.sourceRole
    ? attack.sourceRole
    : 'mixed';
  const pitchMidi = Number.isFinite(attack.pitchMidi) ? attack.pitchMidi : undefined;
  const velocity = clamp01(attack.strength, 0.7);
  const brightness = sourceRole === 'percussion' || sourceRole === 'drums'
    ? 0.82
    : sourceRole === 'bass'
      ? 0.28
      : sourceRole === 'vocal-like' || sourceRole === 'vocals'
        ? 0.66
        : 0.58;
  return {
    sourceRole,
    ...(pitchMidi == null ? {} : { pitchMidi }),
    pitchClass: pitchClassFor(pitchMidi, sourceRole),
    velocity,
    gain: Number((0.3 + velocity * 0.35).toFixed(4)),
    brightness,
  };
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
      hitSound: hitSoundIntent(attack),
    }));
}

function pointKind(source, event) {
  if (source.id === 'rhythm-grid' || source.kind === 'metric') {
    return event.isDownbeat ? 'downbeat' : 'beat';
  }
  if (source.capabilities?.pitch || Number.isFinite(event.pitchMidi)) return 'pitch';
  return 'attack';
}

function pitchLane(pitchMidi, pitchRange) {
  if (!Number.isFinite(pitchMidi) || pitchRange.maximum <= pitchRange.minimum) return 2;
  return Math.max(0, Math.min(4, Math.round(
    ((pitchMidi - pitchRange.minimum) / (pitchRange.maximum - pitchRange.minimum)) * 4,
  )));
}

function sourceRole(source) {
  if (typeof source.stemRole === 'string' && !['mix', 'metric'].includes(source.stemRole)) {
    return source.stemRole;
  }
  if (source.id === 'rhythm-grid') return 'rhythm';
  if (source.id === 'percussion-onsets') return 'percussion';
  if (source.id === 'melody-contour') return 'estimated-melody-contour';
  if (source.id === 'discrete-melody') return 'estimated-melody';
  return 'attack';
}

function buildRhythmPoints(events) {
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

  const evidenceStreams = authoringScore.evidenceStreams;
  const anchorSources = evidenceStreams && Array.isArray(evidenceStreams.timing)
    ? [
        ...evidenceStreams.timing,
        ...(Array.isArray(evidenceStreams.metric) ? evidenceStreams.metric : []),
      ]
    : authoringScore.sources;
  const authoringEvents = anchorSources
    .filter((source) => source.availability !== 'unavailable')
    .flatMap((source) => source.events.map((event) => ({ source, event })))
    .filter(({ event }) => (
      Number.isFinite(event.timeSeconds)
      && event.timeSeconds >= 0
      && event.timeSeconds <= analysis.song.durationSeconds
    ));
  const pitches = authoringEvents
    .map(({ event }) => event.pitchMidi)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const pitchRange = {
    minimum: pitches.length ? pitches[Math.floor((pitches.length - 1) * 0.05)] : 0,
    maximum: pitches.length ? pitches[Math.ceil((pitches.length - 1) * 0.95)] : 0,
  };
  for (const { source, event } of authoringEvents) {
    const kind = pointKind(source, event);
    points.push({
      id: event.id,
      timeSeconds: Number(event.timeSeconds.toFixed(5)),
      suggestedLane: kind === 'pitch' ? pitchLane(event.pitchMidi, pitchRange) : 2,
      kind,
      strength: finite(event.strength, 0.5),
      pitchMidi: Number.isFinite(event.pitchMidi) ? event.pitchMidi : undefined,
      sourceRole: sourceRole(source),
    });
  }

  const priority = { attack: 4, pitch: 3, downbeat: 2, beat: 1 };
  const unique = new Map();
  for (const point of points.sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id))) {
    const key = point.timeSeconds.toFixed(5);
    const current = unique.get(key);
    if (!current || priority[point.kind] > priority[current.kind]) unique.set(key, point);
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
    algorithm: 'region-authoring-base-v1',
    noteCount: events.length,
    rhythmPointCount: rhythmPoints.length,
    pitchedEventCount: performance.attackEvents.filter((event) => Number.isFinite(event.pitchMidi)).length,
    performanceAlgorithm: performance.algorithm,
    authoringAlgorithm: authoringScore.algorithm,
    authoringSourceCount: authoringScore.sources.length,
    authoringEventCount: authoringScore.sources.reduce((count, source) => count + source.events.length, 0),
    authoringRegionCount: authoringScore.regions.length,
    authoringRepeatSetCount: authoringScore.repeatSets.length,
    authoringSuggestionCount: authoringScore.suggestions.length,
  },
  rhythmPoints,
  colorSchemeEvents,
  events,
};

await Promise.all([
  mkdir(dirname(levelPath), { recursive: true }),
  mkdir(dirname(authoringPath), { recursive: true }),
]);
await Promise.all([
  writeFile(levelPath, `${JSON.stringify(level, null, 2)}\n`),
  writeFile(authoringPath, `${JSON.stringify(authoringScore, null, 2)}\n`),
]);
console.log(
  `Generated ${level.id}: ${events.length} base blocks across ${rhythmPoints.length} editable rhythm points; `
  + `${authoringScore.regions.length} authoring regions -> ${authoringPath}.`,
);
