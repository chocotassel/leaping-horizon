import { SCENE_COLOR_SCHEMES, type SceneColorSchemeId } from './game/colorSchemes';
import {
  ObstacleType,
  type ColorSchemeEvent,
  type Level,
  type LevelEvent,
  type ObstacleRow,
} from './types';

export interface RowOverride {
  timeSeconds: number;
  obstacles: ObstacleRow;
}

export interface ColorRangeEdit {
  id: string;
  startSeconds: number;
  endSeconds: number;
  colorSchemeId: SceneColorSchemeId;
}

export interface LevelEdits {
  version: 1;
  levelId: string;
  rowOverrides: RowOverride[];
  colorRanges: ColorRangeEdit[];
}

const EPSILON_SECONDS = 0.00001;

export function rhythmPointKey(timeSeconds: number): string {
  return Number(timeSeconds).toFixed(5);
}

export function emptyLevelEdits(levelId: string): LevelEdits {
  return { version: 1, levelId, rowOverrides: [], colorRanges: [] };
}

function isObstacleRow(value: unknown): value is ObstacleRow {
  return Array.isArray(value) && value.length === 5 && value.every((cell) => (
    Number.isInteger(cell) && cell >= ObstacleType.Empty && cell <= ObstacleType.Spike
  ));
}

function sameRow(left: readonly number[], right: readonly number[]): boolean {
  return left.every((cell, index) => cell === right[index]);
}

function knownPointTimes(level: Level): Map<string, number> {
  const points: ReadonlyArray<{ timeSeconds: number }> = level.rhythmPoints?.length
    ? level.rhythmPoints
    : level.events;
  return new Map(points.map((point) => [rhythmPointKey(point.timeSeconds), point.timeSeconds]));
}

export function parseLevelEdits(value: unknown, level: Level): LevelEdits {
  if (value == null) return emptyLevelEdits(level.id);
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('编辑文件必须是 JSON 对象。');
  const input = value as Partial<LevelEdits>;
  if (input.version !== 1) throw new Error('编辑文件版本不受支持。');
  if (input.levelId !== level.id) throw new Error(`编辑文件属于 ${String(input.levelId)}，不是 ${level.id}。`);

  const times = knownPointTimes(level);
  const baseRows = new Map(level.events.map((event) => [rhythmPointKey(event.timeSeconds), event.obstacles]));
  const seenRows = new Set<string>();
  const rowOverrides = (input.rowOverrides ?? []).map((override, index) => {
    const timeSeconds = Number(override?.timeSeconds);
    const key = rhythmPointKey(timeSeconds);
    if (!Number.isFinite(timeSeconds) || !times.has(key)) throw new Error(`第 ${index + 1} 个行修改不在节奏点上。`);
    if (seenRows.has(key)) throw new Error(`节奏点 ${key}s 被重复修改。`);
    if (!isObstacleRow(override?.obstacles)) throw new Error(`节奏点 ${key}s 的五轨数据无效。`);
    seenRows.add(key);
    return { timeSeconds: times.get(key)!, obstacles: [...override.obstacles] as ObstacleRow };
  }).filter((override) => {
    const base = baseRows.get(rhythmPointKey(override.timeSeconds)) ?? [0, 0, 0, 0, 0];
    return !sameRow(override.obstacles, base);
  }).sort((left, right) => left.timeSeconds - right.timeSeconds);

  const colorRanges = (input.colorRanges ?? []).map((range, index) => {
    const startSeconds = Number(range?.startSeconds);
    const endSeconds = Number(range?.endSeconds);
    const scheme = String(range?.colorSchemeId) as SceneColorSchemeId;
    if (
      typeof range?.id !== 'string'
      || !range.id
      || !Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || startSeconds < 0
      || endSeconds <= startSeconds
      || endSeconds > level.song.durationSeconds + EPSILON_SECONDS
      || !times.has(rhythmPointKey(startSeconds))
      || (
        Math.abs(endSeconds - level.song.durationSeconds) > EPSILON_SECONDS
        && !times.has(rhythmPointKey(endSeconds))
      )
      || !Object.prototype.hasOwnProperty.call(SCENE_COLOR_SCHEMES, scheme)
    ) throw new Error(`第 ${index + 1} 个颜色区间无效。`);
    return { id: range.id, startSeconds, endSeconds, colorSchemeId: scheme };
  }).sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);

  colorRanges.forEach((range, index) => {
    if (index > 0 && range.startSeconds < colorRanges[index - 1].endSeconds - EPSILON_SECONDS) {
      throw new Error('颜色区间不能重叠。');
    }
  });

  return { version: 1, levelId: level.id, rowOverrides, colorRanges };
}

function activeBaseColor(events: readonly ColorSchemeEvent[], timeSeconds: number): ColorSchemeEvent {
  let active = events[0];
  for (const event of events) {
    if (event.timeSeconds > timeSeconds + EPSILON_SECONDS) break;
    active = event;
  }
  return active;
}

function compileColors(level: Level, ranges: readonly ColorRangeEdit[]): ColorSchemeEvent[] {
  if (!ranges.length) return level.colorSchemeEvents.map((event) => ({ ...event }));
  const boundaries = new Set(level.colorSchemeEvents.map((event) => rhythmPointKey(event.timeSeconds)));
  ranges.forEach((range) => {
    boundaries.add(rhythmPointKey(range.startSeconds));
    if (range.endSeconds < level.song.durationSeconds - EPSILON_SECONDS) {
      boundaries.add(rhythmPointKey(range.endSeconds));
    }
  });
  const compiled: ColorSchemeEvent[] = [];
  for (const value of [...boundaries].map(Number).sort((left, right) => left - right)) {
    const range = ranges.find((candidate) => (
      value >= candidate.startSeconds - EPSILON_SECONDS
      && value < candidate.endSeconds - EPSILON_SECONDS
    ));
    const base = activeBaseColor(level.colorSchemeEvents, value);
    const colorSchemeId = range?.colorSchemeId ?? base.colorSchemeId;
    if (compiled[compiled.length - 1]?.colorSchemeId === colorSchemeId) continue;
    compiled.push(range ? {
      timeSeconds: value,
      colorSchemeId,
      kind: 'section',
      source: `manual:${range.id}`,
      strength: 1,
    } : { ...base, timeSeconds: value });
  }
  return compiled;
}

export function applyLevelEdits(base: Level, value: unknown): Level {
  const edits = parseLevelEdits(value, base);
  const baseRows = new Map(base.events.map((event) => [rhythmPointKey(event.timeSeconds), event]));
  const overrides = new Map(edits.rowOverrides.map((override) => [rhythmPointKey(override.timeSeconds), override]));
  const eventKeys = new Set([...baseRows.keys(), ...overrides.keys()]);
  const events = [...eventKeys].map((key): LevelEvent | null => {
    const original = baseRows.get(key);
    const override = overrides.get(key);
    const obstacles = (override?.obstacles ?? original?.obstacles) as ObstacleRow;
    if (obstacles.every((cell) => cell === ObstacleType.Empty)) return null;
    const targetCount = obstacles.filter((cell) => cell === ObstacleType.Breakable).length;
    return {
      ...(original ?? {
        timeSeconds: override!.timeSeconds,
      }),
      obstacles: [...obstacles] as ObstacleRow,
      kind: targetCount > 0 ? 'target' : 'dodge',
    };
  }).filter((event): event is LevelEvent => event !== null)
    .sort((left, right) => left.timeSeconds - right.timeSeconds);

  return {
    ...base,
    generation: {
      ...base.generation,
      noteCount: events.filter((event) => event.kind === 'target').length,
      ...(edits.rowOverrides.length ? { manualRowOverrideCount: edits.rowOverrides.length } : {}),
      ...(edits.colorRanges.length ? { manualColorRangeCount: edits.colorRanges.length } : {}),
    },
    colorSchemeEvents: compileColors(base, edits.colorRanges),
    events,
  };
}
