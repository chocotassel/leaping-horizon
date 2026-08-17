import { ObstacleType, type Level, type LevelEvent, type ObstacleRow } from './types';
import { t } from './i18n';
import { SCENE_COLOR_HUES, SCENE_COLOR_SCHEMES } from './game/colorSchemes';

function isObstacleRow(value: unknown): value is ObstacleRow {
  return Array.isArray(value) && value.length === 5 && value.every((cell) => (
    Number.isInteger(cell) && cell >= ObstacleType.Empty && cell <= ObstacleType.Spike
  ));
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function validateHitSound(value: unknown, label: string): void {
  const hitSound = asObject(value);
  if (
    !hitSound
    || typeof hitSound.pitchMidi !== 'number'
    || !Number.isFinite(hitSound.pitchMidi)
    || hitSound.pitchMidi < 0
    || hitSound.pitchMidi > 127
    || !Number.isInteger(hitSound.pitchClass)
    || (hitSound.pitchClass as number) < 0
    || (hitSound.pitchClass as number) > 11
    || typeof hitSound.sourceRole !== 'string'
    || !hitSound.sourceRole
    || !['velocity', 'gain', 'brightness'].every((key) => (
      typeof hitSound[key] === 'number'
      && Number.isFinite(hitSound[key])
      && (hitSound[key] as number) >= 0
      && (hitSound[key] as number) <= 1
    ))
  ) throw new Error(`${label} has an invalid Hit Voice.`);
}

function hitSoundsMatch(left: unknown, right: unknown): boolean {
  const leftVoice = asObject(left);
  const rightVoice = asObject(right);
  return leftVoice != null
    && rightVoice != null
    && ['pitchMidi', 'pitchClass', 'sourceRole', 'velocity', 'gain', 'brightness'].every((key) => (
      leftVoice[key] === rightVoice[key]
    ));
}

function validatePerformanceContract(level: Level): void {
  const generation = level.generation as JsonObject;
  const levelRecord = level as unknown as JsonObject;
  const score = asObject(generation.performanceScore) ?? asObject(levelRecord.performanceScore);
  if (!score) return;
  if (score.kind !== 'performance-score') throw new Error('The Performance Score has an unknown kind.');

  const rawAttacks = score.attackEvents;
  const rawTraces = score.melodicTraces;
  if (!Array.isArray(rawAttacks) || !rawAttacks.length) throw new Error('The Performance Score has no Attack Events.');
  if (!Array.isArray(rawTraces)) throw new Error('The Performance Score has no Melodic Traces array.');

  const attacksById = new Map<string, JsonObject>();
  for (const [index, rawAttack] of rawAttacks.entries()) {
    const attack = asObject(rawAttack);
    const id = attack?.id;
    if (
      !attack
      || typeof id !== 'string'
      || !id
      || attacksById.has(id)
      || typeof attack.timeSeconds !== 'number'
      || !Number.isFinite(attack.timeSeconds)
      || attack.timeSeconds < 0
      || attack.timeSeconds > level.song.durationSeconds
      || !Number.isInteger(attack.lane)
      || (attack.lane as number) < 0
      || (attack.lane as number) > 4
      || !Array.isArray(attack.evidenceIds)
      || !attack.evidenceIds.length
      || !attack.evidenceIds.every((evidenceId) => typeof evidenceId === 'string' && evidenceId.length > 0)
    ) throw new Error(`Attack Event ${index} is invalid or lacks measured evidence.`);
    validateHitSound(attack.hitSound, `Attack Event ${id}`);
    attacksById.set(id, attack);
  }

  const tracesById = new Map<string, JsonObject>();
  for (const [index, rawTrace] of rawTraces.entries()) {
    const trace = asObject(rawTrace);
    const traceId = trace?.id;
    const attackEventIds = trace?.attackEventIds;
    if (
      !trace
      || typeof traceId !== 'string'
      || !traceId
      || tracesById.has(traceId)
      || !Array.isArray(attackEventIds)
      || !attackEventIds.length
      || !attackEventIds.every((attackId) => typeof attackId === 'string' && attacksById.has(attackId))
    ) throw new Error(`Melodic Trace ${index} is invalid.`);
    if (
      Array.isArray(trace.pitchContour)
      && (
        trace.pitchContour.length !== attackEventIds.length
        || trace.pitchContour.some((pitch, pitchIndex) => (
          pitch !== attacksById.get(attackEventIds[pitchIndex] as string)?.pitchMidi
        ))
      )
    ) throw new Error(`Melodic Trace ${traceId} has a stale pitch contour.`);
    if (
      Array.isArray(trace.laneContour)
      && (
        trace.laneContour.length !== attackEventIds.length
        || trace.laneContour.some((lane, laneIndex) => (
          lane !== attacksById.get(attackEventIds[laneIndex] as string)?.lane
        ))
      )
    ) throw new Error(`Melodic Trace ${traceId} has a stale lane contour.`);
    tracesById.set(traceId, trace);
  }

  const targetRows = level.events.filter((event) => event.kind === 'target');
  if (!targetRows.length) throw new Error('The Performance Score emitted no Target Rows.');
  const targetRowsByAttackId = new Map<string, { event: LevelEvent; attack: JsonObject }>();
  const representedAttackIds = new Set<string>();
  for (const [index, event] of targetRows.entries()) {
    const eventRecord = event as unknown as JsonObject;
    const performanceEventId = eventRecord.performanceEventId;
    const attack = typeof performanceEventId === 'string' ? attacksById.get(performanceEventId) : undefined;
    const targetLanes: number[] = [];
    event.obstacles.forEach((cell, lane) => {
      if (cell === ObstacleType.Breakable) targetLanes.push(lane);
    });
    if (
      event.layer !== 'core'
      || event.pattern !== 'performance'
      || typeof performanceEventId !== 'string'
      || targetRowsByAttackId.has(performanceEventId)
      || !attack
      || targetLanes.length !== 1
      || targetLanes[0] !== attack.lane
      || event.timeSeconds !== attack.timeSeconds
    ) throw new Error(`Performance Target Row ${index} does not exactly realize one Attack Event.`);
    validateHitSound(event.hitSound, `Performance Target Row ${index}`);
    if (!hitSoundsMatch(event.hitSound, attack.hitSound)) {
      throw new Error(`Performance Target Row ${index} substituted a generic Hit Voice.`);
    }

    const continuity = asObject(attack.continuity);
    const traceId = eventRecord.melodicTraceId;
    if (continuity?.traceId != null && traceId !== continuity.traceId) {
      throw new Error(`Performance Target Row ${index} lost its Melodic Trace identity.`);
    }
    if (
      continuity?.traceId == null
      && traceId != null
      && (
        typeof traceId !== 'string'
        || !tracesById.has(traceId)
        || !(tracesById.get(traceId)?.attackEventIds as unknown[]).includes(performanceEventId)
      )
    ) throw new Error(`Performance Target Row ${index} references an invalid Melodic Trace.`);

    const memberIds = eventRecord.performanceEventIds ?? [performanceEventId];
    if (
      !Array.isArray(memberIds)
      || !memberIds.length
      || !memberIds.includes(performanceEventId)
      || memberIds.some((attackId) => (
        typeof attackId !== 'string'
        || !attacksById.has(attackId)
        || representedAttackIds.has(attackId)
      ))
    ) throw new Error(`Performance Target Row ${index} has invalid represented Attack Events.`);
    memberIds.forEach((attackId) => representedAttackIds.add(attackId as string));
    targetRowsByAttackId.set(performanceEventId, { event, attack });
  }

  for (const [traceId, trace] of tracesById) {
    const represented: Array<{ event: LevelEvent; attack: JsonObject }> = [];
    for (const attackId of trace.attackEventIds as string[]) {
      const row = targetRowsByAttackId.get(attackId);
      if (row) represented.push(row);
    }
    for (let index = 1; index < represented.length; index += 1) {
      const previousPitch = represented[index - 1].attack.pitchMidi;
      const currentPitch = represented[index].attack.pitchMidi;
      if (typeof previousPitch !== 'number' || typeof currentPitch !== 'number') continue;
      const pitchDelta = currentPitch - previousPitch;
      const previousLane = represented[index - 1].attack.lane as number;
      const currentLane = represented[index].attack.lane as number;
      const laneDelta = currentLane - previousLane;
      if ((pitchDelta > 0.25 && laneDelta < 0) || (pitchDelta < -0.25 && laneDelta > 0)) {
        throw new Error(`Melodic Trace ${traceId} reverses pitch direction in the lane contour.`);
      }
    }
  }

  const diagnostics = asObject(score.diagnostics);
  const compilation = asObject(diagnostics?.compilation);
  const omittedAttackEvents = compilation?.omittedAttackEvents;
  if (
    !compilation
    || compilation.selectedTargetRowCount !== targetRows.length
    || compilation.representedAttackEventCount !== representedAttackIds.size
    || compilation.mergedAttackEventCount !== representedAttackIds.size - targetRows.length
    || !Array.isArray(compilation.mergedGroups)
    || !Array.isArray(omittedAttackEvents)
    || compilation.omittedAttackEventCount !== omittedAttackEvents.length
    || generation.performanceAttackEventCount !== rawAttacks.length
    || generation.performanceTargetRowCount !== targetRows.length
  ) throw new Error('The Performance Score compilation receipt is inconsistent.');

  const hazardCellCount = level.events.reduce((sum, event) => (
    sum + event.obstacles.filter((cell) => cell === ObstacleType.Spike).length
  ), 0);
  if (hazardCellCount > targetRows.length * 1.5) {
    throw new Error('Hazards, rather than Attack Events, are the primary chart-density source.');
  }
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

  if (level.visualAccentEvents !== undefined) {
    if (!Array.isArray(level.visualAccentEvents)) throw new Error('Visual accent events must be an array.');
    let previousVisualAccentTime = -Infinity;
    level.visualAccentEvents.forEach((event, eventIndex) => {
      if (
        !Number.isFinite(event.timeSeconds)
        || event.timeSeconds < 0
        || event.timeSeconds > level.song.durationSeconds
        || event.timeSeconds <= previousVisualAccentTime
        || event.kind !== 'pulse'
        || !Number.isFinite(event.strength)
        || event.strength < 0
        || event.strength > 1
        || typeof event.source !== 'string'
        || !event.source
        || typeof event.anchorId !== 'string'
        || !event.anchorId
      ) {
        throw new Error(`Visual accent event ${eventIndex} is invalid.`);
      }
      previousVisualAccentTime = event.timeSeconds;
    });
  }

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
  validatePerformanceContract(level);
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

export const LEVELS = Object.entries(levelModules)
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

if (!LEVELS.length) throw new Error(t('error.noLevels'));

export const DEFAULT_LEVEL_ID = LEVELS[0].id;

export function getLevelById(levelId: string | null | undefined): Level {
  return LEVELS.find((level) => level.id === levelId)
    ?? LEVELS.find((level) => level.id === DEFAULT_LEVEL_ID)
    ?? LEVELS[0];
}
