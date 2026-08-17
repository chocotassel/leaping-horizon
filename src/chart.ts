import { ObstacleType, type Level, type LevelEvent, type ObstacleRow } from './types';
import { t } from './i18n';

function isObstacleRow(value: unknown): value is ObstacleRow {
  return Array.isArray(value) && value.length === 5 && value.every((cell) => (
    Number.isInteger(cell) && cell >= ObstacleType.Empty && cell <= ObstacleType.Spike
  ));
}

export function validateLevel(level: Level): Level {
  if (level.version !== 3) throw new Error(t('error.unsupportedLevelVersion', { version: level.version }));
  if (!Number.isFinite(level.song.bpm) || level.song.bpm <= 0) throw new Error(t('error.invalidSongBpm'));
  if (!Number.isFinite(level.song.durationSeconds) || level.song.durationSeconds <= 0) {
    throw new Error(t('error.invalidSongDuration'));
  }
  if (!level.song.audioUrl.toLowerCase().endsWith('.mp3')) throw new Error(t('error.invalidAudioFormat'));
  if (!Array.isArray(level.events)) throw new Error(t('error.invalidLevelEvents'));

  let previousTime = -Infinity;
  level.events.forEach((event: LevelEvent, eventIndex) => {
    if (!Number.isFinite(event.timeSeconds) || event.timeSeconds < 0 || event.timeSeconds > level.song.durationSeconds) {
      throw new Error(t('error.eventOutsideSong', { index: eventIndex }));
    }
    if (event.timeSeconds <= previousTime) {
      throw new Error(t('error.eventOrder', { index: eventIndex }));
    }
    if (!isObstacleRow(event.obstacles)) throw new Error(t('error.invalidEventLanes', { index: eventIndex }));
    if (event.obstacles.every((type) => type === ObstacleType.Empty)) {
      throw new Error(t('error.emptyEvent', { index: eventIndex }));
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

const levelModules = import.meta.glob<{ default: unknown }>('./songs/*/level.json', { eager: true });
const audioModules = import.meta.glob<string>('./songs/*/audio.mp3', {
  eager: true,
  import: 'default',
  query: '?url',
});

export const LEVELS = Object.entries(levelModules)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, module]) => {
    const audioUrl = audioModules[path.replace(/level\.json$/, 'audio.mp3')];
    if (!audioUrl) throw new Error(t('error.missingAudio', { path }));
    const level = module.default as Level;
    return validateLevel({ ...level, song: { ...level.song, audioUrl } });
  });

if (!LEVELS.length) throw new Error(t('error.noLevels'));

export const DEFAULT_LEVEL_ID = LEVELS[0].id;

export function getLevelById(levelId: string | null | undefined): Level {
  return LEVELS.find((level) => level.id === levelId)
    ?? LEVELS.find((level) => level.id === DEFAULT_LEVEL_ID)
    ?? LEVELS[0];
}
