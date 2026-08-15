import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const inputPath = resolve(root, process.argv[2] ?? 'public/analysis/slice-at-two.rhythm-analysis.json');
const collectionPath = resolve(root, process.argv[3] ?? 'src/levels/slice-at-two.levels.json');
const primaryPath = resolve(root, process.argv[4] ?? 'src/levels/slice-at-two.level.json');
const analysis = JSON.parse(await readFile(inputPath, 'utf8'));

const EMPTY = 0;
const BREAKABLE = 1;
const SPIKE = 2;
const LANE_COUNT = 5;
const MIN_PLAYABLE_TIME = 1.2;
const OUTRO_MARGIN = 1.15;
const LANE_STEP_SECONDS = 0.2;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function buildEvents(track) {
  const sourceEvents = track.events.filter((event) => (
    event.timeSeconds >= MIN_PLAYABLE_TIME
    && event.timeSeconds <= analysis.song.durationSeconds - OUTRO_MARGIN
  ));
  let lane = 2;
  let direction = 1;
  let previousTime = 0;
  return sourceEvents.map((sourceEvent, index) => {
    const delta = sourceEvent.timeSeconds - previousTime;
    const allowedSteps = Math.max(0, Math.floor((delta + 1e-6) / LANE_STEP_SECONDS));
    if (allowedSteps > 0) {
      if (lane === 0) direction = 1;
      if (lane === LANE_COUNT - 1) direction = -1;
      if (index > 0 && index % 7 === 0) direction *= -1;
      lane = clamp(lane + direction * Math.min(allowedSteps, index % 5 === 0 ? 2 : 1), 0, LANE_COUNT - 1);
      if (lane === 0) direction = 1;
      if (lane === LANE_COUNT - 1) direction = -1;
    }

    const row = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
    row[lane] = BREAKABLE;
    const confidence = Number.isFinite(sourceEvent.confidence) ? sourceEvent.confidence : 0.5;
    const hazardBudget = delta < 0.32 ? 0 : confidence >= 0.76 ? 2 : confidence >= 0.46 ? 1 : 0;
    const hazardCandidates = lane <= 1
      ? [4, 3]
      : lane >= 3
        ? [0, 1]
        : index % 2 === 0 ? [0, 4] : [4, 0];
    for (const hazardLane of hazardCandidates.slice(0, hazardBudget)) row[hazardLane] = SPIKE;
    previousTime = sourceEvent.timeSeconds;
    return {
      timeSeconds: sourceEvent.timeSeconds,
      obstacles: row,
      strength: sourceEvent.confidence,
      source: track.id,
    };
  });
}

function buildLevel(track) {
  const events = buildEvents(track);
  return {
    id: `${analysis.song.id}-${track.id}`,
    version: 3,
    song: {
      title: analysis.song.title,
      artist: analysis.song.artist,
      audioUrl: analysis.song.audioUrl,
      bpm: 116,
      durationSeconds: analysis.song.durationSeconds,
    },
    generation: {
      algorithm: track.id,
      displayName: track.name,
      description: track.description,
      noteCount: events.length,
      sourceEventCount: track.eventCount,
      timingPolicy: analysis.timingPolicy,
      metrics: track.metrics,
    },
    events,
  };
}

const levels = Object.fromEntries(analysis.tracks.map((track) => [track.id, buildLevel(track)]));
const primaryTrackId = analysis.primaryTrackId;
if (!levels[primaryTrackId]) throw new Error(`Primary rhythm track ${primaryTrackId} is missing.`);

const collection = {
  schemaVersion: 1,
  kind: 'rhythm-level-collection',
  generatedAt: analysis.generatedAt,
  primaryTrackId,
  levels,
};
await mkdir(dirname(collectionPath), { recursive: true });
await writeFile(collectionPath, `${JSON.stringify(collection, null, 2)}\n`);
await writeFile(primaryPath, `${JSON.stringify(levels[primaryTrackId], null, 2)}\n`);
console.log(`Generated ${Object.keys(levels).length} event-timed levels; primary=${primaryTrackId}.`);
