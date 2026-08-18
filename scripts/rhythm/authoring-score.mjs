import { transcribePerformance } from './performance-transcriber.mjs';
import { createHash } from 'node:crypto';

export const AUTHORING_SCORE_ALGORITHM = 'measured-authoring-score-v2';

function finite(value, fallback = Number.NaN) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value, digits = 5) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function compactEvent(sourceId, event, index) {
  const pitchMidi = finite(event?.pitchMidi);
  return {
    id: `${sourceId}:${String(event?.id ?? index + 1)}`,
    timeSeconds: round(finite(event?.timeSeconds), 5),
    strength: round(clamp(finite(event?.strength, event?.confidence ?? 0.5)), 4),
    ...(Number.isFinite(pitchMidi) ? { pitchMidi: round(pitchMidi, 3) } : {}),
  };
}

function sourceEvents(analysis, sourceId) {
  const source = (Array.isArray(analysis?.eventSources) ? analysis.eventSources : [])
    .find((candidate) => candidate?.id === sourceId);
  return Array.isArray(source?.events) ? source.events : [];
}

function inSong(analysis, event) {
  const durationSeconds = finite(analysis?.song?.durationSeconds, Number.POSITIVE_INFINITY);
  return Number.isFinite(event.timeSeconds)
    && event.timeSeconds >= 0
    && event.timeSeconds <= durationSeconds;
}

function sortEvents(events) {
  return events.sort((left, right) => (
    left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id)
  ));
}

function performanceSource(analysis) {
  const performance = analysis?.performanceScore?.kind === 'performance-score'
    ? analysis.performanceScore
    : transcribePerformance(analysis);
  const events = (Array.isArray(performance?.attackEvents) ? performance.attackEvents : [])
    .map((event, index) => compactEvent('performance-attacks', event, index))
    .filter((event) => inSong(analysis, event));
  return {
    id: 'performance-attacks',
    label: '综合击打',
    availability: events.length ? 'measured' : 'unavailable',
    capabilities: { onsets: true, pitch: true, continuousPitch: false },
    events: sortEvents(events),
  };
}

function rhythmSource(analysis) {
  const measured = sourceEvents(analysis, 'beat-this');
  const events = (measured.length ? measured : analysis?.musicalStructure?.beats ?? [])
    .map((event, index) => ({
      id: `rhythm-grid:beat-${String(event?.index ?? index)}`,
      timeSeconds: round(finite(event?.timeSeconds), 5),
      strength: round(clamp(finite(event?.confidence, event?.isDownbeat ? 1 : 0.72)), 4),
      isDownbeat: event?.isDownbeat === true,
    }))
    .filter((event) => inSong(analysis, event));
  return {
    id: 'rhythm-grid',
    label: '节拍网格',
    availability: events.length ? 'measured' : 'unavailable',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: sortEvents(events),
  };
}

function percussionSource(analysis) {
  const percussive = sourceEvents(analysis, 'librosa-percussive');
  const sourceId = percussive.length ? 'librosa-percussive' : 'librosa-onset';
  const events = (percussive.length ? percussive : sourceEvents(analysis, 'librosa-onset'))
    .map((event, index) => ({
      id: `percussion-onsets:${sourceId}:${String(event?.id ?? index + 1)}`,
      timeSeconds: round(finite(event?.timeSeconds), 5),
      strength: round(clamp(finite(event?.confidence, 0.5)), 4),
    }))
    .filter((event) => inSong(analysis, event));
  return {
    id: 'percussion-onsets',
    label: '打击 / 起音',
    availability: events.length ? 'measured' : 'unavailable',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: sortEvents(events),
  };
}

function discreteMelodySource(analysis) {
  const events = sourceEvents(analysis, 'basic-pitch')
    .map((event, index) => {
      const pitchMidi = finite(event?.midiPitch, finite(event?.pitchMidi));
      const durationSeconds = finite(event?.durationSeconds);
      return {
        id: `discrete-melody:basic-pitch:${String(event?.id ?? index + 1)}`,
        timeSeconds: round(finite(event?.timeSeconds), 5),
        strength: round(clamp(finite(event?.confidence, 0.5)), 4),
        ...(Number.isFinite(pitchMidi) ? { pitchMidi: round(pitchMidi, 3) } : {}),
        ...(Number.isFinite(durationSeconds) && durationSeconds > 0
          ? { durationSeconds: round(durationSeconds, 5) }
          : {}),
      };
    })
    .filter((event) => inSong(analysis, event));
  return {
    id: 'discrete-melody',
    label: '旋律音符',
    availability: events.length ? 'estimated' : 'unavailable',
    capabilities: { onsets: true, pitch: true, continuousPitch: false },
    events: sortEvents(events),
  };
}

function contourSource(analysis) {
  const traces = Array.isArray(analysis?.continuousPitch?.traces)
    ? analysis.continuousPitch.traces
    : [];
  const events = traces.flatMap((trace, traceIndex) => (
    (Array.isArray(trace?.points) ? trace.points : []).map((point, pointIndex) => {
      const pitchMidi = finite(point?.pitchMidi, finite(point?.f0Midi));
      return {
        id: `melody-contour:${String(point?.id ?? `${traceIndex + 1}-${pointIndex + 1}`)}`,
        timeSeconds: round(finite(point?.timeSeconds), 5),
        strength: round(clamp(finite(point?.confidence, trace?.confidence ?? 0.5)), 4),
        ...(Number.isFinite(pitchMidi) ? { pitchMidi: round(pitchMidi, 3) } : {}),
        traceId: String(trace?.id ?? `f0-trace-${traceIndex + 1}`),
      };
    })
  ))
    .filter((event) => inSong(analysis, event) && Number.isFinite(event.pitchMidi));
  return {
    id: 'melody-contour',
    label: '连续音高',
    availability: events.length ? 'estimated' : 'unavailable',
    capabilities: { onsets: false, pitch: true, continuousPitch: true },
    events: sortEvents(events),
  };
}

function evidenceStream(source, kind, stemRole, identity = 'direct') {
  return {
    ...source,
    kind,
    stemRole,
    identity,
    events: source.events.map((event) => ({ ...event })),
  };
}

function legacyEvidenceStreams(sources) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const performance = sourceById.get('performance-attacks');
  const rhythm = sourceById.get('rhythm-grid');
  const percussion = sourceById.get('percussion-onsets');
  const discrete = sourceById.get('discrete-melody');
  const contour = sourceById.get('melody-contour');
  return {
    timing: [
      performance && evidenceStream(performance, 'timing', 'mix'),
      percussion && evidenceStream(percussion, 'timing', 'mix'),
      discrete && evidenceStream(discrete, 'timing', 'mix', 'model-estimated'),
    ].filter(Boolean),
    lane: [
      discrete && evidenceStream(discrete, 'lane', 'mix', 'model-estimated'),
      contour && evidenceStream(contour, 'lane', 'mix', 'model-estimated'),
    ].filter(Boolean),
    accent: [
      percussion && evidenceStream(percussion, 'accent', 'mix'),
    ].filter(Boolean),
    metric: [
      rhythm && evidenceStream(rhythm, 'metric', 'metric'),
    ].filter(Boolean),
  };
}

const STEM_LABELS = {
  vocals: '人声',
  drums: '鼓',
  bass: '贝斯',
  other: '其他伴奏',
};

function stemAvailability(stem) {
  if (!stem || stem.status === 'unavailable' || stem.status === 'failed') return 'unavailable';
  return 'estimated';
}

function compactStemEvents(streamId, values, analysis, { traceId = null } = {}) {
  return (Array.isArray(values) ? values : []).map((event, index) => {
    const pitchMidi = finite(event?.pitchMidi);
    const durationSeconds = finite(event?.durationSeconds);
    return {
      id: `${streamId}:${String(event?.id ?? index + 1)}`,
      timeSeconds: round(finite(event?.timeSeconds), 5),
      strength: round(clamp(finite(event?.confidence, event?.strength ?? 0.5)), 4),
      ...(Number.isFinite(pitchMidi) ? { pitchMidi: round(pitchMidi, 3) } : {}),
      ...(Number.isFinite(durationSeconds) && durationSeconds > 0
        ? { durationSeconds: round(durationSeconds, 5) }
        : {}),
      ...((event?.traceId ?? traceId) ? { traceId: String(event?.traceId ?? traceId) } : {}),
    };
  }).filter((event) => inSong(analysis, event));
}

function mergePitchDriverEvents(tracePoints, landmarks) {
  const selected = [];
  for (const event of [...tracePoints, ...landmarks].sort((left, right) => (
    left.timeSeconds - right.timeSeconds
    || left.id.localeCompare(right.id)
  ))) {
    const existingIndex = selected.findIndex((candidate) => (
      candidate.id === event.id
      || Math.abs(candidate.timeSeconds - event.timeSeconds) <= 0.00001
    ));
    if (existingIndex < 0) {
      selected.push(event);
    } else if ((event.strength ?? 0) > (selected[existingIndex].strength ?? 0)) {
      selected[existingIndex] = event;
    }
  }
  return sortEvents(selected);
}

function stemEvidenceStreams(analysis) {
  const evidence = analysis?.stemEvidence;
  if (!evidence || evidence.kind !== 'core4-stem-evidence') {
    return { timing: [], lane: [], accent: [], metric: [] };
  }
  if (
    String(evidence.audioFingerprint ?? '') !== String(analysis?.song?.audioFingerprint ?? '')
    || finite(evidence.timeOriginSeconds, 0) !== 0
  ) {
    throw new Error('Stem Evidence is not aligned to the current game-audio clock.');
  }
  const result = { timing: [], lane: [], accent: [], metric: [] };
  for (const role of ['vocals', 'drums', 'bass', 'other']) {
    const stem = evidence?.stems?.[role];
    const availability = stemAvailability(stem);
    const label = STEM_LABELS[role] ?? role;
    const timingId = `stem:${role}:timing`;
    const landmarkId = `stem:${role}:pitch-landmarks`;
    const laneId = `stem:${role}:pitch`;
    const accentId = `stem:${role}:accents`;
    const timingEvents = compactStemEvents(timingId, stem?.timingEvents, analysis);
    const pitchLandmarks = compactStemEvents(landmarkId, stem?.pitchLandmarks, analysis);
    const tracePitchPoints = (Array.isArray(stem?.pitchTraces) ? stem.pitchTraces : []).flatMap((trace) => (
      compactStemEvents(laneId, trace?.points, analysis, { traceId: trace?.id })
    ));
    const laneLandmarks = compactStemEvents(laneId, stem?.pitchLandmarks, analysis);
    const pitchPoints = mergePitchDriverEvents(tracePitchPoints, laneLandmarks);
    const accentEvents = compactStemEvents(accentId, stem?.accentEvents, analysis);
    result.timing.push({
      id: timingId,
      label: `${label}发音 / 起音`,
      kind: 'timing',
      stemRole: role,
      identity: 'model-estimated',
      availability,
      capabilities: { onsets: true, pitch: timingEvents.some((event) => Number.isFinite(event.pitchMidi)), continuousPitch: false },
      events: sortEvents(timingEvents),
    });
    result.timing.push({
      id: landmarkId,
      label: `${label}转音点`,
      kind: 'timing',
      stemRole: role,
      identity: 'model-estimated',
      availability,
      capabilities: { onsets: false, pitch: true, continuousPitch: false },
      events: sortEvents(pitchLandmarks),
    });
    result.lane.push({
      id: laneId,
      label: `${label}音高`,
      kind: 'lane',
      stemRole: role,
      identity: 'model-estimated',
      availability,
      capabilities: { onsets: false, pitch: true, continuousPitch: true },
      events: sortEvents(pitchPoints),
    });
    result.accent.push({
      id: accentId,
      label: `${label}重音`,
      kind: 'accent',
      stemRole: role,
      identity: 'model-estimated',
      availability,
      capabilities: { onsets: true, pitch: false, continuousPitch: false },
      events: sortEvents(accentEvents),
    });
  }
  return result;
}

function mergeEvidenceStreams(base, stems) {
  return {
    timing: [...base.timing, ...stems.timing],
    lane: [...base.lane, ...stems.lane],
    accent: [...base.accent, ...stems.accent],
    metric: [...base.metric, ...stems.metric],
  };
}

function fallbackEvidenceFingerprint(analysis, streams) {
  const value = JSON.stringify({
    audioFingerprint: String(analysis?.song?.audioFingerprint ?? ''),
    streams: Object.fromEntries(Object.entries(streams).map(([kind, entries]) => [
      kind,
      entries.map((stream) => ({
        id: stream.id,
        availability: stream.availability,
        events: stream.events,
      })),
    ])),
  });
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function validRanges(values) {
  return (Array.isArray(values) ? values : []).filter((value) => {
    const startSeconds = finite(value?.startSeconds);
    const endSeconds = finite(value?.endSeconds);
    return Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds;
  });
}

function authoringRegions(analysis) {
  const structure = analysis?.musicalStructure ?? {};
  const sections = validRanges(structure.sections);
  const phrases = validRanges(structure.phrases);
  const sectionByIndex = new Map(sections.map((section, index) => [
    Number.isInteger(section?.index) ? section.index : index,
    section,
  ]));
  const candidates = [...(phrases.length ? phrases : sections)].sort((left, right) => (
    finite(left.startSeconds) - finite(right.startSeconds)
    || finite(left.endSeconds) - finite(right.endSeconds)
    || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  ));
  return candidates.map((candidate, ordinal) => {
    const sourceId = String(candidate?.id ?? `${phrases.length ? 'phrase' : 'section'}-${ordinal + 1}`);
    const sourceSection = phrases.length
      ? sectionByIndex.get(candidate?.sectionIndex)
      : candidate;
    return {
      id: `region:${sourceId}`,
      label: `片段 ${String(ordinal + 1).padStart(2, '0')}`,
      startSeconds: round(finite(candidate.startSeconds), 5),
      endSeconds: round(finite(candidate.endSeconds), 5),
      ...(sourceSection ? { sourceSectionId: String(sourceSection?.id ?? `section-${ordinal + 1}`) } : {}),
      ...(phrases.length ? { sourcePhraseId: sourceId } : {}),
    };
  });
}

function anchorRegion(regions, startSeconds, endSeconds) {
  return [...regions].map((region) => ({
    region,
    overlap: Math.max(
      0,
      Math.min(region.endSeconds, endSeconds) - Math.max(region.startSeconds, startSeconds),
    ),
  })).filter((candidate) => candidate.overlap > 0)
    .sort((left, right) => (
      right.overlap - left.overlap
      || left.region.startSeconds - right.region.startSeconds
      || left.region.id.localeCompare(right.region.id)
    ))[0]?.region ?? null;
}

function trustedRepeatSets(analysis, regions) {
  const structure = analysis?.musicalStructure ?? {};
  const familyGroups = [
    {
      families: Array.isArray(structure.families) ? structure.families : [],
      phrases: validRanges(structure.phrases),
    },
    {
      families: Array.isArray(structure.overlappingPhraseFamilies)
        ? structure.overlappingPhraseFamilies
        : [],
      phrases: validRanges(structure.overlappingPhrases),
    },
  ];
  const repeatSets = [];
  for (const group of familyGroups) {
    const phrasesById = new Map(group.phrases.map((phrase, index) => [
      String(phrase?.id ?? `phrase-${index + 1}`),
      phrase,
    ]));
    for (const family of group.families) {
      const familyId = String(family?.id ?? '');
      const confidence = finite(family?.confidence, finite(family?.familyConfidence, 0));
      if (!familyId || family?.kind !== 'repeated' || confidence < 0.8) continue;
      const phraseIds = Array.isArray(family?.phraseIds) ? family.phraseIds.map(String) : [];
      const occurrences = phraseIds.map((phraseId) => {
        const phrase = phrasesById.get(phraseId);
        if (!phrase) return null;
        const startSeconds = round(finite(phrase.startSeconds), 5);
        const endSeconds = round(finite(phrase.endSeconds), 5);
        const region = anchorRegion(regions, startSeconds, endSeconds);
        return {
          id: `occurrence:${familyId}:${phraseId}`,
          ...(region ? { regionId: region.id } : {}),
          startSeconds,
          endSeconds,
        };
      }).filter(Boolean).sort((left, right) => (
        left.startSeconds - right.startSeconds
        || left.endSeconds - right.endSeconds
        || left.id.localeCompare(right.id)
      ));
      if (occurrences.length < 2) continue;
      repeatSets.push({
        id: `repeat-set:${familyId}`,
        confidence: round(clamp(confidence), 4),
        occurrences,
      });
    }
  }
  return repeatSets.sort((left, right) => left.id.localeCompare(right.id));
}

function regionEvents(source, region) {
  if (source?.availability === 'unavailable') return [];
  return source.events.filter((event) => (
    event.timeSeconds >= region.startSeconds && event.timeSeconds < region.endSeconds
  ));
}

function pitchSpan(events) {
  const pitches = events.map((event) => finite(event?.pitchMidi)).filter(Number.isFinite);
  if (pitches.length < 2) return 0;
  return Math.max(...pitches) - Math.min(...pitches);
}

function suggestionParameters(sourceId, mapping) {
  if (mapping === 'rest') return { density: 0, motion: 0, challenge: 0 };
  if (sourceId === 'melody-contour') return { density: 0.85, motion: 1, challenge: 0.25 };
  if (sourceId === 'discrete-melody') return { density: 0.75, motion: 0.8, challenge: 0.3 };
  if (mapping === 'alternating') return { density: 0.68, motion: 0.75, challenge: 0.35 };
  if (sourceId === 'percussion-onsets') return { density: 0.48, motion: 0.2, challenge: 0.18 };
  if (sourceId === 'performance-attacks') return { density: 0.6, motion: 0.55, challenge: 0.3 };
  return { density: 0.42, motion: 0.15, challenge: 0.15 };
}

function legacyAuthoringSuggestions(regions, sources) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return regions.map((region) => {
    const eventsBySource = new Map(sources.map((source) => [
      source.id,
      regionEvents(source, region),
    ]));
    const contour = eventsBySource.get('melody-contour') ?? [];
    const discrete = eventsBySource.get('discrete-melody') ?? [];
    const percussion = eventsBySource.get('percussion-onsets') ?? [];
    const performance = eventsBySource.get('performance-attacks') ?? [];
    const rhythm = eventsBySource.get('rhythm-grid') ?? [];
    const durationSeconds = Math.max(0.25, region.endSeconds - region.startSeconds);
    const rhythmRate = rhythm.length / durationSeconds;
    const discreteRate = discrete.length / durationSeconds;
    const percussionRate = percussion.length / durationSeconds;
    let sourceId = 'rhythm-grid';
    let mapping = 'rest';
    let reasonCodes = ['no-event-evidence'];

    if (
      sourceById.get('melody-contour')?.availability !== 'unavailable'
      && contour.length >= 3
      && pitchSpan(contour) >= 1
    ) {
      sourceId = 'melody-contour';
      mapping = 'pitch-contour';
      reasonCodes = ['continuous-pitch-evidence'];
    } else if (
      discrete.length >= 2
      && pitchSpan(discrete) >= 1
      && discreteRate >= Math.max(0.5, rhythmRate * 1.1)
    ) {
      sourceId = 'discrete-melody';
      mapping = 'pitch-contour';
      reasonCodes = ['discrete-pitch-evidence'];
    } else if (percussion.length) {
      sourceId = 'percussion-onsets';
      const densePercussion = percussionRate >= Math.max(1.5, rhythmRate * 1.5);
      mapping = densePercussion ? 'alternating' : 'pulse';
      reasonCodes = [densePercussion ? 'dense-percussive-evidence' : 'sparse-percussive-evidence'];
    } else if (performance.length >= 2) {
      sourceId = 'performance-attacks';
      mapping = 'alternating';
      reasonCodes = ['performance-attack-density'];
    } else if (rhythm.length) {
      sourceId = 'rhythm-grid';
      mapping = 'pulse';
      reasonCodes = ['metric-grid-only'];
    } else if (performance.length) {
      sourceId = 'performance-attacks';
      mapping = 'alternating';
      reasonCodes = ['single-performance-attack'];
    }

    return {
      regionId: region.id,
      sourceId,
      mapping,
      ...suggestionParameters(sourceId, mapping),
      reasonCodes,
    };
  });
}

function streamSummary(stream, region) {
  const events = regionEvents(stream, region);
  const durationSeconds = Math.max(0.00001, region.endSeconds - region.startSeconds);
  const orderedTimes = events.map((event) => event.timeSeconds).sort((left, right) => left - right);
  const gaps = orderedTimes.length
    ? [
        orderedTimes[0] - region.startSeconds,
        ...orderedTimes.slice(1).map((time, index) => time - orderedTimes[index]),
        region.endSeconds - orderedTimes.at(-1),
      ]
    : [durationSeconds];
  const cellCount = 8;
  const occupiedCells = new Set(events.map((event) => Math.max(0, Math.min(
    cellCount - 1,
    Math.floor((event.timeSeconds - region.startSeconds) / durationSeconds * cellCount),
  ))));
  const pitches = events.map((event) => finite(event.pitchMidi)).filter(Number.isFinite);
  return {
    streamId: stream.id,
    kind: stream.kind,
    eventCount: events.length,
    activeCoverageRatio: round(occupiedCells.size / cellCount, 4),
    maximumGapSeconds: round(Math.max(...gaps), 5),
    ...(pitches.length >= 2 ? { pitchSpan: round(Math.max(...pitches) - Math.min(...pitches), 3) } : {}),
  };
}

function buildRegionEvidence(regions, evidenceStreams) {
  const streams = Object.values(evidenceStreams).flat();
  return regions.map((region) => ({
    regionId: region.id,
    streams: streams.map((stream) => streamSummary(stream, region)),
  }));
}

function convertLegacySuggestion(suggestion, region, sources) {
  if (suggestion.mapping === 'rest') {
    return {
      regionId: suggestion.regionId,
      preset: { mode: 'rest' },
      reasonCodes: suggestion.reasonCodes,
    };
  }
  let timingSourceId = suggestion.sourceId;
  if (suggestion.sourceId === 'melody-contour') {
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    timingSourceId = [
      'performance-attacks',
      'discrete-melody',
      'percussion-onsets',
      'rhythm-grid',
    ].find((sourceId) => regionEvents(sourceById.get(sourceId), region).length) ?? '';
    if (!timingSourceId) {
      return {
        regionId: suggestion.regionId,
        preset: { mode: 'rest' },
        reasonCodes: ['no-timing-anchor-evidence'],
      };
    }
  }
  return {
    regionId: suggestion.regionId,
    preset: {
      mode: 'play',
      timingLayers: [{ sourceId: timingSourceId, role: 'target', weight: 1 }],
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
      maxGapBeats: 4,
    },
    reasonCodes: suggestion.reasonCodes,
  };
}

function authoringSuggestions(regions, sources, evidenceStreams, regionEvidence) {
  const legacy = new Map(legacyAuthoringSuggestions(regions, sources).map((suggestion) => [
    suggestion.regionId,
    suggestion,
  ]));
  const stemTiming = new Map(evidenceStreams.timing.filter((stream) => (
    stream.stemRole !== 'mix' && !stream.id.endsWith(':pitch-landmarks')
  )).map((stream) => [stream.stemRole, stream]));
  const stemLandmarks = new Map(evidenceStreams.timing.filter((stream) => (
    stream.stemRole !== 'mix' && stream.id.endsWith(':pitch-landmarks')
  )).map((stream) => [stream.stemRole, stream]));
  const stemLanes = new Map(evidenceStreams.lane.filter((stream) => (
    stream.stemRole !== 'mix'
  )).map((stream) => [stream.stemRole, stream]));
  const stemAccents = new Map(evidenceStreams.accent.filter((stream) => (
    stream.stemRole !== 'mix'
  )).map((stream) => [stream.stemRole, stream]));
  const summaryByRegion = new Map(regionEvidence.map((entry) => [
    entry.regionId,
    new Map(entry.streams.map((summary) => [`${summary.kind}:${summary.streamId}`, summary])),
  ]));
  return regions.map((region) => {
    const summaries = summaryByRegion.get(region.id) ?? new Map();
    const durationSeconds = Math.max(0.25, region.endSeconds - region.startSeconds);
    const summaryFor = (stream) => stream && summaries.get(`${stream.kind}:${stream.id}`);
    const hasTimingCoverage = (role) => {
      const stream = stemTiming.get(role);
      const summary = summaryFor(stream);
      return stream?.availability !== 'unavailable'
        && summary?.eventCount >= 2
        && summary.activeCoverageRatio >= 0.5
        && summary.maximumGapSeconds <= Math.max(1.5, durationSeconds * 0.45);
    };
    const hasLaneCoverage = (role) => {
      const stream = stemLanes.get(role);
      const summary = summaryFor(stream);
      return stream?.availability !== 'unavailable'
        && summary?.eventCount >= 3
        && summary.activeCoverageRatio >= 0.5
        && (summary.pitchSpan ?? 0) >= 2
        && summary.maximumGapSeconds <= Math.max(1.5, durationSeconds * 0.35);
    };
    const vocalLead = hasTimingCoverage('vocals') && hasLaneCoverage('vocals');
    const bassLead = hasTimingCoverage('bass') && hasLaneCoverage('bass');
    const primaryRole = vocalLead
      ? 'vocals'
      : hasTimingCoverage('other')
        ? 'other'
        : bassLead
          ? 'bass'
          : hasTimingCoverage('drums')
            ? 'drums'
            : null;
    if (!primaryRole) return convertLegacySuggestion(legacy.get(region.id), region, sources);

    const primaryTiming = stemTiming.get(primaryRole);
    const timingLayers = [{ sourceId: primaryTiming.id, role: 'target', weight: 1 }];
    if (primaryRole === 'vocals') {
      const landmarks = stemLandmarks.get('vocals');
      const summary = summaryFor(landmarks);
      if (
        landmarks?.availability !== 'unavailable'
        && summary?.eventCount >= 3
        && summary.activeCoverageRatio >= 0.375
        && (summary.pitchSpan ?? 0) >= 2
        && summary.maximumGapSeconds <= Math.max(1.5, durationSeconds * 0.45)
      ) {
        timingLayers.push({ sourceId: landmarks.id, role: 'target', weight: 0.35 });
      }
    }
    if (primaryRole !== 'drums' && hasTimingCoverage('drums')) {
      timingLayers.push({ sourceId: stemTiming.get('drums').id, role: 'target', weight: 0.55 });
    }
    if (hasTimingCoverage('drums')) {
      const drumAccent = stemAccents.get('drums');
      if (
        drumAccent?.availability !== 'unavailable'
        && (summaryFor(drumAccent)?.eventCount ?? 0) > 0
      ) {
        timingLayers.push({ sourceId: drumAccent.id, role: 'accent', weight: 0.8 });
      }
    }
    const laneStream = hasLaneCoverage(primaryRole) ? stemLanes.get(primaryRole) : null;
    const eventRate = timingLayers.filter((layer) => layer.role === 'target').reduce((count, layer) => (
      count + (summaries.get(`timing:${layer.sourceId}`)?.eventCount ?? 0)
    ), 0) / durationSeconds;
    return {
      regionId: region.id,
      preset: {
        mode: 'play',
        timingLayers,
        laneDriver: laneStream
          ? { kind: 'source', sourceId: laneStream.id, motion: 0.9 }
          : {
              kind: 'gesture',
              pattern: eventRate >= 0.85 ? 'alternating' : 'pulse',
              motion: eventRate >= 0.85 ? 0.75 : 0.25,
            },
        density: eventRate >= 2 ? 0.65 : eventRate >= 0.85 ? 0.75 : 0.85,
        challenge: eventRate >= 2 ? 0.35 : 0.22,
        feel: 'natural',
        maxGapBeats: 4,
      },
      reasonCodes: ['separated-stem-coverage', `${primaryRole}-lead`],
    };
  });
}

export function buildAuthoringScore(analysis) {
  const regions = authoringRegions(analysis);
  const sources = [
    performanceSource(analysis),
    rhythmSource(analysis),
    percussionSource(analysis),
    discreteMelodySource(analysis),
    contourSource(analysis),
  ];
  const evidenceStreams = mergeEvidenceStreams(
    legacyEvidenceStreams(sources),
    stemEvidenceStreams(analysis),
  );
  const regionEvidence = buildRegionEvidence(regions, evidenceStreams);
  return {
    kind: 'authoring-score',
    schemaVersion: '2.0.0',
    algorithm: AUTHORING_SCORE_ALGORITHM,
    levelId: `${String(analysis?.song?.id ?? 'unknown-song')}-flow`,
    audioFingerprint: String(analysis?.song?.audioFingerprint ?? 'missing-audio-fingerprint'),
    evidenceFingerprint: String(
      analysis?.stemEvidence?.evidenceFingerprint
      || fallbackEvidenceFingerprint(analysis, evidenceStreams),
    ),
    sources,
    evidenceStreams,
    regions,
    regionEvidence,
    repeatSets: trustedRepeatSets(analysis, regions),
    suggestions: authoringSuggestions(regions, sources, evidenceStreams, regionEvidence),
  };
}
