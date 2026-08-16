const STYLE_CALIBRATION_RATES = {
  melodic: 60,
  percussive: 50,
  rhythmic: 135,
};

const ROLE_MOTIFS = {
  intro: ['focus', 'pulse', 'sweep', 'c'],
  build: ['stairs', 'sweep', 'hook', 'c', 'v'],
  drive: ['c', 's', 'zigzag', 'pendulum', 'sweep'],
  peak: ['m', 's', 'zigzag', 'v', 'stairs', 'pendulum'],
  break: ['focus', 'pulse', 'c', 'sweep'],
  release: ['v', 'hook', 'sweep', 'pulse', 'focus'],
  outro: ['pulse', 'focus', 'v', 'hook'],
};

const CONTOUR_MOTIFS = {
  rising: ['stairs', 'sweep', 'hook', 'v'],
  falling: ['hook', 'sweep', 'c', 'v'],
  oscillating: ['s', 'zigzag', 'pendulum', 'm'],
  steady: ['pulse', 'c', 'focus', 'pendulum'],
  unknown: [],
};

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function weightedMean(values, weights) {
  const weight = weights.reduce((sum, value) => sum + value, 0);
  if (weight <= 1e-9) return mean(values);
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / weight;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(ratio) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const blend = position - lower;
  return sorted[lower] * (1 - blend) + sorted[upper] * blend;
}

function normalizeSeries(values) {
  if (!values.length) return [];
  const low = percentile(values, 0.1);
  const high = percentile(values, 0.9);
  if (high - low <= 1e-9) {
    return values.map((value) => (Math.abs(value) <= 1e-9 ? 0 : 0.5));
  }
  return values.map((value) => clamp((value - low) / (high - low)));
}

function eventSource(analysis, id) {
  const sources = Array.isArray(analysis?.eventSources) ? analysis.eventSources : [];
  return sources.find((source) => source?.id === id) ?? { id, events: [] };
}

function eventsOf(source) {
  return Array.isArray(source?.events)
    ? source.events.filter((event) => Number.isFinite(Number(event?.timeSeconds)))
    : [];
}

function eventRate(source, durationSeconds) {
  const events = eventsOf(source);
  if (durationSeconds > 0) return events.length / durationSeconds * 60;
  return Math.max(0, finite(source?.eventsPerMinute));
}

function deriveSongProfile(analysis, sources) {
  const durationSeconds = Math.max(0, finite(analysis?.song?.durationSeconds));
  const rates = {
    basicPitch: eventRate(sources.melody, durationSeconds),
    librosaOnset: eventRate(sources.onset, durationSeconds),
    beatThis: eventRate(sources.beat, durationSeconds),
  };
  const evidence = {
    melodic: rates.basicPitch / STYLE_CALIBRATION_RATES.melodic,
    percussive: rates.librosaOnset / STYLE_CALIBRATION_RATES.percussive,
    rhythmic: rates.beatThis / STYLE_CALIBRATION_RATES.rhythmic,
  };
  const totalEvidence = evidence.melodic + evidence.percussive + evidence.rhythmic;
  const weights = totalEvidence > 1e-9
    ? Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, round(value / totalEvidence)]))
    : { melodic: 0, percussive: 0, rhythmic: 0 };

  const ranked = Object.entries(weights).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const styleNames = {
    melodic: 'melodic-drive',
    percussive: 'percussive-drive',
    rhythmic: 'rhythmic-drive',
  };
  const dominantStyle = !ranked.length || ranked[0][1] <= 0
    ? 'balanced-flow'
    : ranked[0][1] - (ranked[1]?.[1] ?? 0) < 0.035
      ? 'balanced-flow'
      : styleNames[ranked[0][0]];

  return {
    dominantStyle,
    weights,
    eventRatesPerMinute: Object.fromEntries(
      Object.entries(rates).map(([key, value]) => [key, round(value, 2)]),
    ),
  };
}

function waveformMean(analysis, startSeconds, endSeconds) {
  const peaks = Array.isArray(analysis?.waveform?.peaks) ? analysis.waveform.peaks : [];
  const duration = Math.max(0, finite(analysis?.song?.durationSeconds));
  if (!peaks.length || duration <= 0 || endSeconds <= startSeconds) return 0;
  const start = Math.max(0, Math.floor(startSeconds / duration * peaks.length));
  const end = Math.min(peaks.length, Math.max(start + 1, Math.ceil(endSeconds / duration * peaks.length)));
  return mean(peaks.slice(start, end).map((value) => finite(value)));
}

function eventsPerSecond(events, startSeconds, endSeconds) {
  const duration = Math.max(1e-6, endSeconds - startSeconds);
  const count = events.filter((event) => {
    const time = finite(event.timeSeconds, Number.NaN);
    return time >= startSeconds && time < endSeconds;
  }).length;
  return count / duration;
}

function sectionEnergy(analysis, section) {
  if (Number.isFinite(Number(section?.intensity))) return clamp(Number(section.intensity));
  const bars = Array.isArray(analysis?.musicalStructure?.bars)
    ? analysis.musicalStructure.bars.slice(
      Math.max(0, finite(section?.startBarIndex)),
      Math.max(0, finite(section?.endBarIndex)),
    )
    : [];
  const intensities = bars.map((bar) => Number(bar?.intensity)).filter(Number.isFinite);
  return intensities.length
    ? clamp(mean(intensities))
    : clamp(waveformMean(analysis, finite(section?.startSeconds), finite(section?.endSeconds)));
}

function rankMotifs(weightedLists, limit = 6) {
  const scores = new Map();
  for (const { motifs, weight = 1 } of weightedLists) {
    motifs.forEach((motif, index) => {
      const rankWeight = 1 - index / Math.max(1, motifs.length) * 0.45;
      scores.set(motif, (scores.get(motif) ?? 0) + weight * rankWeight);
    });
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([motif]) => motif);
}

function assignSectionRoles(profiles) {
  if (!profiles.length) return profiles;
  if (profiles.length === 1) return [{ ...profiles[0], role: 'drive', motifBias: ROLE_MOTIFS.drive }];

  const internalIndices = profiles.length > 2
    ? profiles.slice(1, -1).map((_, index) => index + 1)
    : profiles.map((_, index) => index);
  const peakIndex = internalIndices.reduce(
    (best, index) => profiles[index].pressure > profiles[best].pressure ? index : best,
    internalIndices[0],
  );
  const pressureLow = percentile(profiles.map((profile) => profile.pressure), 0.25);
  const dynamicThreshold = Math.max(0.065, (percentile(
    profiles.map((profile) => profile.pressure),
    0.8,
  ) - pressureLow) * 0.22);

  return profiles.map((profile, index) => {
    const previous = profiles[index - 1];
    const next = profiles[index + 1];
    let role;
    if (index === peakIndex) role = 'peak';
    else if (index === 0) role = 'intro';
    else if (index === profiles.length - 1) role = 'outro';
    else if (profile.pressure <= pressureLow && profile.pressure + dynamicThreshold < Math.max(previous.pressure, next.pressure)) {
      role = 'break';
    } else if (next.pressure - profile.pressure >= dynamicThreshold) role = 'build';
    else if (previous.pressure - profile.pressure >= dynamicThreshold) role = 'release';
    else role = 'drive';
    return { ...profile, role, motifBias: [...ROLE_MOTIFS[role]] };
  });
}

function deriveSectionProfiles(analysis, sources, songProfile) {
  const sections = Array.isArray(analysis?.musicalStructure?.sections)
    ? analysis.musicalStructure.sections
    : [];
  const onsetEvents = eventsOf(sources.onset);
  const melodyEvents = eventsOf(sources.melody);
  const beatEvents = eventsOf(sources.beat);
  const raw = sections.map((section, index) => {
    const startSeconds = finite(section?.startSeconds, Number.NaN);
    const endSeconds = finite(section?.endSeconds, Number.NaN);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return null;
    return {
      index: Number.isInteger(section?.index) ? section.index : index,
      id: String(section?.id ?? `S${String(index + 1).padStart(2, '0')}`),
      startSeconds,
      endSeconds,
      startBarIndex: Number.isInteger(section?.startBarIndex) ? section.startBarIndex : null,
      endBarIndex: Number.isInteger(section?.endBarIndex) ? section.endBarIndex : null,
      energy: sectionEnergy(analysis, section),
      onsetRate: eventsPerSecond(onsetEvents, startSeconds, endSeconds),
      melodyRate: eventsPerSecond(melodyEvents, startSeconds, endSeconds),
      beatRate: eventsPerSecond(beatEvents, startSeconds, endSeconds),
    };
  }).filter(Boolean);
  const normalizedOnset = normalizeSeries(raw.map((section) => section.onsetRate));
  const normalizedMelody = normalizeSeries(raw.map((section) => section.melodyRate));
  const normalizedBeat = normalizeSeries(raw.map((section) => section.beatRate));
  const normalizedEnergy = normalizeSeries(raw.map((section) => section.energy));

  const profiles = raw.map((section, index) => {
    const activity = (
      normalizedMelody[index] * songProfile.weights.melodic
      + normalizedOnset[index] * songProfile.weights.percussive
      + normalizedBeat[index] * songProfile.weights.rhythmic
    );
    const pressure = normalizedEnergy[index] * 0.55 + activity * 0.45;
    return {
      index: section.index,
      id: section.id,
      startSeconds: round(section.startSeconds, 5),
      endSeconds: round(section.endSeconds, 5),
      startBarIndex: section.startBarIndex,
      endBarIndex: section.endBarIndex,
      pressure: round(clamp(pressure)),
      energy: round(section.energy),
      activity: {
        melodic: round(normalizedMelody[index]),
        percussive: round(normalizedOnset[index]),
        rhythmic: round(normalizedBeat[index]),
      },
    };
  });
  return assignSectionRoles(profiles);
}

function midiPitch(event) {
  const candidates = [event?.midiPitch, event?.pitchMidi, event?.pitch, event?.pitchMean];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

function pitchBounds(event, pitch) {
  const minimum = Number(event?.pitchMin ?? event?.pitchMinMidi);
  const maximum = Number(event?.pitchMax ?? event?.pitchMaxMidi);
  return {
    minimum: Number.isFinite(minimum) ? minimum : pitch,
    maximum: Number.isFinite(maximum) ? maximum : pitch,
  };
}

function regressionSlope(points) {
  if (points.length < 2) return 0;
  const weights = points.map((point) => point.weight);
  const xMean = weightedMean(points.map((point) => point.x), weights);
  const yMean = weightedMean(points.map((point) => point.y), weights);
  const numerator = points.reduce(
    (sum, point) => sum + point.weight * (point.x - xMean) * (point.y - yMean),
    0,
  );
  const denominator = points.reduce(
    (sum, point) => sum + point.weight * (point.x - xMean) ** 2,
    0,
  );
  return denominator > 1e-9 ? numerator / denominator : 0;
}

function occurrenceContour(phrase, pitchEvents) {
  const startSeconds = finite(phrase?.startSeconds, Number.NaN);
  const endSeconds = finite(phrase?.endSeconds, Number.NaN);
  const duration = endSeconds - startSeconds;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const events = pitchEvents
    .filter((event) => event.timeSeconds >= startSeconds && event.timeSeconds < endSeconds)
    .map((event) => {
      const pitch = midiPitch(event);
      if (!Number.isFinite(pitch)) return null;
      const confidence = clamp(finite(event?.confidence, 1), 0.05, 1);
      return {
        x: clamp((event.timeSeconds - startSeconds) / duration),
        y: pitch,
        weight: confidence,
        confidence,
        bounds: pitchBounds(event, pitch),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.x - right.x);
  if (events.length < 3) return null;

  const center = weightedMean(events.map((event) => event.y), events.map((event) => event.weight));
  const centeredPoints = events.map((event) => ({ ...event, y: event.y - center }));
  const slope = regressionSlope(centeredPoints);
  const pitchSamples = events.flatMap((event) => [event.bounds.minimum, event.y, event.bounds.maximum]);
  const range = percentile(pitchSamples, 0.9) - percentile(pitchSamples, 0.1);
  const directions = [];
  for (let index = 1; index < events.length; index += 1) {
    const difference = events[index].y - events[index - 1].y;
    if (Math.abs(difference) >= 0.75) directions.push(Math.sign(difference));
  }
  let directionChanges = 0;
  for (let index = 1; index < directions.length; index += 1) {
    if (directions[index] !== directions[index - 1]) directionChanges += 1;
  }
  const turnRatio = directions.length > 1 ? directionChanges / (directions.length - 1) : 0;
  const coverage = events[events.length - 1].x - events[0].x;
  return {
    points: centeredPoints,
    slope,
    range,
    turnRatio,
    coverage,
    eventCount: events.length,
    meanConfidence: mean(events.map((event) => event.confidence)),
  };
}

function classifyContour(slope, range, turnRatio) {
  const trendThreshold = Math.max(1.5, range * 0.3);
  if (range >= 3 && turnRatio >= 0.34 && Math.abs(slope) < Math.max(3, range * 0.75)) return 'oscillating';
  if (slope >= trendThreshold) return 'rising';
  if (slope <= -trendThreshold) return 'falling';
  if (range >= 4 && turnRatio >= 0.2) return 'oscillating';
  return 'steady';
}

function familyContour(phrases, pitchEvents) {
  const occurrences = phrases.map((phrase) => occurrenceContour(phrase, pitchEvents)).filter(Boolean);
  if (!occurrences.length) {
    return {
      kind: 'unknown',
      confidence: 0,
      range: 0,
      slope: 0,
      eventCount: 0,
      analyzedOccurrenceCount: 0,
    };
  }

  const occurrenceWeights = occurrences.map((occurrence) => Math.max(1, occurrence.eventCount) * occurrence.meanConfidence);
  const slope = weightedMean(occurrences.map((occurrence) => occurrence.slope), occurrenceWeights);
  const range = weightedMean(occurrences.map((occurrence) => occurrence.range), occurrenceWeights);
  const turnRatio = weightedMean(occurrences.map((occurrence) => occurrence.turnRatio), occurrenceWeights);
  const kind = classifyContour(slope, range, turnRatio);
  const eventCount = occurrences.reduce((sum, occurrence) => sum + occurrence.eventCount, 0);
  const evidence = clamp(eventCount / Math.max(1, phrases.length * 8));
  const occurrenceCoverage = occurrences.length / Math.max(1, phrases.length);
  const temporalCoverage = weightedMean(occurrences.map((occurrence) => occurrence.coverage), occurrenceWeights);
  const detectorConfidence = weightedMean(occurrences.map((occurrence) => occurrence.meanConfidence), occurrenceWeights);
  const shapeClarity = kind === 'oscillating'
    ? clamp(turnRatio)
    : kind === 'steady'
      ? clamp(1 - range / 8)
      : clamp(Math.abs(slope) / Math.max(2, range));
  const confidence = occurrenceCoverage * (
    evidence * 0.35 + temporalCoverage * 0.2 + detectorConfidence * 0.25 + shapeClarity * 0.2
  );
  return {
    kind,
    confidence: round(clamp(confidence)),
    range: round(Math.max(0, range), 3),
    slope: round(slope, 3),
    eventCount,
    analyzedOccurrenceCount: occurrences.length,
  };
}

function sectionForPhrase(phrase, sections) {
  if (Number.isInteger(phrase?.sectionIndex)) {
    const exact = sections.find((section) => section.index === phrase.sectionIndex);
    if (exact) return exact;
  }
  const midpoint = (finite(phrase?.startSeconds) + finite(phrase?.endSeconds)) / 2;
  return sections.find((section) => midpoint >= section.startSeconds && midpoint < section.endSeconds)
    ?? sections.at(-1);
}

function deriveFamilyProfiles(analysis, sectionProfiles, melodyEvents) {
  const phrases = Array.isArray(analysis?.musicalStructure?.phrases)
    ? analysis.musicalStructure.phrases.filter((phrase) => phrase?.familyId)
    : [];
  phrases.sort((left, right) => (
    finite(left?.startSeconds) - finite(right?.startSeconds)
    || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  ));
  const grouped = new Map();
  for (const phrase of phrases) {
    const familyId = String(phrase.familyId);
    if (!grouped.has(familyId)) grouped.set(familyId, []);
    grouped.get(familyId).push(phrase);
  }

  return [...grouped.entries()].map(([familyId, occurrences]) => {
    const contour = familyContour(occurrences, melodyEvents);
    const sections = occurrences.map((phrase) => sectionForPhrase(phrase, sectionProfiles)).filter(Boolean);
    const roleCounts = new Map();
    for (const section of sections) roleCounts.set(section.role, (roleCounts.get(section.role) ?? 0) + 1);
    const sectionRoles = [...roleCounts.keys()];
    const dominantSectionRole = [...roleCounts.entries()].sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      const leftPressure = Math.max(...sections.filter((section) => section.role === left[0]).map((section) => section.pressure));
      const rightPressure = Math.max(...sections.filter((section) => section.role === right[0]).map((section) => section.pressure));
      return rightPressure - leftPressure || left[0].localeCompare(right[0]);
    })[0]?.[0] ?? 'drive';
    const roleLists = [...roleCounts.entries()].map(([role, count]) => ({
      motifs: ROLE_MOTIFS[role] ?? ROLE_MOTIFS.drive,
      weight: count / Math.max(1, sections.length),
    }));
    const motifBias = rankMotifs([
      { motifs: CONTOUR_MOTIFS[contour.kind], weight: contour.confidence > 0 ? 1.15 : 0 },
      ...roleLists,
    ]);
    const fingerprint = String(analysis?.song?.audioFingerprint ?? 'missing-audio-fingerprint');
    const deterministicFallback = hashText(`${fingerprint}|${familyId}|orientation`) % 2 === 0
      ? 'identity'
      : 'mirror';
    const preferredTransform = contour.kind === 'falling'
      ? 'mirror'
      : contour.kind === 'rising'
        ? 'identity'
        : contour.kind === 'oscillating' && Math.abs(contour.slope) >= 0.75
          ? (contour.slope < 0 ? 'mirror' : 'identity')
          : deterministicFallback;
    return {
      familyId,
      occurrencePhraseIds: occurrences.map((phrase) => String(phrase.id ?? '')),
      occurrenceCount: occurrences.length,
      sectionRoles,
      dominantSectionRole,
      contour,
      preferredTransform,
      transformReason: ['rising', 'falling'].includes(contour.kind)
        || (contour.kind === 'oscillating' && Math.abs(contour.slope) >= 0.75)
        ? 'pitch-contour'
        : 'audio-fingerprint-fallback',
      motifBias,
    };
  });
}

/**
 * Translate detector output into stable, gameplay-facing layout intent.
 * This function is pure: it reads only the supplied production analysis.
 */
export function deriveLayoutIntent(analysis) {
  const source = analysis && typeof analysis === 'object' ? analysis : {};
  const sources = {
    onset: eventSource(source, 'librosa-onset'),
    melody: eventSource(source, 'basic-pitch'),
    beat: eventSource(source, 'beat-this'),
  };
  const songProfile = deriveSongProfile(source, sources);
  const sections = deriveSectionProfiles(source, sources, songProfile);
  const families = deriveFamilyProfiles(source, sections, eventsOf(sources.melody));
  return {
    songProfile,
    sections,
    families,
  };
}
