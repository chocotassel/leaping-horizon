import {
  ObstacleType,
  type AuthoringEvent,
  type AuthoringRegion,
  type AuthoringRepeatOccurrence,
  type AuthoringScore,
  type AuthoringSource,
  type AuthoringEvidenceKind,
  type AuthoringEvidenceStream,
  type LaneIndex,
  type Level,
  type LevelEvent,
  type ObstacleRow,
  type RegionRecipe,
} from './types';
import { applyLevelEdits, parseLevelEdits } from './levelEdits';

export interface RegionArrangementNotice {
  code: string;
  message: string;
  recipeId?: string;
}

type MeasuredSourceEvent = AuthoringEvent;
type AuthoringSourceInput = AuthoringSource;
type AuthoringRegionInput = AuthoringRegion;
type AuthoringScoreInput = AuthoringScore;
type RegionRecipeInput = RegionRecipe;
type RecipeOccurrence = AuthoringRepeatOccurrence;

interface WeightedEvent {
  event: MeasuredSourceEvent;
  sourceId: string;
  weight: number;
  score: number;
}

const MERGE_WINDOW_SECONDS = 0.055;

function obstacleRow(lane: LaneIndex, challenge: number, ordinal: number): ObstacleRow {
  const row: ObstacleRow = [
    ObstacleType.Empty,
    ObstacleType.Empty,
    ObstacleType.Empty,
    ObstacleType.Empty,
    ObstacleType.Empty,
  ];
  row[lane] = ObstacleType.Breakable;
  const challengeBucket = ((ordinal * 37 + 17) % 100) / 100;
  const spikeCoverage = Math.max(0, (challenge - 0.5) * 2);
  if (challengeBucket < spikeCoverage) {
    const counterLane = (lane <= 2 ? 4 : 0) as LaneIndex;
    row[counterLane] = ObstacleType.Spike;
  }
  return row;
}

function pitchLanes(events: readonly MeasuredSourceEvent[], motion: number): LaneIndex[] {
  const pitches = events.map((event) => event.pitchMidi);
  if (pitches.some((pitch) => !Number.isFinite(pitch))) {
    throw new Error('pitch-contour requires measured pitch evidence.');
  }
  const unique = [...new Set(pitches as number[])].sort((left, right) => left - right);
  return pitches.map((pitch) => {
    if (unique.length === 1) return 2;
    const fullMotionLane = Math.round(unique.indexOf(pitch as number) / (unique.length - 1) * 4);
    return Math.round(2 + (fullMotionLane - 2) * motion) as LaneIndex;
  });
}

function alternatingLanes(length: number, motion: number): LaneIndex[] {
  const span = Math.max(1, Math.round(Math.max(0, Math.min(1, motion)) * 2));
  const left = (2 - span) as LaneIndex;
  const right = (2 + span) as LaneIndex;
  return Array.from({ length }, (_, index) => index % 2 === 0 ? left : right);
}

function selectByDensity(
  events: readonly MeasuredSourceEvent[],
  density: number,
): MeasuredSourceEvent[] {
  const normalizedDensity = Math.max(0, Math.min(1, density));
  const count = Math.ceil(events.length * normalizedDensity);
  const selectedIds = new Set([...events]
    .sort((left, right) => (
      (right.strength ?? 0.5) - (left.strength ?? 0.5)
      || left.timeSeconds - right.timeSeconds
      || left.id.localeCompare(right.id)
    ))
    .slice(0, count)
    .map((event) => event.id));
  return events.filter((event) => selectedIds.has(event.id));
}

function eventsInRange(
  source: AuthoringSourceInput,
  startSeconds: number,
  endSeconds: number,
): MeasuredSourceEvent[] {
  return source.events.filter((event) => (
    event.timeSeconds >= startSeconds && event.timeSeconds < endSeconds
  ));
}

function laneEventsAtAnchors(
  anchors: readonly MeasuredSourceEvent[],
  driverEvents: readonly MeasuredSourceEvent[],
): MeasuredSourceEvent[] {
  const pitched = driverEvents.filter((event) => Number.isFinite(event.pitchMidi));
  if (!pitched.length) throw new Error('Lane Driver has no pitch evidence in the selected Region.');
  return anchors.map((anchor) => {
    if (Number.isFinite(anchor.pitchMidi) && pitched.some((event) => event.id === anchor.id)) {
      return anchor;
    }
    const nearest = [...pitched].sort((left, right) => (
      Math.abs(left.timeSeconds - anchor.timeSeconds) - Math.abs(right.timeSeconds - anchor.timeSeconds)
      || left.timeSeconds - right.timeSeconds
      || left.id.localeCompare(right.id)
    ))[0];
    return { ...anchor, pitchMidi: nearest.pitchMidi };
  });
}

function lanesForDriver(
  events: readonly MeasuredSourceEvent[],
  recipe: Extract<RegionRecipeInput, { mode: 'play' }>,
  driverEvents: readonly MeasuredSourceEvent[],
): LaneIndex[] {
  if (recipe.laneDriver.kind === 'gesture') {
    return recipe.laneDriver.pattern === 'pulse'
      ? Array.from({ length: events.length }, () => 2)
      : alternatingLanes(events.length, recipe.laneDriver.motion);
  }
  return pitchLanes(
    laneEventsAtAnchors(events, driverEvents),
    recipe.laneDriver.motion,
  );
}

function deduplicateWeightedEvents(values: readonly WeightedEvent[]): WeightedEvent[] {
  const ordered = [...values].sort((left, right) => (
    left.event.timeSeconds - right.event.timeSeconds
    || left.event.id.localeCompare(right.event.id)
  ));
  const clusters: WeightedEvent[][] = [];
  for (const candidate of ordered) {
    if (
      !clusters.length
      || candidate.event.timeSeconds - clusters[clusters.length - 1][0].event.timeSeconds > MERGE_WINDOW_SECONDS
    ) {
      clusters.push([candidate]);
    } else {
      clusters[clusters.length - 1].push(candidate);
    }
  }
  return clusters.map((cluster) => [...cluster].sort((left, right) => (
    right.score - left.score
    || left.event.timeSeconds - right.event.timeSeconds
    || left.event.id.localeCompare(right.event.id)
  ))[0]);
}

function maximumGapSeconds(
  events: readonly MeasuredSourceEvent[],
  startSeconds: number,
  endSeconds: number,
): number {
  if (!events.length) return endSeconds - startSeconds;
  const times = events.map((event) => event.timeSeconds).sort((left, right) => left - right);
  return Math.max(
    times[0] - startSeconds,
    ...times.slice(1).map((time, index) => time - times[index]),
    endSeconds - times[times.length - 1],
  );
}

function selectCoverageFirst(
  events: readonly WeightedEvent[],
  density: number,
  startSeconds: number,
  endSeconds: number,
  maximumGap: number,
): MeasuredSourceEvent[] {
  if (!events.length || density <= 0) return [];
  const count = Math.max(1, Math.ceil(events.length * Math.max(0, Math.min(1, density))));
  const remaining = [...events];
  const selected: WeightedEvent[] = [];
  const durationSeconds = Math.max(0.00001, endSeconds - startSeconds);
  for (let index = 0; index < count && remaining.length; index += 1) {
    const targetTime = startSeconds + ((index + 0.5) / count) * durationSeconds;
    const bestIndex = remaining.map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .sort((left, right) => (
        Math.abs(left.candidate.event.timeSeconds - targetTime)
          - Math.abs(right.candidate.event.timeSeconds - targetTime)
        || right.candidate.score - left.candidate.score
        || left.candidate.event.timeSeconds - right.candidate.event.timeSeconds
        || left.candidate.event.id.localeCompare(right.candidate.event.id)
      ))[0].candidateIndex;
    selected.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }
  while (
    remaining.length
    && maximumGapSeconds(selected.map((entry) => entry.event), startSeconds, endSeconds) > maximumGap
  ) {
    const bestIndex = remaining.map((candidate, candidateIndex) => ({
      candidate,
      candidateIndex,
      maximumGap: maximumGapSeconds(
        [...selected.map((entry) => entry.event), candidate.event],
        startSeconds,
        endSeconds,
      ),
    })).sort((left, right) => (
      left.maximumGap - right.maximumGap
      || right.candidate.score - left.candidate.score
      || left.candidate.event.timeSeconds - right.candidate.event.timeSeconds
      || left.candidate.event.id.localeCompare(right.candidate.event.id)
    ))[0].candidateIndex;
    selected.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }
  const selectedIds = new Set(selected.map((entry) => entry.event.id));
  return events.map((entry) => entry.event).filter((event) => selectedIds.has(event.id))
    .sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id));
}

function mapGestureToOccurrence(
  signatureEvents: readonly MeasuredSourceEvent[],
  signatureStart: number,
  signatureEnd: number,
  occurrenceEvents: readonly MeasuredSourceEvent[],
  occurrenceStart: number,
  occurrenceEnd: number,
): MeasuredSourceEvent[] {
  if (occurrenceEvents.length < signatureEvents.length) {
    throw new Error('Linked repeat occurrence has too few measured source events.');
  }
  const signatureDuration = Math.max(0.00001, signatureEnd - signatureStart);
  const occurrenceDuration = Math.max(0.00001, occurrenceEnd - occurrenceStart);
  const unused = new Set(occurrenceEvents);
  return signatureEvents.map((signatureEvent) => {
    const position = (signatureEvent.timeSeconds - signatureStart) / signatureDuration;
    const targetTime = occurrenceStart + position * occurrenceDuration;
    const match = [...unused].sort((left, right) => (
      Math.abs(left.timeSeconds - targetTime) - Math.abs(right.timeSeconds - targetTime)
      || left.timeSeconds - right.timeSeconds
      || left.id.localeCompare(right.id)
    ))[0];
    unused.delete(match);
    return match;
  });
}

function moveSingleTarget(row: ObstacleRow, lane: LaneIndex): ObstacleRow {
  const moved = [...row] as ObstacleRow;
  const targetLanes = moved
    .map((cell, index) => cell === ObstacleType.Breakable ? index : -1)
    .filter((index) => index >= 0);
  if (targetLanes.length !== 1) return moved;
  const spikeLanes = moved
    .map((cell, index) => cell === ObstacleType.Spike ? index : -1)
    .filter((index) => index >= 0);
  moved[targetLanes[0]] = ObstacleType.Empty;
  if (spikeLanes.length === 1) {
    moved[spikeLanes[0]] = ObstacleType.Empty;
  }
  moved[lane] = ObstacleType.Breakable;
  if (spikeLanes.length === 1) {
    const counterLane = (lane <= 2 ? 4 : 0) as LaneIndex;
    moved[counterLane] = ObstacleType.Spike;
  }
  return moved;
}

function enforceGlobalTargetReachability(
  events: readonly LevelEvent[],
  recipeByTime: ReadonlyMap<string, string>,
  notices: RegionArrangementNotice[],
): LevelEvent[] {
  const nodes = events.map((event, eventIndex) => {
    if (event.kind !== 'target') return null;
    const targetLanes = event.obstacles
      .map((cell, index) => cell === ObstacleType.Breakable ? index as LaneIndex : null)
      .filter((lane): lane is LaneIndex => lane != null);
    if (!targetLanes.length) return null;
    const recipeId = recipeByTime.get(event.timeSeconds.toFixed(5));
    return {
      eventIndex,
      timeSeconds: event.timeSeconds,
      targetLanes,
      intendedLane: targetLanes[0],
      recipeId,
      allowedLanes: recipeId
        ? [0, 1, 2, 3, 4] as LaneIndex[]
        : targetLanes,
    };
  }).filter((node): node is NonNullable<typeof node> => node != null);
  if (!nodes.length) return [...events];

  type LaneState = { cost: number; previousLane: LaneIndex | null };
  const layers: Array<Map<LaneIndex, LaneState>> = [];
  for (const [nodeIndex, node] of nodes.entries()) {
    const layer = new Map<LaneIndex, LaneState>();
    if (nodeIndex === 0) {
      const maximumStartStep = Math.min(
        4,
        Math.floor((Math.max(0, node.timeSeconds) + 0.000001) / 0.08),
      );
      for (const lane of node.allowedLanes) {
        if (Math.abs(lane - 2) > maximumStartStep) continue;
        const deviation = node.recipeId ? lane - node.intendedLane : 0;
        layer.set(lane, { cost: deviation * deviation, previousLane: null });
      }
    } else {
      const previousNode = nodes[nodeIndex - 1];
      const previousLayer = layers[nodeIndex - 1];
      const elapsed = Math.max(0, node.timeSeconds - previousNode.timeSeconds);
      const maximumStep = Math.min(4, Math.floor((elapsed + 0.000001) / 0.08));
      for (const lane of node.allowedLanes) {
        const deviation = node.recipeId ? lane - node.intendedLane : 0;
        for (const [previousLane, previousState] of previousLayer) {
          if (Math.abs(lane - previousLane) > maximumStep) continue;
          const cost = previousState.cost + deviation * deviation;
          const current = layer.get(lane);
          if (
            !current
            || cost < current.cost
            || (cost === current.cost && previousLane < (current.previousLane ?? 5))
          ) {
            layer.set(lane, { cost, previousLane });
          }
        }
      }
    }
    if (!layer.size) {
      throw new Error(`No reachable Target route exists at ${node.timeSeconds}s without moving a fixed Base Row.`);
    }
    layers.push(layer);
  }

  let lane = [...layers[layers.length - 1].entries()].sort((left, right) => (
    left[1].cost - right[1].cost || left[0] - right[0]
  ))[0][0];
  const chosenLanes = Array<LaneIndex>(nodes.length);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    chosenLanes[index] = lane;
    const previousLane = layers[index].get(lane)!.previousLane;
    if (previousLane != null) lane = previousLane;
  }

  const replacements = new Map<number, LevelEvent>();
  nodes.forEach((node, index) => {
    const chosenLane = chosenLanes[index];
    if (!node.recipeId || chosenLane === node.intendedLane) return;
    if (!notices.some((notice) => (
      notice.code === 'lane-reachability-clamped' && notice.recipeId === node.recipeId
    ))) {
      notices.push({
        code: 'lane-reachability-clamped',
        message: `Region recipe ${node.recipeId} was clamped to the measured travel time.`,
        recipeId: node.recipeId,
      });
    }
    replacements.set(node.eventIndex, {
      ...events[node.eventIndex],
      obstacles: moveSingleTarget(events[node.eventIndex].obstacles, chosenLane),
    });
  });
  return events.map((event, index) => replacements.get(index) ?? event);
}

function resolveOccurrences(
  score: AuthoringScoreInput,
  recipe: RegionRecipeInput,
  region: AuthoringRegionInput,
): RecipeOccurrence[] {
  const repeatSet = recipe.repeatSetId
    ? score.repeatSets?.find((candidate) => candidate.id === recipe.repeatSetId)
    : null;
  if (recipe.repeatSetId && !repeatSet) {
    throw new Error(`Region recipe ${recipe.id} references an unknown repeat set.`);
  }
  if (!repeatSet) {
    return [{
      id: region.id,
      regionId: region.id,
      startSeconds: region.startSeconds,
      endSeconds: region.endSeconds,
    }];
  }
  if (!recipe.occurrenceIds?.length) return repeatSet.occurrences;
  return recipe.occurrenceIds.map((occurrenceId) => {
    const occurrence = repeatSet.occurrences.find((candidate) => candidate.id === occurrenceId);
    if (!occurrence) throw new Error(`Unknown repeat occurrence ${occurrenceId}.`);
    return occurrence;
  });
}

function assertRecipeIntervalsDoNotOverlap(
  score: AuthoringScoreInput,
  recipes: readonly RegionRecipeInput[],
): void {
  const intervals: Array<{ recipeId: string; startSeconds: number; endSeconds: number }> = [];
  for (const recipe of recipes) {
    const region = score.regions.find((candidate) => candidate.id === recipe.regionId);
    if (!region) throw new Error(`Region recipe ${recipe.id} references an unknown region.`);
    for (const occurrence of resolveOccurrences(score, recipe, region)) {
      intervals.push({
        recipeId: recipe.id,
        startSeconds: occurrence.startSeconds,
        endSeconds: occurrence.endSeconds,
      });
    }
  }
  intervals.sort((left, right) => (
    left.startSeconds - right.startSeconds
    || left.endSeconds - right.endSeconds
    || left.recipeId.localeCompare(right.recipeId)
  ));
  intervals.forEach((interval, index) => {
    if (index > 0 && interval.startSeconds < intervals[index - 1].endSeconds) {
      throw new Error(`Region recipe intervals overlap: ${intervals[index - 1].recipeId} and ${interval.recipeId}.`);
    }
  });
}

function evidenceCandidates(
  score: AuthoringScoreInput,
  sourceId: string,
  kind: AuthoringEvidenceKind,
  allowLegacySources: boolean,
): AuthoringSourceInput | AuthoringEvidenceStream | undefined {
  const scoreWithStreams = score as AuthoringScoreInput & {
    evidenceStreams?: Partial<Record<AuthoringEvidenceKind, AuthoringEvidenceStream[]>>;
  };
  const direct = scoreWithStreams.evidenceStreams?.[kind]?.find((stream) => stream.id === sourceId);
  if (direct) return direct;
  if (kind === 'timing') {
    const metric = scoreWithStreams.evidenceStreams?.metric?.find((stream) => stream.id === sourceId);
    if (metric) return metric;
  }
  // The legacy catalog is a deliberate compatibility adapter for v2 edits.
  return allowLegacySources
    ? score.sources?.find((source) => source.id === sourceId)
    : undefined;
}

function defaultMaximumGapBeats(recipe: Extract<RegionRecipeInput, { mode: 'play' }>): number {
  if (recipe.maxGapBeats != null) return recipe.maxGapBeats;
  if (recipe.feel === 'showcase') return 2;
  return 4;
}

function timingEvidenceForOccurrence(
  score: AuthoringScoreInput,
  layer: Extract<RegionRecipeInput, { mode: 'play' }>['timingLayers'][number],
  occurrence: RecipeOccurrence,
  allowLegacySources: boolean,
): AuthoringSourceInput | AuthoringEvidenceStream | undefined {
  if (allowLegacySources && layer.sourceId === 'melody-contour') {
    const anchors = [
      'discrete-melody',
      'performance-attacks',
      'percussion-onsets',
      'rhythm-grid',
    ].map((sourceId) => evidenceCandidates(score, sourceId, 'timing', true))
      .filter((stream): stream is AuthoringSourceInput | AuthoringEvidenceStream => Boolean(stream));
    return anchors.find((stream) => (
      stream.availability !== 'unavailable'
      && eventsInRange(stream, occurrence.startSeconds, occurrence.endSeconds).length > 0
    ))
      ?? anchors.find((stream) => stream.availability !== 'unavailable')
      ?? evidenceCandidates(score, layer.sourceId, 'lane', true);
  }
  return evidenceCandidates(score, layer.sourceId, 'timing', allowLegacySources);
}

function weightedCandidatesForOccurrence(
  score: AuthoringScoreInput,
  recipe: Extract<RegionRecipeInput, { mode: 'play' }>,
  occurrence: RecipeOccurrence,
  allowLegacySources: boolean,
): WeightedEvent[] {
  const values: WeightedEvent[] = [];
  for (const layer of recipe.timingLayers.filter((candidate) => candidate.role === 'target')) {
    const stream = timingEvidenceForOccurrence(score, layer, occurrence, allowLegacySources);
    if (!stream) throw new Error(`Region recipe ${recipe.id} references unavailable timing evidence ${layer.sourceId}.`);
    if (stream.availability === 'unavailable') {
      if (stream.capabilities?.continuousPitch) {
        throw new Error(`Region recipe ${recipe.id} requires continuous F0, but that evidence is unavailable.`);
      }
      throw new Error(`Region recipe ${recipe.id} references unavailable evidence ${layer.sourceId}.`);
    }
    if (
      stream.capabilities?.continuousPitch
      && !(
        recipe.laneDriver.kind === 'source'
        && recipe.laneDriver.sourceId === layer.sourceId
      )
    ) {
      throw new Error(`Region recipe ${recipe.id} uses continuous F0 and requires pitch-contour Lane Driver.`);
    }
    const streamEvents = eventsInRange(stream, occurrence.startSeconds, occurrence.endSeconds);
    if (stream.capabilities?.continuousPitch && !streamEvents.length) {
      throw new Error(`Region recipe ${recipe.id} has no continuous F0 evidence in the selected region.`);
    }
    if (allowLegacySources && layer.sourceId === 'melody-contour' && stream.capabilities?.continuousPitch) {
      throw new Error(`Region recipe ${recipe.id} cannot use continuous F0 as timing without a measured note or onset anchor.`);
    }
    for (const event of streamEvents) {
      values.push({
        event,
        sourceId: stream.id,
        weight: layer.weight,
        score: (event.strength ?? 0.5) * layer.weight,
      });
    }
  }
  return deduplicateWeightedEvents(values);
}

function accentCandidatesForOccurrence(
  score: AuthoringScoreInput,
  recipe: Extract<RegionRecipeInput, { mode: 'play' }>,
  occurrence: RecipeOccurrence,
  allowLegacySources: boolean,
): WeightedEvent[] {
  const values: WeightedEvent[] = [];
  for (const layer of recipe.timingLayers.filter((candidate) => candidate.role === 'accent')) {
    const stream = evidenceCandidates(score, layer.sourceId, 'accent', allowLegacySources);
    if (!stream || stream.availability === 'unavailable') {
      throw new Error(`Region recipe ${recipe.id} references unavailable accent evidence ${layer.sourceId}.`);
    }
    for (const event of eventsInRange(stream, occurrence.startSeconds, occurrence.endSeconds)) {
      values.push({
        event,
        sourceId: layer.sourceId,
        weight: layer.weight,
        score: (event.strength ?? 0.5) * layer.weight,
      });
    }
  }
  return deduplicateWeightedEvents(values);
}

function laneDriverEvents(
  score: AuthoringScoreInput,
  recipe: Extract<RegionRecipeInput, { mode: 'play' }>,
  occurrence: RecipeOccurrence,
  allowLegacySources: boolean,
): MeasuredSourceEvent[] {
  if (recipe.laneDriver.kind === 'gesture') return [];
  const stream = evidenceCandidates(score, recipe.laneDriver.sourceId, 'lane', allowLegacySources);
  if (!stream || stream.availability === 'unavailable') {
    if (stream?.capabilities?.continuousPitch || /contour|pitch/i.test(recipe.laneDriver.sourceId)) {
      throw new Error(`Region recipe ${recipe.id} requires continuous F0, but that evidence is unavailable.`);
    }
    throw new Error(`Region recipe ${recipe.id} references an unavailable Lane Driver.`);
  }
  if (stream.capabilities?.pitch !== true) {
    throw new Error(`Region recipe ${recipe.id} uses a Lane Driver without pitch evidence.`);
  }
  const events = eventsInRange(stream, occurrence.startSeconds, occurrence.endSeconds);
  if (!events.some((event) => Number.isFinite(event.pitchMidi))) {
    throw new Error(`Region recipe ${recipe.id} has no continuous F0 pitch evidence in the selected region.`);
  }
  return events;
}

function accentChallenge(
  timeSeconds: number,
  baseChallenge: number,
  accents: readonly WeightedEvent[],
): number {
  const nearby = accents.filter((accent) => (
    Math.abs(accent.event.timeSeconds - timeSeconds) <= MERGE_WINDOW_SECONDS
  ));
  const boost = nearby.reduce((maximum, accent) => Math.max(maximum, accent.score), 0) * 0.25;
  return Math.min(1, baseChallenge + boost);
}

function baseRowsInOccurrences(
  events: readonly LevelEvent[],
  occurrences: readonly RecipeOccurrence[],
): LevelEvent[] {
  return events.filter((event) => occurrences.some((occurrence) => (
    event.timeSeconds >= occurrence.startSeconds && event.timeSeconds < occurrence.endSeconds
  )));
}

export function compilePerformance(
  baseLevel: Level,
  authoringScore: unknown,
  editsUnknown: unknown,
): { level: Level; notices: RegionArrangementNotice[] } {
  const score = authoringScore as AuthoringScoreInput;
  const legacyEdits = (editsUnknown as { version?: unknown } | null)?.version !== 3;
  // Runtime/editor callers normalize v2 edits before compiling. A v1 score still
  // needs its legacy source catalog and selection semantics after that migration.
  const legacyScore = (score as unknown as { schemaVersion?: unknown })?.schemaVersion === '1.0.0';
  const edits = parseLevelEdits(editsUnknown, baseLevel);
  if (score?.kind !== 'authoring-score' || score.levelId !== baseLevel.id) {
    throw new Error('Authoring Score does not belong to this base level.');
  }
  if (edits.baseFingerprint && edits.baseFingerprint !== score.audioFingerprint) {
    throw new Error('Level Edits baseFingerprint does not match the Authoring Score fingerprint.');
  }
  if (
    edits.evidenceFingerprint
    && edits.evidenceFingerprint !== (score as AuthoringScoreInput & { evidenceFingerprint?: string }).evidenceFingerprint
  ) {
    throw new Error('Level Edits evidenceFingerprint does not match the Authoring Score fingerprint.');
  }
  assertRecipeIntervalsDoNotOverlap(score, edits.arrangements);

  const rhythmPointTimes = new Set(baseLevel.rhythmPoints.map((point) => point.timeSeconds.toFixed(5)));
  const notices: RegionArrangementNotice[] = [];
  const recipeByTime = new Map<string, string>();
  let generated: LevelEvent[] = baseLevel.events.map((event) => ({
    ...event,
    obstacles: [...event.obstacles] as ObstacleRow,
  }));
  for (const recipe of edits.arrangements ?? []) {
    const region = score.regions.find((candidate) => candidate.id === recipe.regionId);
    if (!region) throw new Error(`Region recipe ${recipe.id} references unavailable evidence.`);
    const occurrences = resolveOccurrences(score, recipe, region);
    if (!occurrences.length) throw new Error(`Region recipe ${recipe.id} has no occurrence.`);

    if (recipe.mode === 'rest') {
      generated = generated.filter((event) => !occurrences.some((occurrence) => (
        event.timeSeconds >= occurrence.startSeconds && event.timeSeconds < occurrence.endSeconds
      )));
      continue;
    }

    const legacyCompilation = legacyEdits
      || legacyScore
      || recipe.timingLayers.some((layer) => layer.compatibility === 'legacy-single-source-v2');

    const signatureOccurrence = occurrences[0];
    const signatureCandidates = weightedCandidatesForOccurrence(score, recipe, signatureOccurrence, legacyCompilation);
    const beatSeconds = 60 / Math.max(1, baseLevel.song.bpm || 120);
    const allowedMaximumGap = defaultMaximumGapBeats(recipe) * beatSeconds;
    const signatureEvents = legacyCompilation
      ? selectByDensity(signatureCandidates.map((candidate) => candidate.event), recipe.density)
      : selectCoverageFirst(
          signatureCandidates,
          recipe.density,
          signatureOccurrence.startSeconds,
          signatureOccurrence.endSeconds,
          allowedMaximumGap,
        );
    const fullEvidenceGap = maximumGapSeconds(
      signatureCandidates.map((candidate) => candidate.event),
      signatureOccurrence.startSeconds,
      signatureOccurrence.endSeconds,
    );
    const insufficient = signatureEvents.length === 0 || (!legacyCompilation && fullEvidenceGap > allowedMaximumGap);
    if (insufficient) {
      const preserved = baseRowsInOccurrences(baseLevel.events, occurrences);
      if (!preserved.length) {
        throw new Error(`Region recipe ${recipe.id} has insufficient timing evidence and no Base Rows to preserve.`);
      }
      notices.push({
        code: 'insufficient-timing-evidence-preserved-base',
        message: `Region recipe ${recipe.id} preserved Base Rows because selected timing evidence is insufficient.`,
        recipeId: recipe.id,
      });
      continue;
    }
    const signatureDriverEvents = laneDriverEvents(score, recipe, signatureOccurrence, legacyCompilation);
    const signatureLanes = lanesForDriver(signatureEvents, recipe, signatureDriverEvents);

    const compiledOccurrences = occurrences.map((occurrence, occurrenceIndex) => {
      const occurrenceCandidates = occurrenceIndex === 0
        ? signatureCandidates
        : weightedCandidatesForOccurrence(score, recipe, occurrence, legacyCompilation);
      const events = occurrenceIndex === 0
        ? signatureEvents
        : mapGestureToOccurrence(
            signatureEvents,
            signatureOccurrence.startSeconds,
            signatureOccurrence.endSeconds,
            occurrenceCandidates.map((candidate) => candidate.event),
            occurrence.startSeconds,
            occurrence.endSeconds,
          );
      return {
        occurrence,
        events,
        accents: accentCandidatesForOccurrence(score, recipe, occurrence, legacyCompilation),
      };
    });

    generated = generated.filter((event) => !occurrences.some((occurrence) => (
      event.timeSeconds >= occurrence.startSeconds && event.timeSeconds < occurrence.endSeconds
    )));
    compiledOccurrences.forEach(({ events, accents }) => {
      events.forEach((event, index) => {
        if (!rhythmPointTimes.has(event.timeSeconds.toFixed(5))) {
          throw new Error(`Measured event ${event.id} is not a base Rhythm Point.`);
        }
        generated.push({
          timeSeconds: event.timeSeconds,
          obstacles: obstacleRow(
            signatureLanes[index],
            accentChallenge(event.timeSeconds, recipe.challenge, accents),
            index,
          ),
          kind: 'target',
        });
        recipeByTime.set(event.timeSeconds.toFixed(5), recipe.id);
      });
    });
  }

  generated.sort((left, right) => left.timeSeconds - right.timeSeconds);
  const reachableEvents = edits.arrangements.length
    ? enforceGlobalTargetReachability(generated, recipeByTime, notices)
    : generated;
  const arrangedBase: Level = {
      ...baseLevel,
      generation: {
        ...baseLevel.generation,
        noteCount: reachableEvents.filter((event) => event.kind === 'target').length,
      },
      events: reachableEvents,
  };
  return {
    level: applyLevelEdits(arrangedBase, edits),
    notices,
  };
}

/** Compatibility entry point retained for editor/build callers during rollout. */
export const compileRegionRecipes = compilePerformance;
