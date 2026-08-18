import { SCENE_COLOR_SCHEMES, type SceneColorSchemeId } from './game/colorSchemes';
import {
  ObstacleType,
  type ColorSchemeEvent,
  type Level,
  type LevelEvent,
  type ObstacleRow,
  type PlayRegionRecipe,
  type RegionFeel,
  type RegionLaneDriver,
  type RegionMapping,
  type RegionRecipe,
  type RegionTimingLayer,
} from './types';

export type {
  PlayRegionRecipe,
  RegionFeel,
  RegionLaneDriver,
  RegionMapping,
  RegionRecipe,
  RegionTimingLayer,
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
  version: 3;
  levelId: string;
  baseFingerprint?: string;
  evidenceFingerprint?: string;
  arrangements: RegionRecipe[];
  rowOverrides: RowOverride[];
  colorRanges: ColorRangeEdit[];
}

const EPSILON_SECONDS = 0.00001;

export function rhythmPointKey(timeSeconds: number): string {
  return Number(timeSeconds).toFixed(5);
}

export function emptyLevelEdits(levelId: string): LevelEdits {
  return { version: 3, levelId, arrangements: [], rowOverrides: [], colorRanges: [] };
}

function isObstacleRow(value: unknown): value is ObstacleRow {
  return Array.isArray(value) && value.length === 5 && value.every((cell) => (
    Number.isInteger(cell) && cell >= ObstacleType.Empty && cell <= ObstacleType.Spike
  ));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedControl(value: unknown, name: string, index: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`第 ${index + 1} 个 Region Recipe 的 ${name} 必须在 0 到 1 之间。`);
  }
  return number;
}

interface LegacyRegionRecipe {
  id: string;
  regionId: string;
  sourceId: string;
  mapping: RegionMapping;
  density: number;
  motion: number;
  challenge: number;
  repeatSetId?: string;
  occurrenceIds?: string[];
}

function parseRepeatIdentity(
  input: Record<string, unknown>,
  index: number,
): { repeatSetId?: string; occurrenceIds?: string[] } {
  if (input.repeatSetId != null && !nonEmptyString(input.repeatSetId)) {
    throw new Error(`第 ${index + 1} 个 Region Recipe 的 repeatSetId 无效。`);
  }
  let occurrenceIds: string[] | undefined;
  if (input.occurrenceIds != null) {
    if (!Array.isArray(input.occurrenceIds) || input.occurrenceIds.some((id) => !nonEmptyString(id))) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的 occurrenceIds 无效。`);
    }
    occurrenceIds = [...input.occurrenceIds] as string[];
    if (new Set(occurrenceIds).size !== occurrenceIds.length) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的 occurrenceIds 不能重复。`);
    }
    if (!nonEmptyString(input.repeatSetId)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 使用 occurrenceIds 时必须提供 repeatSetId。`);
    }
  }
  return {
    ...(nonEmptyString(input.repeatSetId) ? { repeatSetId: input.repeatSetId } : {}),
    ...(occurrenceIds ? { occurrenceIds } : {}),
  };
}

function parseLegacyRegionRecipes(value: unknown): LegacyRegionRecipe[] {
  if (!Array.isArray(value)) throw new Error('arrangements 必须是数组。');
  const mappings = new Set<RegionMapping>(['pulse', 'alternating', 'pitch-contour', 'rest']);
  const seenIds = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 必须是对象。`);
    }
    const input = entry as Record<string, unknown>;
    if (!nonEmptyString(input.id) || seenIds.has(input.id)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的 id 无效或重复。`);
    }
    if (!nonEmptyString(input.regionId)) throw new Error(`第 ${index + 1} 个 Region Recipe 的 regionId 无效。`);
    if (!nonEmptyString(input.sourceId)) throw new Error(`第 ${index + 1} 个 Region Recipe 的 sourceId 无效。`);
    if (!nonEmptyString(input.mapping) || !mappings.has(input.mapping as RegionMapping)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的 mapping 无效。`);
    }
    const repeat = parseRepeatIdentity(input, index);
    seenIds.add(input.id);
    return {
      id: input.id,
      regionId: input.regionId,
      sourceId: input.sourceId,
      mapping: input.mapping as RegionMapping,
      density: normalizedControl(input.density, 'density', index),
      motion: normalizedControl(input.motion, 'motion', index),
      challenge: normalizedControl(input.challenge, 'challenge', index),
      ...repeat,
    };
  });
}

function migrateLegacyRecipe(recipe: LegacyRegionRecipe): RegionRecipe {
  const repeat = {
    ...(recipe.repeatSetId ? { repeatSetId: recipe.repeatSetId } : {}),
    ...(recipe.occurrenceIds ? { occurrenceIds: [...recipe.occurrenceIds] } : {}),
  };
  if (recipe.mapping === 'rest') {
    return { id: recipe.id, regionId: recipe.regionId, mode: 'rest', ...repeat };
  }
  const laneDriver: RegionLaneDriver = recipe.mapping === 'pitch-contour'
    ? { kind: 'source', sourceId: recipe.sourceId, motion: recipe.motion }
    : {
        kind: 'gesture',
        pattern: recipe.mapping === 'alternating' ? 'alternating' : 'pulse',
        motion: recipe.motion,
      };
  return {
    id: recipe.id,
    regionId: recipe.regionId,
    mode: 'play',
    timingLayers: [{
      sourceId: recipe.sourceId,
      role: 'target',
      weight: 1,
      compatibility: 'legacy-single-source-v2',
    }],
    laneDriver,
    density: recipe.density,
    challenge: recipe.challenge,
    feel: 'natural',
    ...repeat,
  };
}

function parseLaneDriver(value: unknown, index: number): RegionLaneDriver {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new Error(`第 ${index + 1} 个 Region Recipe 的 laneDriver 无效。`);
  }
  const input = value as Record<string, unknown>;
  const motion = normalizedControl(input.motion, 'laneDriver.motion', index);
  if (input.kind === 'source' && nonEmptyString(input.sourceId)) {
    return { kind: 'source', sourceId: input.sourceId, motion };
  }
  if (input.kind === 'gesture' && (input.pattern === 'pulse' || input.pattern === 'alternating')) {
    return { kind: 'gesture', pattern: input.pattern, motion };
  }
  throw new Error(`第 ${index + 1} 个 Region Recipe 的 laneDriver 无效。`);
}

function parseTimingLayers(value: unknown, index: number): RegionTimingLayer[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`第 ${index + 1} 个 Region Recipe 必须至少有一个 timingLayer。`);
  }
  const seen = new Set<string>();
  const layers = value.map((entry, layerIndex) => {
    if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的第 ${layerIndex + 1} 个 timingLayer 无效。`);
    }
    const layer = entry as Record<string, unknown>;
    if (!nonEmptyString(layer.sourceId) || (layer.role !== 'target' && layer.role !== 'accent')) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的第 ${layerIndex + 1} 个 timingLayer 无效。`);
    }
    if (seen.has(layer.sourceId)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的 timingLayer sourceId 不能重复。`);
    }
    if (
      layer.compatibility != null
      && layer.compatibility !== 'legacy-single-source-v2'
    ) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的第 ${layerIndex + 1} 个 timingLayer compatibility 无效。`);
    }
    seen.add(layer.sourceId);
    const weight = normalizedControl(layer.weight, `timingLayers[${layerIndex}].weight`, index);
    if (weight <= 0) throw new Error(`第 ${index + 1} 个 Region Recipe 的 timingLayer weight 必须大于 0。`);
    return {
      sourceId: layer.sourceId,
      role: layer.role,
      weight,
      ...(layer.compatibility === 'legacy-single-source-v2'
        ? { compatibility: layer.compatibility }
        : {}),
    } as RegionTimingLayer;
  });
  if (!layers.some((layer) => layer.role === 'target')) {
    throw new Error(`第 ${index + 1} 个非留白 Region Recipe 必须至少有一个 target timingLayer。`);
  }
  return layers;
}

function parseRegionRecipesV3(value: unknown): RegionRecipe[] {
  if (!Array.isArray(value)) throw new Error('arrangements 必须是数组。');
  const seenIds = new Set<string>();
  const feels = new Set<RegionFeel>(['steady', 'natural', 'showcase']);
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 必须是对象。`);
    }
    const input = entry as Record<string, unknown>;
    if (!nonEmptyString(input.id) || seenIds.has(input.id)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的 id 无效或重复。`);
    }
    if (!nonEmptyString(input.regionId)) throw new Error(`第 ${index + 1} 个 Region Recipe 的 regionId 无效。`);
    const repeat = parseRepeatIdentity(input, index);
    seenIds.add(input.id);
    if (input.mode === 'rest') {
      return { id: input.id, regionId: input.regionId, mode: 'rest', ...repeat };
    }
    if (input.mode !== 'play') throw new Error(`第 ${index + 1} 个 Region Recipe 的 mode 无效。`);
    if (!nonEmptyString(input.feel) || !feels.has(input.feel as RegionFeel)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的 feel 无效。`);
    }
    const maxGapBeats = input.maxGapBeats == null ? undefined : Number(input.maxGapBeats);
    if (maxGapBeats != null && (!Number.isFinite(maxGapBeats) || maxGapBeats <= 0 || maxGapBeats > 32)) {
      throw new Error(`第 ${index + 1} 个 Region Recipe 的 maxGapBeats 必须大于 0 且不超过 32。`);
    }
    const recipe: PlayRegionRecipe = {
      id: input.id,
      regionId: input.regionId,
      mode: 'play',
      timingLayers: parseTimingLayers(input.timingLayers, index),
      laneDriver: parseLaneDriver(input.laneDriver, index),
      density: normalizedControl(input.density, 'density', index),
      challenge: normalizedControl(input.challenge, 'challenge', index),
      feel: input.feel as RegionFeel,
      ...(maxGapBeats != null ? { maxGapBeats } : {}),
      ...repeat,
    };
    return recipe;
  });
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
  const input = value as Omit<Partial<LevelEdits>, 'version' | 'arrangements'> & {
    version?: unknown;
    arrangements?: unknown;
  };
  if (input.version !== 1 && input.version !== 2 && input.version !== 3) throw new Error('编辑文件版本不受支持。');
  if (input.levelId !== level.id) throw new Error(`编辑文件属于 ${String(input.levelId)}，不是 ${level.id}。`);
  const arrangements = input.version === 1
    ? []
    : input.version === 2
      ? parseLegacyRegionRecipes(input.arrangements).map(migrateLegacyRecipe)
      : parseRegionRecipesV3(input.arrangements);
  if (input.baseFingerprint != null && !nonEmptyString(input.baseFingerprint)) {
    throw new Error('baseFingerprint 必须是非空字符串。');
  }
  if (input.evidenceFingerprint != null && !nonEmptyString(input.evidenceFingerprint)) {
    throw new Error('evidenceFingerprint 必须是非空字符串。');
  }
  if (input.rowOverrides != null && !Array.isArray(input.rowOverrides)) {
    throw new Error('rowOverrides must be an array.');
  }
  if (input.colorRanges != null && !Array.isArray(input.colorRanges)) {
    throw new Error('colorRanges must be an array.');
  }

  const times = knownPointTimes(level);
  const seenRows = new Set<string>();
  const rowOverrides = (input.rowOverrides ?? []).map((override, index) => {
    const timeSeconds = Number(override?.timeSeconds);
    const key = rhythmPointKey(timeSeconds);
    if (!Number.isFinite(timeSeconds) || !times.has(key)) throw new Error(`第 ${index + 1} 个行修改不在节奏点上。`);
    if (seenRows.has(key)) throw new Error(`节奏点 ${key}s 被重复修改。`);
    if (!isObstacleRow(override?.obstacles)) throw new Error(`节奏点 ${key}s 的五轨数据无效。`);
    seenRows.add(key);
    return { timeSeconds: times.get(key)!, obstacles: [...override.obstacles] as ObstacleRow };
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

  return {
    version: 3,
    levelId: level.id,
    ...(typeof input.baseFingerprint === 'string' && input.baseFingerprint
      ? { baseFingerprint: input.baseFingerprint }
      : {}),
    ...(typeof input.evidenceFingerprint === 'string' && input.evidenceFingerprint
      ? { evidenceFingerprint: input.evidenceFingerprint }
      : {}),
    arrangements,
    rowOverrides,
    colorRanges,
  };
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
