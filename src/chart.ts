import rhythmLevelCollection from './levels/slice-at-two.levels.json';
import {
  DIFFICULTY_OPTIONS,
  ObstacleType,
  isDifficultyId,
  type DifficultyId,
  type Level,
  type LevelEvent,
  type ObstacleRow,
} from './types';

interface LegacyLevelV2 {
  id: string;
  version: 2;
  ticksPerBeat: number;
  song: {
    title: string;
    artist: string;
    audioUrl: string;
    bpm: number;
    beatOffsetSeconds: number;
    durationSeconds: number;
  };
  generation: Level['generation'];
  obstacles: ObstacleRow[];
}

function isObstacleRow(value: unknown): value is ObstacleRow {
  return Array.isArray(value) && value.length === 5 && value.every((cell) => (
    Number.isInteger(cell) && cell >= ObstacleType.Empty && cell <= ObstacleType.Spike
  ));
}

/** Keep old checked-in levels readable while all generated output moves to v3. */
export function normalizeLevel(input: unknown): Level {
  const raw = input as Partial<Level> & Partial<LegacyLevelV2>;
  if (raw.version === 2 && Array.isArray(raw.obstacles) && raw.song) {
    const legacy = raw as LegacyLevelV2;
    const tickDuration = 60 / legacy.song.bpm / legacy.ticksPerBeat;
    return {
      id: legacy.id,
      version: 3,
      song: {
        title: legacy.song.title,
        artist: legacy.song.artist,
        audioUrl: legacy.song.audioUrl,
        bpm: legacy.song.bpm,
        durationSeconds: legacy.song.durationSeconds,
      },
      generation: {
        ...legacy.generation,
        algorithm: `${legacy.generation.algorithm}-legacy-v2-converted`,
      },
      events: legacy.obstacles.reduce<LevelEvent[]>((events, obstacles, tick) => {
        if (!obstacles.every((type) => type === ObstacleType.Empty)) {
          events.push({
            timeSeconds: legacy.song.beatOffsetSeconds + tick * tickDuration,
            obstacles,
            source: 'legacy-grid',
          });
        }
        return events;
      }, []),
    };
  }
  return validateLevel(raw as Level);
}

export function validateLevel(level: Level): Level {
  if (level.version !== 3) throw new Error(`Unsupported level version ${String(level.version)}.`);
  if (!Number.isFinite(level.song.bpm) || level.song.bpm <= 0) {
    throw new Error('Song BPM must be greater than 0.');
  }
  if (!Number.isFinite(level.song.durationSeconds) || level.song.durationSeconds <= 0) {
    throw new Error('Song duration must be greater than 0.');
  }
  if (!Array.isArray(level.events)) throw new Error('Level events must be an array.');

  let previousTime = -Infinity;
  level.events.forEach((event: LevelEvent, eventIndex) => {
    if (!Number.isFinite(event.timeSeconds) || event.timeSeconds < 0 || event.timeSeconds > level.song.durationSeconds) {
      throw new Error(`Event ${eventIndex} is outside the song.`);
    }
    if (event.timeSeconds <= previousTime) {
      throw new Error(`Event ${eventIndex} is not strictly later than the preceding event.`);
    }
    if (!isObstacleRow(event.obstacles)) {
      throw new Error(`Event ${eventIndex} must contain exactly 5 valid lanes.`);
    }
    if (event.obstacles.every((type) => type === ObstacleType.Empty)) {
      throw new Error(`Event ${eventIndex} is empty and should not be stored.`);
    }
    previousTime = event.timeSeconds;
  });
  return level;
}

export function getMaxEventRowsInWindow(level: Level, windowSeconds: number): number {
  let start = 0;
  let maximum = 0;
  for (let end = 0; end < level.events.length; end += 1) {
    while (level.events[end].timeSeconds - level.events[start].timeSeconds > windowSeconds) start += 1;
    maximum = Math.max(maximum, end - start + 1);
  }
  return maximum;
}

interface RhythmLevelCollection {
  primaryTrackId: string;
  primaryDifficulty: DifficultyId;
  levels: Record<DifficultyId, Record<string, unknown>>;
}

const collection = rhythmLevelCollection as RhythmLevelCollection;
export const RHYTHM_LEVELS_BY_DIFFICULTY = DIFFICULTY_OPTIONS.reduce<Record<DifficultyId, Record<string, Level>>>(
  (difficultyLevels, difficulty) => {
    difficultyLevels[difficulty.id] = Object.entries(collection.levels[difficulty.id]).reduce<Record<string, Level>>(
      (levels, [trackId, level]) => {
        levels[trackId] = normalizeLevel(level);
        return levels;
      },
      {},
    );
    return difficultyLevels;
  },
  { flow: {} },
);

export const RHYTHM_LEVELS = RHYTHM_LEVELS_BY_DIFFICULTY[collection.primaryDifficulty];

export const RHYTHM_LEVEL_OPTIONS = Object.keys(RHYTHM_LEVELS).map((trackId) => ({
  id: trackId,
  name: String(RHYTHM_LEVELS[trackId].generation.displayName ?? trackId),
  noteCount: RHYTHM_LEVELS[trackId].generation.noteCount,
}));

export function getLevelForAlgorithm(
  trackId: string | null | undefined,
  difficulty: DifficultyId | string | null | undefined = collection.primaryDifficulty,
): Level {
  const difficultyId = isDifficultyId(difficulty) ? difficulty : collection.primaryDifficulty;
  const levels = RHYTHM_LEVELS_BY_DIFFICULTY[difficultyId];
  return trackId && levels[trackId]
    ? levels[trackId]
    : levels[collection.primaryTrackId];
}

export const DEMO_LEVEL = getLevelForAlgorithm(collection.primaryTrackId, collection.primaryDifficulty);
