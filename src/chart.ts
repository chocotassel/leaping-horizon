import { applyLevelEdits, parseLevelEdits, type LevelEdits } from './levelEdits';
import { SCENE_COLOR_SCHEMES } from './game/colorSchemes';
import { t } from './i18n';
import { ObstacleType, type Level, type LevelEvent, type ObstacleRow } from './types';

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
  if (!Array.isArray(level.rhythmPoints) || !level.rhythmPoints.length) {
    throw new Error('Level has no editable rhythm points.');
  }
  if (!Array.isArray(level.events)) throw new Error(t('error.invalidLevelEvents'));
  if (!Array.isArray(level.colorSchemeEvents) || !level.colorSchemeEvents.length) {
    throw new Error(t('error.invalidColorSchemeEvents'));
  }

  let previousPointTime = -Infinity;
  const pointTimes = new Set<string>();
  level.rhythmPoints.forEach((point, index) => {
    const key = point.timeSeconds.toFixed(5);
    if (
      !Number.isFinite(point.timeSeconds)
      || point.timeSeconds < 0
      || point.timeSeconds > level.song.durationSeconds
      || point.timeSeconds <= previousPointTime
      || pointTimes.has(key)
      || (point.suggestedLane !== undefined && (
        !Number.isInteger(point.suggestedLane)
        || point.suggestedLane < 0
        || point.suggestedLane > 4
      ))
    ) throw new Error(`Rhythm point ${index} is invalid.`);
    previousPointTime = point.timeSeconds;
    pointTimes.add(key);
  });

  let previousColorTime = -Infinity;
  let previousColorId = '';
  level.colorSchemeEvents.forEach((event, index) => {
    if (
      !Number.isFinite(event.timeSeconds)
      || event.timeSeconds < 0
      || event.timeSeconds > level.song.durationSeconds
      || event.timeSeconds <= previousColorTime
      || !Object.prototype.hasOwnProperty.call(SCENE_COLOR_SCHEMES, event.colorSchemeId)
      || event.colorSchemeId === previousColorId
    ) throw new Error(t('error.invalidColorSchemeEvent', { index }));
    previousColorTime = event.timeSeconds;
    previousColorId = event.colorSchemeId;
  });

  let previousEventTime = -Infinity;
  level.events.forEach((event: LevelEvent, index) => {
    if (
      !Number.isFinite(event.timeSeconds)
      || event.timeSeconds < 0
      || event.timeSeconds > level.song.durationSeconds
      || event.timeSeconds <= previousEventTime
      || !pointTimes.has(event.timeSeconds.toFixed(5))
    ) throw new Error(t('error.eventOrder', { index }));
    if (!isObstacleRow(event.obstacles)) throw new Error(t('error.invalidEventLanes', { index }));
    if (event.obstacles.every((type) => type === ObstacleType.Empty)) {
      throw new Error(t('error.emptyEvent', { index }));
    }
    previousEventTime = event.timeSeconds;
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

export function getMaxObstacleCountInWindow(
  level: Pick<Level, 'events'>,
  type: ObstacleType,
  windowSeconds: number,
): number {
  let start = 0;
  let current = 0;
  let maximum = 0;
  const counts = level.events.map((event) => (
    event.obstacles.reduce((count, obstacle) => count + Number(obstacle === type), 0)
  ));
  for (let end = 0; end < level.events.length; end += 1) {
    current += counts[end];
    while (level.events[end].timeSeconds - level.events[start].timeSeconds > windowSeconds) {
      current -= counts[start];
      start += 1;
    }
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

const levelModules = import.meta.glob<{ default: unknown }>('./songs/*/level.json', { eager: true });
const editModules = import.meta.glob<{ default: unknown }>('./songs/*/edits.json', { eager: true });
const audioModules = import.meta.glob<string>('./songs/*/audio.mp3', {
  eager: true,
  import: 'default',
  query: '?base64',
});
const LEVEL_ORDER = [
  'rearview-halo-flow',
  'slice-at-two-flow',
  'story-reactions-flow',
  'hands-on-deck-flow',
];

const BASE_LEVELS = Object.entries(levelModules)
  .map(([path, module]) => {
    const audioUrl = audioModules[path.replace(/level\.json$/, 'audio.mp3')];
    if (!audioUrl) throw new Error(t('error.missingAudio', { path }));
    const level = validateLevel(module.default as Level);
    return { ...level, song: { ...level.song, audioUrl } };
  })
  .sort((left, right) => {
    const leftOrder = LEVEL_ORDER.indexOf(left.id);
    const rightOrder = LEVEL_ORDER.indexOf(right.id);
    return (leftOrder < 0 ? LEVEL_ORDER.length : leftOrder)
      - (rightOrder < 0 ? LEVEL_ORDER.length : rightOrder)
      || left.id.localeCompare(right.id);
  });

if (!BASE_LEVELS.length) throw new Error(t('error.noLevels'));

const editsByLevelId = new Map<string, LevelEdits>();
for (const level of BASE_LEVELS) {
  const levelPath = Object.entries(levelModules).find(([, module]) => (
    (module.default as { id?: string })?.id === level.id
  ))?.[0];
  const editValue = levelPath ? editModules[levelPath.replace(/level\.json$/, 'edits.json')]?.default : null;
  editsByLevelId.set(level.id, parseLevelEdits(editValue, level));
}

export const LEVELS = BASE_LEVELS.map((level) => applyLevelEdits(level, editsByLevelId.get(level.id)));
export const DEFAULT_LEVEL_ID = LEVELS[0].id;

export function getLevelById(levelId: string | null | undefined): Level {
  return LEVELS.find((level) => level.id === levelId) ?? LEVELS[0];
}
