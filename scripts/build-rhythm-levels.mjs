import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { deriveLayoutIntent } from './rhythm/layout-intent.mjs';
import { planColorSchemeEvents, planVisualAccentEvents } from './rhythm/color-timeline.mjs';
import { densityFillCount, planDensityInterval } from './rhythm/density-planner.mjs';
import {
  analyzeRouteGraph,
  chooseMGesturePlacement,
  findLiteralMGestures,
} from './rhythm/route-analysis.mjs';
import { buildWaveRows } from './rhythm/wave-planner.mjs';
import { planFullWidthSweeps } from './rhythm/wide-sweep-planner.mjs';
import { directSong } from './rhythm/song-director.mjs';
import { transcribePerformance } from './rhythm/performance-transcriber.mjs';

const root = resolve(import.meta.dirname, '..');
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('build-rhythm-levels.mjs is an internal step; run npm run generate instead.');
}
const inputPath = resolve(root, process.argv[2]);
const levelPath = resolve(root, process.argv[3]);
const analysis = JSON.parse(await readFile(inputPath, 'utf8'));
const LAYOUT_INTENT = deriveLayoutIntent(analysis);
const SONG_DIRECTION = directSong(analysis);
const COLOR_SCHEME_EVENTS = planColorSchemeEvents(analysis, LAYOUT_INTENT, SONG_DIRECTION);
const DIRECTOR_VISUAL_ACCENTS = planVisualAccentEvents(SONG_DIRECTION);
const MIN_RUNTIME_ACCENT_SPACING_SECONDS = Math.max(
  1.5,
  60 / Math.max(1, Number(analysis.song.bpm) || 120) * 2.5,
);
const TURN_VISUAL_ACCENTS = (SONG_DIRECTION.moments ?? []).filter((moment) => (
    ['must', 'should'].includes(moment.commitment)
  )).map((moment) => ({
    id: `turn-accent-${moment.id}`,
    timeSeconds: moment.timeSeconds,
    anchorId: moment.anchorId,
    sceneId: moment.sceneId,
    kind: 'pulse',
    strength: moment.strength,
    source: moment.id,
    evidenceIds: moment.evidenceIds,
  })).filter((turnAccent) => DIRECTOR_VISUAL_ACCENTS.every((accent) => (
    Math.abs(accent.timeSeconds - turnAccent.timeSeconds) >= MIN_RUNTIME_ACCENT_SPACING_SECONDS
  )));
const SPACED_TURN_VISUAL_ACCENTS = [];
for (const turnAccent of TURN_VISUAL_ACCENTS) {
  if (
    !SPACED_TURN_VISUAL_ACCENTS.length
    || turnAccent.timeSeconds - SPACED_TURN_VISUAL_ACCENTS.at(-1).timeSeconds >= MIN_RUNTIME_ACCENT_SPACING_SECONDS
  ) SPACED_TURN_VISUAL_ACCENTS.push(turnAccent);
}
const VISUAL_ACCENT_EVENTS = [...DIRECTOR_VISUAL_ACCENTS, ...SPACED_TURN_VISUAL_ACCENTS]
  .sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id));
const PERFORMANCE_SCORE = analysis.performanceScore?.kind === 'performance-score'
  ? analysis.performanceScore
  : transcribePerformance(analysis, { travelSecondsPerLane: 0.08 });

const EMPTY = 0;
const BREAKABLE = 1;
const SPIKE = 2;
const LANE_COUNT = 5;
const START_LANE = 2;
const MIN_PLAYABLE_TIME = 1.2;
const OUTRO_MARGIN = 1.15;
const AUXILIARY_SOURCE_IDS = ['basic-pitch', 'librosa-onset'];
const AUXILIARY_MERGE_SECONDS = 0.06;
const BEAT_SECONDS = 60 / Math.max(1, Number(analysis.song.bpm) || 120);
const MIN_EVENT_GAP_SECONDS = 0.09;
const CLIMAX_RADIUS_SECONDS = BEAT_SECONDS * 16;
const AUXILIARY_PHRASE_GAP_SECONDS = BEAT_SECONDS * 1.5;
const STRUCTURAL_TRAVEL_SECONDS_PER_LANE = 0.23;
const SWEEP_TRAVEL_SECONDS_PER_LANE = 0.09;
const SWEEP_SPIKE_PRESSURE = 0.68;
const KINETIC_FORM_COMPILER_VERSION = 'kinetic-form-row-compiler-v1';
const PERFORMANCE_ROW_COMPILER_VERSION = 'performance-score-row-compiler-v1';
const PERFORMANCE_TRAVEL_SECONDS_PER_LANE = 0.08;
const PERFORMANCE_COINCIDENCE_SECONDS = 0.018;

const FLOW_MODE = {
  id: 'flow',
  label: '心流',
  description: '全程保持操作，随音乐强度递进',
  minTravelSecondsPerLane: STRUCTURAL_TRAVEL_SECONDS_PER_LANE,
};

const MOTIFS = {
  focus: { label: '专注引导', baseLength: 8, minimumLength: 6, controls: [2, 2, 1, 2, 3, 2], spikeMode: 'none' },
  c: { label: 'C 形绕行', baseLength: 12, minimumLength: 9, controls: [4, 3, 2, 1, 1, 2, 3, 4], spikeMode: 'c' },
  sweep: { label: '斜线长扫', baseLength: 10, minimumLength: 7, controls: [0, 1, 2, 3, 4], spikeMode: 'corridor-wide' },
  v: { label: 'V 形折返', baseLength: 12, minimumLength: 8, controls: [0, 2, 4, 2, 0], spikeMode: 'corridor-wide' },
  pulse: { label: '呼吸门', baseLength: 8, minimumLength: 6, controls: [2, 1, 2, 3, 2], spikeMode: 'pulse' },
  s: { label: 'S 形滑行', baseLength: 14, minimumLength: 10, controls: [0, 1, 2, 3, 4, 4, 3, 2, 1, 0], spikeMode: 'corridor' },
  zigzag: { label: 'Z 形变向', baseLength: 12, minimumLength: 9, controls: [0, 0, 2, 4, 4, 2, 0, 0], spikeMode: 'corridor' },
  hook: { label: '钩形回转', baseLength: 10, minimumLength: 7, controls: [0, 1, 2, 3, 4, 4, 3], spikeMode: 'corridor' },
  stairs: { label: '阶梯横移', baseLength: 10, minimumLength: 7, controls: [0, 0, 1, 2, 3, 4, 4], spikeMode: 'corridor-wide' },
  pendulum: { label: '钟摆切换', baseLength: 10, minimumLength: 7, controls: [1, 3, 1, 3, 1], spikeMode: 'pulse' },
  wave: { label: '波浪门', baseLength: 9, minimumLength: 5, controls: [1, 2, 3, 2, 1], spikeMode: 'wave' },
  contour: { label: '旋律轮廓', baseLength: 8, minimumLength: 4, controls: [2], spikeMode: 'contour' },
  m: { label: 'M 形往返手势', baseLength: 6, minimumLength: 6, spikeMode: 'gesture' },
  'full-width-sweep': { label: '全宽鼓点横扫', baseLength: 9, minimumLength: 9, spikeMode: 'gesture' },
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function noise(...parts) {
  let value = hashText(parts.join('|'));
  value += 0x6d2b79f5;
  value = Math.imul(value ^ value >>> 15, value | 1);
  value ^= value + Math.imul(value ^ value >>> 7, value | 61);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function normalizeRobust(values) {
  const low = percentile(values, 0.1);
  const high = percentile(values, 0.9);
  return values.map((value) => clamp((value - low) / Math.max(1e-6, high - low), 0, 1));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function waveformEnergyAt(timeSeconds, radiusSeconds = 2.2) {
  const peaks = analysis.waveform.peaks;
  const center = timeSeconds / analysis.song.durationSeconds * peaks.length;
  const radius = radiusSeconds / analysis.song.durationSeconds * peaks.length;
  const start = Math.max(0, Math.floor(center - radius));
  const end = Math.min(peaks.length, Math.ceil(center + radius));
  return average(peaks.slice(start, end));
}

const onsetTrack = analysis.eventSources.find((source) => source.id === 'librosa-onset');
const melodyTrack = analysis.eventSources.find((source) => source.id === 'basic-pitch');
const beatTrack = analysis.eventSources.find((source) => source.id === 'beat-this');
const AUDIO_SEED = analysis.song.audioFingerprint ?? `waveform-${hashText(
  analysis.waveform.peaks.filter((_, index) => index % 7 === 0).map((value) => Number(value).toFixed(3)).join(','),
).toString(16)}`;

const onsetEventsPerMinute = LAYOUT_INTENT.songProfile.eventRatesPerMinute.librosaOnset;
const melodyEventsPerMinute = LAYOUT_INTENT.songProfile.eventRatesPerMinute.basicPitch;
const beatEventsPerMinute = LAYOUT_INTENT.songProfile.eventRatesPerMinute.beatThis;
const SONG_STYLE = {
  id: LAYOUT_INTENT.songProfile.dominantStyle,
  audioFingerprint: AUDIO_SEED,
  bpm: analysis.song.bpm,
  onsetEventsPerMinute: Number(onsetEventsPerMinute.toFixed(2)),
  melodyEventsPerMinute: Number(melodyEventsPerMinute.toFixed(2)),
  beatEventsPerMinute: Number(beatEventsPerMinute.toFixed(2)),
  weights: LAYOUT_INTENT.songProfile.weights,
};

const INTENT_SECTION_BY_INDEX = new Map(LAYOUT_INTENT.sections.map((section) => [section.index, section]));
const INTENT_FAMILY_BY_PHRASE_ID = new Map(LAYOUT_INTENT.families.flatMap((family) => (
  family.occurrencePhraseIds.map((phraseId) => [phraseId, family])
)));
const DIRECTED_SCENES = Array.isArray(SONG_DIRECTION.scenes) ? SONG_DIRECTION.scenes : [];
const DIRECTED_MOMENTS = Array.isArray(SONG_DIRECTION.moments) ? SONG_DIRECTION.moments : [];
const DIRECTED_IDENTITIES = Array.isArray(SONG_DIRECTION.phraseIdentities)
  ? SONG_DIRECTION.phraseIdentities
  : [];

function intentSectionAt(timeSeconds) {
  return LAYOUT_INTENT.sections.find((section, index) => (
    timeSeconds >= section.startSeconds
    && (index === LAYOUT_INTENT.sections.length - 1 || timeSeconds < section.endSeconds)
  )) ?? LAYOUT_INTENT.sections.at(-1) ?? null;
}

function directedSceneAt(timeSeconds) {
  return DIRECTED_SCENES.find((scene, index) => (
    timeSeconds >= Number(scene.startSeconds)
    && (index === DIRECTED_SCENES.length - 1 || timeSeconds < Number(scene.endSeconds))
  )) ?? DIRECTED_SCENES.at(-1) ?? null;
}

function directedMomentsInRange(startSeconds, endSeconds, minimumCommitment = 'may') {
  const commitmentRank = { may: 0, should: 1, must: 2 };
  const minimumRank = commitmentRank[minimumCommitment] ?? 0;
  return DIRECTED_MOMENTS.filter((moment) => (
    Number(moment.timeSeconds) >= startSeconds
    && Number(moment.timeSeconds) < endSeconds
    && (commitmentRank[moment.commitment] ?? 0) >= minimumRank
  ));
}

function directedIdentityForPhrases(phrases) {
  const phraseIds = new Set(phrases.map((phrase) => String(phrase.id)));
  const intervalStart = Math.min(...phrases.map((phrase) => phrase.startSeconds));
  const intervalEnd = Math.max(...phrases.map((phrase) => phrase.endSeconds));
  return DIRECTED_IDENTITIES
    .map((identity) => {
      const occurrences = Array.isArray(identity.occurrences) ? identity.occurrences : [];
      const idMatches = occurrences.reduce((count, occurrence) => (
        count + Number((occurrence.sourcePhraseIds ?? []).some((phraseId) => phraseIds.has(String(phraseId))))
      ), 0);
      const overlap = occurrences.reduce((sum, occurrence) => {
        const start = Math.max(intervalStart, Number(occurrence.startSeconds));
        const end = Math.min(intervalEnd, Number(occurrence.endSeconds));
        return sum + Math.max(0, end - start);
      }, 0);
      return { identity, idMatches, overlap };
    })
    .sort((left, right) => (
      right.idMatches - left.idMatches
      || right.overlap - left.overlap
      || String(left.identity.id).localeCompare(String(right.identity.id))
    ))[0]?.identity ?? null;
}

function trackDensityAt(track, timeSeconds, radiusSeconds = 2.2) {
  if (!track) return 0;
  return track.events.filter((event) => Math.abs(event.timeSeconds - timeSeconds) <= radiusSeconds).length;
}

function buildFlowValues(events) {
  const energies = events.map((event) => waveformEnergyAt(event.timeSeconds));
  const broadEnergies = events.map((event) => waveformEnergyAt(event.timeSeconds, 4));
  const onsetDensities = events.map((event) => trackDensityAt(onsetTrack, event.timeSeconds));
  const melodyDensities = events.map((event) => trackDensityAt(melodyTrack, event.timeSeconds));
  const broadOnsetDensities = events.map((event) => trackDensityAt(onsetTrack, event.timeSeconds, 4));
  const broadMelodyDensities = events.map((event) => trackDensityAt(melodyTrack, event.timeSeconds, 4));
  const normalizedEnergy = normalizeRobust(energies);
  const normalizedOnsetDensity = normalizeRobust(onsetDensities);
  const normalizedMelodyDensity = normalizeRobust(melodyDensities);
  const normalizedBroadOnset = normalizeRobust(broadOnsetDensities);
  const normalizedBroadMelody = normalizeRobust(broadMelodyDensities);
  const densityAt = (index, broad = false) => {
    const onset = broad ? normalizedBroadOnset[index] : normalizedOnsetDensity[index];
    const melody = broad ? normalizedBroadMelody[index] : normalizedMelodyDensity[index];
    const { melodic, percussive, rhythmic } = SONG_STYLE.weights;
    return melody * melodic + onset * percussive + ((melody + onset) / 2) * rhythmic;
  };
  const raw = events.map((event, index) => {
    const introRampSeconds = BEAT_SECONDS * 32;
    const introRamp = clamp(0.28 + event.timeSeconds / introRampSeconds * 0.72, 0.28, 1);
    const sectionPressure = intentSectionAt(event.timeSeconds)?.pressure ?? 0.5;
    return (
      normalizedEnergy[index] * 0.5
      + densityAt(index) * 0.3
      + sectionPressure * 0.2
    ) * introRamp;
  });
  const values = raw.map((_, index) => {
    const start = Math.max(0, index - 4);
    const end = Math.min(raw.length, index + 5);
    return clamp(average(raw.slice(start, end)), 0, 1);
  });
  const maximumBroadEnergy = Math.max(...broadEnergies, 1e-9);
  const densityClimaxScores = broadEnergies.map((energy, index) => {
    const introRamp = clamp(0.45 + events[index].timeSeconds / (BEAT_SECONDS * 32) * 0.55, 0.45, 1);
    const sectionPressure = intentSectionAt(events[index].timeSeconds)?.pressure ?? 0.5;
    return (
      energy / maximumBroadEnergy * 0.52
      + densityAt(index, true) * 0.25
      + sectionPressure * 0.23
    ) * introRamp;
  });
  const climaxScores = events.map((event) => average(densityClimaxScores.filter((_, candidateIndex) => (
    Math.abs(events[candidateIndex].timeSeconds - event.timeSeconds) <= CLIMAX_RADIUS_SECONDS
  ))));
  return { values, climaxScores };
}

function nearestEventIndex(events, timeSeconds) {
  let low = 0;
  let high = events.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle].timeSeconds < timeSeconds) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(events[low - 1].timeSeconds - timeSeconds) <= Math.abs(events[low].timeSeconds - timeSeconds)) {
    return low - 1;
  }
  return low;
}

function flowAtTime(events, flowValues, timeSeconds) {
  if (!events.length) return 0;
  return flowValues[nearestEventIndex(events, timeSeconds)];
}

function auxiliaryBand(flow) {
  if (flow < 0.34) return 'low';
  if (flow < 0.52) return 'mid';
  if (flow < 0.68) return 'high';
  if (flow < 0.82) return 'very-high';
  return 'climax';
}

function buildAuxiliaryCandidates(baseEvents, flowValues, seed, climaxTime) {
  const minimumGapAt = (timeSeconds) => (
    Math.abs(timeSeconds - climaxTime) <= CLIMAX_RADIUS_SECONDS
      ? Math.max(0.08, MIN_EVENT_GAP_SECONDS * 0.8)
      : MIN_EVENT_GAP_SECONDS
  );
  const sourceEntries = AUXILIARY_SOURCE_IDS.flatMap((sourceId) => {
    const source = analysis.eventSources.find((candidate) => candidate.id === sourceId);
    if (!source) return [];
    const normalized = normalizeRobust(source.events.map((event) => event.confidence));
    return source.events.flatMap((event, index) => (
      event.timeSeconds >= MIN_PLAYABLE_TIME
      && event.timeSeconds <= analysis.song.durationSeconds - OUTRO_MARGIN
        ? [{ ...event, trackId: sourceId, normalizedConfidence: normalized[index] }]
        : []
    ));
  }).sort((left, right) => left.timeSeconds - right.timeSeconds);

  const groups = [];
  for (const entry of sourceEntries) {
    const lastGroup = groups[groups.length - 1];
    if (!lastGroup || entry.timeSeconds - lastGroup[lastGroup.length - 1].timeSeconds > AUXILIARY_MERGE_SECONDS) {
      groups.push([entry]);
    } else {
      lastGroup.push(entry);
    }
  }

  const merged = groups.map((group, groupIndex) => {
    const sourceIds = [...new Set(group.map((entry) => entry.trackId))];
    const representative = [...group].sort((left, right) => {
      const priority = (entry) => (
        (entry.trackId === 'basic-pitch' ? 0.26 : 0.14)
        + entry.normalizedConfidence * 0.12
      );
      return priority(right) - priority(left);
    })[0];
    const quality = clamp(
      0.42 + representative.normalizedConfidence * 0.28 + Math.min(3, sourceIds.length) * 0.1,
      0,
      1,
    );
    return {
      timeSeconds: representative.timeSeconds,
      confidence: representative.confidence,
      detectorSources: sourceIds,
      quality,
      groupIndex,
    };
  }).filter((candidate) => {
    const baseIndex = nearestEventIndex(baseEvents, candidate.timeSeconds);
    return Math.abs(baseEvents[baseIndex].timeSeconds - candidate.timeSeconds) >= minimumGapAt(candidate.timeSeconds);
  });

  const spaced = [];
  for (const candidate of [...merged].sort((left, right) => right.quality - left.quality)) {
    if (spaced.every((chosen) => (
      Math.abs(chosen.timeSeconds - candidate.timeSeconds)
      >= Math.max(minimumGapAt(chosen.timeSeconds), minimumGapAt(candidate.timeSeconds))
    ))) {
      spaced.push(candidate);
    }
  }
  spaced.sort((left, right) => left.timeSeconds - right.timeSeconds);

  let phraseIndex = -1;
  let phraseLength = 0;
  let previousTime = -Infinity;
  for (const candidate of spaced) {
    if (candidate.timeSeconds - previousTime > AUXILIARY_PHRASE_GAP_SECONDS || phraseLength >= 8) {
      phraseIndex += 1;
      phraseLength = 0;
    }
    candidate.phraseIndex = phraseIndex;
    candidate.phrasePosition = phraseLength;
    candidate.flow = flowAtTime(baseEvents, flowValues, candidate.timeSeconds);
    phraseLength += 1;
    previousTime = candidate.timeSeconds;
  }

  // Structural generation performs its own family-wide consensus pass below.
  // Keep the detector pool broad here: throwing candidates away before that
  // pass makes it impossible to recognise the same subdivision in two repeated
  // phrases.  These are still real detector timestamps and are never snapped.
  const ratios = { low: 1, mid: 1, high: 1, 'very-high': 1, climax: 1 };
  const selected = [];
  for (const band of Object.keys(ratios)) {
    const candidates = spaced.filter((candidate) => auxiliaryBand(candidate.flow) === band);
    const quota = Math.round(candidates.length * ratios[band]);
    const ranked = candidates.map((candidate, index) => {
      const globalIndex = spaced.indexOf(candidate);
      const previous = spaced[globalIndex - 1];
      const next = spaced[globalIndex + 1];
      const neighbourBoost = (
        (previous && candidate.timeSeconds - previous.timeSeconds <= 0.48 ? 0.5 : 0)
        + (next && next.timeSeconds - candidate.timeSeconds <= 0.48 ? 0.5 : 0)
      );
      const phraseScore = noise(seed, 'phrase', candidate.phraseIndex);
      return {
        ...candidate,
        selectionScore: phraseScore * 0.52
          + candidate.quality * 0.25
          + neighbourBoost * 0.18
          + noise(seed, 'candidate', band, index) * 0.05,
      };
    }).sort((left, right) => right.selectionScore - left.selectionScore);
    selected.push(...ranked.slice(0, quota));
  }
  const climaxCandidates = spaced.filter((candidate) => (
    Math.abs(candidate.timeSeconds - climaxTime) <= CLIMAX_RADIUS_SECONDS
  ));
  return [...new Map([...selected, ...climaxCandidates].map((candidate) => [candidate.groupIndex, candidate])).values()]
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
}

function samplePath(controls, length) {
  if (length <= 1) return [Math.round(controls[0])];
  return Array.from({ length }, (_, index) => {
    const position = index / (length - 1) * (controls.length - 1);
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(controls.length - 1, leftIndex + 1);
    const mix = position - leftIndex;
    return Math.round(controls[leftIndex] * (1 - mix) + controls[rightIndex] * mix);
  });
}

function kineticFallbackControls(kineticForm) {
  const motionKind = kineticForm?.motion?.kind ?? 'unknown';
  const verbs = new Set(Array.isArray(kineticForm?.verbs) ? kineticForm.verbs : []);
  if (motionKind === 'rising') return [0, 1, 2, 3, 4];
  if (motionKind === 'falling') return [4, 3, 2, 1, 0];
  if (motionKind === 'oscillating' || verbs.has('reverse')) return [1, 3, 1, 4, 2, 0, 2];
  if (verbs.has('bend')) return [2, 1, 3, 2];
  if (verbs.has('drift')) return [1, 2, 3];
  if (verbs.has('release') || verbs.has('rest')) return [2, 2, 1, 2];
  return [2];
}

function sampleContinuous(values, normalizedPosition, fallback = 0) {
  const finite = Array.isArray(values) ? values.filter(Number.isFinite) : [];
  if (!finite.length) return fallback;
  if (finite.length === 1) return Number(finite[0]);
  const position = clamp(normalizedPosition, 0, 1) * (finite.length - 1);
  const leftIndex = Math.floor(position);
  const rightIndex = Math.min(finite.length - 1, leftIndex + 1);
  const mix = position - leftIndex;
  return Number(finite[leftIndex]) * (1 - mix) + Number(finite[rightIndex]) * mix;
}

function kineticContribution(identity, normalizedPosition) {
  const kineticForm = identity?.kineticForm ?? {};
  const verbs = Array.isArray(kineticForm.verbs) ? kineticForm.verbs.map(String) : [];
  const verbSet = new Set(verbs);
  const controls = kineticFallbackControls(kineticForm);
  let desiredLane = sampleContinuous(controls, normalizedPosition, START_LANE);
  const development = String(kineticForm.development ?? 'free');
  const slope = Number(kineticForm.motion?.slope) || 0;
  if (development === 'directed') {
    desiredLane += clamp(slope / 24, -0.65, 0.65) * (normalizedPosition - 0.5);
  } else if (development === 'free') {
    desiredLane += Math.sin(normalizedPosition * Math.PI * 2) * 0.22;
  }
  const pressure = clamp(sampleContinuous(kineticForm.pressureContour, normalizedPosition, 0.5), 0, 1);
  let openness = 0;
  if (verbSet.has('open') || verbSet.has('fork')) openness += 0.45;
  if (verbSet.has('close') || verbSet.has('converge')) openness -= 0.35;
  if (verbSet.has('release') || verbSet.has('rest')) openness += 0.55;
  if (verbSet.has('strike')) openness -= 0.55;
  const attack = String(kineticForm.attack ?? 'flow');
  if (normalizedPosition <= 0.14) {
    if (attack === 'rest') openness += 0.8;
    if (attack === 'strike') openness -= 0.8;
  }
  return {
    identity,
    verbs,
    desiredLane: clamp(desiredLane, 0, LANE_COUNT - 1),
    pressure,
    openness,
    branchMode: String(kineticForm.branchMode ?? 'single-route'),
    attack,
    development,
    normalizedPosition,
  };
}

function compileKineticSpec(baseSpec, identityInputs, normalizedPosition, primaryIdentityId = null) {
  const inputGroups = new Map();
  for (const input of identityInputs) {
    const identity = input?.identity ?? input;
    if (!inputGroups.has(identity.id)) inputGroups.set(identity.id, { identity, positions: [] });
    inputGroups.get(identity.id).positions.push(Number.isFinite(input?.normalizedPosition)
      ? Number(input.normalizedPosition)
      : normalizedPosition);
  }
  const uniqueInputs = [...inputGroups.values()].map(({ identity, positions }) => ({
    identity,
    normalizedPosition: average(positions),
  })).sort((left, right) => String(left.identity.id).localeCompare(String(right.identity.id)));
  if (!uniqueInputs.length) return copySpec(baseSpec);
  const contributions = uniqueInputs.map(({ identity, normalizedPosition: contributionPosition }) => (
    kineticContribution(identity, contributionPosition)
  ));
  const rawContributions = identityInputs.map((input) => {
    const identity = input?.identity ?? input;
    return kineticContribution(
      identity,
      Number.isFinite(input?.normalizedPosition) ? Number(input.normalizedPosition) : normalizedPosition,
    );
  });
  const totalWeight = contributions.reduce((sum, contribution) => (
    sum + (contribution.identity.id === primaryIdentityId ? 2 : 1)
  ), 0);
  const weighted = (selector) => contributions.reduce((sum, contribution) => (
    sum + selector(contribution) * (contribution.identity.id === primaryIdentityId ? 2 : 1)
  ), 0) / totalWeight;
  let preferredLane = Math.round(weighted((contribution) => contribution.desiredLane));
  // Phrase boundaries remain neutral so the derived form can connect to the
  // neighbouring musical sentence without inventing an impossible teleport.
  if (normalizedPosition <= 0.001 || normalizedPosition >= 0.999) preferredLane = START_LANE;
  const pressure = clamp(weighted((contribution) => contribution.pressure), 0, 1);
  const openness = weighted((contribution) => contribution.openness);
  let safeWidth = pressure < 0.47 ? 4 : pressure < 0.55 ? 3 : 2;
  safeWidth = clamp(Math.round(safeWidth + openness), 2, LANE_COUNT);
  const forkConverge = contributions.some((contribution) => contribution.branchMode === 'fork-converge');
  const branchPhase = normalizedPosition >= 0.18 && normalizedPosition <= 0.72;
  const targetLanes = [preferredLane, ...(baseSpec.allowedLanes ?? [])];
  for (const lane of [...new Set(rawContributions.map((contribution) => Math.round(contribution.desiredLane)))]) {
    if (Math.abs(lane - preferredLane) > 1) targetLanes.push(lane);
  }
  if (forkConverge && branchPhase) {
    const provisionalSafeLanes = chooseSafeWindow(preferredLane, preferredLane, safeWidth);
    const alternative = [...provisionalSafeLanes]
      .filter((lane) => lane !== preferredLane)
      .sort((left, right) => Math.abs(left - preferredLane) - Math.abs(right - preferredLane))[0];
    if (Number.isInteger(alternative)) targetLanes.push(alternative);
  }
  const distinctTargetLanes = [...new Set(targetLanes)].sort((left, right) => left - right);
  safeWidth = Math.max(safeWidth, distinctTargetLanes.at(-1) - distinctTargetLanes[0] + 1);
  const minimumSafeStart = Math.max(0, distinctTargetLanes.at(-1) - safeWidth + 1);
  const maximumSafeStart = Math.min(distinctTargetLanes[0], LANE_COUNT - safeWidth);
  const safeStart = clamp(preferredLane - Math.floor(safeWidth / 2), minimumSafeStart, maximumSafeStart);
  const safeLanes = Array.from({ length: safeWidth }, (_, offset) => safeStart + offset);
  const obstacles = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
  for (const lane of distinctTargetLanes) obstacles[lane] = BREAKABLE;
  if (safeWidth < LANE_COUNT) addSpikesOutside(obstacles, safeLanes);
  widenIsolatedMiddleGaps(obstacles, preferredLane);
  const rowSignature = rowKey(obstacles);
  const resolvedSafeWidth = obstacles.filter((cell) => cell !== SPIKE).length;
  const compositionIdentityIds = contributions.map((contribution) => contribution.identity.id);
  const kineticProofs = contributions.map((contribution) => ({
    identityId: contribution.identity.id,
    compilerVersion: KINETIC_FORM_COMPILER_VERSION,
    compilerMode: 'off-seam-kinetic-composition',
    kineticFormVersion: contribution.identity.kineticForm?.version ?? null,
    verbs: contribution.verbs,
    motionKind: contribution.identity.kineticForm?.motion?.kind ?? 'unknown',
    motionSlope: Number(contribution.identity.kineticForm?.motion?.slope) || 0,
    desiredLane: Number(contribution.desiredLane.toFixed(4)),
    pressureContour: contribution.identity.kineticForm?.pressureContour ?? [],
    pressureSample: Number(contribution.pressure.toFixed(4)),
    desiredSafeWidth: clamp(Math.round(
      (contribution.pressure < 0.47 ? 4 : contribution.pressure < 0.55 ? 3 : 2)
      + contribution.openness,
    ), 2, LANE_COUNT),
    branchMode: contribution.branchMode,
    attack: contribution.attack,
    development: contribution.development,
    developmentPolicy: contribution.identity.developmentPolicy,
    normalizedPosition: Number(contribution.normalizedPosition.toFixed(5)),
    compositionIdentityIds,
    compiledPreferredLane: [...distinctTargetLanes].sort((left, right) => (
      Math.abs(left - contribution.desiredLane) - Math.abs(right - contribution.desiredLane)
    ))[0],
    resolvedPreferredLane: [...distinctTargetLanes].sort((left, right) => (
      Math.abs(left - contribution.desiredLane) - Math.abs(right - contribution.desiredLane)
    ))[0],
    compiledSafeWidth: resolvedSafeWidth,
    resolvedSafeWidth,
    resolvedRowSignature: rowSignature,
    evidenceIds: contribution.identity.evidenceIds ?? [],
  }));
  return copySpec(baseSpec, {
    obstacles,
    emit: true,
    kind: 'target',
    pattern: 'kinetic-form',
    role: forkConverge && branchPhase ? 'kinetic-fork' : 'kinetic-line',
    allowedLanes: distinctTargetLanes,
    preferredLane,
    pressure: Number(pressure.toFixed(3)),
    routeBranch: distinctTargetLanes.length > 1,
    directedIdentityIds: compositionIdentityIds,
    kineticProofs,
    kineticCompilerVersion: KINETIC_FORM_COMPILER_VERSION,
  });
}

function attachCanonicalTemplateProof(spec, identity, normalizedPosition) {
  if (!identity || spec.kind !== 'target') return copySpec(spec);
  const derivedSpec = copySpec(spec);
  const initialTargetLanes = lanesMatching(derivedSpec.obstacles, (cell) => cell === BREAKABLE);
  if (normalizedPosition <= 0.001 && initialTargetLanes.length) {
    if (identity.kineticForm?.attack === 'rest') {
      derivedSpec.obstacles = derivedSpec.obstacles.map((cell) => cell === SPIKE ? EMPTY : cell);
    } else if (identity.kineticForm?.attack === 'strike') {
      const anchorLane = initialTargetLanes.includes(derivedSpec.preferredLane)
        ? derivedSpec.preferredLane
        : initialTargetLanes[0];
      addSpikesOutside(derivedSpec.obstacles, chooseSafeWindow(anchorLane, anchorLane, 3));
      widenIsolatedMiddleGaps(derivedSpec.obstacles, anchorLane);
    }
  }
  const targetLanes = lanesMatching(derivedSpec.obstacles, (cell) => cell === BREAKABLE);
  if (!targetLanes.length) return copySpec(spec);
  const contribution = kineticContribution(identity, normalizedPosition);
  const preferredLane = targetLanes.includes(spec.preferredLane)
    ? spec.preferredLane
    : [...targetLanes].sort((left, right) => (
      Math.abs(left - contribution.desiredLane) - Math.abs(right - contribution.desiredLane)
    ))[0];
  const proof = {
    identityId: identity.id,
    compilerVersion: KINETIC_FORM_COMPILER_VERSION,
    compilerMode: 'canonical-template-compiled',
    kineticFormVersion: identity.kineticForm?.version ?? null,
    verbs: contribution.verbs,
    motionKind: identity.kineticForm?.motion?.kind ?? 'unknown',
    motionSlope: Number(identity.kineticForm?.motion?.slope) || 0,
    desiredLane: Number(contribution.desiredLane.toFixed(4)),
    pressureContour: identity.kineticForm?.pressureContour ?? [],
    pressureSample: Number(contribution.pressure.toFixed(4)),
    branchMode: contribution.branchMode,
    attack: contribution.attack,
    development: contribution.development,
    developmentPolicy: identity.developmentPolicy,
    normalizedPosition: Number(normalizedPosition.toFixed(5)),
    compositionIdentityIds: [identity.id],
    compiledPreferredLane: preferredLane,
    resolvedPreferredLane: preferredLane,
    compiledSafeWidth: derivedSpec.obstacles.filter((cell) => cell !== SPIKE).length,
    resolvedSafeWidth: derivedSpec.obstacles.filter((cell) => cell !== SPIKE).length,
    resolvedRowSignature: rowKey(derivedSpec.obstacles),
    evidenceIds: identity.evidenceIds ?? [],
    appliedDerivations: [
      'motif-palette-from-verbs-and-motion',
      'pressure-contour-bar-blend',
      'branch-mode-topology',
      'attack-profile',
      'development-policy-selection',
    ],
  };
  return copySpec(derivedSpec, {
    directedIdentityIds: [identity.id],
    kineticProofs: [proof],
    kineticCompilerVersion: KINETIC_FORM_COMPILER_VERSION,
  });
}

function melodicContourPath(prototype, indices, kineticForm, transformId) {
  const startSeconds = prototype.startSeconds
    ?? prototype.items[indices[0]]?.sourceEvent.timeSeconds;
  const endSeconds = prototype.endSeconds
    ?? prototype.items[indices.at(-1)]?.sourceEvent.timeSeconds;
  const pitchEvents = (melodyTrack?.events ?? []).filter((event) => (
    Number.isFinite(Number(event.midiPitch))
    && event.timeSeconds >= startSeconds - BEAT_SECONDS
    && event.timeSeconds <= endSeconds + BEAT_SECONDS
  ));
  let desired;
  if (pitchEvents.length >= 2) {
    const pitchValues = pitchEvents.map((event) => Number(event.midiPitch));
    const low = percentile(pitchValues, 0.08);
    const high = percentile(pitchValues, 0.92);
    const center = (low + high) / 2;
    const span = Math.max(3, high - low);
    desired = indices.map((slotIndex) => {
      const timeSeconds = prototype.items[slotIndex].sourceEvent.timeSeconds;
      const nearest = pitchEvents.reduce((best, event) => (
        Math.abs(event.timeSeconds - timeSeconds) < Math.abs(best.timeSeconds - timeSeconds) ? event : best
      ), pitchEvents[0]);
      const pitch = Math.abs(nearest.timeSeconds - timeSeconds) <= BEAT_SECONDS * 1.35
        ? Number(nearest.midiPitch)
        : center;
      return Math.round(clamp((pitch - low) / span, 0, 1) * (LANE_COUNT - 1));
    });
  } else {
    desired = samplePath(kineticFallbackControls(kineticForm), indices.length);
  }
  if (transformId === 'mirror') desired = desired.map((lane) => LANE_COUNT - 1 - lane);
  return desired;
}

function chooseSafeWindow(lane, nextLane, width) {
  const candidates = [];
  for (let start = 0; start <= LANE_COUNT - width; start += 1) {
    if (lane >= start && lane < start + width) candidates.push(start);
  }
  candidates.sort((left, right) => {
    const score = (start) => {
      const end = start + width - 1;
      const includesNext = nextLane >= start && nextLane <= end;
      const center = (start + end) / 2;
      return (includesNext ? 2 : 0) - Math.abs(center - (lane + Math.sign(nextLane - lane) * 0.3));
    };
    return score(right) - score(left);
  });
  const start = candidates[0];
  return Array.from({ length: width }, (_, offset) => start + offset);
}

function addSpikesOutside(row, safeLanes) {
  let count = 0;
  for (let lane = 0; lane < LANE_COUNT; lane += 1) {
    if (!safeLanes.includes(lane)) {
      row[lane] = SPIKE;
      count += 1;
    }
  }
  return count;
}

function widenIsolatedMiddleGaps(row, preferredLane) {
  let changed = true;
  while (changed) {
    changed = false;
    let runStart = null;
    for (let lane = 0; lane <= row.length; lane += 1) {
      const safe = lane < row.length && row[lane] !== SPIKE;
      if (safe && runStart === null) runStart = lane;
      if (!safe && runStart !== null) {
        const runEnd = lane - 1;
        if (runStart === runEnd && runStart > 0 && runEnd < LANE_COUNT - 1) {
          const neighbours = [runStart - 1, runEnd + 1]
            .filter((candidate) => row[candidate] === SPIKE)
            .sort((left, right) => Math.abs(left - preferredLane) - Math.abs(right - preferredLane));
          if (neighbours.length) {
            row[neighbours[0]] = EMPTY;
            changed = true;
            break;
          }
        }
        runStart = null;
      }
    }
  }
}

function buildObstacleRow(motifId, lane, nextLane, position, length, flow, cCampLane, waveRow) {
  const motif = MOTIFS[motifId];
  if (waveRow) {
    const row = [...waveRow];
    const allowedLanes = lanesMatching(row, (cell) => cell !== SPIKE);
    return {
      row,
      spikeCount: row.filter((cell) => cell === SPIKE).length,
      safeLaneCount: allowedLanes.length,
      kind: 'dodge',
      allowedLanes,
      preferredLane: null,
    };
  }
  const row = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
  let spikeCount = 0;
  let safeLaneCount = LANE_COUNT;

  if (motif.spikeMode === 'c') {
    const phase = length <= 1 ? 0 : position / (length - 1);
    const cap = phase < 0.18 || phase > 0.82;
    const spikeLanes = cCampLane === 4
      ? (cap ? [0, 1, 2] : [0, 1])
      : (cap ? [2, 3, 4] : [3, 4]);
    for (const spikeLane of spikeLanes) {
      if (spikeLane !== lane) {
        row[spikeLane] = SPIKE;
        spikeCount += 1;
      }
    }
    safeLaneCount = LANE_COUNT - spikeCount;
  } else if (motif.spikeMode !== 'none') {
    let width = flow < 0.47 ? 4 : flow < 0.55 ? 3 : 2;
    if (['hook', 'stairs', 'sweep'].includes(motifId) && position % 3 === 1 && flow < 0.56) width = 4;
    if (motif.spikeMode === 'pulse') {
      width = flow >= 0.55 ? 2 : flow >= 0.47 ? 3 : 4;
    }
    const safeLanes = chooseSafeWindow(lane, nextLane, width);
    spikeCount = addSpikesOutside(row, safeLanes);
    safeLaneCount = safeLanes.length;
  }

  row[lane] = BREAKABLE;
  widenIsolatedMiddleGaps(row, nextLane);
  spikeCount = row.filter((cell) => cell === SPIKE).length;
  safeLaneCount = LANE_COUNT - spikeCount;
  return { row, spikeCount, safeLaneCount, kind: 'target', allowedLanes: [lane], preferredLane: lane };
}

function lanesMatching(row, predicate) {
  return row.flatMap((cell, lane) => predicate(cell) ? [lane] : []);
}

function eventAllowedLanes(item) {
  const declared = Array.isArray(item._allowedLanes) ? item._allowedLanes : [];
  if (declared.length) return [...new Set(declared)];
  const targets = lanesMatching(item.obstacles ?? [], (cell) => cell === BREAKABLE);
  if (targets.length) return targets;
  return lanesMatching(item.obstacles ?? [], (cell) => cell !== SPIKE);
}

function solveLaneRoute(items, startLane = START_LANE, startTime = 0) {
  let states = new Map([[startLane, { cost: 0, path: [] }]]);
  let previousTime = startTime;
  let previousItem = null;
  for (const item of items) {
    const secondsPerLane = Math.min(
      FLOW_MODE.minTravelSecondsPerLane,
      Number(item.travelSecondsPerLane) || Number.POSITIVE_INFINITY,
      Number(previousItem?.travelSecondsPerLane) || Number.POSITIVE_INFINITY,
    );
    const maximumSteps = Math.min(
      LANE_COUNT - 1,
      Math.max(0, Math.floor((item.timeSeconds - previousTime + 1e-6) / secondsPerLane)),
    );
    const nextStates = new Map();
    for (const lane of eventAllowedLanes(item)) {
      for (const [priorLane, priorState] of states) {
        if (Math.abs(lane - priorLane) > maximumSteps) continue;
        // This path is only a reachability witness. Choice Rows intentionally
        // have no preferred target: every declared lane remains a real option
        // for the player, while the solver may use any one of them as proof.
        const cost = priorState.cost + Math.abs(lane - priorLane) * 0.08;
        if (!nextStates.has(lane) || cost < nextStates.get(lane).cost) {
          nextStates.set(lane, { cost, path: [...priorState.path, lane] });
        }
      }
    }
    if (!nextStates.size) return null;
    states = nextStates;
    previousTime = item.timeSeconds;
    previousItem = item;
  }
  return [...states.values()].sort((left, right) => left.cost - right.cost)[0].path;
}

function makeInternalEvent({
  timeSeconds,
  obstacles,
  strength,
  source,
  kind,
  pattern,
  flow,
  sectionIndex,
  role,
  allowedLanes,
  preferredLane,
}) {
  return {
    timeSeconds,
    obstacles,
    strength,
    source,
    kind,
    pattern,
    flow: Number(flow.toFixed(3)),
    _sectionIndex: sectionIndex,
    _role: role,
    _allowedLanes: allowedLanes,
    _preferredLane: preferredLane,
  };
}

function stripInternalFields(event) {
  const {
    _sectionIndex,
    _role,
    _allowedLanes,
    _preferredLane,
    _adaptiveLane,
    ...publicEvent
  } = event;
  return { ...publicEvent, role: _role, section: _sectionIndex };
}

function timeValue(value) {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return Number.NaN;
  return Number(value.timeSeconds ?? value.downbeatTimeSeconds ?? value.startSeconds ?? value.time);
}

function rowKey(row) {
  return row.join('');
}

function stableId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function normalizeMusicalStructure(sourceEvents) {
  const raw = analysis.musicalStructure ?? {};
  const rawBeats = Array.isArray(raw.beats) ? raw.beats : [];
  const beats = rawBeats.map((beat, index) => ({
    ...beat,
    index: Number.isInteger(beat?.index) ? beat.index : index,
    timeSeconds: timeValue(beat),
    isDownbeat: Boolean(beat?.isDownbeat),
  })).filter((beat) => Number.isFinite(beat.timeSeconds));

  let bars = (Array.isArray(raw.bars) ? raw.bars : []).map((bar, index) => ({
    ...bar,
    index: Number.isInteger(bar?.index) ? bar.index : index,
    startSeconds: Number(bar?.startSeconds ?? bar?.downbeatTimeSeconds),
    endSeconds: Number(bar?.endSeconds),
  })).filter((bar) => Number.isFinite(bar.startSeconds));

  if (!bars.length) {
    let downbeats = beats.filter((beat) => beat.isDownbeat).map((beat) => beat.timeSeconds);
    if (!downbeats.length && Array.isArray(raw.downbeats)) {
      downbeats = raw.downbeats.map(timeValue).filter(Number.isFinite);
    }
    if (!downbeats.length) {
      // Compatibility fallback only. These are every fourth detected Beat This
      // event, not an invented BPM grid and not evenly distributed timestamps.
      downbeats = sourceEvents.filter((_, index) => index % (raw.beatsPerBar ?? 4) === 0)
        .map((event) => event.timeSeconds);
    }
    bars = downbeats.map((startSeconds, index) => ({
      index,
      startSeconds,
      endSeconds: downbeats[index + 1] ?? Math.min(
        analysis.song.durationSeconds - OUTRO_MARGIN,
        sourceEvents[sourceEvents.length - 1]?.timeSeconds + 0.65,
      ),
      downbeatTimeSeconds: startSeconds,
      intensity: waveformEnergyAt(startSeconds, 1.8),
    }));
  } else {
    bars = bars.map((bar, index) => ({
      ...bar,
      endSeconds: Number.isFinite(bar.endSeconds)
        ? bar.endSeconds
        : (bars[index + 1]?.startSeconds ?? analysis.song.durationSeconds - OUTRO_MARGIN),
    }));
  }

  const barsPerPhrase = Number(raw.barsPerPhrase) || 8;
  let phrases = (Array.isArray(raw.phrases) ? raw.phrases : []).map((phrase, index) => {
    const startBarIndex = Number.isInteger(phrase?.startBarIndex)
      ? phrase.startBarIndex
      : Math.max(0, bars.findIndex((bar) => bar.startSeconds >= Number(phrase?.startSeconds) - 0.05));
    const declaredBarCount = Number(phrase?.barCount);
    const endBarIndex = Number.isInteger(phrase?.endBarIndex)
      ? phrase.endBarIndex
      : startBarIndex + (Number.isFinite(declaredBarCount) ? declaredBarCount : barsPerPhrase);
    const barCount = Number.isFinite(declaredBarCount)
      ? declaredBarCount
      : Math.max(1, endBarIndex - startBarIndex);
    return {
      ...phrase,
      index: Number.isInteger(phrase?.index) ? phrase.index : index,
      id: phrase?.id ?? `phrase-${String(index + 1).padStart(2, '0')}`,
      startBarIndex,
      endBarIndex,
      barCount,
      startSeconds: Number(phrase?.startSeconds ?? bars[startBarIndex]?.startSeconds),
      endSeconds: Number(
        phrase?.endSeconds
        ?? bars[Math.min(bars.length - 1, startBarIndex + barCount - 1)]?.endSeconds,
      ),
      familyId: phrase?.familyId ?? `family-${String(index + 1).padStart(2, '0')}`,
      familyKind: phrase?.familyKind ?? 'unique',
      intensity: Number(phrase?.intensity),
    };
  }).filter((phrase) => Number.isFinite(phrase.startSeconds) && Number.isFinite(phrase.endSeconds));

  if (!phrases.length) {
    phrases = [];
    for (let startBarIndex = 0; startBarIndex < bars.length; startBarIndex += barsPerPhrase) {
      const phraseBars = bars.slice(startBarIndex, startBarIndex + barsPerPhrase);
      if (!phraseBars.length) continue;
      const index = phrases.length;
      phrases.push({
        index,
        id: `fallback-phrase-${String(index + 1).padStart(2, '0')}`,
        startBarIndex,
        endBarIndex: startBarIndex + phraseBars.length,
        barCount: phraseBars.length,
        startSeconds: phraseBars[0].startSeconds,
        endSeconds: phraseBars[phraseBars.length - 1].endSeconds,
        familyId: `fallback-family-${String(index + 1).padStart(2, '0')}`,
        familyKind: 'fallback',
        intensity: average(phraseBars.map((bar) => Number(bar.intensity) || waveformEnergyAt(bar.startSeconds))),
      });
    }
  }

  const coveredBarCount = phrases.reduce((maximum, phrase) => Math.max(maximum, phrase.endBarIndex), 0);
  if (coveredBarCount < bars.length) {
    const tailBars = bars.slice(coveredBarCount);
    phrases.push({
      index: phrases.length,
      id: `tail-phrase-${String(phrases.length + 1).padStart(2, '0')}`,
      startBarIndex: coveredBarCount,
      endBarIndex: bars.length,
      barCount: tailBars.length,
      startSeconds: tailBars[0].startSeconds,
      endSeconds: tailBars[tailBars.length - 1].endSeconds,
      familyId: `tail-family-${String(phrases.length + 1).padStart(2, '0')}`,
      familyKind: 'tail',
      intensity: average(tailBars.map((bar) => Number(bar.intensity) || waveformEnergyAt(bar.startSeconds))),
    });
  }

  phrases.sort((left, right) => left.startSeconds - right.startSeconds);
  const phraseById = new Map(phrases.map((phrase) => [phrase.id, phrase]));
  const parent = new Map(phrases.map((phrase) => [phrase.id, phrase.id]));
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const union = (leftId, rightId) => {
    if (!parent.has(leftId) || !parent.has(rightId)) return;
    const leftRoot = find(leftId);
    const rightRoot = find(rightId);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const link of Array.isArray(raw.phraseLinks) ? raw.phraseLinks : []) {
    if (link?.relationship === 'same-family') union(link.sourcePhraseId, link.targetPhraseId);
  }
  for (const phrase of phrases) {
    const rootPhrase = phraseById.get(find(phrase.id));
    phrase.analysisFamilyId = phrase.familyId;
    if (rootPhrase && rootPhrase.id !== phrase.id) phrase.familyId = rootPhrase.familyId;
  }

  const overlappingPhrases = (Array.isArray(raw.overlappingPhrases) ? raw.overlappingPhrases : [])
    .map((phrase, index) => ({
      ...phrase,
      id: phrase?.id ?? `overlap-${index}`,
      familyId: phrase?.familyId ?? `overlap-family-${index}`,
      startSeconds: Number(phrase?.startSeconds ?? bars[phrase?.startBarIndex]?.startSeconds),
      endSeconds: Number(
        phrase?.endSeconds
        ?? bars[Math.max(0, (phrase?.endBarIndex ?? 1) - 1)]?.endSeconds,
      ),
    }))
    .filter((phrase) => Number.isFinite(phrase.startSeconds) && Number.isFinite(phrase.endSeconds));

  return {
    raw,
    beats,
    bars,
    phrases,
    overlappingPhrases,
    algorithm: raw.algorithm ?? 'beat-this-downbeat-fallback',
    timingPolicy: raw.timingPolicy ?? 'Detected event and downbeat timestamps are preserved exactly.',
    barsPerPhrase,
  };
}

function barAtTime(bars, timeSeconds) {
  let selected = bars[0];
  for (const bar of bars) {
    if (bar.startSeconds > timeSeconds + 1e-6) break;
    selected = bar;
    if (timeSeconds < bar.endSeconds - 1e-6) return bar;
  }
  return selected;
}

function buildPhraseContexts(structure, sourceEvents, flowValues) {
  const contexts = structure.phrases.map((phrase) => ({ ...phrase, items: [] }));
  for (let sourceIndex = 0; sourceIndex < sourceEvents.length; sourceIndex += 1) {
    const sourceEvent = sourceEvents[sourceIndex];
    let phrase = contexts.find((candidate, index) => (
      sourceEvent.timeSeconds >= candidate.startSeconds - 0.04
      && (
        index === contexts.length - 1
          ? sourceEvent.timeSeconds <= candidate.endSeconds + 0.04
          : sourceEvent.timeSeconds < candidate.endSeconds - 0.02
      )
    ));
    if (!phrase) {
      phrase = [...contexts].sort((left, right) => (
        Math.min(Math.abs(sourceEvent.timeSeconds - left.startSeconds), Math.abs(sourceEvent.timeSeconds - left.endSeconds))
        - Math.min(Math.abs(sourceEvent.timeSeconds - right.startSeconds), Math.abs(sourceEvent.timeSeconds - right.endSeconds))
      ))[0];
    }
    if (!phrase) continue;
    const bar = barAtTime(structure.bars, sourceEvent.timeSeconds);
    const barInPhrase = clamp((bar?.index ?? phrase.startBarIndex) - phrase.startBarIndex, 0, phrase.barCount - 1);
    const beatInBar = phrase.items.filter((item) => item.barInPhrase === barInPhrase).length;
    phrase.items.push({
      sourceEvent,
      sourceIndex,
      flow: flowValues[sourceIndex],
      barIndex: bar?.index ?? phrase.startBarIndex + barInPhrase,
      barInPhrase,
      beatInBar,
    });
  }
  return contexts.filter((phrase) => phrase.items.length).map((phrase) => ({
    ...phrase,
    intensity: Number.isFinite(phrase.intensity)
      ? clamp(phrase.intensity * 0.55 + average(phrase.items.map((item) => item.flow)) * 0.45, 0, 1)
      : average(phrase.items.map((item) => item.flow)),
    durationClass: `${phrase.barCount}bars-${phrase.items.length}slots`,
  }));
}

function countTrackEvents(track, startSeconds, endSeconds) {
  if (!track) return 0;
  return track.events.filter((event) => (
    event.timeSeconds >= startSeconds - 0.02 && event.timeSeconds < endSeconds - 0.02
  )).length;
}

function buildFamilyBarProfiles(phrases, barCount, bars) {
  const barByIndex = new Map(bars.map((bar) => [bar.index, bar]));
  return Array.from({ length: barCount }, (_, barInPhrase) => {
    const occurrences = phrases.flatMap((phrase) => {
      const items = phrase.items.filter((item) => item.barInPhrase === barInPhrase);
      if (!items.length) return [];
      const bar = barByIndex.get(items[0].barIndex);
      const startSeconds = bar?.startSeconds ?? items[0].sourceEvent.timeSeconds;
      const nextItems = phrase.items.filter((item) => item.barInPhrase > barInPhrase);
      const endSeconds = bar?.endSeconds
        ?? nextItems[0]?.sourceEvent.timeSeconds
        ?? phrase.endSeconds;
      const duration = Math.max(0.2, endSeconds - startSeconds);
      const midpoint = (startSeconds + endSeconds) / 2;
      return [{
        flow: average(items.map((item) => item.flow)),
        energy: waveformEnergyAt(midpoint, Math.min(1, duration / 2)),
        melodyRate: countTrackEvents(melodyTrack, startSeconds, endSeconds) / duration * 60,
        onsetRate: countTrackEvents(onsetTrack, startSeconds, endSeconds) / duration * 60,
        section: intentSectionAt(midpoint),
      }];
    });
    const flow = average(occurrences.map((sample) => sample.flow));
    const energy = average(occurrences.map((sample) => sample.energy));
    const melodyRate = average(occurrences.map((sample) => sample.melodyRate));
    const onsetRate = average(occurrences.map((sample) => sample.onsetRate));
    const melodyAccent = clamp(melodyRate / Math.max(12, melodyEventsPerMinute) / 1.7, 0, 1);
    const onsetAccent = clamp(onsetRate / Math.max(12, onsetEventsPerMinute) / 1.7, 0, 1);
    const styleAccent = (
      melodyAccent * SONG_STYLE.weights.melodic
      + onsetAccent * SONG_STYLE.weights.percussive
      + ((melodyAccent + onsetAccent) / 2) * SONG_STYLE.weights.rhythmic
    );
    const sections = occurrences.map((sample) => sample.section).filter(Boolean);
    const section = sections.sort((left, right) => right.pressure - left.pressure)[0] ?? null;
    const sectionPressure = average(sections.map((sample) => sample.pressure));
    return {
      flow: Number(flow.toFixed(3)),
      energy: Number(energy.toFixed(3)),
      melodyEventsPerMinute: Number(melodyRate.toFixed(2)),
      onsetEventsPerMinute: Number(onsetRate.toFixed(2)),
      sectionRole: section?.role ?? 'drive',
      sectionPressure: Number(sectionPressure.toFixed(3)),
      score: Number(clamp(flow * 0.48 + styleAccent * 0.27 + sectionPressure * 0.25, 0, 1).toFixed(3)),
    };
  });
}

function kineticMotifPalette(kineticForm, scene, moments, preferredMotifs) {
  const verbs = new Set(Array.isArray(kineticForm?.verbs) ? kineticForm.verbs : []);
  const motionKind = kineticForm?.motion?.kind ?? 'unknown';
  const momentTypes = new Set(moments.map((moment) => moment.type));
  let semantic = ['contour', 'contour', 'pulse', 'contour', 'contour'];
  if (verbs.has('rest') || verbs.has('release') || scene?.state === 'release') {
    semantic = ['focus', 'contour', 'pulse', 'contour', 'contour', 'contour'];
  } else if (verbs.has('strike') || momentTypes.has('impact') || momentTypes.has('rupture')) {
    semantic = ['contour', 'sweep', 'contour', 'zigzag', 'contour', 'contour'];
  } else if (motionKind === 'oscillating' || verbs.has('reverse') || verbs.has('bend')) {
    semantic = ['contour', 's', 'contour', 'hook', 'contour', 'contour'];
  } else if (motionKind === 'rising' || verbs.has('open') || verbs.has('fork')) {
    semantic = ['contour', 'stairs', 'contour', 'sweep', 'contour'];
  } else if (motionKind === 'falling' || verbs.has('close') || verbs.has('converge')) {
    semantic = ['contour', 'hook', 'contour', 'c', 'contour'];
  }
  const stylePreferences = preferredMotifs
    .filter((motif, index, values) => motif !== 'm' && motif !== 'wave' && MOTIFS[motif]
      && values.indexOf(motif) === index)
    .slice(0, 2);
  return [...semantic, ...stylePreferences];
}

function motifPlanFor({
  phrases,
  barCount,
  isIntro,
  familyId,
  bars,
  familyIntent,
  kineticForm,
  wavePlan,
}) {
  const profiles = buildFamilyBarProfiles(phrases, barCount, bars);
  const pressureContour = Array.isArray(kineticForm?.pressureContour)
    ? kineticForm.pressureContour.filter(Number.isFinite)
    : [];
  if (pressureContour.length) {
    for (let index = 0; index < profiles.length; index += 1) {
      const contourIndex = Math.round(index / Math.max(1, profiles.length - 1) * (pressureContour.length - 1));
      profiles[index].score = Number(clamp(
        profiles[index].score * 0.58 + pressureContour[contourIndex] * 0.42,
        0,
        1,
      ).toFixed(3));
    }
  }
  const motifs = Array.from({ length: barCount }, () => null);
  const averageSlotsPerBar = Math.max(1, phrases[0].items.length / Math.max(1, barCount));
  let barInPhrase = 0;
  let previousMotif = null;
  while (barInPhrase < barCount) {
    const profile = profiles[barInPhrase];
    if (isIntro && barInPhrase < Math.min(2, barCount)) {
      motifs[barInPhrase] = 'focus';
      previousMotif = 'focus';
      barInPhrase += 1;
      continue;
    }
    const representativePhrase = phrases[0];
    const bar = bars[representativePhrase.startBarIndex + barInPhrase];
    const startSeconds = bar?.startSeconds ?? representativePhrase.startSeconds;
    const endSeconds = bar?.endSeconds ?? representativePhrase.endSeconds;
    const scene = directedSceneAt((startSeconds + endSeconds) / 2);
    const moments = directedMomentsInRange(startSeconds, endSeconds);
    const palette = kineticMotifPalette(
      kineticForm,
      scene,
      moments,
      familyIntent?.motifBias ?? [],
    );
    let paletteIndex = hashText([
      AUDIO_SEED,
      familyId,
      kineticForm?.motion?.kind ?? familyIntent?.contour?.kind ?? 'unknown',
      kineticForm?.verbs?.join(',') ?? 'no-verbs',
      profile.sectionRole,
      scene?.state ?? 'no-scene',
      moments.map((moment) => moment.type).join(',') || 'no-moment',
      barInPhrase,
      Math.round(profile.score * 10),
    ].join('|')) % palette.length;
    if (palette[paletteIndex] === previousMotif) {
      paletteIndex = (paletteIndex + 1) % palette.length;
    }
    const motif = palette[paletteIndex];
    const requestedSlots = profile.score >= 0.55
      ? MOTIFS[motif].baseLength
      : MOTIFS[motif].minimumLength;
    const remainingBars = barCount - barInPhrase;
    const span = motif === 'focus'
      ? 1
      : clamp(Math.ceil(requestedSlots / averageSlotsPerBar), 1, Math.min(3, remainingBars));
    for (let offset = 0; offset < span; offset += 1) motifs[barInPhrase + offset] = motif;
    previousMotif = motif;
    barInPhrase += span;
  }
  if (wavePlan && barCount >= 2) {
    const starts = Array.from({ length: barCount - 1 }, (_, index) => index)
      .filter((start) => !isIntro || start >= 2)
      .sort((left, right) => {
        return profiles[right].score - profiles[left].score || left - right;
      });
    const waveStartBar = starts[0] ?? 0;
    motifs[waveStartBar] = 'wave';
    motifs[waveStartBar + 1] = 'wave';
    return { motifs, profiles, waveStartBar };
  }
  return { motifs, profiles, waveStartBar: null };
}

const BAR_ROLES = ['opening', 'call', 'answer', 'turn', 'lift', 'drive', 'peak', 'cadence'];

function templateMobility(group, auxiliaryCandidates, secondsPerLane = STRUCTURAL_TRAVEL_SECONDS_PER_LANE) {
  const slotCount = group[0].items.length;
  return Array.from({ length: slotCount }, (_, slot) => {
    if (slot === 0) return 0;
    return Math.min(...group.map((phrase) => Math.min(
      LANE_COUNT - 1,
      Math.max(0, (() => {
        const startSeconds = phrase.items[slot - 1].sourceEvent.timeSeconds;
        const endSeconds = phrase.items[slot].sourceEvent.timeSeconds;
        const subdivisions = auxiliaryCandidates
          .filter((candidate) => candidate.timeSeconds > startSeconds && candidate.timeSeconds < endSeconds)
          .map((candidate) => candidate.timeSeconds);
        const checkpoints = [startSeconds, ...subdivisions, endSeconds];
        return checkpoints.slice(1).reduce((capacity, checkpoint, index) => (
          capacity + Math.floor(
            (checkpoint - checkpoints[index] + 1e-6) / secondsPerLane,
          )
        ), 0);
      })()),
    )));
  });
}

function mobilityBetweenSlots(mobility, fromSlot, toSlot) {
  if (fromSlot < 0 || toSlot >= mobility.length) return LANE_COUNT - 1;
  return mobility.slice(fromSlot + 1, toSlot + 1).reduce((sum, value) => sum + value, 0);
}

function specAllowedLanes(spec) {
  if (Array.isArray(spec?.allowedLanes) && spec.allowedLanes.length) return [...new Set(spec.allowedLanes)];
  const targets = lanesMatching(spec?.obstacles ?? [], (cell) => cell === BREAKABLE);
  if (targets.length) return targets;
  return lanesMatching(spec?.obstacles ?? [], (cell) => cell !== SPIKE);
}

function neighbouringEmittedSlot(slots, slotIndex, direction) {
  for (let candidate = slotIndex + direction; candidate >= 0 && candidate < slots.length; candidate += direction) {
    if (slots[candidate]?.emit) return candidate;
  }
  return -1;
}

function viableChoiceLanes(slots, mobility, slotIndex) {
  const spec = slots[slotIndex];
  const safeLanes = lanesMatching(spec.obstacles, (cell) => cell !== SPIKE);
  const candidateLanes = spec.pattern === 'c'
    ? safeLanes
    : Array.from({ length: LANE_COUNT }, (_, lane) => lane);
  const previousSlot = neighbouringEmittedSlot(slots, slotIndex, -1);
  const nextSlot = neighbouringEmittedSlot(slots, slotIndex, 1);
  const previousLanes = previousSlot >= 0 ? specAllowedLanes(slots[previousSlot]) : [START_LANE];
  const nextLanes = nextSlot >= 0 ? specAllowedLanes(slots[nextSlot]) : [START_LANE];
  const previousCapacity = previousSlot >= 0
    ? mobilityBetweenSlots(mobility, previousSlot, slotIndex)
    : LANE_COUNT - 1;
  const nextCapacity = nextSlot >= 0
    ? mobilityBetweenSlots(mobility, slotIndex, nextSlot)
    : LANE_COUNT - 1;
  return candidateLanes.filter((lane) => (
    previousLanes.some((previousLane) => Math.abs(lane - previousLane) <= previousCapacity)
    && nextLanes.some((nextLane) => Math.abs(lane - nextLane) <= nextCapacity)
  ));
}

function chooseSpreadLanes(viableLanes, guideLane, count, key) {
  const selected = viableLanes.includes(guideLane) ? [guideLane] : [viableLanes[0]];
  while (selected.length < count) {
    const candidates = viableLanes.filter((lane) => !selected.includes(lane));
    if (!candidates.length) break;
    candidates.sort((left, right) => {
      const spread = (lane) => Math.min(...selected.map((selectedLane) => Math.abs(lane - selectedLane)));
      return spread(right) - spread(left)
        || noise(key, right, 'branch-lane') - noise(key, left, 'branch-lane');
    });
    selected.push(candidates[0]);
  }
  return selected.sort((left, right) => left - right);
}

function addChoiceBranches({
  slots,
  mobility,
  key,
  blockedSlots = new Set(),
  branchMode = 'single-route',
}) {
  const candidateGroups = [];
  let group = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const spec = slots[slotIndex];
    const viableLanes = spec?.emit
      && spec.kind === 'target'
      && spec.pattern !== 'm'
      && slotIndex > 0
      && slotIndex < slots.length - 1
      && !blockedSlots.has(slotIndex)
      ? viableChoiceLanes(slots, mobility, slotIndex)
      : [];
    const continues = group.length
      && group[group.length - 1].slotIndex === slotIndex - 1
      && slots[group[group.length - 1].slotIndex].blockId === spec?.blockId;
    if (viableLanes.length >= 2) {
      if (!continues && group.length) candidateGroups.push(group);
      if (!continues) group = [];
      group.push({ slotIndex, viableLanes });
    } else if (group.length) {
      candidateGroups.push(group);
      group = [];
    }
  }
  if (group.length) candidateGroups.push(group);

  let multiTargetChoiceRows = 0;
  let maximumConsecutiveRows = 0;
  for (const candidates of candidateGroups) {
    const pressure = average(candidates.map(({ slotIndex }) => slots[slotIndex].pressure ?? 0.5));
    const requestedLength = branchMode === 'fork-converge'
      ? pressure >= 0.78 ? 4 : pressure >= 0.52 ? 3 : 2
      : pressure >= 0.78 ? 2 : 1;
    const runLength = Math.min(requestedLength, candidates.length);
    const start = Math.floor(noise(key, slots[candidates[0].slotIndex].blockId, 'branch-run')
      * (candidates.length - runLength + 1));
    const run = candidates.slice(start, start + runLength);
    let realisedRun = 0;
    for (const { slotIndex, viableLanes } of run) {
      const spec = slots[slotIndex];
      const guideLane = specAllowedLanes(spec)[0] ?? START_LANE;
      const wantsThree = viableLanes.length >= 3;
      const choiceLanes = chooseSpreadLanes(
        viableLanes,
        guideLane,
        wantsThree ? 3 : 2,
        `${key}:${spec.relativeSlotKey}`,
      );
      if (choiceLanes.length < 2) continue;
      spec.obstacles = spec.obstacles.map((cell) => cell === BREAKABLE ? EMPTY : cell);
      for (const lane of choiceLanes) spec.obstacles[lane] = BREAKABLE;
      widenIsolatedMiddleGaps(spec.obstacles, guideLane);
      spec.allowedLanes = choiceLanes;
      spec.preferredLane = null;
      spec.role = spec.downbeatCue ? 'downbeat-choice' : 'branch-choice';
      spec.routeBranch = true;
      spec.choiceLaneCount = choiceLanes.length;
      multiTargetChoiceRows += 1;
      realisedRun += 1;
    }
    maximumConsecutiveRows = Math.max(maximumConsecutiveRows, realisedRun);
  }
  return { multiTargetChoiceRows, maximumConsecutiveRows };
}

function mGesturePhases(mirror) {
  const base = [
    { kind: 'dodge', row: [SPIKE, SPIKE, SPIKE, EMPTY, EMPTY], role: 'm-right-gate' },
    { kind: 'target', row: [BREAKABLE, EMPTY, EMPTY, EMPTY, EMPTY], role: 'm-left-strike' },
    { kind: 'dodge', row: [SPIKE, SPIKE, SPIKE, EMPTY, EMPTY], role: 'm-right-return-gate' },
    { kind: 'dodge', row: [SPIKE, SPIKE, SPIKE, EMPTY, EMPTY], role: 'm-right-ridge' },
    { kind: 'target', row: [BREAKABLE, EMPTY, EMPTY, EMPTY, EMPTY], role: 'm-second-left-strike' },
    { kind: 'dodge', row: [SPIKE, SPIKE, SPIKE, EMPTY, EMPTY], role: 'm-final-right-gate' },
  ];
  return base.map((phase) => {
    const row = mirror ? [...phase.row].reverse() : [...phase.row];
    return {
      ...phase,
      row,
      allowedLanes: phase.kind === 'target'
        ? lanesMatching(row, (cell) => cell === BREAKABLE)
        : lanesMatching(row, (cell) => cell !== SPIKE),
    };
  });
}

const M_GESTURE_SLOT_OFFSETS = [0, 2, 4, 5, 7, 9];

function travelCapacityAtRealTimes(slotTimeSets, fromSlot, toSlot) {
  if (fromSlot < 0 || slotTimeSets.some((slotTimes) => toSlot >= slotTimes.length)) return LANE_COUNT - 1;
  return Math.min(...slotTimeSets.map((slotTimes) => Math.min(
    LANE_COUNT - 1,
    Math.max(0, Math.floor(
      (slotTimes[toSlot] - slotTimes[fromSlot] + 1e-6) / FLOW_MODE.minTravelSecondsPerLane,
    )),
  )));
}

function reachableLanesAfter(fromLanes, toLanes, capacity) {
  return toLanes.filter((lane) => (
    fromLanes.some((priorLane) => Math.abs(lane - priorLane) <= capacity)
  ));
}

function fitMGesture({ slots, slotTimeSets, startSlot, mirror }) {
  const phases = mGesturePhases(mirror);
  const phaseSlots = M_GESTURE_SLOT_OFFSETS.map((offset) => startSlot + offset);
  const endSlot = phaseSlots.at(-1);
  if (endSlot >= slots.length || slotTimeSets.some((slotTimes) => slotTimes.length !== slots.length)) return null;
  if (slots.slice(startSlot, endSlot + 1).some((slot) => (
    ['full-width-sweep', 'wave'].includes(slot.pattern)
  ))) return null;
  const previousSlot = neighbouringEmittedSlot(slots, startSlot, -1);
  let reachableLanes = previousSlot >= 0 ? specAllowedLanes(slots[previousSlot]) : [START_LANE];
  let lastSlot = previousSlot;
  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
    reachableLanes = reachableLanesAfter(
      reachableLanes,
      phases[phaseIndex].allowedLanes,
      travelCapacityAtRealTimes(slotTimeSets, lastSlot, phaseSlots[phaseIndex]),
    );
    if (!reachableLanes.length) return null;
    lastSlot = phaseSlots[phaseIndex];
  }
  const exitSlot = neighbouringEmittedSlot(slots, endSlot, 1);
  if (exitSlot >= 0 && !reachableLanesAfter(
    reachableLanes,
    specAllowedLanes(slots[exitSlot]),
    travelCapacityAtRealTimes(slotTimeSets, endSlot, exitSlot),
  ).length) return null;

  return {
    phases,
    mirror,
    phaseSlots,
    startSlot,
    endSlot,
    span: endSlot - startSlot + 1,
    skippedSlotCount: M_GESTURE_SLOT_OFFSETS.at(-1) + 1 - phases.length,
    durationSeconds: Math.max(...slotTimeSets.map((slotTimes) => (
      slotTimes[endSlot] - slotTimes[startSlot]
    ))),
  };
}

function fitReachableBarPath(desired, indices, mobility, entryLane, forceStart, forceEnd) {
  let states = new Map([[entryLane, { cost: 0, path: [] }]]);
  for (let position = 0; position < indices.length; position += 1) {
    const slotIndex = indices[position];
    const maximumSteps = mobility[slotIndex];
    const requestsCenter = (forceStart && position === 0) || (forceEnd && position === indices.length - 1);
    const mustBeCenter = requestsCenter && [...states.keys()].some((priorLane) => (
      Math.abs(START_LANE - priorLane) <= maximumSteps
    ));
    const allowedLanes = mustBeCenter ? [START_LANE] : Array.from({ length: LANE_COUNT }, (_, lane) => lane);
    const nextStates = new Map();
    for (const lane of allowedLanes) {
      for (const [previousLane, state] of states) {
        if (Math.abs(lane - previousLane) > maximumSteps) continue;
        const cost = state.cost + (lane - desired[position]) ** 2;
        const existing = nextStates.get(lane);
        if (!existing || cost < existing.cost) {
          nextStates.set(lane, { cost, path: [...state.path, lane] });
        }
      }
    }
    if (!nextStates.size) {
      throw new Error(`No reachable bar path at slot ${slotIndex}; mobility=${maximumSteps}.`);
    }
    states = nextStates;
  }
  return [...states.values()].sort((left, right) => left.cost - right.cost)[0].path;
}

function applyFullWidthSweepPlan({
  slots,
  phrases,
  prototype,
  motifPlan,
  templateId,
  familyId,
  transformId,
  trackId,
  enabled = false,
  maximumGestures = 1,
}) {
  if (!enabled) {
    return {
      blockedSlots: new Set(),
      gestureCount: 0,
      edgeToEdgeTransitionCount: 0,
      gestures: [],
    };
  }
  const planningSlots = slots.map((spec, slotIndex) => {
    const item = prototype.items[slotIndex];
    const allowedLanes = specAllowedLanes(spec);
    return {
      baseLane: Number.isInteger(spec?.preferredLane)
        ? spec.preferredLane
        : (allowedLanes[0] ?? START_LANE),
      barInPhrase: item.barInPhrase,
      beatInBar: item.beatInBar,
      blocked: ['m', 'wave'].includes(spec?.pattern) || !spec?.emit,
      sectionRole: spec?.sectionRole
        ?? motifPlan.profiles[item.barInPhrase]?.sectionRole
        ?? 'drive',
      score: motifPlan.profiles[item.barInPhrase]?.score ?? spec?.pressure ?? 0,
      timeSecondsByOccurrence: phrases.map((phrase) => (
        phrase.items[slotIndex].sourceEvent.timeSeconds
      )),
    };
  });
  const plan = planFullWidthSweeps({
    slots: planningSlots,
    mobility: templateMobility(phrases, [], SWEEP_TRAVEL_SECONDS_PER_LANE),
    laneCount: LANE_COUNT,
    secondsPerBeat: BEAT_SECONDS,
    orientationSeed: transformId === 'mirror' ? 1 : 0,
    maximumGestures,
  });
  const gestureById = new Map(plan.gestures.map((gesture) => [gesture.id, gesture]));
  const blockedSlots = new Set();

  for (let slotIndex = 0; slotIndex < plan.slotPlans.length; slotIndex += 1) {
    const slotPlan = plan.slotPlans[slotIndex];
    if (!slotPlan) continue;
    blockedSlots.add(slotIndex);
    const item = prototype.items[slotIndex];
    const original = slots[slotIndex];
    const gesture = gestureById.get(slotPlan.gestureId);
    const isEdgeTarget = slotPlan.kind === 'edge-target';
    const gesturePressure = average(gesture.anchorSlots.map((slot) => planningSlots[slot].score));
    const sweepHazardMode = gesture.sectionRole === 'peak' || gesturePressure >= SWEEP_SPIKE_PRESSURE
      ? 'spiked'
      : 'clean';
    const obstacles = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
    if (isEdgeTarget) {
      if (sweepHazardMode === 'spiked') {
        addSpikesOutside(
          obstacles,
          slotPlan.lane === 0 ? [0, 1] : [LANE_COUNT - 2, LANE_COUNT - 1],
        );
      }
      obstacles[slotPlan.lane] = BREAKABLE;
    }
    slots[slotIndex] = {
      ...original,
      obstacles,
      emit: isEdgeTarget,
      kind: isEdgeTarget ? 'target' : 'travel',
      pattern: 'full-width-sweep',
      role: isEdgeTarget ? 'full-width-edge-hit' : 'full-width-silent-slot',
      barRole: isEdgeTarget ? 'edge-drum-hit' : 'silent-lateral-travel',
      downbeatCue: item.beatInBar === 0,
      allowedLanes: isEdgeTarget ? [slotPlan.lane] : Array.from({ length: LANE_COUNT }, (_, lane) => lane),
      preferredLane: isEdgeTarget ? slotPlan.lane : null,
      templateId,
      familyId,
      transformId,
      relativeSlotKey: `${templateId}:${slotPlan.gestureId}:slot-${slotIndex - gesture.startSlot}`,
      blockId: `${templateId}:${slotPlan.gestureId}`,
      routeBranch: false,
      choiceLaneCount: isEdgeTarget ? 1 : 0,
      sweepGestureId: slotPlan.gestureId,
      sweepPhase: slotPlan.kind,
      sweepAnchorIndex: slotPlan.anchorIndex,
      sweepHazardMode,
      travelSecondsPerLane: SWEEP_TRAVEL_SECONDS_PER_LANE,
      overridePriority: 0,
    };
  }

  return {
    blockedSlots,
    gestureCount: plan.gestures.length,
    edgeToEdgeTransitionCount: plan.gestures.reduce(
      (sum, gesture) => sum + gesture.edgeToEdgeTransitionCount,
      0,
    ),
    gestures: plan.gestures,
  };
}

function makeCanonicalTemplate({
  key,
  familyId,
  durationClass,
  phrases,
  trackId,
  mVariant,
  mStartBar,
  mMirrorPreference,
  mDesiredSectionRoles = [],
  bars,
  familyIntent,
  directedIdentity,
  wavePlan = null,
  fullWidthPlan = null,
  difficultyBoost = 0,
  auxiliaryCandidates = [],
}) {
  const prototype = phrases[0];
  const intensity = clamp(Math.max(...phrases.map((phrase) => phrase.intensity)) + difficultyBoost, 0, 1);
  const isIntro = phrases.some((phrase) => phrase.startBarIndex === 0);
  const templateId = `template-${stableId(trackId)}-${stableId(familyId)}-${stableId(durationClass)}`;
  const transformId = familyIntent?.preferredTransform
    ?? (noise(AUDIO_SEED, trackId, familyId, durationClass, 'transform') < 0.5 ? 'identity' : 'mirror');
  const isBeatAlignedTemplate = trackId === 'beat-this';
  const mobility = templateMobility(phrases, auxiliaryCandidates);
  const coreMobility = templateMobility(phrases, []);
  const slotTimeSets = phrases.map((phrase) => (
    phrase.items.map((item) => item.sourceEvent.timeSeconds)
  ));
  const motifPlan = motifPlanFor({
    phrases,
    barCount: prototype.barCount,
    isIntro,
    familyId,
    bars,
    familyIntent,
    kineticForm: directedIdentity?.kineticForm,
    wavePlan,
  });
  const plan = motifPlan.motifs;
  const slots = Array.from({ length: prototype.items.length }, () => null);
  let previousLane = START_LANE;

  let barInPhrase = 0;
  while (barInPhrase < prototype.barCount) {
    const moduleStartBar = barInPhrase;
    const motif = plan[moduleStartBar];
    let moduleEndBar = moduleStartBar + 1;
    while (moduleEndBar < prototype.barCount && plan[moduleEndBar] === motif) moduleEndBar += 1;
    const indices = prototype.items
      .map((item, slotIndex) => ({ item, slotIndex }))
      .filter(({ item }) => item.barInPhrase >= moduleStartBar && item.barInPhrase < moduleEndBar)
      .map(({ slotIndex }) => slotIndex);
    if (!indices.length) {
      barInPhrase = moduleEndBar;
      continue;
    }
    const modulePressure = clamp(
      average(motifPlan.profiles.slice(moduleStartBar, moduleEndBar).map((profile) => profile.score))
      + difficultyBoost,
      0,
      1,
    );
    let waveMirror = wavePlan?.mirror ?? (transformId === 'mirror');
    let waveRows = null;
    if (motif === 'wave') {
      const orientations = [false, true].map((mirror) => {
        const rows = buildWaveRows({ length: indices.length, mirror });
        const entryLanes = lanesMatching(rows[0], (cell) => cell !== SPIKE);
        return {
          mirror,
          rows,
          entryDistance: Math.min(...entryLanes.map((lane) => Math.abs(lane - previousLane))),
        };
      }).sort((left, right) => (
        left.entryDistance - right.entryDistance
        || Number(left.mirror !== waveMirror) - Number(right.mirror !== waveMirror)
      ));
      waveMirror = orientations[0].mirror;
      waveRows = orientations[0].rows;
    }
    const rawControls = motif === 'c' ? [2, 3, 4, 4, 3, 2] : MOTIFS[motif].controls;
    const controls = transformId === 'mirror'
      ? rawControls.map((lane) => LANE_COUNT - 1 - lane)
      : rawControls;
    const desired = waveRows
      ? waveRows.map((row) => {
        const safeLanes = lanesMatching(row, (cell) => cell !== SPIKE);
        return waveMirror ? safeLanes.at(-1) : safeLanes[0];
      })
      : motif === 'contour'
        ? melodicContourPath(prototype, indices, directedIdentity?.kineticForm, transformId)
        : samplePath(controls, indices.length);
    const forceStart = isBeatAlignedTemplate && moduleStartBar === 0;
    const forceEnd = isBeatAlignedTemplate && moduleEndBar === prototype.barCount;
    if (forceStart) {
      desired[0] = START_LANE;
    }
    if (forceEnd) {
      desired[desired.length - 1] = START_LANE;
    }
    const lanes = isBeatAlignedTemplate
      ? fitReachableBarPath(desired, indices, mobility, previousLane, forceStart, forceEnd)
      : desired.map((lane, position) => {
        const slotIndex = indices[position];
        const fitted = clamp(lane, previousLane - mobility[slotIndex], previousLane + mobility[slotIndex]);
        previousLane = fitted;
        return fitted;
      });
    previousLane = lanes[lanes.length - 1];
    const cCampLane = transformId === 'mirror' ? 0 : 4;
    for (let position = 0; position < indices.length; position += 1) {
      const slotIndex = indices[position];
      const item = prototype.items[slotIndex];
      const lane = lanes[position];
      const nextLane = lanes[position + 1] ?? lane;
      const rowResult = buildObstacleRow(
        motif,
        lane,
        nextLane,
        position,
        indices.length,
        modulePressure,
        cCampLane,
        waveRows?.[position],
      );
      slots[slotIndex] = {
        obstacles: rowResult.row,
        emit: true,
        kind: rowResult.kind,
        pattern: motif,
        role: motif === 'wave' ? 'wave-gate' : item.beatInBar === 0 ? 'downbeat-cue' : 'beat-target',
        barRole: BAR_ROLES[item.barInPhrase % BAR_ROLES.length],
        downbeatCue: item.beatInBar === 0,
        allowedLanes: rowResult.allowedLanes,
        preferredLane: rowResult.preferredLane,
        templateId,
        familyId,
        transformId: motif === 'wave' ? (waveMirror ? 'mirror' : 'identity') : transformId,
        relativeSlotKey: `${templateId}:bar-${item.barInPhrase}:slot-${item.beatInBar}`,
        blockId: `${templateId}:bars-${moduleStartBar}-${moduleEndBar - 1}`,
        sectionRole: motifPlan.profiles[item.barInPhrase]?.sectionRole ?? familyIntent?.dominantSectionRole ?? 'drive',
        pressure: modulePressure,
        overridePriority: 0,
      };
    }
    barInPhrase = moduleEndBar;
  }

  const fullWidthSweepPlan = applyFullWidthSweepPlan({
    slots,
    phrases,
    prototype,
    motifPlan,
    templateId,
    familyId,
    transformId,
    trackId,
    enabled: Boolean(fullWidthPlan),
    maximumGestures: fullWidthPlan?.maximumGestures ?? 1,
  });

  let appliedMStartBar = null;
  let appliedMGesture = null;
  if (mVariant && Number.isInteger(mStartBar)) {
    const placementCandidates = Array.from({ length: prototype.barCount }, (_, candidateBar) => candidateBar)
      .sort((left, right) => Math.abs(left - mStartBar) - Math.abs(right - mStartBar))
      .flatMap((candidateBar) => {
        const startSlot = prototype.items.findIndex((item) => item.barInPhrase === candidateBar);
        if (startSlot < 0) return [];
        const orientations = [false, true]
          .map((mirror) => fitMGesture({ slots, slotTimeSets, startSlot, mirror }))
          .filter(Boolean)
          .map((gesture) => {
            const sectionRoles = [...new Set(gesture.phaseSlots.map((slotIndex) => (
              motifPlan.profiles[prototype.items[slotIndex].barInPhrase]?.sectionRole
                ?? familyIntent?.dominantSectionRole
                ?? 'drive'
            )))];
            return {
              ...gesture,
              candidateBar,
              sectionRoles,
              rolePenalty: mDesiredSectionRoles.length
                && !sectionRoles.some((role) => mDesiredSectionRoles.includes(role)) ? 1 : 0,
            };
          });
        const preferredMirror = mMirrorPreference
          ?? (noise(AUDIO_SEED, trackId, familyId, candidateBar, 'm-orientation') >= 0.5);
        return orientations.sort((left, right) => (
          left.span - right.span
          || Number(left.mirror !== (transformId === 'mirror' ? true : preferredMirror))
            - Number(right.mirror !== (transformId === 'mirror' ? true : preferredMirror))
        ));
      });
    const desiredMirror = mMirrorPreference ?? (transformId === 'mirror');
    const placement = chooseMGesturePlacement(placementCandidates, desiredMirror, mStartBar);
    if (placement) {
      const {
        startSlot,
        endSlot,
        candidateBar,
        mirror: mirrorM,
        phases,
        phaseSlots,
      } = placement;
      appliedMStartBar = candidateBar;
      appliedMGesture = {
        rows: phases.map((phase) => rowKey(phase.row)),
        slotOffsets: phaseSlots.map((slotIndex) => slotIndex - startSlot),
        skippedSlotCount: placement.skippedSlotCount,
        durationSeconds: Number(placement.durationSeconds.toFixed(3)),
      };
      const phaseBySlot = new Map(phaseSlots.map((slotIndex, phaseIndex) => [slotIndex, {
        ...phases[phaseIndex],
        phaseIndex,
      }]));
      for (let slotIndex = startSlot; slotIndex <= endSlot; slotIndex += 1) {
        const phase = phaseBySlot.get(slotIndex) ?? null;
        const isTarget = phase?.kind === 'target';
        const isDodge = phase?.kind === 'dodge';
        const mBarOffset = prototype.items[slotIndex].barInPhrase - candidateBar;
        slots[slotIndex] = {
          obstacles: phase ? [...phase.row] : [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
          emit: Boolean(phase),
          kind: isTarget ? 'target' : isDodge ? 'dodge' : 'travel',
          pattern: 'm',
          role: phase?.role ?? 'm-travel-slot',
          barRole: mBarOffset === 0 ? 'm-gesture-entry' : 'm-gesture-stroke',
          downbeatCue: prototype.items[slotIndex].beatInBar === 0,
          allowedLanes: phase?.allowedLanes ?? Array.from({ length: LANE_COUNT }, (_, lane) => lane),
          preferredLane: isTarget ? phase.allowedLanes[0] : null,
          templateId,
          familyId,
          transformId: mirrorM ? 'mirror' : 'identity',
          relativeSlotKey: `${templateId}:m-${phase?.phaseIndex ?? `travel-${slotIndex - startSlot}`}`,
          blockId: `${templateId}:m-${startSlot}`,
          sectionRole: motifPlan.profiles[prototype.items[slotIndex].barInPhrase]?.sectionRole
            ?? familyIntent?.dominantSectionRole
            ?? 'peak',
          pressure: intensity,
          variant: mVariant,
          overridePriority: 0,
        };
      }
    }
  }

  const auxiliarySensitiveSlots = new Set();
  if (auxiliaryCandidates.length) {
    for (let slotIndex = 0; slotIndex < prototype.items.length; slotIndex += 1) {
      const hasNearbyAuxiliary = phrases.some((phrase) => {
        const timeSeconds = phrase.items[slotIndex].sourceEvent.timeSeconds;
        return auxiliaryCandidates.some((candidate) => (
          Math.abs(candidate.timeSeconds - timeSeconds) < FLOW_MODE.minTravelSecondsPerLane * 1.55
        ));
      });
      if (hasNearbyAuxiliary) auxiliarySensitiveSlots.add(slotIndex);
    }
  }
  for (const slotIndex of fullWidthSweepPlan.blockedSlots) auxiliarySensitiveSlots.add(slotIndex);
  const preBranchSlots = slots.map((slot) => copySpec(slot));
  let choiceBranchSummary = addChoiceBranches({
    slots,
    mobility,
    key: `${AUDIO_SEED}:${trackId}:${familyId}:${durationClass}`,
    blockedSlots: auxiliarySensitiveSlots,
    branchMode: directedIdentity?.kineticForm?.branchMode ?? 'single-route',
  });
  const branchesRemainReachable = phrases.every((phrase) => {
    const pseudoEvents = slots.flatMap((spec, slotIndex) => spec.emit ? [{
      timeSeconds: phrase.items[slotIndex].sourceEvent.timeSeconds,
      obstacles: spec.obstacles,
      kind: spec.kind,
      _allowedLanes: spec.allowedLanes,
      _preferredLane: spec.preferredLane,
      travelSecondsPerLane: spec.travelSecondsPerLane,
    }] : []);
    return Boolean(solveLaneRoute(pseudoEvents, START_LANE, phrase.startSeconds - BEAT_SECONDS));
  });
  if (!branchesRemainReachable) {
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      slots[slotIndex] = preBranchSlots[slotIndex];
    }
    choiceBranchSummary = {
      multiTargetChoiceRows: 0,
      maximumConsecutiveRows: 0,
      fallbackReason: 'branch-candidates-were-not-reachable-at-measured-times',
    };
  }

  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    if (slots[slotIndex]) continue;
    slots[slotIndex] = {
      obstacles: [EMPTY, EMPTY, BREAKABLE, EMPTY, EMPTY],
      emit: true,
      kind: 'target',
      pattern: 'focus',
      role: 'beat-target',
      barRole: 'continuation',
      downbeatCue: false,
      allowedLanes: [START_LANE],
      preferredLane: START_LANE,
      templateId,
      familyId,
      transformId,
      relativeSlotKey: `${templateId}:slot-${slotIndex}`,
      blockId: `${templateId}:remainder`,
      sectionRole: familyIntent?.dominantSectionRole ?? 'drive',
      pressure: intensity,
      overridePriority: 0,
    };
  }

  return {
    key,
    id: templateId,
    familyId,
    durationClass,
    prototypePhraseId: prototype.id,
    occurrencePhraseIds: phrases.map((phrase) => phrase.id),
    occurrenceCount: phrases.length,
    transformId,
    familyIntent: familyIntent ? {
      dominantSectionRole: familyIntent.dominantSectionRole,
      sectionRoles: familyIntent.sectionRoles,
      contour: familyIntent.contour,
      motifBias: familyIntent.motifBias,
      transformReason: familyIntent.transformReason,
    } : null,
    directedIdentityId: directedIdentity?.id ?? null,
    kineticForm: directedIdentity?.kineticForm ?? null,
    intensity: Number(intensity.toFixed(3)),
    motifPlan: plan,
    barProfiles: motifPlan.profiles,
    mVariant,
    mStartBar: appliedMStartBar,
    mMirrored: slots.some((slot) => slot.pattern === 'm' && slot.transformId === 'mirror'),
    mGesture: appliedMGesture,
    fullWidthSweepPlan: {
      gestureCount: fullWidthSweepPlan.gestureCount,
      edgeToEdgeTransitionCount: fullWidthSweepPlan.edgeToEdgeTransitionCount,
      gestures: fullWidthSweepPlan.gestures,
    },
    choiceBranchSummary,
    slots,
  };
}

function copySpec(spec, overrides = {}) {
  return {
    ...spec,
    obstacles: [...spec.obstacles],
    allowedLanes: [...spec.allowedLanes],
    ...(Array.isArray(spec.directedIdentityIds) ? {
      directedIdentityIds: [...spec.directedIdentityIds],
    } : {}),
    ...(Array.isArray(spec.kineticProofs) ? {
      kineticProofs: spec.kineticProofs.map((proof) => ({
        ...proof,
        verbs: [...(proof.verbs ?? [])],
        pressureContour: [...(proof.pressureContour ?? [])],
        compositionIdentityIds: [...(proof.compositionIdentityIds ?? [])],
        evidenceIds: [...(proof.evidenceIds ?? [])],
      })),
    } : {}),
    ...overrides,
  };
}

function collectRangeTemplateEntries(startSeconds, endSeconds, phraseContexts, occurrenceTemplates) {
  return phraseContexts.flatMap((phrase) => (
    phrase.items.flatMap((item, slotIndex) => (
      item.sourceEvent.timeSeconds >= startSeconds
      && item.sourceEvent.timeSeconds < endSeconds
        ? [{ phrase, item, slotIndex, spec: occurrenceTemplates.get(phrase.id)[slotIndex] }]
        : []
    ))
  ));
}

function applyRangeReuse({
  id,
  sourceStartSeconds,
  sourceEndSeconds,
  targetStartSeconds,
  targetEndSeconds,
  priority,
  similarity,
}, phraseContexts, occurrenceTemplates, { allowTargetGestureReplacement = false } = {}) {
  const source = collectRangeTemplateEntries(
    sourceStartSeconds,
    sourceEndSeconds,
    phraseContexts,
    occurrenceTemplates,
  );
  const target = collectRangeTemplateEntries(
    targetStartSeconds,
    targetEndSeconds,
    phraseContexts,
    occurrenceTemplates,
  );
  if (!source.length || source.length !== target.length) return null;
  // Timing-fitted gestures own a real-time entry/exit contract. Copying one
  // through a shifted recurrence window can detach it from the timestamps it
  // was validated against, so only the surrounding musical core is reusable.
  const sourceHasTimedGesture = source.some((entry) => (
    ['m', 'full-width-sweep', 'wave'].includes(entry.spec.pattern)
  ));
  const targetHasTimedGesture = target.some((entry) => (
    ['m', 'full-width-sweep', 'wave'].includes(entry.spec.pattern)
  ));
  if (sourceHasTimedGesture || (targetHasTimedGesture && !allowTargetGestureReplacement)) return null;
  for (let index = 0; index < target.length; index += 1) {
    const sourceSpec = source[index].spec;
    occurrenceTemplates.get(target[index].phrase.id)[target[index].slotIndex] = copySpec(sourceSpec, {
      reusedFrom: `${source[index].phrase.id}:${sourceSpec.relativeSlotKey}`,
      reuseLinkId: id,
      overridePriority: priority,
    });
  }
  return {
    id,
    sourceStartSeconds,
    sourceEndSeconds,
    targetStartSeconds,
    targetEndSeconds,
    copiedSlotCount: source.length,
    similarity: Number(similarity),
    exact: true,
  };
}

function applyStructuralReuse(structure, phraseContexts, occurrenceTemplates, templateGroups) {
  const applied = [];
  const overlapGroups = new Map();
  for (const phrase of structure.overlappingPhrases) {
    const exactEnough = (
      ['repeated', 'exact-repeat', 'exact'].includes(phrase.familyKind)
      && Number(phrase.similarityToPrototype) >= 0.88
      && (phrase.relationship === undefined || ['same-family', 'exact'].includes(phrase.relationship))
    );
    if (!exactEnough) continue;
    if (!overlapGroups.has(phrase.familyId)) overlapGroups.set(phrase.familyId, []);
    overlapGroups.get(phrase.familyId).push(phrase);
  }
  for (const [familyId, occurrences] of overlapGroups) {
    if (occurrences.length < 2) continue;
    const [prototype, ...repeats] = [...occurrences].sort((left, right) => left.startSeconds - right.startSeconds);
    for (const repeat of repeats) {
      const result = applyRangeReuse({
        id: `analysis-overlap-${familyId}-${repeat.id}`,
        sourceStartSeconds: prototype.startSeconds,
        sourceEndSeconds: prototype.endSeconds,
        targetStartSeconds: repeat.startSeconds,
        targetEndSeconds: repeat.endSeconds,
        priority: 1,
        similarity: repeat.similarityToPrototype,
      }, phraseContexts, occurrenceTemplates);
      if (result) applied.push(result);
    }
  }
  // A phrase family owns exactly one canonical template. If an overlapping
  // phrase promoted a stronger slot into one occurrence, promote the same slot
  // to every occurrence of that family rather than silently breaking identity.
  for (const group of templateGroups.values()) {
    if (group.phrases.length < 2) continue;
    const arrays = group.phrases.map((phrase) => occurrenceTemplates.get(phrase.id));
    for (let slotIndex = 0; slotIndex < arrays[0].length; slotIndex += 1) {
      const strongest = arrays.map((slots) => slots[slotIndex])
        .sort((left, right) => (right.overridePriority ?? 0) - (left.overridePriority ?? 0))[0];
      for (const slots of arrays) slots[slotIndex] = copySpec(strongest);
    }
  }
  return applied;
}

function makeAuxiliaryRow(lane, intensity, key, layer) {
  const row = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
  row[lane] = BREAKABLE;
  const threshold = layer === 'overlay' ? 0.5 : 0.52;
  if (intensity >= threshold && noise(key, 'aux-spikes') < clamp((intensity - threshold) * 2.6 + 0.48, 0, 0.94)) {
    addSpikesOutside(row, chooseSafeWindow(lane, lane, intensity >= 0.86 ? 2 : 3));
    widenIsolatedMiddleGaps(row, lane);
  }
  return row;
}

function phraseAtTime(phrases, timeSeconds) {
  return phrases.find((phrase, index) => (
    timeSeconds >= phrase.startSeconds - 0.03
    && (index === phrases.length - 1 || timeSeconds < phrase.endSeconds - 0.02)
  ));
}

function previousCoreEvent(events, event) {
  const eventIndex = events.indexOf(event);
  for (let index = eventIndex - 1; index >= 0; index -= 1) {
    if (events[index].layer === 'core') return events[index];
  }
  return null;
}

function directedShiftCandidates(events, event, fallbackLane) {
  const previous = previousCoreEvent(events, event);
  const previousLanes = previous ? eventAllowedLanes(previous) : [START_LANE];
  const previousTime = previous?.timeSeconds ?? 0;
  const secondsPerLane = Math.min(
    FLOW_MODE.minTravelSecondsPerLane,
    Number(event.travelSecondsPerLane) || Number.POSITIVE_INFINITY,
    Number(previous?.travelSecondsPerLane) || Number.POSITIVE_INFINITY,
  );
  const maximumSteps = Math.min(
    LANE_COUNT - 1,
    Math.max(0, Math.floor((event.timeSeconds - previousTime + 1e-6) / secondsPerLane)),
  );
  return Array.from({ length: LANE_COUNT }, (_, lane) => lane)
    .filter((lane) => (
      !previousLanes.includes(lane)
      && previousLanes.some((previousLane) => Math.abs(lane - previousLane) <= maximumSteps)
    ))
    .sort((left, right) => {
      const leftDistance = Math.min(...previousLanes.map((lane) => Math.abs(left - lane)));
      const rightDistance = Math.min(...previousLanes.map((lane) => Math.abs(right - lane)));
      return leftDistance - rightDistance
        || Math.abs(left - fallbackLane) - Math.abs(right - fallbackLane)
        || left - right;
    });
}

function applyDirectedMomentEmphasis(events) {
  const realizations = [];
  const candidates = events.filter((event) => event.layer === 'core');
  if (!candidates.length) return realizations;
  for (const moment of DIRECTED_MOMENTS.filter((candidate) => (
    ['must', 'should'].includes(candidate.commitment)
  )).sort((left, right) => left.timeSeconds - right.timeSeconds)) {
    const nearest = candidates.reduce((best, event) => (
      Math.abs(event.timeSeconds - moment.timeSeconds) < Math.abs(best.timeSeconds - moment.timeSeconds)
        ? event
        : best
    ), candidates[0]);
    if (!nearest) continue;
    const timeOffsetSeconds = Math.abs(nearest.timeSeconds - moment.timeSeconds);
    if (timeOffsetSeconds > Math.max(BEAT_SECONDS * 1.5, 0.45)) continue;
    const echoes = nearest.templateId && nearest.relativeSlotKey
      ? events.filter((event) => (
        event.layer === 'core'
        && event.templateId === nearest.templateId
        && event.relativeSlotKey === nearest.relativeSlotKey
      ))
      : [nearest];
    const snapshots = echoes.map((event) => ({
      event,
      obstacles: [...event.obstacles],
      kind: event.kind,
      allowedLanes: [...eventAllowedLanes(event)],
      preferredLane: event._preferredLane,
      role: event._role,
      choiceLaneCount: event.choiceLaneCount,
      routeBranch: event.routeBranch,
    }));
    const namedGesture = ['m', 'wave', 'full-width-sweep'].includes(nearest.pattern)
      && !moment.requiredChannels.includes('movement');
    let layoutAction = namedGesture ? `named-${nearest.pattern}` : `directed-${moment.type}`;
    if (!namedGesture) {
      for (const event of echoes) {
        const currentSafeLanes = lanesMatching(event.obstacles, (cell) => cell !== SPIKE);
        const declared = eventAllowedLanes(event);
        const fallbackLane = Number.isInteger(event._preferredLane)
          ? event._preferredLane
          : declared.reduce((best, lane) => (
            Math.abs(lane - START_LANE) < Math.abs(best - START_LANE) ? lane : best
          ), declared[0] ?? START_LANE);
        let shiftCandidates = directedShiftCandidates(events, event, fallbackLane);
        if (moment.requiredChannels.includes('movement') && !shiftCandidates.length) {
          const prior = previousCoreEvent(events, event);
          if (prior && prior.kind === 'target') {
            if (!snapshots.some((snapshot) => snapshot.event === prior)) {
              snapshots.push({
                event: prior,
                obstacles: [...prior.obstacles],
                kind: prior.kind,
                allowedLanes: [...eventAllowedLanes(prior)],
                preferredLane: prior._preferredLane,
                role: prior._role,
                choiceLaneCount: prior.choiceLaneCount,
                routeBranch: prior.routeBranch,
              });
            }
            const priorLane = Number.isInteger(prior._preferredLane)
              ? prior._preferredLane
              : eventAllowedLanes(prior).sort((left, right) => (
                Math.abs(left - fallbackLane) - Math.abs(right - fallbackLane)
              ))[0];
            prior.obstacles = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
            prior.obstacles[priorLane] = BREAKABLE;
            prior._allowedLanes = [priorLane];
            prior._preferredLane = priorLane;
            prior.choiceLaneCount = 1;
            prior.routeBranch = false;
            prior.directedMovementPreparation = moment.id;
            shiftCandidates = directedShiftCandidates(events, event, fallbackLane);
          }
        }
        const guideLane = moment.requiredChannels.includes('movement') && shiftCandidates.length
          ? shiftCandidates[0]
          : fallbackLane;
        let row = [...event.obstacles];
        let allowedLanes = declared.length ? declared : [guideLane];
        if (moment.type === 'impact') {
          const choiceCount = 3;
          const choicePool = moment.requiredChannels.includes('movement') && shiftCandidates.length
            ? shiftCandidates
            : currentSafeLanes;
          allowedLanes = chooseSpreadLanes(
            choicePool,
            guideLane,
            Math.min(choiceCount, choicePool.length),
            `${AUDIO_SEED}:${moment.id}:${event.relativeSlotKey}:emphasis`,
          );
          row = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
          for (const lane of allowedLanes) row[lane] = BREAKABLE;
        } else if (['arrival', 'rupture'].includes(moment.type)) {
          const preferredWidths = moment.type === 'arrival' ? [4, 3, 2] : [2, 3, 4];
          const originalRowKey = rowKey(event.obstacles);
          const eventIndex = events.indexOf(event);
          const previousRowKey = eventIndex > 0 ? rowKey(events[eventIndex - 1].obstacles) : null;
          const previous = previousCoreEvent(events, event);
          const previousHazardCount = previous?.obstacles.filter((cell) => cell === SPIKE).length ?? 0;
          const candidates = preferredWidths.map((width) => {
            const candidateRow = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
            addSpikesOutside(candidateRow, chooseSafeWindow(guideLane, guideLane, width));
            candidateRow[guideLane] = BREAKABLE;
            return candidateRow;
          });
          row = candidates.find((candidateRow) => (
            rowKey(candidateRow) !== originalRowKey
            && rowKey(candidateRow) !== previousRowKey
            && (
              !moment.requiredChannels.includes('density')
              || candidateRow.filter((cell) => cell === SPIKE).length !== previousHazardCount
            )
          ))
            ?? candidates.find((candidateRow) => (
              rowKey(candidateRow) !== previousRowKey
              && (
                !moment.requiredChannels.includes('density')
                || candidateRow.filter((cell) => cell === SPIKE).length !== previousHazardCount
              )
            ))
            ?? candidates[0];
          allowedLanes = [guideLane];
        } else if (['release', 'breath'].includes(moment.type)) {
          row = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
          row[guideLane] = BREAKABLE;
          allowedLanes = [guideLane];
        }
        event.obstacles = row;
        event.kind = 'target';
        event._allowedLanes = allowedLanes;
        event._preferredLane = allowedLanes.length === 1 ? allowedLanes[0] : null;
        event._role = `directed-${moment.type}`;
        event.choiceLaneCount = allowedLanes.length;
        event.routeBranch = allowedLanes.length > 1;
      }
      if (String(nearest.templateId).startsWith('kinetic-exact-') && echoes.length > 1) {
        const canonicalRow = [...nearest.obstacles];
        const canonicalAllowedLanes = [...eventAllowedLanes(nearest)];
        for (const echo of echoes) {
          echo.obstacles = [...canonicalRow];
          echo.kind = nearest.kind;
          echo._allowedLanes = [...canonicalAllowedLanes];
          echo._preferredLane = canonicalAllowedLanes.length === 1 ? canonicalAllowedLanes[0] : null;
          echo._role = nearest._role;
          echo.choiceLaneCount = canonicalAllowedLanes.length;
          echo.routeBranch = canonicalAllowedLanes.length > 1;
        }
      }
      let emphasizedRoute = solveLaneRoute(events);
      if (!emphasizedRoute) {
        const prior = previousCoreEvent(events, nearest);
        const priorLanes = prior ? eventAllowedLanes(prior) : [START_LANE];
        const candidateLanes = Array.from({ length: LANE_COUNT }, (_, lane) => lane)
          .filter((lane) => (
            !moment.requiredChannels.includes('movement') || !priorLanes.includes(lane)
          ));
        const candidateWidths = moment.type === 'arrival' ? [4, 3, 2] : [2, 3, 4];
        searchExactCue:
        for (const lane of candidateLanes) {
          for (const width of candidateWidths) {
            const row = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
            addSpikesOutside(row, chooseSafeWindow(lane, lane, width));
            row[lane] = BREAKABLE;
            const hazardCount = row.filter((cell) => cell === SPIKE).length;
            if (moment.requiredChannels.includes('threat') && (
              !hazardCount || (prior && rowKey(row) === rowKey(prior.obstacles))
            )) continue;
            if (moment.requiredChannels.includes('density') && prior
              && hazardCount === prior.obstacles.filter((cell) => cell === SPIKE).length) continue;
            for (const echo of echoes) {
              echo.obstacles = [...row];
              echo.kind = 'target';
              echo._allowedLanes = [lane];
              echo._preferredLane = lane;
              echo._role = `directed-${moment.type}`;
              echo.choiceLaneCount = 1;
              echo.routeBranch = false;
            }
            emphasizedRoute = solveLaneRoute(events);
            if (emphasizedRoute) {
              layoutAction = `${layoutAction}-exact-canonical-fit`;
              break searchExactCue;
            }
          }
        }
      }
      if (!emphasizedRoute) {
        const clearanceSeconds = Math.max(0.16, FLOW_MODE.minTravelSecondsPerLane);
        const removableAuxiliary = events.filter((candidate) => (
          candidate.layer !== 'core'
          && echoes.some((echo) => Math.abs(candidate.timeSeconds - echo.timeSeconds) <= clearanceSeconds)
        ));
        const removableSet = new Set(removableAuxiliary);
        const routeWithBreath = removableAuxiliary.length
          ? solveLaneRoute(events.filter((candidate) => !removableSet.has(candidate)))
          : null;
        if (routeWithBreath) {
          for (let index = events.length - 1; index >= 0; index -= 1) {
            if (removableSet.has(events[index])) events.splice(index, 1);
          }
          layoutAction = `${layoutAction}-with-breath`;
        } else {
          for (const snapshot of snapshots) {
            snapshot.event.obstacles = snapshot.obstacles;
            snapshot.event.kind = snapshot.kind;
            snapshot.event._allowedLanes = snapshot.allowedLanes;
            snapshot.event._preferredLane = snapshot.preferredLane;
            snapshot.event._role = snapshot.role;
            snapshot.event.choiceLaneCount = snapshot.choiceLaneCount;
            snapshot.event.routeBranch = snapshot.routeBranch;
          }
          layoutAction = 'route-safe-cue-only';
        }
      }
    }
    nearest.directedMomentIds = [...new Set([...(nearest.directedMomentIds ?? []), moment.id])];
    nearest.directorMomentType = moment.type;
    nearest.directorCommitment = moment.commitment;
    nearest.directorAnchorId = moment.anchorId;
    nearest.directorLayoutAction = layoutAction;
    nearest.directorStrength = Number(moment.strength);
    realizations.push({
      momentId: moment.id,
      anchorId: moment.anchorId,
      eventTimeSeconds: Number(nearest.timeSeconds.toFixed(5)),
      eventOffsetSeconds: Number(timeOffsetSeconds.toFixed(5)),
      relativeSlotKey: nearest.relativeSlotKey ?? null,
      pattern: nearest.pattern,
      layoutAction,
      echoedOccurrenceCount: echoes.length,
    });
  }
  return realizations;
}

function previousCoreIndex(events, eventIndex) {
  for (let index = eventIndex - 1; index >= 0; index -= 1) {
    if (events[index].layer === 'core') return index;
  }
  return -1;
}

function namedGestureEventIndices(events, eventIndex) {
  const event = events[eventIndex];
  if (!event || !['m', 'wave', 'full-width-sweep'].includes(event.pattern)) return [];
  const coreIndices = events.flatMap((candidate, index) => candidate.layer === 'core' ? [index] : []);
  const corePosition = coreIndices.indexOf(eventIndex);
  if (corePosition < 0) return [];
  let start = corePosition;
  let end = corePosition + 1;
  const belongs = (index) => {
    const candidate = events[coreIndices[index]];
    return candidate?.phraseId === event.phraseId
      && candidate?.pattern === event.pattern
      && Math.abs(candidate.timeSeconds - event.timeSeconds) <= BEAT_SECONDS * 12;
  };
  while (start > 0 && belongs(start - 1)) start -= 1;
  while (end < coreIndices.length && belongs(end)) end += 1;
  return coreIndices.slice(start, end);
}

function buildSpatialChannelReceipts(events, eventIndex, layout) {
  if (eventIndex < 0 || layout.layoutAction === 'route-safe-cue-only') {
    return { movement: null, density: null, threat: null };
  }
  const event = events[eventIndex];
  const priorIndex = previousCoreIndex(events, eventIndex);
  const prior = priorIndex >= 0 ? events[priorIndex] : null;
  const fromLanes = prior ? eventAllowedLanes(prior) : [START_LANE];
  const toLanes = eventAllowedLanes(event);
  const minimumShiftLanes = Math.min(...fromLanes.flatMap((fromLane) => (
    toLanes.map((toLane) => Math.abs(toLane - fromLane))
  )));
  const gestureEventIndices = namedGestureEventIndices(events, eventIndex);
  const gestureMoves = gestureEventIndices.length >= 2
    && new Set(gestureEventIndices.map((index) => rowKey(events[index].obstacles))).size > 1;
  const beforeHazardCount = prior?.obstacles.filter((cell) => cell === SPIKE).length ?? null;
  const afterHazardCount = event.obstacles.filter((cell) => cell === SPIKE).length;
  const shared = {
    eventIndex,
    timeSeconds: layout.eventTimeSeconds,
    action: layout.layoutAction,
  };
  return {
    movement: gestureMoves ? {
      ...shared,
      mode: 'named-gesture',
      gestureEventIndices,
    } : minimumShiftLanes > 0 ? {
      ...shared,
      mode: 'forced-shift',
      previousEventIndex: priorIndex,
      fromLanes,
      toLanes,
      minimumShiftLanes,
    } : null,
    density: prior && beforeHazardCount !== afterHazardCount ? {
      ...shared,
      previousEventIndex: priorIndex,
      beforeHazardCount,
      afterHazardCount,
      hazardDelta: afterHazardCount - beforeHazardCount,
    } : null,
    threat: prior
      && afterHazardCount > 0
      && rowKey(prior.obstacles) !== rowKey(event.obstacles)
      ? {
        ...shared,
        previousEventIndex: priorIndex,
        previousObstacleRow: rowKey(prior.obstacles),
        obstacleRow: rowKey(event.obstacles),
      }
      : null,
  };
}

function buildRealizationReceipt(events, layoutRealizations) {
  for (const event of events) {
    if (!Array.isArray(event.kineticProofs)) continue;
    for (const proof of event.kineticProofs) {
      const compiledPreferredLane = Number(proof.compiledPreferredLane ?? proof.resolvedPreferredLane);
      const finalTargetLanes = lanesMatching(event.obstacles, (cell) => cell === BREAKABLE);
      const refinedPreferredLane = finalTargetLanes.includes(compiledPreferredLane)
        ? compiledPreferredLane
        : [...finalTargetLanes].sort((left, right) => (
          Math.abs(left - compiledPreferredLane) - Math.abs(right - compiledPreferredLane)
        ))[0];
      proof.refinements = [];
      if (Number.isInteger(refinedPreferredLane) && refinedPreferredLane !== compiledPreferredLane) {
        proof.refinements.push({
          kind: 'bounded-route-refinement',
          fromLane: compiledPreferredLane,
          toLane: refinedPreferredLane,
          distance: Math.abs(refinedPreferredLane - compiledPreferredLane),
        });
      }
      proof.resolvedPreferredLane = refinedPreferredLane;
      proof.resolvedSafeWidth = event.obstacles.filter((cell) => cell !== SPIKE).length;
      proof.finalRowSignature = rowKey(event.obstacles);
      proof.postCompileAdjusted = proof.resolvedRowSignature !== proof.finalRowSignature;
    }
  }
  const layoutByMomentId = new Map(layoutRealizations.map((realization) => [realization.momentId, realization]));
  const cues = DIRECTED_MOMENTS.map((moment) => {
    const layout = layoutByMomentId.get(moment.id) ?? null;
    const eventIndex = layout
      ? events.findIndex((event) => (
        Array.isArray(event.directedMomentIds) && event.directedMomentIds.includes(moment.id)
      ))
      : -1;
    const spatialReceipts = layout
      ? buildSpatialChannelReceipts(events, eventIndex, layout)
      : { movement: null, density: null, threat: null };
    const color = COLOR_SCHEME_EVENTS.find((event) => event.anchorId === moment.anchorId) ?? null;
    const accent = VISUAL_ACCENT_EVENTS.find((event) => event.anchorId === moment.anchorId) ?? null;
    const channelReceipts = {
      movement: spatialReceipts.movement ? {
        ...spatialReceipts.movement,
        pattern: layout.pattern,
      } : null,
      density: spatialReceipts.density,
      threat: spatialReceipts.threat,
      color: color ? {
        timeSeconds: color.timeSeconds,
        colorSchemeId: color.colorSchemeId,
        source: color.source,
      } : null,
      'visual-accent': accent ? {
        timeSeconds: accent.timeSeconds,
        id: accent.id,
        kind: accent.kind,
      } : null,
    };
    const requiredChannels = Array.isArray(moment.requiredChannels) ? moment.requiredChannels : [];
    const missingChannels = requiredChannels.filter((channel) => !channelReceipts[channel]);
    return {
      momentId: moment.id,
      anchorId: moment.anchorId,
      sceneId: moment.sceneId,
      type: moment.type,
      commitment: moment.commitment,
      cueTimeSeconds: moment.timeSeconds,
      requiredChannels,
      missingChannels,
      status: missingChannels.length ? 'partial' : 'realized',
      channels: Object.fromEntries(requiredChannels.map((channel) => [channel, channelReceipts[channel] ?? null])),
      evidenceIds: moment.evidenceIds,
    };
  });
  const obligated = cues.filter((cue) => cue.commitment === 'must');
  const realizedObligations = obligated.filter((cue) => cue.status === 'realized').length;
  const phraseIdentities = DIRECTED_IDENTITIES.map((identity) => {
    const validProofForIdentity = (event) => {
      if (!Array.isArray(event.directedIdentityIds) || !event.directedIdentityIds.includes(identity.id)) return null;
      const proof = event.kineticProofs?.find((candidate) => candidate.identityId === identity.id) ?? null;
      if (!proof) return null;
      const kineticForm = identity.kineticForm ?? {};
      const preferredLaneStillPlayable = event.obstacles[proof.resolvedPreferredLane] === BREAKABLE;
      const preferredLaneRefinementIsBounded = Math.abs(
        Number(proof.resolvedPreferredLane) - Number(proof.compiledPreferredLane),
      ) <= 2;
      const safeWidthStillRepresentative = Math.abs(
        Number(proof.resolvedSafeWidth) - Number(proof.compiledSafeWidth),
      ) <= 1;
      const contributionStillObservable = proof.compilerMode !== 'off-seam-kinetic-composition' || (
        Math.abs(Number(proof.resolvedPreferredLane) - Number(proof.desiredLane)) <= 2
        && Math.abs(Number(proof.resolvedSafeWidth) - Number(proof.desiredSafeWidth)) <= 1
      );
      return proof.compilerVersion === KINETIC_FORM_COMPILER_VERSION
        && proof.kineticFormVersion === (kineticForm.version ?? null)
        && JSON.stringify(proof.verbs) === JSON.stringify(kineticForm.verbs ?? [])
        && proof.motionKind === (kineticForm.motion?.kind ?? 'unknown')
        && Number(proof.motionSlope) === (Number(kineticForm.motion?.slope) || 0)
        && JSON.stringify(proof.pressureContour) === JSON.stringify(kineticForm.pressureContour ?? [])
        && proof.branchMode === (kineticForm.branchMode ?? 'single-route')
        && proof.attack === (kineticForm.attack ?? 'flow')
        && proof.development === (kineticForm.development ?? 'free')
        && proof.developmentPolicy === identity.developmentPolicy
        && JSON.stringify(proof.evidenceIds) === JSON.stringify(identity.evidenceIds ?? [])
        && proof.finalRowSignature === rowKey(event.obstacles)
        && preferredLaneStillPlayable
        && preferredLaneRefinementIsBounded
        && safeWidthStillRepresentative
        && contributionStillObservable
        ? proof
        : null;
    };
    const occurrences = (identity.occurrences ?? []).map((occurrence) => {
      const eventIndices = events.flatMap((event, index) => (
        event.layer === 'core'
        && event.timeSeconds >= Number(occurrence.startSeconds)
        && event.timeSeconds < Number(occurrence.endSeconds)
          ? [index]
          : []
      ));
      const consumedEventIndices = eventIndices.filter((index) => Boolean(validProofForIdentity(events[index])));
      const eligibleEventIndices = eventIndices.filter((index) => events[index].kind === 'target');
      return {
        occurrenceId: occurrence.id,
        startSeconds: occurrence.startSeconds,
        endSeconds: occurrence.endSeconds,
        eventIndices,
        eligibleEventIndices,
        rowSignature: eventIndices.map((index) => (
          `${events[index].kind}:${rowKey(events[index].obstacles)}`
        )),
        routeBranchSignature: eventIndices.map((index) => events[index].routeBranch === true),
        consumedEventIndices,
        kineticProof: {
          compilerVersion: KINETIC_FORM_COMPILER_VERSION,
          kineticFormVersion: identity.kineticForm?.version ?? null,
          evidenceIds: identity.evidenceIds ?? [],
          consumedRowSignatures: consumedEventIndices.map((index) => rowKey(events[index].obstacles)),
          consumedTargetCoverage: eligibleEventIndices.length
            ? Number((consumedEventIndices.length / eligibleEventIndices.length).toFixed(3))
            : null,
          hasKineticConsumption: consumedEventIndices.length > 0,
        },
      };
    });
    const hasRows = occurrences.length > 0 && occurrences.every((occurrence) => occurrence.eventIndices.length > 0);
    const consumesKineticForm = occurrences.length > 0 && occurrences.every((occurrence) => (
      occurrence.kineticProof.hasKineticConsumption
    ));
    const preservesBranchTopology = identity.kineticForm?.branchMode !== 'fork-converge'
      || occurrences.every((occurrence) => {
        const rows = occurrence.consumedEventIndices.map((index) => events[index]);
        const firstForkIndex = rows.findIndex((event) => (
          event.routeBranch === true
          && event.kind === 'target'
          && event.obstacles.filter((cell) => cell === BREAKABLE).length >= 2
        ));
        return firstForkIndex >= 0 && rows.slice(firstForkIndex + 1).some((event) => (
          event.kind === 'target'
          && event.routeBranch !== true
          && event.obstacles.filter((cell) => cell === BREAKABLE).length === 1
        ));
      });
    const preservesExactForm = identity.relation !== 'exact' || (
      occurrences.length >= 2
      && occurrences.slice(1).every((occurrence) => (
        JSON.stringify(occurrence.rowSignature) === JSON.stringify(occurrences[0].rowSignature)
        && JSON.stringify(occurrence.routeBranchSignature) === JSON.stringify(occurrences[0].routeBranchSignature)
      ))
    );
    const status = hasRows && consumesKineticForm && preservesBranchTopology && preservesExactForm
      ? 'realized'
      : 'partial';
    return {
      identityId: identity.id,
      relation: identity.relation,
      developmentPolicy: identity.developmentPolicy,
      kineticFormVersion: identity.kineticForm?.version ?? null,
      kineticVerbs: identity.kineticForm?.verbs ?? [],
      branchMode: identity.kineticForm?.branchMode ?? null,
      status,
      missingContracts: [
        ...(!hasRows ? ['occurrence-rows'] : []),
        ...(!consumesKineticForm ? ['kinetic-form-compiled'] : []),
        ...(!preservesBranchTopology ? ['branch-topology'] : []),
        ...(!preservesExactForm ? ['canonical-form-or-topology'] : []),
      ],
      occurrences,
      evidenceIds: identity.evidenceIds,
    };
  });
  const exactIdentityContracts = phraseIdentities.filter((identity) => identity.relation === 'exact');
  return {
    algorithm: 'directed-song-score-compiler-receipt-v3',
    kineticCompilerVersion: KINETIC_FORM_COMPILER_VERSION,
    audioFingerprint: SONG_DIRECTION.audioFingerprint,
    cueCount: cues.length,
    mustCueCount: obligated.length,
    realizedMustCueCount: realizedObligations,
    mustCueCoverage: obligated.length
      ? Number((realizedObligations / obligated.length).toFixed(3))
      : null,
    cues,
    phraseIdentityCount: phraseIdentities.length,
    realizedPhraseIdentityCount: phraseIdentities.filter((identity) => identity.status === 'realized').length,
    exactPhraseIdentityCount: exactIdentityContracts.length,
    realizedExactPhraseIdentityCount: exactIdentityContracts.filter((identity) => identity.status === 'realized').length,
    exactPhraseIdentityCoverage: exactIdentityContracts.length
      ? Number((exactIdentityContracts.filter((identity) => identity.status === 'realized').length
        / exactIdentityContracts.length).toFixed(3))
      : null,
    phraseIdentities,
  };
}

function identityInputsAtTime(timeSeconds) {
  return DIRECTED_IDENTITIES.flatMap((identity) => (
    (identity.occurrences ?? []).flatMap((occurrence) => {
      const startSeconds = Number(occurrence.startSeconds);
      const endSeconds = Number(occurrence.endSeconds);
      return timeSeconds >= startSeconds && timeSeconds < endSeconds
        ? [{
          identity,
          occurrence,
          normalizedPosition: clamp(
            (timeSeconds - startSeconds) / Math.max(1e-6, endSeconds - startSeconds),
            0,
            1,
          ),
        }]
        : [];
    })
  ));
}

function compileDirectedPhraseIdentities(phraseContexts, occurrenceTemplates) {
  const applied = [];
  const exactIdentities = DIRECTED_IDENTITIES.filter((identity) => (
    identity.relation === 'exact'
    && identity.developmentPolicy === 'preserve-canonical-kinetic-form'
    && Array.isArray(identity.occurrences)
    && identity.occurrences.length >= 2
  ));
  const exactOccurrencesById = new Map();
  const exactEntryByKey = new Map();
  const exactMembershipsByKey = new Map();
  const exactParent = new Map();
  const findExactRoot = (key) => {
    const parent = exactParent.get(key) ?? key;
    if (parent === key) return key;
    const rootKey = findExactRoot(parent);
    exactParent.set(key, rootKey);
    return rootKey;
  };
  const unionExactKeys = (leftKey, rightKey) => {
    const leftRoot = findExactRoot(leftKey);
    const rightRoot = findExactRoot(rightKey);
    if (leftRoot === rightRoot) return;
    const [parentKey, childKey] = [leftRoot, rightRoot].sort();
    exactParent.set(childKey, parentKey);
  };
  for (const identity of exactIdentities) {
    const occurrences = identity.occurrences.map((occurrence) => ({
      occurrence,
      entries: collectRangeTemplateEntries(
        Number(occurrence.startSeconds),
        Number(occurrence.endSeconds),
        phraseContexts,
        occurrenceTemplates,
      ),
    }));
    const slotCounts = new Set(occurrences.map(({ entries }) => entries.length));
    if (slotCounts.size !== 1 || occurrences.some(({ entries }) => entries.length === 0)) {
      throw new Error(
        `Exact Phrase Identity ${identity.id} cannot compile one canonical Kinetic Form: `
        + `occurrence slot counts are ${occurrences.map(({ entries }) => entries.length).join(', ')}.`,
      );
    }
    for (const { occurrence, entries } of occurrences) {
      for (let slotIndex = 0; slotIndex < entries.length; slotIndex += 1) {
        const entry = entries[slotIndex];
        const key = `${entry.phrase.id}:${entry.slotIndex}`;
        exactParent.set(key, exactParent.get(key) ?? key);
        exactEntryByKey.set(key, entry);
        if (!exactMembershipsByKey.has(key)) exactMembershipsByKey.set(key, []);
        exactMembershipsByKey.get(key).push({
          identity,
          occurrence,
          normalizedPosition: clamp(
            (entry.item.sourceEvent.timeSeconds - Number(occurrence.startSeconds))
              / Math.max(1e-6, Number(occurrence.endSeconds) - Number(occurrence.startSeconds)),
            0,
            1,
          ),
        });
      }
    }
    for (let slotIndex = 0; slotIndex < occurrences[0].entries.length; slotIndex += 1) {
      const keys = occurrences.map(({ entries }) => `${entries[slotIndex].phrase.id}:${entries[slotIndex].slotIndex}`);
      for (const key of keys.slice(1)) unionExactKeys(keys[0], key);
    }
    exactOccurrencesById.set(identity.id, occurrences);
  }
  const exactComponents = new Map();
  for (const key of exactEntryByKey.keys()) {
    const rootKey = findExactRoot(key);
    if (!exactComponents.has(rootKey)) exactComponents.set(rootKey, []);
    exactComponents.get(rootKey).push(key);
  }

  // Non-exact forms are composed in one pass, so overlapping semantic readings
  // influence the same row rather than silently overwriting one another.
  for (const phrase of phraseContexts) {
    const specs = occurrenceTemplates.get(phrase.id);
    for (let slotIndex = 0; slotIndex < phrase.items.length; slotIndex += 1) {
      const key = `${phrase.id}:${slotIndex}`;
      if (exactEntryByKey.has(key)) continue;
      const activeNonExactInputs = identityInputsAtTime(phrase.items[slotIndex].sourceEvent.timeSeconds)
        .filter(({ identity }) => identity.relation !== 'exact');
      const hasMissingIdentity = activeNonExactInputs.some(({ identity }) => (
        !specs[slotIndex].directedIdentityIds?.includes(identity.id)
      ));
      if (!hasMissingIdentity) continue;
      const inputs = activeNonExactInputs;
      const primaryIdentityId = directedIdentityForPhrases([phrase])?.id ?? null;
      specs[slotIndex] = compileKineticSpec(
        specs[slotIndex],
        inputs,
        average(inputs.map((input) => input.normalizedPosition)),
        primaryIdentityId,
      );
    }
  }

  // Overlapping exact contracts form equality constraints. Unioning matching
  // occurrence slots lets one connected component satisfy every literal-repeat
  // relationship at once, even when repeated windows overlap or nest.
  for (const componentKeys of exactComponents.values()) {
    const entries = componentKeys.map((key) => exactEntryByKey.get(key));
    const exactMemberships = componentKeys.flatMap((key) => exactMembershipsByKey.get(key) ?? []);
    const allInputs = entries.flatMap((entry) => identityInputsAtTime(entry.item.sourceEvent.timeSeconds));
    const componentIdentityIds = new Set(exactMemberships.map(({ identity }) => identity.id));
    const contributionInputs = [
      ...allInputs.filter(({ identity }) => identity.relation !== 'exact'),
      ...exactMemberships,
    ];
    const normalizedPosition = average(exactMemberships.map((membership) => membership.normalizedPosition));
    const primaryIdentityId = [...componentIdentityIds].sort()[0] ?? null;
    const componentId = `kinetic-exact-${stableId(findExactRoot(componentKeys[0]))}`;
    const componentBaseSpec = copySpec(entries[0].spec, {
      allowedLanes: [...new Set(entries.flatMap((entry) => entry.spec.allowedLanes ?? []))],
      templateId: componentId,
      relativeSlotKey: `${componentId}:row`,
      blockId: componentId,
    });
    const compiled = compileKineticSpec(componentBaseSpec, contributionInputs, normalizedPosition, primaryIdentityId);
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      const localInputs = identityInputsAtTime(entry.item.sourceEvent.timeSeconds);
      const localExactMemberships = exactMembershipsByKey.get(componentKeys[entryIndex]) ?? [];
      const localInputsById = new Map([...localInputs.filter(({ identity }) => identity.relation !== 'exact'), ...localExactMemberships]
        .map((input) => [input.identity.id, input]));
      const localProofs = compiled.kineticProofs.flatMap((proof) => {
        const localInput = localInputsById.get(proof.identityId);
        if (!localInput) return [];
        const localContribution = kineticContribution(localInput.identity, localInput.normalizedPosition);
        const localPreferredLane = [...compiled.allowedLanes].sort((left, right) => (
          Math.abs(left - localContribution.desiredLane) - Math.abs(right - localContribution.desiredLane)
        ))[0];
        return [{
          ...proof,
          desiredLane: Number(localContribution.desiredLane.toFixed(4)),
          pressureSample: Number(localContribution.pressure.toFixed(4)),
          desiredSafeWidth: clamp(Math.round(
            (localContribution.pressure < 0.47 ? 4 : localContribution.pressure < 0.55 ? 3 : 2)
            + localContribution.openness,
          ), 2, LANE_COUNT),
          compiledPreferredLane: localPreferredLane,
          resolvedPreferredLane: localPreferredLane,
          normalizedPosition: Number(localInput.normalizedPosition.toFixed(5)),
        }];
      });
      occurrenceTemplates.get(entry.phrase.id)[entry.slotIndex] = copySpec(compiled, {
        directedIdentityIds: localProofs.map((proof) => proof.identityId),
        kineticProofs: localProofs,
        reusedFrom: componentKeys[0],
        reuseLinkId: `director-exact-equivalence-${componentId}`,
      });
    }
  }

  for (const identity of exactIdentities) {
    const occurrences = exactOccurrencesById.get(identity.id);
    const canonical = occurrences[0];
    for (const target of occurrences.slice(1)) {
      applied.push({
        id: `director-exact-${identity.id}-${target.occurrence.id}`,
        sourceStartSeconds: Number(canonical.occurrence.startSeconds),
        sourceEndSeconds: Number(canonical.occurrence.endSeconds),
        targetStartSeconds: Number(target.occurrence.startSeconds),
        targetEndSeconds: Number(target.occurrence.endSeconds),
        priority: 3,
        similarity: Number(identity.confidence),
        slotCount: canonical.entries.length,
        directedIdentityId: identity.id,
        compilerVersion: KINETIC_FORM_COMPILER_VERSION,
        realization: 'kinetic-form-compiled',
      });
    }
  }
  return applied;
}

function relabelTruncatedNamedGestureFragments(occurrenceTemplates) {
  const minimumLengths = new Map([
    ['wave', 5],
    ['m', M_GESTURE_SLOT_OFFSETS.at(-1) + 1],
    ['full-width-sweep', MOTIFS['full-width-sweep'].minimumLength],
  ]);
  for (const specs of occurrenceTemplates.values()) {
    let start = 0;
    while (start < specs.length) {
      const pattern = specs[start].pattern;
      let end = start + 1;
      while (end < specs.length && specs[end].pattern === pattern) end += 1;
      const minimumLength = minimumLengths.get(pattern);
      if (minimumLength && end - start < minimumLength) {
        for (let index = start; index < end; index += 1) {
          specs[index].pattern = 'contour';
          specs[index].role = specs[index].kind === 'target' ? 'kinetic-contour' : 'contour-guide';
          delete specs[index].sweepGestureId;
          delete specs[index].sweepPhase;
          delete specs[index].sweepAnchorIndex;
          delete specs[index].sweepHazardMode;
        }
      }
      start = end;
    }
  }
}

function pruneDeadChoiceCells(events, routeAnalysis, routeAnalysisOptions) {
  let analysisResult = routeAnalysis;
  let prunedCellCount = 0;
  for (let iteration = 0; iteration < 6 && analysisResult.deadChoiceCells.length; iteration += 1) {
    let changed = false;
    const seen = new Set();
    const auxiliaryRowsToRemove = new Set();
    for (const deadCell of analysisResult.deadChoiceCells) {
      const event = events[deadCell.rowIndex];
      if (!event || event.kind !== 'target' || event.obstacles[deadCell.lane] !== BREAKABLE) continue;
      if (
        event.directedMovementPreparation
        || event.directedMomentIds?.some((momentId) => (
          DIRECTED_MOMENTS.find((moment) => moment.id === momentId)?.requiredChannels?.includes('movement')
        ))
      ) continue;
      if (
        event.layer !== 'core'
        && event.obstacles.filter((cell) => cell === BREAKABLE).length === 1
      ) {
        auxiliaryRowsToRemove.add(event);
        prunedCellCount += 1;
        changed = true;
        continue;
      }
      const key = `${event.templateId ?? event.phraseId}:${event.relativeSlotKey ?? deadCell.rowIndex}:${deadCell.lane}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const echoes = event.layer === 'core' && event.templateId && event.relativeSlotKey
        ? events.filter((candidate) => (
          candidate.layer === 'core'
          && candidate.templateId === event.templateId
          && candidate.relativeSlotKey === event.relativeSlotKey
        ))
        : [event];
      const removableFromEveryEcho = echoes.every((candidate) => (
        candidate.obstacles[deadCell.lane] === BREAKABLE
        && candidate.obstacles.filter((cell) => cell === BREAKABLE).length >= 2
      ));
      const targets = removableFromEveryEcho
        ? echoes
        : event.obstacles.filter((cell) => cell === BREAKABLE).length >= 2 ? [event] : [];
      for (const target of targets) {
        target.obstacles[deadCell.lane] = EMPTY;
        target._allowedLanes = lanesMatching(target.obstacles, (cell) => cell === BREAKABLE);
        target._preferredLane = target._allowedLanes.length === 1 ? target._allowedLanes[0] : null;
        target.choiceLaneCount = target._allowedLanes.length;
        target.routeBranch = target._allowedLanes.length > 1;
        target.branchPrunedForGlobalRoute = true;
        prunedCellCount += 1;
        changed = true;
      }
    }
    if (auxiliaryRowsToRemove.size) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (auxiliaryRowsToRemove.has(events[index])) events.splice(index, 1);
      }
    }
    if (!changed) break;
    analysisResult = analyzeRouteGraph(events, routeAnalysisOptions);
  }
  return { analysis: analysisResult, prunedCellCount };
}

function repairExactEquivalenceRoutes(events, routeAnalysisOptions) {
  const groups = new Map();
  const protectedMovementEvents = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const ownsMovementCue = event.directedMomentIds?.some((momentId) => (
      DIRECTED_MOMENTS.find((moment) => moment.id === momentId)?.requiredChannels?.includes('movement')
    ));
    if (!ownsMovementCue) continue;
    protectedMovementEvents.add(event);
    const priorIndex = previousCoreIndex(events, index);
    if (priorIndex >= 0) protectedMovementEvents.add(events[priorIndex]);
  }
  for (const event of events) {
    if (event.layer !== 'core' || !String(event.templateId).startsWith('kinetic-exact-')) continue;
    if (!groups.has(event.templateId)) groups.set(event.templateId, []);
    groups.get(event.templateId).push(event);
  }
  let analysisResult = analyzeRouteGraph(events, routeAnalysisOptions);
  const viableRowCount = (analysis) => analysis.globallyViableLanesByRow
    .filter((lanes) => lanes.length > 0).length;
  const routeCost = (analysis) => analysis.feasible
    ? analysis.deadChoiceCells.length
    : 100000 - viableRowCount(analysis);
  for (
    let iteration = 0;
    iteration < 30 && (!analysisResult.feasible || analysisResult.deadChoiceCells.length);
    iteration += 1
  ) {
    let best = null;
    const baselineCost = routeCost(analysisResult);
    for (const [groupId, groupEvents] of groups) {
      if (groupEvents.some((event) => protectedMovementEvents.has(event))) continue;
      const snapshots = groupEvents.map((event) => ({
        event,
        obstacles: [...event.obstacles],
        allowedLanes: [...eventAllowedLanes(event)],
        preferredLane: event._preferredLane,
        choiceLaneCount: event.choiceLaneCount,
        routeBranch: event.routeBranch,
      }));
      const compiledLanes = groupEvents.flatMap((event) => (
        event.kineticProofs?.map((proof) => Number(proof.compiledPreferredLane)) ?? []
      )).filter(Number.isInteger);
      const candidates = Array.from({ length: (1 << LANE_COUNT) - 1 }, (_, maskIndex) => maskIndex + 1)
        .map((mask) => Array.from({ length: LANE_COUNT }, (_, lane) => lane)
          .filter((lane) => (mask & (1 << lane)) !== 0))
        .filter((lanes) => compiledLanes.every((compiledLane) => (
          lanes.some((lane) => Math.abs(lane - compiledLane) <= 2)
        )))
        .sort((left, right) => left.length - right.length || left.join('').localeCompare(right.join('')));
      for (const lanes of candidates) {
        const safeWidth = clamp(Math.max(
          lanes.at(-1) - lanes[0] + 1,
          Math.round(average(groupEvents.flatMap((event) => (
            event.kineticProofs?.map((proof) => Number(proof.compiledSafeWidth)) ?? []
          )).filter(Number.isFinite))) || 3,
        ), 2, LANE_COUNT);
        const minimumSafeStart = Math.max(0, lanes.at(-1) - safeWidth + 1);
        const maximumSafeStart = Math.min(lanes[0], LANE_COUNT - safeWidth);
        const safeStart = clamp(Math.round(average(lanes)) - Math.floor(safeWidth / 2), minimumSafeStart, maximumSafeStart);
        const safeLanes = Array.from({ length: safeWidth }, (_, offset) => safeStart + offset);
        for (const event of groupEvents) {
          event.obstacles = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
          for (const lane of lanes) event.obstacles[lane] = BREAKABLE;
          addSpikesOutside(event.obstacles, safeLanes);
          event._allowedLanes = [...lanes];
          event._preferredLane = lanes.length === 1 ? lanes[0] : null;
          event.choiceLaneCount = lanes.length;
          event.routeBranch = lanes.length > 1;
        }
        const candidateAnalysis = analyzeRouteGraph(events, routeAnalysisOptions);
        const cost = routeCost(candidateAnalysis);
        const candidate = { groupId, snapshots, lanes, safeLanes, analysis: candidateAnalysis, cost };
        if (
          cost < (best?.cost ?? baselineCost)
          || (cost === best?.cost && lanes.length < best.lanes.length)
        ) best = candidate;
        for (const snapshot of snapshots) {
          snapshot.event.obstacles = snapshot.obstacles;
          snapshot.event._allowedLanes = snapshot.allowedLanes;
          snapshot.event._preferredLane = snapshot.preferredLane;
          snapshot.event.choiceLaneCount = snapshot.choiceLaneCount;
          snapshot.event.routeBranch = snapshot.routeBranch;
        }
        if (candidateAnalysis.feasible && !candidateAnalysis.deadChoiceCells.length) break;
      }
      if (best?.analysis.feasible && !best.analysis.deadChoiceCells.length) break;
    }
    if (!best || best.cost >= baselineCost) break;
    const chosenEvents = groups.get(best.groupId);
    for (const event of chosenEvents) {
      event.obstacles = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
      for (const lane of best.lanes) event.obstacles[lane] = BREAKABLE;
      addSpikesOutside(event.obstacles, best.safeLanes);
      event._allowedLanes = [...best.lanes];
      event._preferredLane = best.lanes.length === 1 ? best.lanes[0] : null;
      event.choiceLaneCount = best.lanes.length;
      event.routeBranch = best.lanes.length > 1;
      event.kineticRouteRefinement = true;
    }
    analysisResult = analyzeRouteGraph(events, routeAnalysisOptions);
  }
  return analysisResult;
}

function ensureForkConvergeTopology(events, routeAnalysisOptions) {
  let analysisResult = analyzeRouteGraph(events, routeAnalysisOptions);
  const protectedMovementEvents = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event.directedMomentIds?.some((momentId) => (
      DIRECTED_MOMENTS.find((moment) => moment.id === momentId)?.requiredChannels?.includes('movement')
    ))) continue;
    protectedMovementEvents.add(event);
    const priorIndex = previousCoreIndex(events, index);
    if (priorIndex >= 0) protectedMovementEvents.add(events[priorIndex]);
  }
  for (const identity of DIRECTED_IDENTITIES.filter((candidate) => (
    candidate.kineticForm?.branchMode === 'fork-converge'
  ))) {
    for (const occurrence of identity.occurrences ?? []) {
      const occurrenceRows = events.filter((event) => (
        event.layer === 'core'
        && event.timeSeconds >= Number(occurrence.startSeconds)
        && event.timeSeconds < Number(occurrence.endSeconds)
        && event.directedIdentityIds?.includes(identity.id)
      ));
      const firstForkIndex = occurrenceRows.findIndex((event) => (
        event.routeBranch === true && event.obstacles.filter((cell) => cell === BREAKABLE).length >= 2
      ));
      if (firstForkIndex >= 0 && occurrenceRows.slice(firstForkIndex + 1).some((event) => (
        event.kind === 'target'
        && event.routeBranch !== true
        && event.obstacles.filter((cell) => cell === BREAKABLE).length === 1
      ))) continue;
      const candidates = occurrenceRows.filter((event, index) => (
        !protectedMovementEvents.has(event)
        &&
        event.kind === 'target'
        && event.obstacles.filter((cell) => cell === BREAKABLE).length === 1
        && index < occurrenceRows.length - 1
        && occurrenceRows.slice(index + 1).some((later) => (
          later.kind === 'target' && later.obstacles.filter((cell) => cell === BREAKABLE).length === 1
        ))
      ));
      let applied = false;
      for (const event of candidates) {
        const echoes = event.templateId && event.relativeSlotKey
          ? events.filter((candidate) => (
            candidate.layer === 'core'
            && candidate.templateId === event.templateId
            && candidate.relativeSlotKey === event.relativeSlotKey
          ))
          : [event];
        const targetLane = lanesMatching(event.obstacles, (cell) => cell === BREAKABLE)[0];
        const alternativeLanes = Array.from({ length: LANE_COUNT }, (_, lane) => lane)
          .filter((lane) => lane !== targetLane)
          .sort((left, right) => Math.abs(left - targetLane) - Math.abs(right - targetLane));
        for (const alternativeLane of alternativeLanes) {
          const snapshots = echoes.map((echo) => ({
            echo,
            obstacles: [...echo.obstacles],
            allowedLanes: [...eventAllowedLanes(echo)],
            preferredLane: echo._preferredLane,
            choiceLaneCount: echo.choiceLaneCount,
            routeBranch: echo.routeBranch,
          }));
          for (const echo of echoes) {
            echo.obstacles[alternativeLane] = BREAKABLE;
            echo._allowedLanes = [...new Set([...eventAllowedLanes(echo), alternativeLane])].sort((a, b) => a - b);
            echo._preferredLane = null;
            echo.choiceLaneCount = echo._allowedLanes.length;
            echo.routeBranch = echo.choiceLaneCount > 1;
            echo.kineticBranchRefinement = true;
          }
          const candidateAnalysis = analyzeRouteGraph(events, routeAnalysisOptions);
          const allNewBranchesLive = echoes.every((echo) => {
            const rowIndex = events.indexOf(echo);
            return !candidateAnalysis.deadChoiceCells.some((cell) => (
              cell.rowIndex === rowIndex && echo.obstacles[cell.lane] === BREAKABLE
            ));
          });
          if (candidateAnalysis.feasible && allNewBranchesLive) {
            analysisResult = candidateAnalysis;
            applied = true;
            break;
          }
          for (const snapshot of snapshots) {
            snapshot.echo.obstacles = snapshot.obstacles;
            snapshot.echo._allowedLanes = snapshot.allowedLanes;
            snapshot.echo._preferredLane = snapshot.preferredLane;
            snapshot.echo.choiceLaneCount = snapshot.choiceLaneCount;
            snapshot.echo.routeBranch = snapshot.routeBranch;
            delete snapshot.echo.kineticBranchRefinement;
          }
        }
        if (applied) break;
      }
    }
  }
  return analysisResult;
}

function addDensityFillRows(events) {
  const intervalGroups = new Map();
  const eventsByPhrase = new Map();
  for (const event of events) {
    if (!eventsByPhrase.has(event.phraseId)) eventsByPhrase.set(event.phraseId, []);
    eventsByPhrase.get(event.phraseId).push(event);
  }
  for (const phraseEvents of eventsByPhrase.values()) {
    phraseEvents.sort((left, right) => left.timeSeconds - right.timeSeconds);
    for (let index = 1; index < phraseEvents.length; index += 1) {
      const before = phraseEvents[index - 1];
      const after = phraseEvents[index];
      const plan = planDensityInterval(before, after);
      if (!plan) continue;
      const key = `${before.templateId}:${before.relativeSlotKey}->${after.relativeSlotKey}`;
      if (!intervalGroups.has(key)) intervalGroups.set(key, []);
      intervalGroups.get(key).push({ before, after, plan });
    }
  }

  const fillEvents = [];
  const counts = { solid: 0, compact: 0 };
  for (const intervals of intervalGroups.values()) {
    const mode = intervals.some((interval) => interval.plan.mode === 'solid') ? 'solid' : 'compact';
    const fillCount = Math.max(...intervals.map(({ before, after }) => (
      densityFillCount(after.timeSeconds - before.timeSeconds, mode)
    )));
    if (!fillCount) continue;
    for (const { before, after, plan } of intervals) {
      const basePattern = before.pattern.replace(/-melody$/, '');
      for (let fillIndex = 1; fillIndex <= fillCount; fillIndex += 1) {
        const phase = fillIndex / (fillCount + 1);
        const event = makeInternalEvent({
          timeSeconds: before.timeSeconds + (after.timeSeconds - before.timeSeconds) * phase,
          obstacles: [...plan.obstacles],
          strength: (Number(before.strength) + Number(after.strength)) / 2,
          source: 'layout-density-rule',
          kind: plan.kind,
          pattern: `${basePattern}-fill`,
          flow: before.flow + (after.flow - before.flow) * phase,
          sectionIndex: before._sectionIndex,
          role: `${mode}-density-guide`,
          allowedLanes: plan.allowedLanes,
          preferredLane: null,
        });
        Object.assign(event, {
          familyId: before.familyId,
          phraseId: before.phraseId,
          barIndex: before.barIndex,
          barInPhrase: before.barInPhrase,
          beatInBar: before.beatInBar,
          downbeatCue: false,
          barRole: before.barRole,
          sectionRole: before.sectionRole,
          pressure: Number(Math.max(before.pressure, after.pressure).toFixed(3)),
          relativeSlotKey: `${before.relativeSlotKey}:density-${mode}-${fillIndex}-of-${fillCount}`,
          occurrenceSlotKey: `${before.phraseId}:density-${before.relativeSlotKey}-${fillIndex}`,
          layer: 'auxiliary-common',
          templateId: before.templateId,
          transformId: before.transformId,
          barModule: before.barModule,
          choiceLaneCount: 0,
          routeBranch: false,
          densityFill: true,
          densityMode: mode,
        });
        fillEvents.push(event);
        counts[mode] += 1;
      }
    }
  }
  return {
    events: [...events, ...fillEvents].sort((left, right) => left.timeSeconds - right.timeSeconds),
    counts,
  };
}

function retargetBurstAnchor(spec, lane) {
  const previousSpikeCount = spec.obstacles.filter((cell) => cell === SPIKE).length;
  const obstacles = [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
  obstacles[lane] = BREAKABLE;
  if (previousSpikeCount) {
    const safeWidth = previousSpikeCount >= 3 ? 2 : 3;
    addSpikesOutside(obstacles, chooseSafeWindow(lane, lane, safeWidth));
    widenIsolatedMiddleGaps(obstacles, lane);
  }
  spec.obstacles = obstacles;
  spec.emit = true;
  spec.kind = 'target';
  spec.role = 'melody-burst-anchor';
  spec.allowedLanes = [lane];
  spec.preferredLane = lane;
}

function prepareClimaxMelodyBurst({
  trackId,
  candidates,
  climaxTime,
  phraseContexts,
  occurrenceTemplates,
  templateGroups,
}) {
  if (trackId !== 'beat-this') return null;
  const nearby = candidates.filter((candidate) => (
    Math.abs(candidate.timeSeconds - climaxTime) <= CLIMAX_RADIUS_SECONDS
  ));
  const clusters = [];
  let cluster = [];
  for (const candidate of nearby) {
    if (cluster.length && candidate.timeSeconds - cluster[cluster.length - 1].timeSeconds > FLOW_MODE.minTravelSecondsPerLane) {
      if (cluster.length >= 3) clusters.push(cluster);
      cluster = [];
    }
    cluster.push(candidate);
  }
  if (cluster.length >= 3) clusters.push(cluster);
  clusters.sort((left, right) => right.length - left.length || right[0].timeSeconds - left[0].timeSeconds);
  for (const candidateCluster of clusters) {
    const phrase = phraseAtTime(phraseContexts, candidateCluster[0].timeSeconds);
    if (!phrase || candidateCluster.some((candidate) => phraseAtTime(phraseContexts, candidate.timeSeconds)?.id !== phrase.id)) continue;
    const group = templateGroups.get(`${phrase.familyId}|${phrase.durationClass}`);
    if (!group || group.phrases.length !== 1) continue;
    const beforeSlot = phrase.items.reduce((best, item, index) => (
      item.sourceEvent.timeSeconds < candidateCluster[0].timeSeconds ? index : best
    ), -1);
    const afterSlot = phrase.items.findIndex((item) => item.sourceEvent.timeSeconds > candidateCluster[candidateCluster.length - 1].timeSeconds);
    if (beforeSlot < 0 || afterSlot < 0) continue;
    const beforeGap = candidateCluster[0].timeSeconds - phrase.items[beforeSlot].sourceEvent.timeSeconds;
    const afterGap = phrase.items[afterSlot].sourceEvent.timeSeconds - candidateCluster[candidateCluster.length - 1].timeSeconds;
    if (beforeGap > FLOW_MODE.minTravelSecondsPerLane || afterGap > FLOW_MODE.minTravelSecondsPerLane) continue;
    const specs = occurrenceTemplates.get(phrase.id);
    // The M module owns a silent timing envelope around its six visible rows.
    // Retargeting either anchor (or a skipped slot between them) would destroy
    // the literal gesture even if auxiliary emission is rejected later.
    if (specs.slice(beforeSlot, afterSlot + 1).some((spec) => (
      ['m', 'full-width-sweep', 'wave'].includes(spec.pattern)
      || spec.kineticProofs?.some((proof) => (
        DIRECTED_IDENTITIES.find((identity) => identity.id === proof.identityId)?.relation === 'exact'
      ))
    ))) continue;
    if (specs[beforeSlot].kind !== 'target' || specs[afterSlot].kind !== 'target') continue;
    retargetBurstAnchor(specs[beforeSlot], START_LANE);
    retargetBurstAnchor(specs[afterSlot], START_LANE);
    return {
      phraseId: phrase.id,
      familyId: phrase.familyId,
      layer: 'overlay',
      targetLane: START_LANE,
      startSeconds: Number(phrase.items[beforeSlot].sourceEvent.timeSeconds.toFixed(5)),
      endSeconds: Number(phrase.items[afterSlot].sourceEvent.timeSeconds.toFixed(5)),
      detectorPeakTimes: candidateCluster.map((candidate) => Number(candidate.timeSeconds.toFixed(5))),
      expectedRunLength: candidateCluster.length + 2,
      policy: 'Real detector peaks are preserved; a unique climax template keeps the surrounding core anchors on one lane.',
    };
  }
  return null;
}

function summarizeFullWidthSweeps(events, routeGraph) {
  const groups = new Map();
  events.forEach((event, rowIndex) => {
    if (!event.sweepGestureId) return;
    const key = `${event.phraseId}:${event.sweepGestureId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ event, rowIndex });
  });

  const gestures = [];
  let edgeToEdgeTransitionCount = 0;
  let forcedEdgeTargetCount = 0;
  for (const [id, rows] of groups) {
    rows.sort((left, right) => left.event.timeSeconds - right.event.timeSeconds);
    const anchors = rows.flatMap(({ event, rowIndex }) => {
      if (event.sweepPhase !== 'edge-target' || event.kind !== 'target') return [];
      const targetLanes = lanesMatching(event.obstacles, (cell) => cell === BREAKABLE);
      const viableLanes = routeGraph.globallyViableLanesByRow[rowIndex] ?? [];
      const lane = targetLanes[0];
      const forcedEdge = targetLanes.length === 1
        && viableLanes.length === 1
        && viableLanes[0] === lane
        && (lane === 0 || lane === LANE_COUNT - 1);
      if (!forcedEdge) return [];
      forcedEdgeTargetCount += 1;
      return [{
        timeSeconds: event.timeSeconds,
        lane,
        rowIndex,
        sectionRole: event.sectionRole,
      }];
    });
    let transitions = 0;
    for (let index = 1; index < anchors.length; index += 1) {
      const elapsed = anchors[index].timeSeconds - anchors[index - 1].timeSeconds;
      if (
        Math.abs(anchors[index].lane - anchors[index - 1].lane) === LANE_COUNT - 1
        && elapsed <= BEAT_SECONDS * 1.35 + 1e-6
      ) transitions += 1;
    }
    if (anchors.length < 5 || transitions < 4) continue;
    edgeToEdgeTransitionCount += transitions;
    const intentSections = [...new Set(anchors.map((anchor) => (
      intentSectionAt(anchor.timeSeconds)?.index
    )).filter(Number.isInteger))];
    gestures.push({
      id,
      phraseId: rows[0].event.phraseId,
      templateId: rows[0].event.templateId,
      startSeconds: Number(rows[0].event.timeSeconds.toFixed(3)),
      endSeconds: Number(rows.at(-1).event.timeSeconds.toFixed(3)),
      sectionRole: anchors.some((anchor) => anchor.sectionRole === 'peak') ? 'peak' : anchors[0].sectionRole,
      intentSectionIndices: intentSections,
      anchorTimes: anchors.map((anchor) => Number(anchor.timeSeconds.toFixed(5))),
      anchorLanes: anchors.map((anchor) => anchor.lane),
      edgeToEdgeTransitionCount: transitions,
    });
  }

  return {
    fullWidthSweepCount: gestures.length,
    alternatingEdgeRunCount: gestures.length,
    edgeToEdgeTransitionCount,
    forcedEdgeTargetCount,
    gestures,
    policy: 'Counts only globally viable forced-edge Choice Rows in the actual emitted event graph; timestamps are never moved.',
  };
}

function performanceAttackPriority(event) {
  const roleWeight = event.sourceRole === 'vocal-like'
    ? 0.18
    : event.sourceRole === 'melody'
      ? 0.14
      : 0.1;
  const continuityWeight = event.continuity?.traceId ? 0.12 : 0;
  return clamp(Number(event.strength) || 0.5, 0, 1) + roleWeight + continuityWeight;
}

function normalizePerformanceAttackEvents(performanceScore) {
  return (Array.isArray(performanceScore?.attackEvents) ? performanceScore.attackEvents : [])
    .filter((event) => (
      event
      && typeof event.id === 'string'
      && Number.isFinite(Number(event.timeSeconds))
      && Number(event.timeSeconds) >= 0
      && Number(event.timeSeconds) <= analysis.song.durationSeconds
      && Number.isInteger(Number(event.lane))
      && Number(event.lane) >= 0
      && Number(event.lane) < LANE_COUNT
    ))
    .map((event) => ({
      ...event,
      timeSeconds: Number(event.timeSeconds),
      lane: Number(event.lane),
      strength: clamp(Number(event.strength) || 0.5, 0, 1),
      evidenceIds: Array.isArray(event.evidenceIds) ? [...event.evidenceIds] : [],
    }))
    .sort((left, right) => (
      left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id)
    ));
}

function coalesceCoincidentPerformanceAttacks(attackEvents) {
  const groups = [];
  for (const attackEvent of attackEvents) {
    const previous = groups.at(-1);
    if (
      previous
      && attackEvent.timeSeconds - previous.at(-1).timeSeconds <= PERFORMANCE_COINCIDENCE_SECONDS
    ) {
      previous.push(attackEvent);
    } else {
      groups.push([attackEvent]);
    }
  }
  const mergedGroups = [];
  const events = groups.map((group) => {
    const leader = [...group].sort((left, right) => (
      performanceAttackPriority(right) - performanceAttackPriority(left)
      || left.timeSeconds - right.timeSeconds
      || left.id.localeCompare(right.id)
    ))[0];
    if (group.length > 1) {
      mergedGroups.push({
        performanceEventId: leader.id,
        mergedPerformanceEventIds: group.map((event) => event.id),
        sourceTimesSeconds: group.map((event) => event.timeSeconds),
        reason: 'perceptual-coincidence-within-18ms',
        evidenceIds: [...new Set(group.flatMap((event) => event.evidenceIds ?? []))],
      });
    }
    return {
      ...leader,
      mergedPerformanceEventIds: group.map((event) => event.id),
      mergedEvidenceIds: [...new Set(group.flatMap((event) => event.evidenceIds ?? []))],
    };
  });
  return { events, mergedGroups };
}

function performanceTransitionIsReachable(before, after) {
  const fromLane = before ? before.lane : START_LANE;
  const fromTime = before ? before.timeSeconds : 0;
  const requiredSeconds = Math.abs(after.lane - fromLane) * PERFORMANCE_TRAVEL_SECONDS_PER_LANE;
  return after.timeSeconds - fromTime + 1e-6 >= requiredSeconds;
}

function selectPlayablePerformanceAttacks(performanceScore) {
  const normalized = normalizePerformanceAttackEvents(performanceScore);
  const completeSequenceIsReachable = normalized.every((event, index) => (
    performanceTransitionIsReachable(normalized[index - 1] ?? null, event)
  ));
  if (completeSequenceIsReachable) {
    return {
      input: normalized,
      selected: normalized.map((event) => ({
        ...event,
        mergedPerformanceEventIds: [event.id],
        mergedEvidenceIds: [...event.evidenceIds],
      })),
      omitted: [],
      mergedGroups: [],
    };
  }
  const coalesced = coalesceCoincidentPerformanceAttacks(normalized);
  const candidates = coalesced.events;
  const plans = candidates.map((event) => ({
    count: performanceTransitionIsReachable(null, event) ? 1 : 0,
    evidenceScore: performanceTransitionIsReachable(null, event)
      ? performanceAttackPriority(event)
      : Number.NEGATIVE_INFINITY,
    previousIndex: -1,
  }));
  const isBetter = (count, evidenceScore, current) => (
    count > current.count
    || (count === current.count && evidenceScore > current.evidenceScore + 1e-9)
  );
  for (let index = 0; index < candidates.length; index += 1) {
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      if (!plans[previousIndex].count) continue;
      if (!performanceTransitionIsReachable(candidates[previousIndex], candidates[index])) continue;
      const count = plans[previousIndex].count + 1;
      const evidenceScore = plans[previousIndex].evidenceScore
        + performanceAttackPriority(candidates[index]);
      if (!isBetter(count, evidenceScore, plans[index])) continue;
      plans[index] = { count, evidenceScore, previousIndex };
    }
  }
  let endIndex = -1;
  for (let index = 0; index < plans.length; index += 1) {
    if (endIndex < 0 || isBetter(plans[index].count, plans[index].evidenceScore, plans[endIndex])) {
      endIndex = index;
    }
  }
  const selectedIndices = new Set();
  while (endIndex >= 0 && plans[endIndex]?.count) {
    selectedIndices.add(endIndex);
    endIndex = plans[endIndex].previousIndex;
  }
  const selected = candidates.filter((_, index) => selectedIndices.has(index));
  const selectedIds = new Set(selected.flatMap((event) => event.mergedPerformanceEventIds));
  const omitted = normalized.filter((event) => !selectedIds.has(event.id)).map((event) => ({
    performanceEventId: event.id,
    timeSeconds: event.timeSeconds,
    lane: event.lane,
    sourceRole: event.sourceRole,
    strength: event.strength,
    evidenceIds: event.evidenceIds,
    reason: 'motion-constrained-voice-selection',
  }));
  return {
    input: normalized,
    selected,
    omitted,
    mergedGroups: coalesced.mergedGroups,
  };
}

function performanceSectionIndexAt(timeSeconds) {
  const index = DIRECTED_SCENES.findIndex((scene, sceneIndex) => (
    timeSeconds >= Number(scene.startSeconds)
    && (
      sceneIndex === DIRECTED_SCENES.length - 1
      || timeSeconds < Number(scene.endSeconds)
    )
  ));
  return index >= 0 ? index : 0;
}

function makePerformanceTargetEvent(attackEvent) {
  const row = Array(LANE_COUNT).fill(EMPTY);
  row[attackEvent.lane] = BREAKABLE;
  const sectionIndex = performanceSectionIndexAt(attackEvent.timeSeconds);
  const event = makeInternalEvent({
    timeSeconds: attackEvent.timeSeconds,
    obstacles: row,
    strength: attackEvent.strength,
    source: `performance-score:${attackEvent.sourceRole ?? 'unknown'}`,
    kind: 'target',
    pattern: 'performance',
    flow: attackEvent.strength,
    sectionIndex,
    role: 'performance-attack',
    allowedLanes: [attackEvent.lane],
    preferredLane: attackEvent.lane,
  });
  const traceId = attackEvent.continuity?.traceId ?? null;
  Object.assign(event, {
    performanceEventId: attackEvent.id,
    performanceEventIds: [...attackEvent.mergedPerformanceEventIds],
    ...(traceId ? { melodicTraceId: traceId } : {}),
    ...(Number.isFinite(Number(attackEvent.pitchMidi)) ? {
      pitchMidi: Number(attackEvent.pitchMidi),
    } : {}),
    ...(Number.isFinite(Number(attackEvent.pitchClass)) ? {
      pitchClass: Number(attackEvent.pitchClass),
    } : {}),
    sourceRole: attackEvent.sourceRole ?? 'percussion',
    evidenceIds: [...attackEvent.mergedEvidenceIds],
    continuity: attackEvent.continuity ? { ...attackEvent.continuity } : null,
    hitSound: attackEvent.hitSound ? { ...attackEvent.hitSound } : {
      pitchMidi: Number.isFinite(Number(attackEvent.pitchMidi)) ? Number(attackEvent.pitchMidi) : 36,
      pitchClass: Number.isFinite(Number(attackEvent.pitchClass)) ? Number(attackEvent.pitchClass) : 0,
      sourceRole: attackEvent.sourceRole ?? 'percussion',
      velocity: attackEvent.strength,
      gain: 0.18,
      brightness: attackEvent.sourceRole === 'percussion' ? 0.42 : 0.6,
    },
    phraseId: attackEvent.phraseId ?? attackEvent.phraseIds?.[0] ?? 'performance-unphrased',
    phraseIds: Array.isArray(attackEvent.phraseIds)
      ? [...attackEvent.phraseIds]
      : attackEvent.phraseId ? [attackEvent.phraseId] : [],
    layer: 'core',
    pressure: attackEvent.strength,
    relativeSlotKey: traceId
      ? `${traceId}:attack-${Number(attackEvent.continuity?.index) || 0}`
      : attackEvent.id,
    occurrenceSlotKey: attackEvent.id,
    choiceLaneCount: 1,
    routeBranch: false,
    travelSecondsPerLane: PERFORMANCE_TRAVEL_SECONDS_PER_LANE,
  });
  return event;
}

function decoratePerformanceRowsWithDirector(events) {
  const realizations = [];
  const moments = DIRECTED_MOMENTS.filter((moment) => (
    ['must', 'should'].includes(moment.commitment)
  )).sort((left, right) => left.timeSeconds - right.timeSeconds);
  for (const moment of moments) {
    const maximumOffset = Math.max(BEAT_SECONDS * 1.5, 0.45);
    const candidates = events.flatMap((event, index) => (
      Math.abs(event.timeSeconds - moment.timeSeconds) <= maximumOffset
        ? [{ event, index }]
        : []
    ));
    if (!candidates.length) continue;
    const needsMovement = moment.requiredChannels?.includes('movement');
    const selected = candidates.sort((left, right) => {
      const leftPrior = events[left.index - 1];
      const rightPrior = events[right.index - 1];
      const leftMoves = leftPrior && leftPrior._preferredLane !== left.event._preferredLane;
      const rightMoves = rightPrior && rightPrior._preferredLane !== right.event._preferredLane;
      return Number(needsMovement && rightMoves) - Number(needsMovement && leftMoves)
        || Math.abs(left.event.timeSeconds - moment.timeSeconds)
          - Math.abs(right.event.timeSeconds - moment.timeSeconds)
        || left.event.timeSeconds - right.event.timeSeconds;
    })[0];
    const { event } = selected;
    const targetLane = event._preferredLane;
    const requiredChannels = new Set(moment.requiredChannels ?? []);
    const expressiveImpact = ['impact', 'arrival', 'rupture'].includes(moment.type);
    let layoutAction = 'performance-expression';
    if (moment.type === 'release' || moment.type === 'breath') {
      event.obstacles = event.obstacles.map((cell) => cell === SPIKE ? EMPTY : cell);
      layoutAction = 'performance-hazard-release';
    } else if (expressiveImpact || requiredChannels.has('threat') || requiredChannels.has('density')) {
      const hazardCount = moment.commitment === 'must' && Number(moment.strength) >= 0.75 ? 2 : 1;
      const hazardCandidates = Array.from({ length: LANE_COUNT }, (_, lane) => lane)
        .filter((lane) => lane !== targetLane)
        .sort((left, right) => (
          Math.abs(right - targetLane) - Math.abs(left - targetLane)
          || noise(AUDIO_SEED, moment.id, left) - noise(AUDIO_SEED, moment.id, right)
        ));
      for (const lane of hazardCandidates.slice(0, hazardCount)) event.obstacles[lane] = SPIKE;
      event.obstacles[targetLane] = BREAKABLE;
      layoutAction = 'performance-hazard-accent';
    }
    event.directedMomentIds = [...new Set([...(event.directedMomentIds ?? []), moment.id])];
    event.directorMomentType = moment.type;
    event.directorCommitment = moment.commitment;
    event.directorAnchorId = moment.anchorId;
    event.directorLayoutAction = layoutAction;
    event.directorStrength = Number(moment.strength);
    event.pressure = Math.max(event.pressure, Number(moment.strength) || 0);
    realizations.push({
      momentId: moment.id,
      anchorId: moment.anchorId,
      eventTimeSeconds: event.timeSeconds,
      eventOffsetSeconds: Number(Math.abs(event.timeSeconds - moment.timeSeconds).toFixed(5)),
      relativeSlotKey: event.relativeSlotKey,
      pattern: event.pattern,
      layoutAction,
      echoedOccurrenceCount: 1,
    });
  }
  return realizations;
}

function buildPerformanceFlowSections(events) {
  const descriptors = DIRECTED_SCENES.length ? DIRECTED_SCENES : [{
    id: 'performance-scene-001',
    startSeconds: 0,
    endSeconds: analysis.song.durationSeconds,
    state: 'performance',
    pressure: average(events.map((event) => event.flow)),
  }];
  return descriptors.map((scene, index) => {
    const sectionEvents = events.filter((event) => event._sectionIndex === index);
    return {
      motif: 'performance',
      label: '演奏轨迹',
      startSeconds: Number(scene.startSeconds),
      endSeconds: Number(scene.endSeconds),
      slotCount: sectionEvents.length,
      eventCount: sectionEvents.length,
      noteCount: sectionEvents.length,
      targetCellCount: sectionEvents.length,
      dodgeCount: 0,
      spikeCount: sectionEvents.reduce((sum, event) => (
        sum + event.obstacles.filter((cell) => cell === SPIKE).length
      ), 0),
      flow: Number(average(sectionEvents.map((event) => event.flow)).toFixed(3)),
      sectionRole: scene.state ?? 'performance',
      pressure: Number((Number(scene.pressure) || 0).toFixed(3)),
      directorSceneId: scene.id,
    };
  });
}

function buildPerformancePhraseSections(events, performanceScore) {
  const selectedIds = new Set(events.map((event) => event.performanceEventId));
  return (performanceScore.melodicTraces ?? []).flatMap((trace) => {
    const traceEvents = (trace.attackEventIds ?? []).filter((id) => selectedIds.has(id));
    return traceEvents.length ? [{
      index: 0,
      phraseId: trace.phraseId ?? trace.id,
      familyId: trace.phraseId ?? trace.id,
      familyKind: 'performance-trace',
      durationClass: 'measured',
      templateId: null,
      transformId: 'identity',
      sectionRole: 'performance',
      contour: {
        kind: trace.contourKind ?? 'unknown',
        eventCount: traceEvents.length,
      },
      startSeconds: Number(trace.startSeconds),
      endSeconds: Number(trace.endSeconds),
      startBarIndex: null,
      endBarIndex: null,
      barCount: null,
      coreSlotCount: traceEvents.length,
      eventCount: traceEvents.length,
      coreEventCount: traceEvents.length,
      auxiliaryEventCount: 0,
      intensity: Number(average(events.filter((event) => (
        event.melodicTraceId === trace.id
      )).map((event) => event.flow)).toFixed(3)),
    }] : [];
  }).map((section, index) => ({ ...section, index }));
}

function buildPerformanceRealizationReceipt(events, directedMomentRealizations) {
  const receipt = buildRealizationReceipt(events, directedMomentRealizations);
  const phraseIdentities = receipt.phraseIdentities.map((identity) => ({
    ...identity,
    status: 'superseded',
    missingContracts: [],
    supersededByPerformanceScore: true,
    supersessionReason: 'Performance Score is authoritative for Target Row timing and lane intent.',
  }));
  return {
    ...receipt,
    algorithm: 'performance-score-director-receipt-v1',
    kineticCompilerVersion: null,
    targetAuthority: 'performance-score',
    directorAuthority: 'hazard-pressure-color-visual-only',
    phraseIdentities,
    realizedPhraseIdentityCount: 0,
    supersededPhraseIdentityCount: phraseIdentities.length,
    realizedExactPhraseIdentityCount: 0,
    exactPhraseIdentityCoverage: null,
    cues: receipt.cues.map((cue) => ({
      ...cue,
      targetLaneAuthority: 'performance-score',
      directorMayRetarget: false,
    })),
  };
}

function buildPerformanceChart(track, performanceScore) {
  const selection = selectPlayablePerformanceAttacks(performanceScore);
  if (!selection.selected.length) {
    throw new Error('Performance Score contains no playable Attack Events.');
  }
  const events = selection.selected.map(makePerformanceTargetEvent);
  const directedMomentRealizations = decoratePerformanceRowsWithDirector(events);
  const routeAnalysisOptions = {
    startLane: START_LANE,
    startTime: 0,
    secondsPerLane: PERFORMANCE_TRAVEL_SECONDS_PER_LANE,
    laneCount: LANE_COUNT,
    requireCombo: true,
  };
  const routeAnalysis = analyzeRouteGraph(events, routeAnalysisOptions);
  if (!routeAnalysis.feasible || routeAnalysis.deadChoiceCells.length) {
    throw new Error('Performance Score compiler could not preserve a full-combo performance route.');
  }
  events.forEach((event, index) => {
    event._routeLane = routeAnalysis.referenceRoute[index];
  });
  const realizationReceipt = buildPerformanceRealizationReceipt(events, directedMomentRealizations);
  const spikeCount = events.reduce((sum, event) => (
    sum + event.obstacles.filter((cell) => cell === SPIKE).length
  ), 0);
  let totalMovement = 0;
  let maximumMovement = 0;
  let priorLane = START_LANE;
  for (const event of events) {
    const movement = Math.abs(event._routeLane - priorLane);
    totalMovement += movement;
    maximumMovement = Math.max(maximumMovement, movement);
    priorLane = event._routeLane;
  }
  const selectedPerformanceEventIds = events.flatMap((event) => event.performanceEventIds);
  const compiledPerformanceScore = {
    ...performanceScore,
    diagnostics: {
      ...(performanceScore.diagnostics ?? {}),
      compilation: {
        compiler: PERFORMANCE_ROW_COMPILER_VERSION,
        timingPolicy: 'measured-attack-times-without-beat-grid-quantization',
        lanePolicy: 'measured-local-pitch-contour-without-director-retargeting',
        inputAttackEventCount: selection.input.length,
        selectedTargetRowCount: events.length,
        representedAttackEventCount: selectedPerformanceEventIds.length,
        mergedAttackEventCount: selection.mergedGroups.reduce((sum, group) => (
          sum + group.mergedPerformanceEventIds.length - 1
        ), 0),
        omittedAttackEventCount: selection.omitted.length,
        mergedGroups: selection.mergedGroups,
        omittedAttackEvents: selection.omitted,
      },
    },
  };
  const emptySweepMetrics = {
    fullWidthSweepCount: 0,
    alternatingEdgeRunCount: 0,
    edgeToEdgeTransitionCount: 0,
    forcedEdgeTargetCount: 0,
    gestures: [],
    policy: 'Performance rows use measured Attack Events; Director decoration never creates target sweeps.',
  };
  return {
    events: events.map((event) => {
      const { _routeLane, ...withoutRoute } = event;
      return stripInternalFields(withoutRoute);
    }),
    targetCount: events.length,
    choiceRowCount: events.length,
    multiTargetChoiceRowCount: 0,
    maximumConsecutiveMultiTargetRows: 0,
    fullRouteBranchCount: 0,
    deadBranchTargetCellCount: 0,
    prunedDeadBranchTargetCellCount: 0,
    maximumConsecutiveFullRouteBranches: 0,
    pathCountCapped: 1,
    consecutiveChoicePairCount: 0,
    wideChoiceRowCount: 0,
    fullWidthSweepCount: 0,
    edgeToEdgeTransitionCount: 0,
    strongSweepMetrics: emptySweepMetrics,
    dodgeCount: 0,
    guidanceRowCount: spikeCount,
    spikeCount,
    edgeGateCount: 0,
    averageMovement: totalMovement / events.length,
    maximumMovement,
    motifCounts: { performance: events.length },
    flowSections: buildPerformanceFlowSections(events),
    phraseSections: buildPerformancePhraseSections(events, performanceScore),
    barSections: [],
    familyTemplates: [],
    repeatConsistency: {
      repeatedFamilyGroupCount: 0,
      exactGroupCount: 0,
      exactRatio: null,
      groups: [],
      appliedRangeLinks: [],
      policy: 'Repeated performances retain measured Attack Event timing and pitch lanes; layout templates do not overwrite them.',
    },
    realizationReceipt,
    mGestureSummary: { count: 0, identityCount: 0, mirrorCount: 0, windows: [] },
    melodyBurst: null,
    musicalStructureAlgorithm: analysis.musicalStructure?.algorithm ?? 'performance-score',
    musicalStructureTimingPolicy: analysis.musicalStructure?.timingPolicy
      ?? 'measured-performance-events',
    climaxTimeSeconds: Number(([...DIRECTED_MOMENTS]
      .sort((left, right) => Number(right.strength) - Number(left.strength))[0]?.timeSeconds
      ?? analysis.song.durationSeconds * 0.8).toFixed(3)),
    auxiliaryCandidateCount: 0,
    auxiliaryNoteCount: 0,
    rejectedAuxiliaryCount: selection.omitted.length,
    densityFillCount: 0,
    solidDensityFillCount: 0,
    compactDensityFillCount: 0,
    maximumMelodyRun: Math.max(0, ...(performanceScore.melodicTraces ?? []).map((trace) => (
      (trace.attackEventIds ?? []).filter((id) => selectedPerformanceEventIds.includes(id)).length
    ))),
    layoutIntentProfile: {
      algorithm: 'performance-score-to-playable-row-intent-v1',
      audioFingerprint: AUDIO_SEED,
      songProfile: LAYOUT_INTENT.songProfile,
      sections: LAYOUT_INTENT.sections,
    },
    layoutAlgorithm: PERFORMANCE_ROW_COMPILER_VERSION,
    performanceScore: compiledPerformanceScore,
  };
}

function buildEvents(track) {
  if (PERFORMANCE_SCORE?.kind === 'performance-score') {
    return buildPerformanceChart(track, PERFORMANCE_SCORE);
  }
  const sourceEvents = track.events.filter((event) => (
    event.timeSeconds >= MIN_PLAYABLE_TIME
    && event.timeSeconds <= analysis.song.durationSeconds - OUTRO_MARGIN
  ));
  if (!sourceEvents.length) throw new Error(`Rhythm track ${track.id} contains no playable events.`);
  const flowAnalysis = buildFlowValues(sourceEvents);
  const flowValues = flowAnalysis.values;
  const declaredPeak = LAYOUT_INTENT.sections
    .filter((section) => section.role === 'peak')
    .sort((left, right) => right.pressure - left.pressure)[0];
  const peakIndices = sourceEvents.flatMap((event, index) => (
    declaredPeak
    && event.timeSeconds >= declaredPeak.startSeconds
    && event.timeSeconds < declaredPeak.endSeconds
      ? [index]
      : []
  ));
  const climaxPool = peakIndices.length ? peakIndices : sourceEvents.map((_, index) => index);
  const climaxIndex = climaxPool.reduce((best, index) => (
    flowAnalysis.climaxScores[index] > flowAnalysis.climaxScores[best] ? index : best
  ), climaxPool[0]);
  const climaxTime = sourceEvents[climaxIndex]?.timeSeconds ?? analysis.song.durationSeconds * 0.85;
  const seed = `${AUDIO_SEED}:${track.id}:responsive-choice-structure-v9`;
  const structure = normalizeMusicalStructure(sourceEvents);
  const introEndSeconds = structure.phrases.find((phrase) => phrase.startBarIndex === 0)?.endSeconds
    ?? BEAT_SECONDS * 32;
  const phraseContexts = buildPhraseContexts(structure, sourceEvents, flowValues);
  // The structure model is aligned to Beat This beats. Comparator tracks have
  // different, sometimes bursty event counts, so they keep the same real bar
  // boundaries but compile an occurrence-local template. Exact cross-occurrence
  // reuse is asserted on the selected Beat This chart.
  if (track.id !== 'beat-this') {
    for (const phrase of phraseContexts) {
      phrase.analysisFamilyId = phrase.analysisFamilyId ?? phrase.familyId;
      phrase.familyId = `${phrase.familyId}-${phrase.id}`;
      phrase.durationClass = `${phrase.durationClass}-${phrase.id}`;
    }
  }
  const selectedAuxiliary = track.id === 'beat-this'
    ? buildAuxiliaryCandidates(sourceEvents, flowValues, seed, climaxTime)
    : [];

  const templateGroups = new Map();
  for (const phrase of phraseContexts) {
    const key = `${phrase.familyId}|${phrase.durationClass}`;
    if (!templateGroups.has(key)) templateGroups.set(key, { key, phrases: [] });
    templateGroups.get(key).phrases.push(phrase);
  }
  for (const group of templateGroups.values()) {
    group.intent = group.phrases
      .map((phrase) => INTENT_FAMILY_BY_PHRASE_ID.get(phrase.id))
      .find(Boolean) ?? null;
  }

  const climaxGroup = [...templateGroups.values()].find((group) => (
    group.phrases.some((phrase) => climaxTime >= phrase.startSeconds && climaxTime < phrase.endSeconds)
  ));
  const familyTemplates = [];
  const commitmentRank = { may: 0, should: 1, must: 2 };
  const directionByGroup = new Map([...templateGroups.values()].map((group) => {
    const directedIdentity = directedIdentityForPhrases(group.phrases);
    const moments = DIRECTED_MOMENTS.filter((moment) => group.phrases.some((phrase) => (
      moment.timeSeconds >= phrase.startSeconds && moment.timeSeconds < phrase.endSeconds
    ))).sort((left, right) => (
      (commitmentRank[right.commitment] ?? 0) - (commitmentRank[left.commitment] ?? 0)
      || Number(right.strength) - Number(left.strength)
      || Number(left.timeSeconds) - Number(right.timeSeconds)
    ));
    return [group, { directedIdentity, moments, strongestMoment: moments[0] ?? null }];
  }));
  const orderedTemplateGroups = [...templateGroups.values()].sort((left, right) => (
    left.phrases[0].startSeconds - right.phrases[0].startSeconds
    || left.key.localeCompare(right.key)
  ));
  for (const group of orderedTemplateGroups) {
    const prototype = group.phrases[0];
    const familyId = prototype.familyId;
    const durationClass = prototype.durationClass;
    const direction = directionByGroup.get(group);
    const directedIdentity = direction?.directedIdentity ?? null;
    const kineticForm = directedIdentity?.kineticForm ?? null;
    const verbs = new Set(Array.isArray(kineticForm?.verbs) ? kineticForm.verbs : []);
    const strongestMoment = direction?.strongestMoment ?? null;
    const pressure = average(group.phrases.map((phrase) => phrase.intensity));
    let mVariant = null;
    let mStartBar = null;
    let mMirrorPreference = null;
    let mDesiredSectionRoles = [];
    const momentSupportsM = strongestMoment
      && ['must', 'should'].includes(strongestMoment.commitment)
      && Number(strongestMoment.strength) >= 0.78
      && ['impact', 'arrival', 'rupture'].includes(strongestMoment.type);
    const formSupportsM = kineticForm?.motion?.kind === 'oscillating'
      && (verbs.has('reverse') || verbs.has('strike'));
    if (momentSupportsM && formSupportsM && prototype.items.length >= M_GESTURE_SLOT_OFFSETS.at(-1) + 1) {
      const sourcePhrase = group.phrases.find((phrase) => (
        strongestMoment.timeSeconds >= phrase.startSeconds && strongestMoment.timeSeconds < phrase.endSeconds
      )) ?? prototype;
      const relativePosition = clamp(
        (strongestMoment.timeSeconds - sourcePhrase.startSeconds)
          / Math.max(0.001, sourcePhrase.endSeconds - sourcePhrase.startSeconds),
        0,
        1,
      );
      mVariant = 'directed';
      mMirrorPreference = Number(kineticForm?.motion?.slope) < 0;
      mDesiredSectionRoles = [directedSceneAt(strongestMoment.timeSeconds)?.state ?? 'drive'];
      mStartBar = clamp(
        Math.round(relativePosition * Math.max(0, prototype.barCount - 2)),
        0,
        Math.max(0, prototype.barCount - 2),
      );
    }
    const wavePlan = !mVariant
      && prototype.barCount >= 2
      && prototype.items.length >= 5
      && pressure >= 0.48
      && kineticForm?.motion?.kind === 'oscillating'
      && (verbs.has('drift') || verbs.has('bend') || verbs.has('reverse'))
      ? { mirror: Number(kineticForm?.motion?.slope) < 0 }
      : null;
    const fullWidthPlan = strongestMoment?.commitment === 'must'
      && Number(strongestMoment.strength) >= 0.8
      && ['impact', 'rupture'].includes(strongestMoment.type)
      && verbs.has('strike')
      && prototype.items.length >= MOTIFS['full-width-sweep'].minimumLength
      ? { maximumGestures: 1, sourceMomentId: strongestMoment.id }
      : null;
    const template = makeCanonicalTemplate({
      key: group.key,
      familyId,
      durationClass,
      phrases: group.phrases,
      trackId: track.id,
      mVariant,
      mStartBar,
      mMirrorPreference,
      mDesiredSectionRoles,
      bars: structure.bars,
      familyIntent: group.intent,
      directedIdentity,
      wavePlan,
      fullWidthPlan,
      difficultyBoost: strongestMoment?.commitment === 'must'
        ? clamp(Number(strongestMoment.strength) * 0.12, 0, 0.12)
        : 0,
      auxiliaryCandidates: selectedAuxiliary,
    });
    group.template = template;
    familyTemplates.push(template);
  }

  const occurrenceTemplates = new Map();
  for (const group of templateGroups.values()) {
    const directedIdentity = DIRECTED_IDENTITIES.find((identity) => (
      identity.id === group.template.directedIdentityId
    )) ?? null;
    for (const phrase of group.phrases) {
      occurrenceTemplates.set(phrase.id, group.template.slots.map((slot, slotIndex) => (
        attachCanonicalTemplateProof(
          slot,
          directedIdentity,
          group.template.slots.length <= 1 ? 0 : slotIndex / (group.template.slots.length - 1),
        )
      )));
    }
  }
  const structuralReuseLinks = track.id === 'beat-this'
    ? applyStructuralReuse(
      structure,
      phraseContexts,
      occurrenceTemplates,
      templateGroups,
    )
    : [];
  const directedIdentityReuseLinks = compileDirectedPhraseIdentities(
    phraseContexts,
    occurrenceTemplates,
  );
  relabelTruncatedNamedGestureFragments(occurrenceTemplates);
  const appliedReuseLinks = [...structuralReuseLinks, ...directedIdentityReuseLinks];
  const melodyBurst = prepareClimaxMelodyBurst({
    trackId: track.id,
    candidates: selectedAuxiliary,
    climaxTime,
    phraseContexts,
    occurrenceTemplates,
    templateGroups,
  });

  const flowSections = [];
  const phraseSections = [];
  const barSections = [];
  const slotSectionIndex = new Map();
  const slotBarSectionIndex = new Map();
  const motifCounts = {};
  for (const phrase of phraseContexts) {
    const specs = occurrenceTemplates.get(phrase.id);
    let slotIndex = 0;
    while (slotIndex < specs.length) {
      const blockId = specs[slotIndex].blockId;
      let blockEnd = slotIndex + 1;
      while (blockEnd < specs.length && specs[blockEnd].blockId === blockId) blockEnd += 1;
      const blockSpecs = specs.slice(slotIndex, blockEnd);
      const blockItems = phrase.items.slice(slotIndex, blockEnd);
      const firstSpec = blockSpecs[0];
      const sectionIndex = flowSections.length;
      const section = {
        motif: firstSpec.pattern,
        label: MOTIFS[firstSpec.pattern]?.label ?? firstSpec.pattern,
        startSeconds: Number(blockItems[0].sourceEvent.timeSeconds.toFixed(3)),
        endSeconds: Number(blockItems[blockItems.length - 1].sourceEvent.timeSeconds.toFixed(3)),
        slotCount: blockSpecs.length,
        eventCount: 0,
        noteCount: 0,
        targetCellCount: 0,
        dodgeCount: 0,
        spikeCount: 0,
        flow: Number(average(blockItems.map((item) => item.flow)).toFixed(3)),
        familyId: firstSpec.familyId,
        phraseId: phrase.id,
        templateId: firstSpec.templateId,
        transformId: firstSpec.transformId,
        barIndex: blockItems[0].barIndex,
        barInPhrase: blockItems[0].barInPhrase,
        barRole: firstSpec.barRole,
        sectionRole: firstSpec.sectionRole,
        pressure: Number((firstSpec.pressure ?? average(blockItems.map((item) => item.flow))).toFixed(3)),
        downbeatCue: blockSpecs.some((spec) => spec.downbeatCue),
        slotTimes: blockItems.map((item) => Number(item.sourceEvent.timeSeconds.toFixed(5))),
        templateRows: blockSpecs.map((spec) => rowKey(spec.obstacles)),
        ...(firstSpec.pattern === 'm' ? {
          variant: firstSpec.variant,
          mirrored: firstSpec.transformId === 'mirror',
          orientation: firstSpec.transformId === 'mirror'
            ? 'right-edge-left-edge-right-edge-left-edge'
            : 'left-edge-right-edge-left-edge-right-edge',
          gateCount: blockSpecs.filter((spec) => spec.emit && spec.kind === 'dodge').length,
          choiceRowCount: blockSpecs.filter((spec) => spec.emit && spec.kind === 'target').length,
          gestureRows: blockSpecs.flatMap((spec, index) => spec.emit ? [{
            timeSeconds: Number(blockItems[index].sourceEvent.timeSeconds.toFixed(5)),
            kind: spec.kind === 'dodge' ? 'gate' : 'choice',
            row: rowKey(spec.obstacles),
          }] : []),
        } : {}),
        ...(firstSpec.pattern === 'wave' ? {
          mirrored: firstSpec.transformId === 'mirror',
        } : {}),
      };
      flowSections.push(section);
      motifCounts[firstSpec.pattern] = (motifCounts[firstSpec.pattern] ?? 0) + 1;
      for (let offset = slotIndex; offset < blockEnd; offset += 1) {
        slotSectionIndex.set(`${phrase.id}:${offset}`, sectionIndex);
      }
      slotIndex = blockEnd;
    }
    const phraseGroup = templateGroups.get(`${phrase.familyId}|${phrase.durationClass}`);
    phraseSections.push({
      index: phraseSections.length,
      phraseId: phrase.id,
      familyId: phrase.familyId,
      analysisFamilyId: phrase.analysisFamilyId ?? phrase.familyId,
      familyKind: phrase.familyKind,
      durationClass: phrase.durationClass,
      templateId: phraseGroup.template.id,
      transformId: phraseGroup.template.transformId,
      sectionRole: INTENT_SECTION_BY_INDEX.get(phrase.sectionIndex)?.role
        ?? phraseGroup.intent?.dominantSectionRole
        ?? 'drive',
      contour: phraseGroup.intent?.contour ?? null,
      startSeconds: Number(phrase.startSeconds.toFixed(3)),
      endSeconds: Number(phrase.endSeconds.toFixed(3)),
      startBarIndex: phrase.startBarIndex,
      endBarIndex: phrase.endBarIndex,
      barCount: phrase.barCount,
      coreSlotCount: phrase.items.length,
      eventCount: 0,
      coreEventCount: 0,
      auxiliaryEventCount: 0,
      intensity: Number(phrase.intensity.toFixed(3)),
    });
    for (let barInPhrase = 0; barInPhrase < phrase.barCount; barInPhrase += 1) {
      const slotIndices = phrase.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.barInPhrase === barInPhrase)
        .map(({ index }) => index);
      if (!slotIndices.length) continue;
      const barSpecs = slotIndices.map((index) => specs[index]);
      const barItems = slotIndices.map((index) => phrase.items[index]);
      const cueSpec = barSpecs.find((spec) => spec.downbeatCue) ?? barSpecs[0];
      const barSectionIndex = barSections.length;
      barSections.push({
        index: barSectionIndex,
        phraseId: phrase.id,
        familyId: cueSpec.familyId,
        templateId: cueSpec.templateId,
        transformId: cueSpec.transformId,
        barIndex: barItems[0].barIndex,
        barInPhrase,
        barRole: cueSpec.barRole,
        sectionRole: cueSpec.sectionRole,
        pressure: Number((cueSpec.pressure ?? average(barItems.map((item) => item.flow))).toFixed(3)),
        startSeconds: Number(barItems[0].sourceEvent.timeSeconds.toFixed(3)),
        endSeconds: Number(barItems[barItems.length - 1].sourceEvent.timeSeconds.toFixed(3)),
        downbeatCue: true,
        cueRole: cueSpec.emit ? cueSpec.role : 'intentional-travel-rest',
        cueRelativeSlotKey: cueSpec.relativeSlotKey,
        slotCount: barSpecs.length,
        slotTimes: barItems.map((item) => Number(item.sourceEvent.timeSeconds.toFixed(5))),
        templateRows: barSpecs.map((spec) => rowKey(spec.obstacles)),
        motifs: [...new Set(barSpecs.map((spec) => spec.pattern))],
        eventCount: 0,
        noteCount: 0,
        targetCellCount: 0,
        dodgeCount: 0,
        spikeCount: 0,
      });
      for (const index of slotIndices) slotBarSectionIndex.set(`${phrase.id}:${index}`, barSectionIndex);
    }
  }

  const events = [];
  for (const phrase of phraseContexts) {
    const specs = occurrenceTemplates.get(phrase.id);
    for (let slotIndex = 0; slotIndex < phrase.items.length; slotIndex += 1) {
      const spec = specs[slotIndex];
      if (!spec.emit) continue;
      const item = phrase.items[slotIndex];
      const sectionIndex = slotSectionIndex.get(`${phrase.id}:${slotIndex}`);
      const event = makeInternalEvent({
        timeSeconds: item.sourceEvent.timeSeconds,
        obstacles: [...spec.obstacles],
        strength: item.sourceEvent.confidence,
        source: item.sourceEvent.sources?.join('+') ?? track.id,
        kind: spec.kind,
        pattern: spec.pattern,
        flow: item.flow,
        sectionIndex,
        role: spec.role,
        allowedLanes: spec.allowedLanes,
        preferredLane: spec.preferredLane,
      });
      Object.assign(event, {
        familyId: spec.familyId,
        phraseId: phrase.id,
        barIndex: item.barIndex,
        barInPhrase: item.barInPhrase,
        beatInBar: item.beatInBar,
        downbeatCue: spec.downbeatCue,
        barRole: spec.barRole,
        sectionRole: spec.sectionRole,
        pressure: Number((spec.pressure ?? item.flow).toFixed(3)),
        relativeSlotKey: spec.relativeSlotKey,
        occurrenceSlotKey: `${phrase.id}:slot-${slotIndex}`,
        layer: 'core',
        templateId: spec.templateId,
        transformId: spec.transformId,
        barModule: slotBarSectionIndex.get(`${phrase.id}:${slotIndex}`),
        choiceLaneCount: spec.kind === 'target'
          ? spec.obstacles.filter((cell) => cell === BREAKABLE).length
          : 0,
        routeBranch: Boolean(spec.routeBranch),
        ...(Array.isArray(spec.directedIdentityIds) && spec.directedIdentityIds.length ? {
          directedIdentityIds: [...spec.directedIdentityIds],
          kineticCompilerVersion: spec.kineticCompilerVersion,
          kineticProofs: spec.kineticProofs.map((proof) => ({ ...proof })),
        } : {}),
        ...(spec.sweepGestureId ? {
          sweepGestureId: spec.sweepGestureId,
          sweepPhase: spec.sweepPhase,
          sweepAnchorIndex: spec.sweepAnchorIndex,
          sweepHazardMode: spec.sweepHazardMode,
          travelSecondsPerLane: spec.travelSecondsPerLane,
        } : {}),
        ...(spec.reusedFrom ? { reusedFrom: spec.reusedFrom, reuseLinkId: spec.reuseLinkId } : {}),
      });
      events.push(event);
    }
  }
  let combined = [...events].sort((left, right) => left.timeSeconds - right.timeSeconds);
  if (!solveLaneRoute(combined)) {
    const failureIndex = combined.findIndex((_, index) => !solveLaneRoute(combined.slice(0, index + 1)));
    const failed = combined[failureIndex];
    const prior = combined[failureIndex - 1];
    throw new Error(
      `Canonical phrase templates are not reachable for ${track.id} at ${failed?.timeSeconds}s `
      + `(slot=${failed?.occurrenceSlotKey}, bar=${failed?.barInPhrase}, pattern=${failed?.pattern}, `
      + `kind=${failed?.kind}, row=${rowKey(failed?.obstacles ?? [])}, allowed=${failed?._allowedLanes?.join(',')}, `
      + `lane=${failed?._preferredLane}, `
      + `prior=${prior?.timeSeconds}s/${prior?.barInPhrase}/${prior?._preferredLane}`
      + `/allowed-${prior?._allowedLanes?.join(',')}, `
      + `keys=${prior?.relativeSlotKey}->${failed?.relativeSlotKey}).`,
    );
  }

  const auxEntries = [];
  for (const candidate of selectedAuxiliary) {
    const phrase = phraseAtTime(phraseContexts, candidate.timeSeconds);
    if (!phrase) continue;
    const specs = occurrenceTemplates.get(phrase.id);
    let previousSlot = -1;
    for (let index = 0; index < phrase.items.length; index += 1) {
      if (phrase.items[index].sourceEvent.timeSeconds < candidate.timeSeconds) previousSlot = index;
      else break;
    }
    if (previousSlot < 0 || previousSlot >= phrase.items.length - 1) continue;
    const before = phrase.items[previousSlot].sourceEvent.timeSeconds;
    const after = phrase.items[previousSlot + 1].sourceEvent.timeSeconds;
    const phase = clamp((candidate.timeSeconds - before) / Math.max(1e-6, after - before), 0, 1);
    // The key classifies the musical interval only; the emitted event keeps the
    // detector's exact timestamp and phase. Repeated performances often place
    // the same ornament on opposite sides of the interval midpoint by a few
    // milliseconds, so splitting early/late would create false mismatches.
    const phaseBucket = 'subdivision';
    const anchorSpec = specs[previousSlot];
    const nextSpec = specs[previousSlot + 1];
    // The six emitted rows are the gesture. Subdivisions immediately before,
    // inside, or immediately after it would turn the visible M back into an
    // unrelated 9–10 row burst.
    if (
      ['m', 'full-width-sweep', 'wave'].includes(anchorSpec.pattern)
      || ['m', 'full-width-sweep', 'wave'].includes(nextSpec?.pattern)
    ) continue;
    const canonicalKey = `${anchorSpec.templateId}:${anchorSpec.relativeSlotKey}:after-${phaseBucket}`;
    const targetSpec = [...specs.slice(0, previousSlot + 1)].reverse().find((spec) => spec.kind === 'target')
      ?? specs.slice(previousSlot + 1).find((spec) => spec.kind === 'target');
    const lane = targetSpec?.preferredLane ?? START_LANE;
    const isOverlay = Math.abs(candidate.timeSeconds - climaxTime) <= CLIMAX_RADIUS_SECONDS;
    auxEntries.push({
      candidate,
      phrase,
      previousSlot,
      canonicalKey,
      lane,
      layer: isOverlay ? 'overlay' : 'auxiliary-common',
      spec: anchorSpec,
    });
  }

  const expectedOccurrences = new Map();
  for (const phrase of phraseContexts) {
    const specs = occurrenceTemplates.get(phrase.id);
    for (const spec of specs) {
      const key = `${spec.templateId}:${spec.relativeSlotKey}`;
      if (!expectedOccurrences.has(key)) expectedOccurrences.set(key, new Set());
      expectedOccurrences.get(key).add(phrase.id);
    }
  }
  const auxiliaryGroups = new Map();
  for (const entry of auxEntries) {
    if (!auxiliaryGroups.has(entry.canonicalKey)) auxiliaryGroups.set(entry.canonicalKey, []);
    auxiliaryGroups.get(entry.canonicalKey).push(entry);
  }

  const acceptedAuxiliary = [];
  const commonBatches = [];
  for (const [canonicalKey, entries] of auxiliaryGroups) {
    const bestByPhrase = new Map();
    for (const entry of entries) {
      const current = bestByPhrase.get(entry.phrase.id);
      if (!current || entry.candidate.quality > current.candidate.quality) bestByPhrase.set(entry.phrase.id, entry);
    }
    const sample = entries[0];
    const anchorOccurrenceKey = `${sample.spec.templateId}:${sample.spec.relativeSlotKey}`;
    const expected = expectedOccurrences.get(anchorOccurrenceKey) ?? new Set([sample.phrase.id]);
    if (expected.size > 1 && [...expected].every((phraseId) => bestByPhrase.has(phraseId))) {
      // Consensus is part of the canonical arrangement even when one return
      // happens near the climax. Only additional, non-consensus peaks become
      // overlays; otherwise the repeated phrase would silently lose a row.
      commonBatches.push([...expected].map((phraseId) => ({
        ...bestByPhrase.get(phraseId),
        layer: 'auxiliary-common',
      })));
    } else if (expected.size === 1) {
      // A unique phrase has no sibling whose arrangement can be contradicted,
      // so it may retain every distinct real peak in the interval. Repeated
      // families never receive occurrence-only overlays.
      for (const entry of entries) {
        entry.adaptiveLane = true;
        commonBatches.push([entry]);
      }
    }
  }

  const templateIntensityById = new Map(familyTemplates.map((template) => [template.id, template.intensity]));
  const canonicalAuxiliaryRows = new Map();
  const preserveMotifSurvival = (row, motif, transformId, preferredLane) => {
    if (motif !== 'c') return row;
    const campingEdge = transformId === 'mirror' ? 0 : LANE_COUNT - 1;
    if (row[campingEdge] === SPIKE) row[campingEdge] = EMPTY;
    widenIsolatedMiddleGaps(row, preferredLane);
    return row;
  };
  const auxiliaryRowFor = (entry) => {
    if (entry.layer === 'overlay') {
      return preserveMotifSurvival(
        makeAuxiliaryRow(entry.lane, entry.candidate.flow, entry.canonicalKey, entry.layer),
        entry.spec.pattern,
        entry.spec.transformId,
        entry.lane,
      );
    }
    if (!canonicalAuxiliaryRows.has(entry.canonicalKey)) {
      const templateIntensity = templateIntensityById.get(entry.spec.templateId) ?? entry.candidate.flow;
      const canonicalIntensity = entry.phrase.startSeconds < introEndSeconds
        ? templateIntensity
        : templateIntensity;
      canonicalAuxiliaryRows.set(entry.canonicalKey, preserveMotifSurvival(
        makeAuxiliaryRow(entry.lane, canonicalIntensity, entry.canonicalKey, 'auxiliary-common'),
        entry.spec.pattern,
        entry.spec.transformId,
        entry.lane,
      ));
    }
    return [...canonicalAuxiliaryRows.get(entry.canonicalKey)];
  };
  const toAuxEvent = (entry) => {
    const item = entry.phrase.items[entry.previousSlot];
    const sectionIndex = slotSectionIndex.get(`${entry.phrase.id}:${entry.previousSlot}`);
    const event = makeInternalEvent({
      timeSeconds: entry.candidate.timeSeconds,
      obstacles: auxiliaryRowFor(entry),
      strength: entry.candidate.confidence,
      source: entry.candidate.detectorSources.join('+'),
      kind: 'target',
      pattern: `${entry.spec.pattern}-melody`,
      flow: entry.candidate.flow,
      sectionIndex,
      role: entry.layer === 'overlay' ? 'climax-overlay-hit' : 'melody-hit',
      allowedLanes: entry.layer === 'overlay' || entry.adaptiveLane ? [0, 1, 2, 3, 4] : [entry.lane],
      preferredLane: entry.lane,
    });
    Object.assign(event, {
      familyId: entry.spec.familyId,
      phraseId: entry.phrase.id,
      barIndex: item.barIndex,
      barInPhrase: item.barInPhrase,
      beatInBar: item.beatInBar,
      downbeatCue: false,
      barRole: entry.spec.barRole,
      relativeSlotKey: entry.canonicalKey,
      occurrenceSlotKey: `${entry.phrase.id}:aux-${entry.candidate.groupIndex}`,
      layer: entry.layer,
      templateId: entry.spec.templateId,
      transformId: entry.spec.transformId,
      barModule: slotBarSectionIndex.get(`${entry.phrase.id}:${entry.previousSlot}`),
      _adaptiveLane: Boolean(entry.adaptiveLane),
    });
    return event;
  };

  commonBatches.sort((left, right) => average(right.map((entry) => entry.candidate.flow))
    - average(left.map((entry) => entry.candidate.flow)));
  let acceptedIntroAuxiliary = 0;
  for (const batch of commonBatches) {
    const introCount = batch.filter((entry) => entry.candidate.timeSeconds < introEndSeconds).length;
    if (introCount && acceptedIntroAuxiliary + introCount > 3) continue;
    const batchEvents = batch.map(toAuxEvent);
    const trial = [...combined, ...batchEvents].sort((left, right) => left.timeSeconds - right.timeSeconds);
    if (solveLaneRoute(trial)) {
      combined = trial;
      acceptedAuxiliary.push(...batchEvents);
      acceptedIntroAuxiliary += introCount;
    }
  }
  if (!solveLaneRoute(combined)) throw new Error(`Unable to build a full-combo route for ${track.id}.`);
  const routeAnalysisOptions = {
    startLane: START_LANE,
    startTime: 0,
    secondsPerLane: FLOW_MODE.minTravelSecondsPerLane,
    laneCount: LANE_COUNT,
    requireCombo: true,
  };
  const adaptiveProxy = combined.map((event) => {
    if (event.layer !== 'overlay' && !event._adaptiveLane) return event;
    const allowed = eventAllowedLanes(event);
    return {
      ...event,
      obstacles: Array.from(
        { length: LANE_COUNT },
        (_, lane) => allowed.includes(lane) ? BREAKABLE : EMPTY,
      ),
    };
  });
  const adaptiveRouteGraph = analyzeRouteGraph(adaptiveProxy, routeAnalysisOptions);
  if (!adaptiveRouteGraph.feasible) {
    throw new Error(`Adaptive melody rows have no full-combo route for ${track.id}.`);
  }

  const materializeAdaptiveRows = (useEveryViableLane = false) => combined.forEach((event, index) => {
    if (event.layer === 'overlay' || event._adaptiveLane) {
      const adaptiveLayer = event.layer === 'overlay' ? 'overlay' : 'auxiliary-common';
      const adaptiveIntensity = event.timeSeconds < introEndSeconds
        ? 0
        : event.flow;
      const viableLanes = adaptiveRouteGraph.globallyViableLanesByRow[index];
      const guideLane = viableLanes[Math.min(
        viableLanes.length - 1,
        Math.floor(noise(AUDIO_SEED, event.relativeSlotKey, event.timeSeconds, 'adaptive-guide')
          * viableLanes.length),
      )];
      const desiredChoiceCount = Math.min(
        viableLanes.length,
        adaptiveIntensity >= 0.62 ? 3 : 2,
      );
      const choiceLanes = useEveryViableLane
        ? viableLanes
        : chooseSpreadLanes(
          viableLanes,
          guideLane,
          Math.max(1, desiredChoiceCount),
          `${event.relativeSlotKey}:${event.timeSeconds}:adaptive-choice`,
        );
      const row = preserveMotifSurvival(
        makeAuxiliaryRow(
          guideLane,
          adaptiveIntensity,
          event.layer === 'overlay' ? `${event.relativeSlotKey}:${event.timeSeconds}` : event.relativeSlotKey,
          adaptiveLayer,
        ),
        event.pattern.replace(/-melody$/, ''),
        event.transformId,
        guideLane,
      );
      for (let lane = 0; lane < LANE_COUNT; lane += 1) {
        if (row[lane] === BREAKABLE) row[lane] = EMPTY;
      }
      for (const lane of choiceLanes) row[lane] = BREAKABLE;
      widenIsolatedMiddleGaps(row, guideLane);
      event.obstacles = row;
      event._allowedLanes = choiceLanes;
      event._preferredLane = choiceLanes.length === 1 ? choiceLanes[0] : null;
      if (choiceLanes.length > 1) {
        event.role = event.layer === 'overlay' ? 'climax-overlay-choice' : 'melody-choice';
      }
    }
    event.choiceLaneCount = event.kind === 'target'
      ? event.obstacles.filter((cell) => cell === BREAKABLE).length
      : 0;
    event.routeBranch = event.choiceLaneCount > 1;
  });
  materializeAdaptiveRows();
  let routeChoiceAnalysis = analyzeRouteGraph(combined, routeAnalysisOptions);
  if (routeChoiceAnalysis.deadChoiceCells.length) {
    // A narrowed set can make two individually valid branches conflict across
    // adjacent melody rows. Expanding only adaptive rows to their complete
    // globally viable sets restores symmetry without moving any audio event.
    materializeAdaptiveRows(true);
    routeChoiceAnalysis = analyzeRouteGraph(combined, routeAnalysisOptions);
  }
  const directedMomentRealizations = applyDirectedMomentEmphasis(combined);
  routeChoiceAnalysis = analyzeRouteGraph(combined, routeAnalysisOptions);
  const routePruning = pruneDeadChoiceCells(combined, routeChoiceAnalysis, routeAnalysisOptions);
  routeChoiceAnalysis = routePruning.analysis;
  if (!routeChoiceAnalysis.feasible || routeChoiceAnalysis.deadChoiceCells.length) {
    routeChoiceAnalysis = repairExactEquivalenceRoutes(combined, routeAnalysisOptions);
  }
  for (let refinement = 0; refinement < 4 && routeChoiceAnalysis.deadChoiceCells.length; refinement += 1) {
    const supplementalPruning = pruneDeadChoiceCells(combined, routeChoiceAnalysis, routeAnalysisOptions);
    routePruning.prunedCellCount += supplementalPruning.prunedCellCount;
    routeChoiceAnalysis = supplementalPruning.analysis;
    if (!routeChoiceAnalysis.feasible || routeChoiceAnalysis.deadChoiceCells.length) {
      routeChoiceAnalysis = repairExactEquivalenceRoutes(combined, routeAnalysisOptions);
    }
  }
  routeChoiceAnalysis = ensureForkConvergeTopology(combined, routeAnalysisOptions);
  if (!routeChoiceAnalysis.feasible) {
    throw new Error(`Shared route analysis found no full-combo route for ${track.id}.`);
  }
  if (routeChoiceAnalysis.deadChoiceCells.length) {
    const firstDeadCell = routeChoiceAnalysis.deadChoiceCells[0];
    const deadEvent = combined[firstDeadCell.rowIndex];
    throw new Error(
      `Chart ${track.id} exposes ${routeChoiceAnalysis.deadChoiceCells.length} dead Choice Cells; `
      + `first is row ${firstDeadCell.rowIndex}, lane ${firstDeadCell.lane}, `
      + `time ${deadEvent?.timeSeconds}s, pattern ${deadEvent?.pattern}, layer ${deadEvent?.layer}.`,
    );
  }
  const densityPlan = addDensityFillRows(combined);
  combined = densityPlan.events;
  routeChoiceAnalysis = analyzeRouteGraph(combined, routeAnalysisOptions);
  const realizationReceipt = buildRealizationReceipt(combined, directedMomentRealizations);
  const unrealizedCues = realizationReceipt.cues.filter((cue) => cue.status !== 'realized');
  if (unrealizedCues.length) {
    throw new Error(
      `Director cues were not fully realized for ${track.id}: `
      + unrealizedCues.map((cue) => `${cue.momentId}[${cue.missingChannels.join(',')}]`).join('; '),
    );
  }
  const unrealizedPhraseIdentities = realizationReceipt.phraseIdentities.filter((identity) => (
    identity.status !== 'realized'
  ));
  if (unrealizedPhraseIdentities.length) {
    throw new Error(
      `Phrase Identity contracts were not fully realized for ${track.id}: `
      + unrealizedPhraseIdentities
        .map((identity) => {
          const first = identity.occurrences[0];
          const mismatch = identity.occurrences.slice(1).flatMap((occurrence) => {
            const index = occurrence.rowSignature.findIndex((row, rowIndex) => (
              row !== first?.rowSignature[rowIndex]
              || occurrence.routeBranchSignature[rowIndex] !== first?.routeBranchSignature[rowIndex]
            ));
            return index >= 0 || occurrence.rowSignature.length !== first?.rowSignature.length
              ? [`${occurrence.occurrenceId}:${first?.rowSignature.length ?? 0}/${occurrence.rowSignature.length}@${index}`]
              : [];
          })[0];
          return `${identity.identityId}[${identity.missingContracts.join(',')}]${mismatch ? `{${mismatch}}` : ''}`;
        })
        .join('; '),
    );
  }
  const strongSweepMetrics = summarizeFullWidthSweeps(combined, routeChoiceAnalysis);
  const literalMGestureWindows = findLiteralMGestures(combined);
  const mGestureSummary = {
    count: literalMGestureWindows.length,
    identityCount: literalMGestureWindows.filter((window) => window.orientation === 'identity').length,
    mirrorCount: literalMGestureWindows.filter((window) => window.orientation === 'mirror').length,
    windows: literalMGestureWindows.map((window) => ({
      startEventIndex: window.startIndex,
      endEventIndex: window.endIndex,
      startSeconds: Number(window.startSeconds.toFixed(5)),
      endSeconds: Number(window.endSeconds.toFixed(5)),
      orientation: window.orientation,
      rows: window.rows,
    })),
  };
  combined.forEach((event, index) => {
    event._routeLane = routeChoiceAnalysis.referenceRoute[index];
  });
  const gestureEventIndicesBySection = new Map();
  combined.forEach((event, eventIndex) => {
    if (event.pattern !== 'm') return;
    if (!gestureEventIndicesBySection.has(event._sectionIndex)) {
      gestureEventIndicesBySection.set(event._sectionIndex, []);
    }
    gestureEventIndicesBySection.get(event._sectionIndex).push(eventIndex);
  });
  for (const [sectionIndex, section] of flowSections.entries()) {
    section.eventCount = 0;
    section.noteCount = 0;
    section.targetCellCount = 0;
    section.dodgeCount = 0;
    section.spikeCount = 0;
    if (section.motif === 'm') {
      const gestureEventIndices = gestureEventIndicesBySection.get(sectionIndex) ?? [];
      section.gestureStartEventIndex = gestureEventIndices[0] ?? null;
      section.gestureEndEventIndex = gestureEventIndices.at(-1) ?? null;
      section.gestureEventIndices = gestureEventIndices;
    }
  }
  const phraseSectionById = new Map(phraseSections.map((section) => [section.phraseId, section]));
  let targetCount = 0;
  let dodgeCount = 0;
  let guidanceRowCount = 0;
  let spikeCount = 0;
  let edgeGateCount = 0;
  let totalMovement = 0;
  let maximumMovement = 0;
  let priorRouteLane = START_LANE;
  let currentRun = 0;
  let maximumMelodyRun = 0;
  let previousTarget = null;
  let currentMultiTargetRun = 0;
  let maximumConsecutiveMultiTargetRows = 0;
  for (const event of combined) {
    const section = flowSections[event._sectionIndex];
    const phraseSection = phraseSectionById.get(event.phraseId);
    const barSection = barSections[event.barModule];
    const rowSpikes = event.obstacles.filter((cell) => cell === SPIKE).length;
    const rowTargets = event.obstacles.filter((cell) => cell === BREAKABLE).length;
    const safeLaneCount = LANE_COUNT - rowSpikes;
    section.eventCount += 1;
    section.noteCount += Number(rowTargets > 0);
    section.targetCellCount += rowTargets;
    section.dodgeCount += event.kind === 'dodge' ? 1 : 0;
    section.spikeCount += rowSpikes;
    phraseSection.eventCount += 1;
    if (event.layer === 'core') phraseSection.coreEventCount += 1;
    else phraseSection.auxiliaryEventCount += 1;
    if (barSection) {
      barSection.eventCount += 1;
      barSection.noteCount += Number(rowTargets > 0);
      barSection.targetCellCount += rowTargets;
      barSection.dodgeCount += event.kind === 'dodge' ? 1 : 0;
      barSection.spikeCount += rowSpikes;
    }
    targetCount += rowTargets;
    dodgeCount += event.kind === 'dodge' ? 1 : 0;
    spikeCount += rowSpikes;
    if (rowSpikes) guidanceRowCount += 1;
    if (safeLaneCount === 1) edgeGateCount += 1;
    if (event.kind === 'target' && rowTargets > 1) {
      currentMultiTargetRun += 1;
      maximumConsecutiveMultiTargetRows = Math.max(
        maximumConsecutiveMultiTargetRows,
        currentMultiTargetRun,
      );
    } else {
      currentMultiTargetRun = 0;
    }
    const movement = Math.abs(event._routeLane - priorRouteLane);
    totalMovement += movement;
    maximumMovement = Math.max(maximumMovement, movement);
    priorRouteLane = event._routeLane;
    if (rowTargets) {
      if (
        previousTarget
        && event.timeSeconds - previousTarget.timeSeconds <= FLOW_MODE.minTravelSecondsPerLane
        && event._routeLane === previousTarget.lane
      ) currentRun += 1;
      else currentRun = 1;
      maximumMelodyRun = Math.max(maximumMelodyRun, currentRun);
      previousTarget = { timeSeconds: event.timeSeconds, lane: event._routeLane };
    } else {
      currentRun = 0;
      previousTarget = null;
    }
  }

  const consistencyGroups = [];
  for (const group of templateGroups.values()) {
    if (group.phrases.length < 2) continue;
    const signatures = group.phrases.map((phrase) => combined
      .filter((event) => event.phraseId === phrase.id)
      .map((event) => `${event.relativeSlotKey}:${event.kind}:${rowKey(event.obstacles)}`)
      .join(','));
    consistencyGroups.push({
      familyId: group.template.familyId,
      durationClass: group.template.durationClass,
      phraseIds: group.phrases.map((phrase) => phrase.id),
      occurrenceCount: group.phrases.length,
      exact: signatures.every((signature) => signature === signatures[0]),
      coreSlotCount: group.template.slots.length,
    });
  }
  const exactGroupCount = consistencyGroups.filter((group) => group.exact).length;
  const repeatConsistency = {
    repeatedFamilyGroupCount: consistencyGroups.length,
    exactGroupCount,
    exactRatio: consistencyGroups.length ? Number((exactGroupCount / consistencyGroups.length).toFixed(3)) : null,
    groups: consistencyGroups,
    appliedRangeLinks: appliedReuseLinks,
    policy: 'Every emitted row is canonical per repeated familyId + durationClass; occurrence-only overlays are limited to unique phrases.',
  };

  return {
    events: combined.map((event) => {
      const { _routeLane, ...withoutRoute } = event;
      return stripInternalFields(withoutRoute);
    }),
    targetCount,
    choiceRowCount: routeChoiceAnalysis.choiceRowCount,
    multiTargetChoiceRowCount: routeChoiceAnalysis.multiTargetChoiceRowCount,
    maximumConsecutiveMultiTargetRows,
    fullRouteBranchCount: routeChoiceAnalysis.meaningfulChoiceRows.length,
    deadBranchTargetCellCount: routeChoiceAnalysis.deadChoiceCells.length,
    prunedDeadBranchTargetCellCount: routePruning.prunedCellCount,
    maximumConsecutiveFullRouteBranches: routeChoiceAnalysis.maximumConsecutiveChoiceRows,
    pathCountCapped: routeChoiceAnalysis.pathCountCapped,
    consecutiveChoicePairCount: routeChoiceAnalysis.consecutiveChoicePairs.length,
    wideChoiceRowCount: routeChoiceAnalysis.wideChoiceRowCount,
    fullWidthSweepCount: strongSweepMetrics.fullWidthSweepCount,
    edgeToEdgeTransitionCount: strongSweepMetrics.edgeToEdgeTransitionCount,
    strongSweepMetrics,
    dodgeCount,
    guidanceRowCount,
    spikeCount,
    edgeGateCount,
    averageMovement: combined.length ? totalMovement / combined.length : 0,
    maximumMovement,
    motifCounts,
    flowSections,
    phraseSections,
    barSections,
    familyTemplates: familyTemplates.map((template) => {
      // Range reuse can promote a stronger overlapping phrase into a canonical
      // family. Report the realised prototype, not the pre-link draft.
      const realisedSlots = occurrenceTemplates.get(template.prototypePhraseId) ?? template.slots;
      return {
        id: template.id,
        familyId: template.familyId,
        durationClass: template.durationClass,
        prototypePhraseId: template.prototypePhraseId,
        occurrencePhraseIds: template.occurrencePhraseIds,
        occurrenceCount: template.occurrenceCount,
        transformId: template.transformId,
        directedIdentityId: template.directedIdentityId,
        kineticForm: template.kineticForm,
        intensity: template.intensity,
        motifPlan: template.motifPlan,
        barProfiles: template.barProfiles,
        mVariant: template.mVariant,
        mStartBar: template.mStartBar,
        mMirrored: template.mMirrored,
        mGesture: template.mGesture,
        fullWidthSweepPlan: template.fullWidthSweepPlan,
        choiceBranchSummary: template.choiceBranchSummary,
        dominantSectionRole: template.familyIntent?.dominantSectionRole ?? 'drive',
        sectionRoles: template.familyIntent?.sectionRoles ?? ['drive'],
        contour: template.familyIntent?.contour ?? {
          kind: 'unknown',
          confidence: 0,
          range: 0,
          slope: 0,
          eventCount: 0,
          analyzedOccurrenceCount: 0,
        },
        preferredTransform: template.transformId,
        transformReason: template.familyIntent?.transformReason ?? 'geometry-fallback',
        motifBias: template.familyIntent?.motifBias ?? template.motifPlan,
        coreSlotCount: realisedSlots.length,
        coreRowSignature: realisedSlots.map((slot) => rowKey(slot.obstacles)).join(','),
        barModules: [...new Map(realisedSlots.map((slot) => [slot.blockId, {
          id: slot.blockId,
          motif: slot.pattern,
          barRole: slot.barRole,
          downbeatCue: slot.downbeatCue,
        }])).values()],
      };
    }),
    repeatConsistency,
    realizationReceipt,
    mGestureSummary,
    melodyBurst,
    musicalStructureAlgorithm: structure.algorithm,
    musicalStructureTimingPolicy: structure.timingPolicy,
    climaxTimeSeconds: Number(climaxTime.toFixed(3)),
    auxiliaryCandidateCount: selectedAuxiliary.length,
    auxiliaryNoteCount: acceptedAuxiliary.length,
    rejectedAuxiliaryCount: selectedAuxiliary.length - acceptedAuxiliary.length,
    densityFillCount: densityPlan.counts.solid + densityPlan.counts.compact,
    solidDensityFillCount: densityPlan.counts.solid,
    compactDensityFillCount: densityPlan.counts.compact,
    maximumMelodyRun,
    layoutIntentProfile: {
      algorithm: 'music-description-to-layout-intent-v1',
      audioFingerprint: AUDIO_SEED,
      songProfile: LAYOUT_INTENT.songProfile,
      sections: LAYOUT_INTENT.sections,
    },
    layoutAlgorithm: 'evidence-directed-kinetic-compiler-v14',
  };
}

function buildLevel(track) {
  const chart = buildEvents(track);
  return {
    id: `${analysis.song.id}-${FLOW_MODE.id}`,
    version: 3,
    song: {
      title: analysis.song.title,
      artist: analysis.song.artist,
      audioUrl: analysis.song.audioUrl,
      bpm: analysis.song.bpm,
      durationSeconds: analysis.song.durationSeconds,
    },
    generation: {
      algorithm: track.id,
      displayName: chart.performanceScore ? '原声演奏谱面' : '证据导演心流谱面',
      description: chart.performanceScore
        ? 'Performance Score 逐个保留实测发音时刻与局部音高轨迹；Song Director 只修饰压力、障碍与视觉，不移动演奏目标。'
        : '自动 Song Director 从原始音频证据提取句子身份、运动形态和叙事转折；编译器再将这些意图变成可验证的路线、障碍与视觉反应。',
      difficulty: FLOW_MODE.id,
      difficultyLabel: FLOW_MODE.label,
      difficultyDescription: FLOW_MODE.description,
      noteCount: chart.choiceRowCount,
      targetCellCount: chart.targetCount,
      multiTargetChoiceRowCount: chart.multiTargetChoiceRowCount,
      maximumConsecutiveMultiTargetRows: chart.maximumConsecutiveMultiTargetRows,
      fullRouteBranchCount: chart.fullRouteBranchCount,
      deadBranchTargetCellCount: chart.deadBranchTargetCellCount,
      prunedDeadBranchTargetCellCount: chart.prunedDeadBranchTargetCellCount,
      maximumConsecutiveFullRouteBranches: chart.maximumConsecutiveFullRouteBranches,
      pathCountCapped: chart.pathCountCapped,
      consecutiveChoicePairCount: chart.consecutiveChoicePairCount,
      wideChoiceRowCount: chart.wideChoiceRowCount,
      fullWidthSweepCount: chart.fullWidthSweepCount,
      edgeToEdgeTransitionCount: chart.edgeToEdgeTransitionCount,
      strongSweepMetrics: chart.strongSweepMetrics,
      eventCount: chart.events.length,
      dodgeCount: chart.dodgeCount,
      guidanceRowCount: chart.guidanceRowCount,
      spikeCount: chart.spikeCount,
      edgeGateCount: chart.edgeGateCount,
      sourceEventCount: chart.performanceScore
        ? chart.performanceScore.attackEvents.length
        : track.eventCount,
      auxiliaryCandidateCount: chart.auxiliaryCandidateCount,
      auxiliaryNoteCount: chart.auxiliaryNoteCount,
      rejectedAuxiliaryCount: chart.rejectedAuxiliaryCount,
      densityFillCount: chart.densityFillCount,
      solidDensityFillCount: chart.solidDensityFillCount,
      compactDensityFillCount: chart.compactDensityFillCount,
      maximumMelodyRun: chart.maximumMelodyRun,
      averageLaneMovement: Number(chart.averageMovement.toFixed(3)),
      maximumLaneMovement: chart.maximumMovement,
      minTravelSecondsPerLane: chart.performanceScore
        ? PERFORMANCE_TRAVEL_SECONDS_PER_LANE
        : FLOW_MODE.minTravelSecondsPerLane,
      fullWidthSweepTravelSecondsPerLane: SWEEP_TRAVEL_SECONDS_PER_LANE,
      motifCounts: chart.motifCounts,
      flowSections: chart.flowSections,
      phraseSections: chart.phraseSections,
      barSections: chart.barSections,
      familyTemplates: chart.familyTemplates,
      repeatConsistency: chart.repeatConsistency,
      directorScore: SONG_DIRECTION,
      realizationReceipt: chart.realizationReceipt,
      ...(chart.performanceScore ? {
        performanceScore: chart.performanceScore,
        performanceScoreAlgorithm: chart.performanceScore.algorithm,
        performanceAttackEventCount: chart.performanceScore.attackEvents.length,
        performanceTargetRowCount: chart.choiceRowCount,
      } : {}),
      mGestureSummary: chart.mGestureSummary,
      melodyBurst: chart.melodyBurst,
      musicalStructureAlgorithm: chart.musicalStructureAlgorithm,
      musicalStructureTimingPolicy: chart.musicalStructureTimingPolicy,
      climaxTimeSeconds: chart.climaxTimeSeconds,
      layoutIntentProfile: chart.layoutIntentProfile,
      layoutAlgorithm: chart.layoutAlgorithm,
      colorSchemeAlgorithm: 'director-color-scenes-v4',
      colorSchemeEventCount: COLOR_SCHEME_EVENTS.length,
      visualAccentEventCount: VISUAL_ACCENT_EVENTS.length,
      timingPolicy: analysis.timingPolicy,
      audioCompression: analysis.song.audioCompression,
    },
    colorSchemeEvents: COLOR_SCHEME_EVENTS,
    visualAccentEvents: VISUAL_ACCENT_EVENTS,
    events: chart.events,
  };
}

const primarySource = analysis.eventSources.find((source) => source.id === analysis.primaryEventSourceId);
if (!primarySource) throw new Error(`Primary event source ${analysis.primaryEventSourceId} is missing.`);
const level = buildLevel(primarySource);

await mkdir(dirname(levelPath), { recursive: true });
await writeFile(levelPath, `${JSON.stringify(level, null, 2)}\n`);
console.log(
  `Generated ${level.id}: ${level.generation.noteCount} Choice Rows / `
  + `${level.generation.targetCellCount} Target Cells, `
  + `${level.generation.spikeCount} spikes, ${level.generation.auxiliaryNoteCount} melodic subdivisions.`,
);
