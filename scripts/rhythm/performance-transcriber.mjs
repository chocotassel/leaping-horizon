export const PERFORMANCE_TRANSCRIBER_ALGORITHM = 'measured-performance-transcriber-v1';

const DEFAULT_FUSION_WINDOW_SECONDS = 0.055;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value, fallback = Number.NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function pitchClassOf(pitchMidi) {
  if (!Number.isFinite(pitchMidi)) return null;
  return ((Math.round(pitchMidi) % 12) + 12) % 12;
}

function sourceDescriptor(sourceId) {
  if (sourceId === 'basic-pitch') return { kind: 'pitch', priority: 6, laneHint: null };
  if (sourceId === 'librosa-onset') return { kind: 'onset', priority: 5, laneHint: null };
  if (sourceId === 'librosa-percussive') return { kind: 'percussion', priority: 4, laneHint: null };
  if (sourceId === 'librosa-harmonic') return { kind: 'harmonic', priority: 3, laneHint: null };
  if (sourceId === 'beat-this') return { kind: 'beat', priority: 2, laneHint: null };
  const band = /^librosa-band-(bass|low-mid|mid|high-mid|high)$/.exec(sourceId);
  if (band) {
    return {
      kind: 'band',
      priority: 3,
      laneHint: ['bass', 'low-mid', 'mid', 'high-mid', 'high'].indexOf(band[1]),
    };
  }
  return null;
}

function measuredCandidates(analysis) {
  const candidates = [];
  const sourceEventCounts = {};
  const sources = Array.isArray(analysis?.eventSources) ? analysis.eventSources : [];
  for (const [sourceIndex, source] of sources.entries()) {
    const sourceId = String(source?.id ?? `source-${sourceIndex + 1}`);
    const descriptor = sourceDescriptor(sourceId);
    if (!descriptor) continue;
    const events = Array.isArray(source?.events) ? source.events : [];
    sourceEventCounts[sourceId] = events.filter((event) => Number.isFinite(finite(event?.timeSeconds))).length;
    for (const [eventIndex, event] of events.entries()) {
      const timeSeconds = finite(event?.timeSeconds);
      if (!Number.isFinite(timeSeconds)) continue;
      const pitchMidi = Number.isFinite(finite(event?.midiPitch))
        ? clamp(finite(event.midiPitch), 0, 127)
        : null;
      candidates.push({
        evidenceId: `event:${sourceId}:${String(event?.id ?? eventIndex + 1)}`,
        sourceId,
        kind: descriptor.kind,
        priority: descriptor.priority,
        laneHint: descriptor.laneHint,
        timeSeconds,
        confidence: clamp(finite(event?.confidence, descriptor.kind === 'beat' ? 0.72 : 0.65)),
        pitchMidi,
        pitchMin: Number.isFinite(finite(event?.pitchMin)) ? finite(event.pitchMin) : pitchMidi,
        pitchMax: Number.isFinite(finite(event?.pitchMax)) ? finite(event.pitchMax) : pitchMidi,
        durationSeconds: Math.max(0, finite(event?.durationSeconds, 0)),
        polyphony: Math.max(1, Math.round(finite(event?.polyphony, 1))),
        isDownbeat: event?.isDownbeat === true,
        barIndex: Number.isInteger(event?.barIndex) ? event.barIndex : null,
        beatInBar: Number.isInteger(event?.beatInBar) ? event.beatInBar : null,
      });
    }
  }

  if (!sourceEventCounts['beat-this']) {
    const beats = Array.isArray(analysis?.musicalStructure?.beats)
      ? analysis.musicalStructure.beats
      : [];
    sourceEventCounts['musical-structure-beat'] = beats.filter(
      (beat) => Number.isFinite(finite(beat?.timeSeconds)),
    ).length;
    for (const [index, beat] of beats.entries()) {
      const timeSeconds = finite(beat?.timeSeconds);
      if (!Number.isFinite(timeSeconds)) continue;
      candidates.push({
        evidenceId: `structure:beat:${String(beat?.index ?? index)}`,
        sourceId: 'musical-structure-beat',
        kind: 'beat',
        priority: 1,
        laneHint: null,
        timeSeconds,
        confidence: beat?.isDownbeat === true ? 1 : 0.72,
        pitchMidi: null,
        pitchMin: null,
        pitchMax: null,
        durationSeconds: 0,
        polyphony: 1,
        isDownbeat: beat?.isDownbeat === true,
        barIndex: Number.isInteger(beat?.barIndex) ? beat.barIndex : null,
        beatInBar: Number.isInteger(beat?.beatInBar) ? beat.beatInBar : null,
      });
    }
  }

  candidates.sort((left, right) => (
    left.timeSeconds - right.timeSeconds
    || right.priority - left.priority
    || left.evidenceId.localeCompare(right.evidenceId)
  ));
  return { candidates, sourceEventCounts };
}

function fuseCandidates(candidates, fusionWindowSeconds) {
  const groups = [];
  for (const candidate of candidates) {
    const previous = groups.at(-1);
    if (previous && candidate.timeSeconds - previous[0].timeSeconds <= fusionWindowSeconds) {
      previous.push(candidate);
    } else {
      groups.push([candidate]);
    }
  }
  return groups;
}

function coalesceNearSimultaneousGroups(groups, minimumSeparationSeconds) {
  const ordered = [...groups].sort((left, right) => (
    chooseTimeCandidate(left).timeSeconds - chooseTimeCandidate(right).timeSeconds
    || left[0].evidenceId.localeCompare(right[0].evidenceId)
  ));
  const merged = [];
  for (const group of ordered) {
    const previous = merged.at(-1);
    if (
      previous
      && chooseTimeCandidate(group).timeSeconds - chooseTimeCandidate(previous).timeSeconds
        < minimumSeparationSeconds
    ) {
      previous.push(...group);
      previous.sort((left, right) => (
        left.timeSeconds - right.timeSeconds
        || right.priority - left.priority
        || left.evidenceId.localeCompare(right.evidenceId)
      ));
    } else {
      merged.push([...group]);
    }
  }
  return merged;
}

function phraseMembership(analysis, timeSeconds) {
  const structure = analysis?.musicalStructure ?? {};
  const primary = Array.isArray(structure.phrases) ? structure.phrases : [];
  const overlapping = Array.isArray(structure.overlappingPhrases) ? structure.overlappingPhrases : [];
  const contains = (phrase) => {
    const start = finite(phrase?.startSeconds);
    const end = finite(phrase?.endSeconds);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      && timeSeconds >= start && timeSeconds < end;
  };
  const primaryIds = primary.filter(contains).map((phrase, index) => String(phrase?.id ?? `phrase-${index + 1}`));
  const overlapIds = overlapping.filter(contains)
    .map((phrase, index) => String(phrase?.id ?? `overlap-phrase-${index + 1}`));
  return {
    phraseId: primaryIds[0] ?? overlapIds[0] ?? null,
    phraseIds: [...new Set([...primaryIds, ...overlapIds])].sort(),
  };
}

function chooseCanonical(group) {
  return [...group].sort((left, right) => (
    Number(right.pitchMidi != null) - Number(left.pitchMidi != null)
    || right.priority - left.priority
    || right.confidence - left.confidence
    || left.timeSeconds - right.timeSeconds
    || left.evidenceId.localeCompare(right.evidenceId)
  ))[0];
}

function chooseTimeCandidate(group) {
  const trustedFrontKinds = new Set(['onset', 'percussion', 'harmonic', 'band']);
  const attackFronts = group.filter((candidate) => (
    trustedFrontKinds.has(candidate.kind) && candidate.confidence >= 0.45
  ));
  const pitchFallback = group.filter((candidate) => candidate.pitchMidi != null);
  const pool = attackFronts.length ? attackFronts : pitchFallback.length ? pitchFallback : group;
  return [...pool].sort((left, right) => (
    left.timeSeconds - right.timeSeconds
    || right.confidence - left.confidence
    || right.priority - left.priority
    || left.evidenceId.localeCompare(right.evidenceId)
  ))[0];
}

function resolvePerformancePitch(candidate, previousPitch, phraseId, timeSeconds) {
  if (candidate.pitchMidi == null || candidate.polyphony <= 1) {
    return { candidate, approximated: false };
  }
  const pitchMinimum = Number.isFinite(candidate.pitchMin) ? clamp(candidate.pitchMin, 0, 127) : null;
  const pitchMaximum = Number.isFinite(candidate.pitchMax) ? clamp(candidate.pitchMax, 0, 127) : null;
  const voiceBounds = [...new Set([pitchMinimum, pitchMaximum].filter(Number.isFinite))];
  let resolvedPitch = candidate.pitchMidi;
  const canContinue = previousPitch
    && previousPitch.phraseId === phraseId
    && timeSeconds - previousPitch.timeSeconds <= 1.5;
  if (voiceBounds.length) {
    resolvedPitch = [...voiceBounds].sort((left, right) => {
      if (!canContinue) return right - left;
      return Math.abs(left - previousPitch.pitchMidi) - Math.abs(right - previousPitch.pitchMidi)
        || right - left;
    })[0];
  }
  return {
    candidate: { ...candidate, pitchMidi: resolvedPitch },
    approximated: true,
  };
}

function roleFor(group, canonical) {
  if (canonical.pitchMidi != null) {
    const sustained = canonical.durationSeconds >= 0.38;
    const monophonic = canonical.polyphony <= 1;
    return sustained && monophonic ? 'vocal-like' : 'melody';
  }
  if (group.some((candidate) => candidate.kind === 'harmonic')) return 'melody';
  return 'percussion';
}

function strengthFor(group) {
  const maximum = Math.max(...group.map((candidate) => candidate.confidence));
  const sourceCount = new Set(group.map((candidate) => candidate.sourceId)).size;
  const convergence = Math.min(0.18, Math.max(0, sourceCount - 1) * 0.06);
  const downbeat = group.some((candidate) => candidate.isDownbeat) ? 0.06 : 0;
  return round(clamp(maximum + convergence + downbeat));
}

function initialLane(group, role, ordinal) {
  const bandLanes = group.map((candidate) => candidate.laneHint).filter(Number.isInteger);
  if (bandLanes.length) return Math.round(bandLanes.reduce((sum, lane) => sum + lane, 0) / bandLanes.length);
  if (role !== 'percussion') return 2;
  return 2;
}

function emptyContinuity() {
  return {
    traceId: null,
    index: null,
    length: 0,
    previousEventId: null,
    nextEventId: null,
    direction: 'none',
    intervalSemitones: null,
    sustained: false,
  };
}

function makeHitSound(event) {
  const pitchMidi = event.pitchMidi ?? 36 + event.lane * 2;
  const voice = event.sourceRole;
  return {
    pitchMidi: round(pitchMidi, 3),
    pitchClass: pitchClassOf(pitchMidi),
    sourceRole: voice,
    velocity: event.strength,
    gain: voice === 'percussion' ? 0.13 : voice === 'vocal-like' ? 0.14 : 0.16,
    brightness: voice === 'percussion' ? 0.36 : voice === 'vocal-like' ? 0.62 : 0.5,
  };
}

function pitchDirection(currentPitch, previousPitch) {
  const interval = currentPitch - previousPitch;
  if (interval > 0.25) return 'up';
  if (interval < -0.25) return 'down';
  return 'repeat';
}

function localPitchLanes(events, travelSecondsPerLane) {
  const pitchKeys = events.map((event) => round(event.pitchMidi * 2) / 2);
  const uniquePitches = [...new Set(pitchKeys)].sort((left, right) => left - right);
  const rawLanes = pitchKeys.map((pitch) => {
    if (uniquePitches.length === 1) return 2;
    const rank = uniquePitches.indexOf(pitch);
    return Math.round(rank / (uniquePitches.length - 1) * 4);
  });
  const lanes = [rawLanes[0]];
  for (let index = 1; index < events.length; index += 1) {
    const previousLane = lanes[index - 1];
    const elapsed = Math.max(0, events[index].timeSeconds - events[index - 1].timeSeconds);
    const maximumStep = Math.min(4, Math.floor((elapsed + 0.001) / travelSecondsPerLane));
    const direction = pitchDirection(events[index].pitchMidi, events[index - 1].pitchMidi);
    if (maximumStep === 0 || direction === 'repeat') {
      lanes.push(previousLane);
      continue;
    }
    if (direction === 'up') {
      if (previousLane >= 4) {
        lanes.push(4);
        continue;
      }
      lanes.push(clamp(rawLanes[index], previousLane + 1, Math.min(4, previousLane + maximumStep)));
    } else {
      if (previousLane <= 0) {
        lanes.push(0);
        continue;
      }
      lanes.push(clamp(rawLanes[index], Math.max(0, previousLane - maximumStep), previousLane - 1));
    }
  }
  return lanes;
}

function contourKind(events) {
  const directions = events.slice(1).map((event, index) => (
    pitchDirection(event.pitchMidi, events[index].pitchMidi)
  )).filter((direction) => direction !== 'repeat');
  if (!directions.length) return 'level';
  const changes = directions.slice(1).filter((direction, index) => direction !== directions[index]).length;
  if (changes >= 2) return 's-curve';
  if (changes === 1) return directions[0] === 'up' ? 'arch' : 'valley';
  return directions[0] === 'up' ? 'rising' : 'falling';
}

function applyMelodicTraces(attackRecords, options) {
  const maximumTraceGapSeconds = clamp(
    finite(options?.maximumTraceGapSeconds, 1.1),
    0.15,
    2,
  );
  const travelSecondsPerLane = clamp(
    finite(options?.travelSecondsPerLane, 0.08),
    0.06,
    0.15,
  );
  const pitched = attackRecords.filter(({ event }) => event.pitchMidi != null);
  const runs = [];
  for (const record of pitched) {
    const previousRun = runs.at(-1);
    const previous = previousRun?.at(-1);
    const samePhrase = previous && previous.event.phraseId === record.event.phraseId;
    const gap = previous ? record.event.timeSeconds - previous.event.timeSeconds : Number.POSITIVE_INFINITY;
    if (samePhrase && gap <= maximumTraceGapSeconds) previousRun.push(record);
    else runs.push([record]);
  }

  const traces = [];
  for (const run of runs.filter((candidate) => candidate.length >= 2)) {
    const events = run.map((record) => record.event);
    const traceId = `trace-${String(traces.length + 1).padStart(4, '0')}`;
    const lanes = localPitchLanes(events, travelSecondsPerLane);
    for (const [index, event] of events.entries()) {
      event.lane = lanes[index];
      const previous = events[index - 1] ?? null;
      const next = events[index + 1] ?? null;
      const intervalSemitones = previous ? round(event.pitchMidi - previous.pitchMidi, 3) : null;
      const durationSeconds = run[index].canonical.durationSeconds;
      event.continuity = {
        traceId,
        index,
        length: events.length,
        previousEventId: previous?.id ?? null,
        nextEventId: next?.id ?? null,
        direction: previous ? pitchDirection(event.pitchMidi, previous.pitchMidi) : 'start',
        intervalSemitones,
        sustained: durationSeconds >= 0.38
          || (next != null && durationSeconds >= next.timeSeconds - event.timeSeconds - 0.06),
      };
      event.hitSound = makeHitSound(event);
    }
    traces.push({
      id: traceId,
      phraseId: events[0].phraseId,
      startSeconds: events[0].timeSeconds,
      endSeconds: events.at(-1).timeSeconds,
      sourceRole: events.some((event) => event.sourceRole === 'vocal-like') ? 'vocal-like' : 'melody',
      attackEventIds: events.map((event) => event.id),
      laneContour: lanes,
      pitchContour: events.map((event) => event.pitchMidi),
      contourKind: contourKind(events),
      evidenceIds: [...new Set(events.flatMap((event) => event.evidenceIds))].sort(),
    });
  }
  return traces;
}

function laneDeviationWeight(record) {
  if (record.event.pitchMidi != null) return 8;
  if (record.group.some((candidate) => Number.isInteger(candidate.laneHint))) return 2.5;
  if (record.event.sourceRole !== 'percussion') return 2;
  return 0.5;
}

function traceDirectionPenalty(event, lane, previousPitchLane) {
  if (event.continuity.traceId == null || event.continuity.index === 0 || previousPitchLane == null) return 0;
  const direction = event.continuity.direction;
  if (direction === 'up') {
    if (lane > previousPitchLane) return 0;
    return lane === previousPitchLane ? 5 : 25 + (previousPitchLane - lane) * 5;
  }
  if (direction === 'down') {
    if (lane < previousPitchLane) return 0;
    return lane === previousPitchLane ? 5 : 25 + (lane - previousPitchLane) * 5;
  }
  if (direction === 'repeat') return Math.abs(lane - previousPitchLane) * 4;
  return 0;
}

function realizeReachableLanes(attackRecords, melodicTraces, options) {
  if (!attackRecords.length) return { constrainedLaneCount: 0 };
  const travelSecondsPerLane = clamp(
    finite(options?.travelSecondsPerLane, 0.08),
    0.06,
    0.15,
  );
  const intendedLanes = attackRecords.map(({ event }) => event.lane);
  const initialKey = '2|null';
  let previousStates = new Map([[
    initialKey,
    { cost: 0, currentLane: 2, lastPitchLane: null, previousKey: null },
  ]]);
  const layers = [];

  for (const [eventIndex, record] of attackRecords.entries()) {
    const event = record.event;
    const previousTime = eventIndex === 0 ? 0 : attackRecords[eventIndex - 1].event.timeSeconds;
    const elapsed = Math.max(0, event.timeSeconds - previousTime);
    const nextStates = new Map();
    for (const [previousKey, previousState] of previousStates.entries()) {
      for (let lane = 0; lane < 5; lane += 1) {
        if (elapsed + 1e-6 < Math.abs(lane - previousState.currentLane) * travelSecondsPerLane) continue;
        const deviation = lane - event.lane;
        const cost = previousState.cost
          + deviation * deviation * laneDeviationWeight(record)
          + traceDirectionPenalty(event, lane, previousState.lastPitchLane);
        const lastPitchLane = event.continuity.traceId != null ? lane : previousState.lastPitchLane;
        const key = `${lane}|${lastPitchLane ?? 'null'}`;
        const existing = nextStates.get(key);
        if (
          !existing
          || cost < existing.cost - 1e-9
          || (Math.abs(cost - existing.cost) <= 1e-9 && previousKey.localeCompare(existing.previousKey) < 0)
        ) {
          nextStates.set(key, {
            cost,
            currentLane: lane,
            lastPitchLane,
            previousKey,
          });
        }
      }
    }
    layers.push(nextStates);
    previousStates = nextStates;
  }

  const finalEntry = [...previousStates.entries()].sort((left, right) => (
    left[1].cost - right[1].cost || left[0].localeCompare(right[0])
  ))[0];
  let stateKey = finalEntry[0];
  const realizedLanes = Array(attackRecords.length);
  for (let index = attackRecords.length - 1; index >= 0; index -= 1) {
    const state = layers[index].get(stateKey);
    realizedLanes[index] = state.currentLane;
    stateKey = state.previousKey;
  }

  let constrainedLaneCount = 0;
  for (const [index, record] of attackRecords.entries()) {
    if (realizedLanes[index] !== intendedLanes[index]) constrainedLaneCount += 1;
    record.event.lane = realizedLanes[index];
    record.event.hitSound = makeHitSound(record.event);
  }
  const eventsById = new Map(attackRecords.map(({ event }) => [event.id, event]));
  for (const trace of melodicTraces) {
    trace.laneContour = trace.attackEventIds.map((eventId) => eventsById.get(eventId).lane);
  }
  return { constrainedLaneCount };
}

export function transcribePerformance(analysis, options = {}) {
  const measured = analysis && typeof analysis === 'object';
  const fusionWindowSeconds = clamp(
    finite(options?.fusionWindowSeconds, DEFAULT_FUSION_WINDOW_SECONDS),
    0.02,
    0.065,
  );
  const minimumAttackSeparationSeconds = clamp(
    finite(options?.minimumAttackSeparationSeconds, 0.018),
    0.01,
    0.04,
  );
  const { candidates, sourceEventCounts } = measured
    ? measuredCandidates(analysis)
    : { candidates: [], sourceEventCounts: {} };
  const candidateGroups = coalesceNearSimultaneousGroups(
    fuseCandidates(candidates, fusionWindowSeconds),
    minimumAttackSeparationSeconds,
  );
  const metricOnlyBeatEvidenceCount = candidateGroups
    .filter((group) => group.every((candidate) => candidate.kind === 'beat'))
    .reduce((count, group) => count + group.length, 0);
  const groups = candidateGroups.filter((group) => group.some((candidate) => candidate.kind !== 'beat'));
  let previousPitch = null;
  let polyphonicApproximationCount = 0;
  const attackRecords = groups.map((group, index) => {
    const measuredCanonical = chooseCanonical(group);
    const timeCandidate = chooseTimeCandidate(group);
    const { phraseId, phraseIds } = phraseMembership(analysis, timeCandidate.timeSeconds);
    const resolvedPitch = resolvePerformancePitch(
      measuredCanonical,
      previousPitch,
      phraseId,
      timeCandidate.timeSeconds,
    );
    const canonical = resolvedPitch.candidate;
    if (resolvedPitch.approximated) polyphonicApproximationCount += 1;
    if (canonical.pitchMidi != null) {
      previousPitch = {
        pitchMidi: canonical.pitchMidi,
        phraseId,
        timeSeconds: timeCandidate.timeSeconds,
      };
    }
    const sourceRole = roleFor(group, canonical);
    const strength = strengthFor(group);
    const pitchMidi = canonical.pitchMidi == null ? null : round(canonical.pitchMidi, 3);
    const event = {
      id: `attack-${String(index + 1).padStart(5, '0')}`,
      timeSeconds: round(timeCandidate.timeSeconds, 5),
      lane: initialLane(group, sourceRole, index),
      pitchMidi,
      pitchClass: pitchClassOf(pitchMidi),
      sourceRole,
      strength,
      evidenceIds: group.map((candidate) => candidate.evidenceId).sort(),
      sourceTimeEvidence: {
        evidenceId: timeCandidate.evidenceId,
        sourceId: timeCandidate.sourceId,
        kind: timeCandidate.kind,
      },
      phraseId,
      phraseIds,
      continuity: emptyContinuity(),
      hitSound: null,
    };
    event.hitSound = makeHitSound(event);
    return { event, group, canonical, timeCandidate };
  });
  const melodicTraces = applyMelodicTraces(attackRecords, options);
  const laneRealization = realizeReachableLanes(attackRecords, melodicTraces, options);
  const attackEvents = attackRecords.map((record) => record.event);
  const warnings = [];
  if (!measured) warnings.push('missing-measured-analysis');
  else if (!attackEvents.length) warnings.push('missing-attack-evidence');
  const timeSourceCounts = {};
  for (const { timeCandidate } of attackRecords) {
    timeSourceCounts[timeCandidate.sourceId] = (timeSourceCounts[timeCandidate.sourceId] ?? 0) + 1;
  }
  return {
    schemaVersion: '1.0.0',
    kind: 'performance-score',
    algorithm: PERFORMANCE_TRANSCRIBER_ALGORITHM,
    audioFingerprint: measured
      ? String(analysis?.song?.audioFingerprint ?? 'missing-audio-fingerprint')
      : 'missing-audio-fingerprint',
    attackEvents,
    melodicTraces,
    diagnostics: {
      sourceEventCounts,
      candidateCount: candidates.length,
      attackEventCount: attackEvents.length,
      fusedAttackCount: groups.filter((group) => group.length > 1).length,
      melodicTraceCount: melodicTraces.length,
      pitchedAttackCount: attackEvents.filter((event) => event.pitchMidi != null).length,
      percussiveAttackCount: attackEvents.filter((event) => event.sourceRole === 'percussion').length,
      constrainedLaneCount: laneRealization.constrainedLaneCount,
      polyphonicApproximationCount,
      timeSourceCounts,
      metricOnlyBeatEvidenceCount,
      warnings,
    },
  };
}
