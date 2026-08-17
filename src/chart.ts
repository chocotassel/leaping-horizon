import { ObstacleType, type Level, type LevelEvent, type ObstacleRow } from './types';
import { t } from './i18n';
import { SCENE_COLOR_HUES, SCENE_COLOR_SCHEMES } from './game/colorSchemes';

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
  if (!Array.isArray(level.colorSchemeEvents) || !level.colorSchemeEvents.length) {
    throw new Error(t('error.invalidColorSchemeEvents'));
  }

  let previousColorTime = -Infinity;
  let previousColorSchemeId: keyof typeof SCENE_COLOR_HUES | null = null;
  level.colorSchemeEvents.forEach((event, eventIndex) => {
    const hues = SCENE_COLOR_HUES[event.colorSchemeId];
    const previousHues = previousColorSchemeId === null ? null : SCENE_COLOR_HUES[previousColorSchemeId];
    if (
      !Number.isFinite(event.timeSeconds)
      || event.timeSeconds < 0
      || event.timeSeconds > level.song.durationSeconds
      || event.timeSeconds <= previousColorTime
      || !Object.prototype.hasOwnProperty.call(SCENE_COLOR_SCHEMES, event.colorSchemeId)
      || !['section', 'accent'].includes(event.kind)
      || typeof event.source !== 'string'
      || !Number.isFinite(event.strength)
      || event.strength < 0
      || event.strength > 1
      || (previousHues && (
        previousHues.primary === hues.primary || previousHues.accent === hues.accent
      ))
    ) throw new Error(t('error.invalidColorSchemeEvent', { index: eventIndex }));
    previousColorTime = event.timeSeconds;
    previousColorSchemeId = event.colorSchemeId;
  });

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
  query: '?base64',
});

export const LEVELS = Object.entries(levelModules)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, module]) => {
    const audioUrl = audioModules[path.replace(/level\.json$/, 'audio.mp3')];
    if (!audioUrl) throw new Error(t('error.missingAudio', { path }));
    const level = validateLevel(module.default as Level);
    return { ...level, song: { ...level.song, audioUrl } };
  });

if (!LEVELS.length) throw new Error(t('error.noLevels'));

export const DEFAULT_LEVEL_ID = LEVELS[0].id;

export function getLevelById(levelId: string | null | undefined): Level {
  return LEVELS.find((level) => level.id === levelId)
    ?? LEVELS.find((level) => level.id === DEFAULT_LEVEL_ID)
    ?? LEVELS[0];
}
