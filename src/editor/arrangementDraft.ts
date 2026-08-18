import type { LevelEdits } from '../levelEdits';
import type {
  AuthoringEvidenceKind,
  AuthoringEvidenceStream,
  AuthoringSource,
  AuthoringScore as CoreAuthoringScore,
  PlayRegionRecipe,
  RegionLaneDriver,
  RegionRecipe,
  RegionTimingLayer,
} from '../types';

export type PerformancePresetId =
  | 'vocal-lead'
  | 'drum-groove'
  | 'bass-drive'
  | 'ensemble'
  | 'long-note'
  | 'rest';

export type AuthoringScore = CoreAuthoringScore & {
  /** Optional editor-only URLs; absent in runtime and hidden when unavailable. */
  stemPreviewUrls?: Partial<Record<'vocals' | 'drums' | 'bass' | 'other', string>>;
};

export type RegionRecipeDraft =
  | Omit<PlayRegionRecipe, 'id' | 'regionId' | 'repeatSetId' | 'occurrenceIds'>
  | { mode: 'rest' };

export interface RegionReviewItem {
  regionId: string;
  reasons: string[];
}

function cloneLaneDriver(driver: RegionLaneDriver): RegionLaneDriver {
  return { ...driver };
}

function cloneDraft(draft: RegionRecipeDraft): RegionRecipeDraft {
  if (draft.mode === 'rest') return { mode: 'rest' };
  return {
    mode: 'play',
    timingLayers: draft.timingLayers.map((layer) => ({ ...layer })),
    laneDriver: cloneLaneDriver(draft.laneDriver),
    density: draft.density,
    challenge: draft.challenge,
    feel: draft.feel,
    ...(draft.maxGapBeats == null ? {} : { maxGapBeats: draft.maxGapBeats }),
  };
}

function cloneRecipe(recipe: RegionRecipe): RegionRecipe {
  const identity = {
    id: recipe.id,
    regionId: recipe.regionId,
    ...(recipe.repeatSetId ? { repeatSetId: recipe.repeatSetId } : {}),
    ...(recipe.occurrenceIds ? { occurrenceIds: [...recipe.occurrenceIds] } : {}),
  };
  return recipe.mode === 'rest'
    ? { ...identity, mode: 'rest' }
    : { ...identity, ...cloneDraft(recipe) } as RegionRecipe;
}

export function draftFromRecipe(recipe: RegionRecipe): RegionRecipeDraft {
  return cloneDraft(recipe);
}

interface LegacySuggestion {
  regionId: string;
  sourceId: string;
  mapping: 'pulse' | 'alternating' | 'pitch-contour' | 'rest';
  density: number;
  motion: number;
  challenge: number;
  reasonCodes: string[];
}

interface LegacyScore {
  kind: 'authoring-score';
  schemaVersion: '1.0.0';
  algorithm: string;
  levelId: string;
  audioFingerprint: string;
  sources: AuthoringSource[];
  regions: CoreAuthoringScore['regions'];
  repeatSets: CoreAuthoringScore['repeatSets'];
  suggestions: LegacySuggestion[];
}

function legacyStream(
  source: AuthoringSource,
  kind: AuthoringEvidenceKind,
): AuthoringEvidenceStream {
  const estimated = source.id === 'discrete-melody' || source.id === 'melody-contour';
  return {
    ...source,
    kind,
    stemRole: kind === 'metric' ? 'metric' : 'mix',
    identity: estimated ? 'model-estimated' : 'direct',
    events: source.events.map((event) => ({ ...event })),
  };
}

function legacySuggestionPreset(suggestion: LegacySuggestion): CoreAuthoringScore['suggestions'][number] {
  if (suggestion.mapping === 'rest') {
    return {
      regionId: suggestion.regionId,
      preset: { mode: 'rest' },
      reasonCodes: [...suggestion.reasonCodes],
    };
  }
  return {
    regionId: suggestion.regionId,
    preset: {
      mode: 'play',
      timingLayers: [{ sourceId: suggestion.sourceId, role: 'target', weight: 1 }],
      laneDriver: suggestion.mapping === 'pitch-contour'
        ? { kind: 'source', sourceId: suggestion.sourceId, motion: suggestion.motion }
        : {
            kind: 'gesture',
            pattern: suggestion.mapping === 'alternating' ? 'alternating' : 'pulse',
            motion: suggestion.motion,
          },
      density: suggestion.density,
      challenge: suggestion.challenge,
      feel: 'natural',
    },
    reasonCodes: [...suggestion.reasonCodes],
  };
}

/** Compatibility adapter used only by the editor while checked-in v1 sidecars migrate. */
export function normalizeAuthoringScoreForEditor(value: unknown): AuthoringScore {
  if (!value || typeof value !== 'object') throw new Error('Authoring Score 格式无效。');
  const candidate = value as Partial<AuthoringScore> & { schemaVersion?: unknown };
  if (candidate.schemaVersion === '2.0.0') return candidate as AuthoringScore;
  if (candidate.schemaVersion !== '1.0.0') throw new Error('Authoring Score 版本不受支持。');
  const legacy = value as LegacyScore;
  const sourceById = new Map(legacy.sources.map((source) => [source.id, source]));
  const rhythm = sourceById.get('rhythm-grid');
  const timing = legacy.sources
    .filter((source) => source.id !== 'rhythm-grid' && source.capabilities.onsets)
    .map((source) => legacyStream(source, 'timing'));
  const lane = legacy.sources
    .filter((source) => source.capabilities.pitch)
    .map((source) => legacyStream(source, 'lane'));
  const percussion = sourceById.get('percussion-onsets');
  const accent = percussion ? [legacyStream(percussion, 'accent')] : [];
  const metric = rhythm ? [legacyStream(rhythm, 'metric')] : [];
  const allStreams = [...timing, ...lane, ...accent, ...metric];
  const regionEvidence = legacy.regions.map((region) => ({
    regionId: region.id,
    streams: allStreams.map((stream) => {
      const events = stream.events.filter((event) => (
        event.timeSeconds >= region.startSeconds && event.timeSeconds < region.endSeconds
      ));
      const duration = Math.max(0.00001, region.endSeconds - region.startSeconds);
      const times = events.map((event) => event.timeSeconds).sort((left, right) => left - right);
      const gaps = times.length
        ? [
            times[0] - region.startSeconds,
            ...times.slice(1).map((time, index) => time - times[index]),
            region.endSeconds - times[times.length - 1],
          ]
        : [duration];
      const cells = new Set(events.map((event) => Math.max(0, Math.min(
        7,
        Math.floor((event.timeSeconds - region.startSeconds) / duration * 8),
      ))));
      return {
        streamId: stream.id,
        kind: stream.kind,
        eventCount: events.length,
        activeCoverageRatio: cells.size / 8,
        maximumGapSeconds: Math.max(...gaps),
      };
    }),
  }));
  return {
    kind: 'authoring-score',
    schemaVersion: '2.0.0',
    algorithm: `${legacy.algorithm}-editor-compat`,
    levelId: legacy.levelId,
    audioFingerprint: legacy.audioFingerprint,
    evidenceFingerprint: `legacy:${legacy.audioFingerprint}:${legacy.algorithm}`,
    sources: legacy.sources.map((source) => ({
      ...source,
      events: source.events.map((event) => ({ ...event })),
    })),
    evidenceStreams: { timing, lane, accent, metric },
    regions: legacy.regions.map((region) => ({ ...region })),
    regionEvidence,
    repeatSets: legacy.repeatSets.map((set) => ({
      ...set,
      occurrences: set.occurrences.map((occurrence) => ({ ...occurrence })),
    })),
    suggestions: legacy.suggestions.map(legacySuggestionPreset),
  };
}

function streamGroup(score: AuthoringScore, kind: AuthoringEvidenceKind): AuthoringEvidenceStream[] {
  return score.evidenceStreams[kind];
}

function selectableStreams(
  score: AuthoringScore,
  kind: AuthoringEvidenceKind,
): AuthoringEvidenceStream[] {
  return streamGroup(score, kind).filter((stream) => stream.availability !== 'unavailable');
}

function streamForStem(
  score: AuthoringScore,
  kind: AuthoringEvidenceKind,
  stemRole: string,
): AuthoringEvidenceStream | undefined {
  return selectableStreams(score, kind).find((stream) => (
    stream.stemRole === stemRole
    && (kind !== 'timing' || !stream.id.endsWith(':pitch-landmarks'))
  ));
}

function requireStream(
  score: AuthoringScore,
  kind: AuthoringEvidenceKind,
  stemRole: string,
  label: string,
): AuthoringEvidenceStream {
  const stream = streamForStem(score, kind, stemRole);
  if (!stream) throw new Error(`${label}证据当前不可用，请选择其他预设。`);
  return stream;
}

function playRecipe(
  regionId: string,
  timingLayers: RegionTimingLayer[],
  laneDriver: RegionLaneDriver,
  values: Pick<PlayRegionRecipe, 'density' | 'challenge' | 'feel'> & { maxGapBeats?: number },
): RegionRecipe {
  return {
    id: `recipe:${regionId}`,
    regionId,
    mode: 'play',
    timingLayers,
    laneDriver,
    density: values.density,
    challenge: values.challenge,
    feel: values.feel,
    ...(values.maxGapBeats == null ? {} : { maxGapBeats: values.maxGapBeats }),
  };
}

export function materializePerformancePreset(
  score: AuthoringScore,
  regionId: string,
  presetId: PerformancePresetId,
): RegionRecipe {
  if (!score.regions.some((region) => region.id === regionId)) {
    throw new Error(`找不到片段 ${regionId}。`);
  }
  if (presetId === 'rest') return { id: `recipe:${regionId}`, regionId, mode: 'rest' };

  if (presetId === 'vocal-lead') {
    const target = requireStream(score, 'timing', 'vocals', '人声发音');
    const lane = streamForStem(score, 'lane', 'vocals');
    const drumAccent = streamForStem(score, 'accent', 'drums');
    return playRecipe(
      regionId,
      [
        { sourceId: target.id, role: 'target', weight: 1 },
        ...(drumAccent ? [{ sourceId: drumAccent.id, role: 'accent' as const, weight: 0.75 }] : []),
      ],
      lane
        ? { kind: 'source', sourceId: lane.id, motion: 0.9 }
        : { kind: 'gesture', pattern: 'alternating', motion: 0.65 },
      { density: 0.82, challenge: 0.28, feel: 'natural', maxGapBeats: 3 },
    );
  }

  if (presetId === 'drum-groove') {
    const target = requireStream(score, 'timing', 'drums', '鼓点');
    const accent = streamForStem(score, 'accent', 'drums');
    return playRecipe(
      regionId,
      [
        { sourceId: target.id, role: 'target', weight: 1 },
        ...(accent ? [{ sourceId: accent.id, role: 'accent' as const, weight: 0.8 }] : []),
      ],
      { kind: 'gesture', pattern: 'alternating', motion: 0.72 },
      { density: 0.75, challenge: 0.34, feel: 'steady', maxGapBeats: 3 },
    );
  }

  if (presetId === 'bass-drive') {
    const target = requireStream(score, 'timing', 'bass', '贝斯起音');
    const lane = streamForStem(score, 'lane', 'bass');
    return playRecipe(
      regionId,
      [{ sourceId: target.id, role: 'target', weight: 1 }],
      lane
        ? { kind: 'source', sourceId: lane.id, motion: 0.68 }
        : { kind: 'gesture', pattern: 'alternating', motion: 0.55 },
      { density: 0.78, challenge: 0.3, feel: 'steady', maxGapBeats: 4 },
    );
  }

  if (presetId === 'long-note') {
    const role = ['vocals', 'other', 'bass'].find((candidate) => (
      streamForStem(score, 'timing', candidate) && streamForStem(score, 'lane', candidate)
    ));
    if (!role) throw new Error('当前片段没有可用的长音轨迹，请选择其他预设。');
    const target = requireStream(score, 'timing', role, '长音起点');
    const lane = requireStream(score, 'lane', role, '连续音高');
    return playRecipe(
      regionId,
      [{ sourceId: target.id, role: 'target', weight: 1 }],
      { kind: 'source', sourceId: lane.id, motion: 1 },
      { density: 0.9, challenge: 0.22, feel: 'showcase', maxGapBeats: 4 },
    );
  }

  const stemTargets = ['vocals', 'drums', 'bass', 'other']
    .map((role) => streamForStem(score, 'timing', role))
    .filter((stream): stream is AuthoringEvidenceStream => Boolean(stream));
  const fallback = selectableStreams(score, 'timing').find((stream) => stream.id === 'performance-attacks')
    ?? selectableStreams(score, 'timing')[0];
  const targets = stemTargets.length ? stemTargets : fallback ? [fallback] : [];
  if (!targets.length) throw new Error('当前片段没有任何可演奏的时间证据。');
  const accents = selectableStreams(score, 'accent').filter((stream) => (
    targets.some((target) => target.stemRole === stream.stemRole)
  ));
  return playRecipe(
    regionId,
    [
      ...targets.map((stream, index) => ({
        sourceId: stream.id,
        role: 'target' as const,
        weight: index === 0 ? 1 : 0.65,
      })),
      ...accents.slice(0, 2).map((stream) => ({
        sourceId: stream.id, role: 'accent' as const, weight: 0.7,
      })),
    ],
    { kind: 'gesture', pattern: 'alternating', motion: 0.82 },
    { density: 0.68, challenge: 0.38, feel: 'showcase', maxGapBeats: 3 },
  );
}

export function recipesFromSuggestions(score: AuthoringScore): RegionRecipe[] {
  const suggestions = new Map(score.suggestions.map((suggestion) => [suggestion.regionId, suggestion]));
  const recipes: RegionRecipe[] = [];
  const regions = [...score.regions]
    .sort((left, right) => (
      left.startSeconds - right.startSeconds
      || left.endSeconds - right.endSeconds
      || left.id.localeCompare(right.id)
    ));
  for (const region of regions) {
    const suggestion = suggestions.get(region.id);
    if (!suggestion) continue;
    const draft = cloneDraft(suggestion.preset);
    recipes.push(draft.mode === 'rest'
      ? { id: `recipe:${region.id}`, regionId: region.id, mode: 'rest' }
      : { id: `recipe:${region.id}`, regionId: region.id, ...draft } as RegionRecipe);
  }
  return recipes;
}

export function draftForRegion(
  score: AuthoringScore,
  edits: LevelEdits,
  regionId: string,
): RegionRecipeDraft {
  const current = edits.arrangements.find((recipe) => recipe.regionId === regionId);
  if (current) return draftFromRecipe(current);
  const suggestion = score.suggestions.find((candidate) => candidate.regionId === regionId);
  if (suggestion) return cloneDraft(suggestion.preset);
  for (const preset of ['vocal-lead', 'drum-groove', 'bass-drive', 'ensemble'] as const) {
    try {
      return draftFromRecipe(materializePerformancePreset(score, regionId, preset));
    } catch { /* try the next friendly default */ }
  }
  return { mode: 'rest' };
}

export function materializeRecipe(
  regionId: string,
  draft: RegionRecipeDraft,
  repeat?: { repeatSetId: string; occurrenceIds: string[] } | null,
): RegionRecipe {
  const identity = {
    id: `recipe:${regionId}`,
    regionId,
    ...(repeat ? {
      repeatSetId: repeat.repeatSetId,
      occurrenceIds: [...repeat.occurrenceIds],
    } : {}),
  };
  if (draft.mode === 'rest') return { ...identity, mode: 'rest' };
  if (!draft.timingLayers.some((layer) => layer.role === 'target')) {
    throw new Error('至少选择一个领奏或一起演奏的声部。');
  }
  return { ...identity, ...cloneDraft(draft) } as RegionRecipe;
}

export function isEvidenceSelectable(
  score: AuthoringScore,
  kind: AuthoringEvidenceKind,
  sourceId: string,
): boolean {
  return streamGroup(score, kind).some((stream) => (
    stream.id === sourceId && stream.availability !== 'unavailable'
  ));
}

export function setTimingLayerSelection<T extends RegionRecipe | RegionRecipeDraft>(
  score: AuthoringScore,
  value: T,
  selection: { sourceId: string; role: 'target' | 'accent'; selected: boolean },
): T {
  if (value.mode !== 'play') throw new Error('留白配方不能添加声部，请先选择演奏预设。');
  const kind = selection.role === 'target' ? 'timing' : 'accent';
  if (selection.selected && !isEvidenceSelectable(score, kind, selection.sourceId)) {
    throw new Error(`证据 ${selection.sourceId} 在当前角色中不可用。`);
  }
  const without = value.timingLayers.filter((layer) => layer.sourceId !== selection.sourceId);
  const timingLayers = selection.selected && without.length === value.timingLayers.length
    ? [
        ...without,
        {
          sourceId: selection.sourceId,
          role: selection.role,
          weight: selection.role === 'target'
            ? without.some((layer) => layer.role === 'target') ? 0.65 : 1
            : 0.75,
        },
      ]
    : selection.selected
      ? value.timingLayers.map((layer) => ({ ...layer }))
      : without;
  if (!timingLayers.some((layer) => layer.role === 'target')) {
    throw new Error('至少保留一个领奏或一起演奏的声部。');
  }
  return { ...value, timingLayers: timingLayers.map((layer) => ({ ...layer })) } as T;
}

export function setLaneDriver(
  score: AuthoringScore,
  draft: RegionRecipeDraft,
  laneDriver: RegionLaneDriver,
): RegionRecipeDraft {
  if (draft.mode !== 'play') throw new Error('留白配方没有轨道跟随。');
  if (
    laneDriver.kind === 'source'
    && !isEvidenceSelectable(score, 'lane', laneDriver.sourceId)
  ) throw new Error(`轨道证据 ${laneDriver.sourceId} 当前不可用。`);
  return { ...draft, laneDriver: cloneLaneDriver(laneDriver) };
}

export function getRegionStreamSummary(
  score: AuthoringScore,
  regionId: string,
  streamId: string,
) {
  return score.regionEvidence
    .find((entry) => entry.regionId === regionId)
    ?.streams.find((summary) => summary.streamId === streamId) ?? null;
}

export function buildRegionReviewQueue(score: AuthoringScore): RegionReviewItem[] {
  const uncertainCodes = new Set([
    'metric-grid-only', 'single-performance-attack', 'no-event-evidence',
  ]);
  const queue: RegionReviewItem[] = [];
  const regions = [...score.regions]
    .sort((left, right) => left.startSeconds - right.startSeconds || left.id.localeCompare(right.id))
    ;
  for (const region of regions) {
    const suggestion = score.suggestions.find((candidate) => candidate.regionId === region.id);
    const reasons: string[] = [];
    if (!suggestion) {
      reasons.push('建议不确定');
    } else if (suggestion.preset.mode === 'play') {
      const targetLayers = suggestion.preset.timingLayers.filter((layer) => layer.role === 'target');
      const summaries = targetLayers.map((layer) => (
        getRegionStreamSummary(score, region.id, layer.sourceId)
      ));
      if (
        !summaries.length
        || summaries.every((summary) => (
          !summary
          || summary.activeCoverageRatio < 0.4
          || summary.maximumGapSeconds > Math.max(2, (region.endSeconds - region.startSeconds) * 0.55)
        ))
      ) reasons.push('低覆盖');
      if (suggestion.reasonCodes.some((code) => uncertainCodes.has(code))) {
        reasons.push('建议不确定');
      }
    }
    if (reasons.length) queue.push({ regionId: region.id, reasons });
  }
  return queue;
}

export function prepareEditorEdits(edits: LevelEdits, score: AuthoringScore): LevelEdits {
  return {
    ...edits,
    baseFingerprint: edits.baseFingerprint || score.audioFingerprint,
    evidenceFingerprint: edits.evidenceFingerprint || score.evidenceFingerprint,
  };
}

export function upsertRegionRecipe(edits: LevelEdits, recipe: RegionRecipe): LevelEdits {
  const firstIndex = edits.arrangements.findIndex((candidate) => candidate.regionId === recipe.regionId);
  const withoutRegion = edits.arrangements.filter((candidate) => candidate.regionId !== recipe.regionId);
  const insertAt = firstIndex < 0 ? withoutRegion.length : Math.min(firstIndex, withoutRegion.length);
  return {
    ...edits,
    arrangements: [
      ...withoutRegion.slice(0, insertAt),
      cloneRecipe(recipe),
      ...withoutRegion.slice(insertAt),
    ],
  };
}

export function deleteRegionRecipe(edits: LevelEdits, regionId: string): LevelEdits {
  return {
    ...edits,
    arrangements: edits.arrangements.filter((recipe) => recipe.regionId !== regionId),
  };
}

export function repeatSelectionForRegion(
  score: AuthoringScore,
  regionId: string,
): { repeatSetId: string; occurrenceIds: string[] } | null {
  const repeatSet = [...score.repeatSets]
    .filter((candidate) => (
      candidate.confidence >= 0.8
      && candidate.occurrences.length >= 2
      && candidate.occurrences.some((occurrence) => occurrence.regionId === regionId)
    ))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))[0];
  if (!repeatSet) return null;
  return {
    repeatSetId: repeatSet.id,
    occurrenceIds: [...repeatSet.occurrences]
      .sort((left, right) => (
        left.startSeconds - right.startSeconds
        || left.endSeconds - right.endSeconds
        || left.id.localeCompare(right.id)
      ))
      .map((occurrence) => occurrence.id),
  };
}

interface TimeInterval {
  startSeconds: number;
  endSeconds: number;
}

function recipeIntervals(score: AuthoringScore, recipe: RegionRecipe): TimeInterval[] {
  if (recipe.repeatSetId) {
    const repeatSet = score.repeatSets.find((candidate) => candidate.id === recipe.repeatSetId);
    if (!repeatSet) return [];
    const occurrenceIds = recipe.occurrenceIds?.length ? new Set(recipe.occurrenceIds) : null;
    return repeatSet.occurrences
      .filter((occurrence) => !occurrenceIds || occurrenceIds.has(occurrence.id))
      .map((occurrence) => ({
        startSeconds: occurrence.startSeconds,
        endSeconds: occurrence.endSeconds,
      }));
  }
  const region = score.regions.find((candidate) => candidate.id === recipe.regionId);
  return region ? [{ startSeconds: region.startSeconds, endSeconds: region.endSeconds }] : [];
}

function intervalsOverlap(left: TimeInterval, right: TimeInterval): boolean {
  return left.startSeconds < right.endSeconds && right.startSeconds < left.endSeconds;
}

export function upsertLinkedRegionRecipe(
  edits: LevelEdits,
  score: AuthoringScore,
  recipe: RegionRecipe,
): LevelEdits {
  const targetIntervals = recipeIntervals(score, recipe);
  if (!recipe.repeatSetId || targetIntervals.length === 0) {
    throw new Error('同步重复段的配方缺少可用的重复区间。');
  }
  const removedIndices: number[] = [];
  const retained = edits.arrangements.filter((candidate, index) => {
    const overlaps = candidate.regionId === recipe.regionId
      || recipeIntervals(score, candidate).some((candidateInterval) => (
        targetIntervals.some((targetInterval) => intervalsOverlap(candidateInterval, targetInterval))
      ));
    if (overlaps) removedIndices.push(index);
    return !overlaps;
  });
  const firstRemoved = removedIndices.length ? Math.min(...removedIndices) : edits.arrangements.length;
  const insertAt = edits.arrangements
    .slice(0, firstRemoved)
    .filter((candidate) => retained.includes(candidate))
    .length;
  return {
    ...edits,
    arrangements: [
      ...retained.slice(0, insertAt),
      cloneRecipe(recipe),
      ...retained.slice(insertAt),
    ],
  };
}

export type { LevelEdits, RegionRecipe };
