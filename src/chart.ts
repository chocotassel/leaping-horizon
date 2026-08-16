import { ObstacleType, type Level, type LevelEvent, type ObstacleRow } from './types';

function isObstacleRow(value: unknown): value is ObstacleRow {
  return Array.isArray(value) && value.length === 5 && value.every((cell) => (
    Number.isInteger(cell) && cell >= ObstacleType.Empty && cell <= ObstacleType.Spike
  ));
}

export function validateLevel(level: Level): Level {
  if (level.version !== 3) throw new Error(`Unsupported level version ${String(level.version)}.`);
  if (!Number.isFinite(level.song.bpm) || level.song.bpm <= 0) throw new Error('Song BPM must be greater than 0.');
  if (!Number.isFinite(level.song.durationSeconds) || level.song.durationSeconds <= 0) {
    throw new Error('Song duration must be greater than 0.');
  }
  if (!level.song.audioUrl.toLowerCase().endsWith('.mp3')) throw new Error('Game audio must be MP3.');
  if (!Array.isArray(level.events)) throw new Error('Level events must be an array.');

  let previousTime = -Infinity;
  level.events.forEach((event: LevelEvent, eventIndex) => {
    if (!Number.isFinite(event.timeSeconds) || event.timeSeconds < 0 || event.timeSeconds > level.song.durationSeconds) {
      throw new Error(`Event ${eventIndex} is outside the song.`);
    }
    if (event.timeSeconds <= previousTime) {
      throw new Error(`Event ${eventIndex} is not strictly later than the preceding event.`);
    }
    if (!isObstacleRow(event.obstacles)) throw new Error(`Event ${eventIndex} must contain exactly 5 valid lanes.`);
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

const levelModules = import.meta.glob<{ default: unknown }>('./levels/*.level.json', { eager: true });

export const LEVELS = Object.entries(levelModules)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([, module]) => validateLevel(module.default as Level));

if (!LEVELS.length) throw new Error('No generated level files were found.');

export const DEFAULT_LEVEL_ID = LEVELS.find((level) => level.song.title === 'Slice at Two')?.id ?? LEVELS[0].id;

export function getLevelById(levelId: string | null | undefined): Level {
  return LEVELS.find((level) => level.id === levelId)
    ?? LEVELS.find((level) => level.id === DEFAULT_LEVEL_ID)
    ?? LEVELS[0];
}
