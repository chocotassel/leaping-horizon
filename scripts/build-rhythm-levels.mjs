import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { deriveLayoutIntent } from './rhythm/layout-intent.mjs';

const root = resolve(import.meta.dirname, '..');
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('build-rhythm-levels.mjs is an internal step; run npm run generate instead.');
}
const inputPath = resolve(root, process.argv[2]);
const levelPath = resolve(root, process.argv[3]);
const analysis = JSON.parse(await readFile(inputPath, 'utf8'));
const LAYOUT_INTENT = deriveLayoutIntent(analysis);

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

const FLOW_MODE = {
  id: 'flow',
  label: '心流',
  description: '全程保持操作，随音乐强度递进',
  minTravelSecondsPerLane: 0.23,
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
  m: { label: 'M 形诱导连击', baseLength: 6, minimumLength: 6, spikeMode: 'pocket' },
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

function intentSectionAt(timeSeconds) {
  return LAYOUT_INTENT.sections.find((section, index) => (
    timeSeconds >= section.startSeconds
    && (index === LAYOUT_INTENT.sections.length - 1 || timeSeconds < section.endSeconds)
  )) ?? LAYOUT_INTENT.sections.at(-1) ?? null;
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

function buildObstacleRow(motifId, lane, nextLane, position, length, flow, cCampLane) {
  const motif = MOTIFS[motifId];
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
    let width = flow < 0.45 ? 3 : 2;
    if (['hook', 'stairs', 'sweep'].includes(motifId) && position % 3 === 1 && flow < 0.56) width = 4;
    if (motif.spikeMode === 'pulse') width = flow >= 0.42 || position % 3 === 1 ? 2 : 3;
    const safeLanes = chooseSafeWindow(lane, nextLane, width);
    spikeCount = addSpikesOutside(row, safeLanes);
    safeLaneCount = safeLanes.length;
  }

  row[lane] = BREAKABLE;
  widenIsolatedMiddleGaps(row, nextLane);
  spikeCount = row.filter((cell) => cell === SPIKE).length;
  safeLaneCount = LANE_COUNT - spikeCount;
  return { row, spikeCount, safeLaneCount };
}

function solveLaneRoute(items, startLane = START_LANE, startTime = 0) {
  let states = new Map([[startLane, { cost: 0, path: [] }]]);
  let previousTime = startTime;
  for (const item of items) {
    const maximumSteps = Math.min(
      LANE_COUNT - 1,
      Math.max(0, Math.floor((item.timeSeconds - previousTime + 1e-6) / FLOW_MODE.minTravelSecondsPerLane)),
    );
    const nextStates = new Map();
    for (const lane of item._allowedLanes) {
      for (const [priorLane, priorState] of states) {
        if (Math.abs(lane - priorLane) > maximumSteps) continue;
        const cost = priorState.cost
          + Math.abs(lane - priorLane) * 0.08
          + Math.abs(lane - (item._preferredLane ?? lane)) * 0.015;
        if (!nextStates.has(lane) || cost < nextStates.get(lane).cost) {
          nextStates.set(lane, { cost, path: [...priorState.path, lane] });
        }
      }
    }
    if (!nextStates.size) return null;
    states = nextStates;
    previousTime = item.timeSeconds;
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

function motifPlanFor({ phrases, barCount, isIntro, familyId, bars, familyIntent }) {
  const profiles = buildFamilyBarProfiles(phrases, barCount, bars);
  const fallbackMotifs = [
    'focus',
    'sweep',
    'c',
    'v',
    's',
    'zigzag',
    'hook',
    'stairs',
    'pendulum',
    'pulse',
  ];
  const preferredMotifs = (familyIntent?.motifBias ?? [])
    .filter((motif, index, values) => motif !== 'm' && MOTIFS[motif] && values.indexOf(motif) === index);
  const palette = preferredMotifs.length >= 3
    ? [
      ...preferredMotifs,
      ...preferredMotifs.slice(0, 3),
      ...fallbackMotifs.filter((motif) => !preferredMotifs.includes(motif)).slice(0, 2),
    ]
    : fallbackMotifs;
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
    let paletteIndex = hashText([
      AUDIO_SEED,
      familyId,
      familyIntent?.contour?.kind ?? 'unknown',
      profile.sectionRole,
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
  return { motifs, profiles };
}

const BAR_ROLES = ['opening', 'call', 'answer', 'turn', 'lift', 'drive', 'peak', 'cadence'];

function templateMobility(group, auxiliaryCandidates) {
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
            (checkpoint - checkpoints[index] + 1e-6) / FLOW_MODE.minTravelSecondsPerLane,
          )
        ), 0);
      })()),
    )));
  });
}

function fitReachableBarPath(desired, indices, mobility, entryLane, forceStart, forceEnd) {
  let states = new Map([[entryLane, { cost: 0, path: [] }]]);
  for (let position = 0; position < indices.length; position += 1) {
    const slotIndex = indices[position];
    const maximumSteps = mobility[slotIndex];
    const mustBeCenter = (forceStart && position === 0) || (forceEnd && position === indices.length - 1);
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

function makeCanonicalTemplate({
  key,
  familyId,
  durationClass,
  phrases,
  trackId,
  mVariant,
  mStartBar,
  bars,
  familyIntent,
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
  const motifPlan = motifPlanFor({
    phrases,
    barCount: prototype.barCount,
    isIntro,
    familyId,
    bars,
    familyIntent,
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
    const rawControls = motif === 'c' ? [2, 3, 4, 4, 3, 2] : MOTIFS[motif].controls;
    const controls = transformId === 'mirror'
      ? rawControls.map((lane) => LANE_COUNT - 1 - lane)
      : rawControls;
    const desired = samplePath(controls, indices.length);
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
    const modulePressure = clamp(
      average(motifPlan.profiles.slice(moduleStartBar, moduleEndBar).map((profile) => profile.score))
      + difficultyBoost,
      0,
      1,
    );
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
      );
      slots[slotIndex] = {
        obstacles: rowResult.row,
        emit: true,
        kind: 'target',
        pattern: motif,
        role: item.beatInBar === 0 ? 'downbeat-cue' : 'beat-target',
        barRole: BAR_ROLES[item.barInPhrase % BAR_ROLES.length],
        downbeatCue: item.beatInBar === 0,
        allowedLanes: [lane],
        preferredLane: lane,
        templateId,
        familyId,
        transformId,
        relativeSlotKey: `${templateId}:bar-${item.barInPhrase}:slot-${item.beatInBar}`,
        blockId: `${templateId}:bars-${moduleStartBar}-${moduleEndBar - 1}`,
        sectionRole: motifPlan.profiles[item.barInPhrase]?.sectionRole ?? familyIntent?.dominantSectionRole ?? 'drive',
        pressure: modulePressure,
        overridePriority: 0,
      };
    }
    barInPhrase = moduleEndBar;
  }

  let appliedMStartBar = null;
  if (mVariant && Number.isInteger(mStartBar)) {
    const placementCandidates = Array.from({ length: prototype.barCount }, (_, candidateBar) => candidateBar)
      .sort((left, right) => Math.abs(left - mStartBar) - Math.abs(right - mStartBar))
      .flatMap((candidateBar) => {
        const startSlot = prototype.items.findIndex((item) => item.barInPhrase === candidateBar);
        if (startSlot < 0 || startSlot + 5 >= slots.length) return [];
        const entryLane = slots[startSlot - 1]?.preferredLane ?? START_LANE;
        const exitLane = slots[startSlot + 6]?.preferredLane ?? START_LANE;
        const orientations = [
          { mirror: false, gate: [3, 4] },
          { mirror: true, gate: [0, 1] },
        ].filter(({ gate }) => (
          gate.some((lane) => Math.abs(lane - entryLane) <= mobility[startSlot])
          && (
            startSlot + 6 >= mobility.length
            || gate.some((lane) => Math.abs(lane - exitLane) <= mobility[startSlot + 6])
          )
        )).map((candidate) => ({
          ...candidate,
          candidateBar,
          startSlot,
          cost: Math.min(...candidate.gate.map((lane) => Math.abs(lane - entryLane)))
            + Math.min(...candidate.gate.map((lane) => Math.abs(lane - exitLane))),
        }));
        const preferredMirror = noise(AUDIO_SEED, trackId, familyId, candidateBar, 'm-orientation') >= 0.5;
        return orientations.sort((left, right) => (
          left.cost - right.cost
          || Number(left.mirror !== (transformId === 'mirror' ? true : preferredMirror))
            - Number(right.mirror !== (transformId === 'mirror' ? true : preferredMirror))
        ));
      });
    const placement = placementCandidates[0];
    if (placement) {
      const { startSlot, candidateBar, mirror: mirrorM } = placement;
      appliedMStartBar = candidateBar;
      const baseRows = [
        [SPIKE, SPIKE, SPIKE, EMPTY, EMPTY],
        [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
        [BREAKABLE, EMPTY, EMPTY, EMPTY, EMPTY],
        [BREAKABLE, EMPTY, EMPTY, EMPTY, EMPTY],
        [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
        [SPIKE, SPIKE, SPIKE, EMPTY, EMPTY],
      ];
      const rows = mirrorM ? baseRows.map((row) => [...row].reverse()) : baseRows;
      const pocketLane = mirrorM ? LANE_COUNT - 1 : 0;
      const gateLanes = mirrorM ? [0, 1] : [3, 4];
      const slotKinds = ['dodge', 'travel', 'target', 'target', 'travel', 'dodge'];
      const roles = ['entry-gate', 'travel-slot', 'pocket-hit', 'pocket-hit', 'travel-slot', 'exit-gate'];
      for (let offset = 0; offset < rows.length; offset += 1) {
        const slotIndex = startSlot + offset;
        const isTarget = slotKinds[offset] === 'target';
        const isDodge = slotKinds[offset] === 'dodge';
        const mBarOffset = prototype.items[slotIndex].barInPhrase - candidateBar;
        slots[slotIndex] = {
          obstacles: rows[offset],
          emit: isTarget || isDodge,
          kind: isTarget ? 'target' : 'dodge',
          pattern: 'm',
          role: roles[offset],
          barRole: mBarOffset === 0 ? 'peak-pocket-entry' : 'peak-pocket-release',
          downbeatCue: prototype.items[slotIndex].beatInBar === 0,
          allowedLanes: isTarget ? [pocketLane] : gateLanes,
          preferredLane: isTarget ? pocketLane : gateLanes[0],
          templateId,
          familyId,
          transformId: mirrorM ? 'mirror' : 'identity',
          relativeSlotKey: `${templateId}:m-${offset}`,
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
    intensity: Number(intensity.toFixed(3)),
    motifPlan: plan,
    barProfiles: motifPlan.profiles,
    mVariant,
    mStartBar: appliedMStartBar,
    slots,
  };
}

function copySpec(spec, overrides = {}) {
  return {
    ...spec,
    obstacles: [...spec.obstacles],
    allowedLanes: [...spec.allowedLanes],
    ...overrides,
  };
}

function applyRangeReuse({
  id,
  sourceStartSeconds,
  sourceEndSeconds,
  targetStartSeconds,
  targetEndSeconds,
  priority,
  similarity,
}, phraseContexts, occurrenceTemplates) {
  const collect = (startSeconds, endSeconds) => phraseContexts.flatMap((phrase) => (
    phrase.items.flatMap((item, slotIndex) => (
      item.sourceEvent.timeSeconds >= startSeconds - 0.08
      && item.sourceEvent.timeSeconds < endSeconds - 0.08
        ? [{ phrase, item, slotIndex, spec: occurrenceTemplates.get(phrase.id)[slotIndex] }]
        : []
    ))
  ));
  const source = collect(sourceStartSeconds, sourceEndSeconds);
  const target = collect(targetStartSeconds, targetEndSeconds);
  if (!source.length || source.length !== target.length) return null;
  // M pockets are playability overlays with their own entry/exit contract.
  // Copying one through a shifted recurrence window can detach it from the
  // transition it was validated against, so only the musical core is reusable.
  if ([...source, ...target].some((entry) => entry.spec.pattern === 'm')) return null;
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

function buildEvents(track) {
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
  const seed = `${AUDIO_SEED}:${track.id}:responsive-structure-v5`;
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
  const standardMGroup = track.id === 'beat-this' && beatEventsPerMinute >= 135
    ? [...templateGroups.values()]
      .filter((group) => (
        group !== climaxGroup
        && group.phrases[0].items.length >= 12
        && group.phrases.every((phrase) => phrase.startBarIndex >= 4)
        && ['build', 'drive', 'release'].includes(group.intent?.dominantSectionRole ?? 'drive')
      ))
      .sort((left, right) => (
        Number(left.phrases.length > 1) - Number(right.phrases.length > 1)
        || Math.abs(average(left.phrases.map((phrase) => phrase.intensity)) - 0.62)
          - Math.abs(average(right.phrases.map((phrase) => phrase.intensity)) - 0.62)
      ))[0]
    : null;

  const familyTemplates = [];
  for (const group of templateGroups.values()) {
    const prototype = group.phrases[0];
    const familyId = prototype.familyId;
    const durationClass = prototype.durationClass;
    let mVariant = null;
    let mStartBar = null;
    if (group === climaxGroup && track.id === 'beat-this') {
      mVariant = 'melodic';
      const climaxPhrase = group.phrases.find((phrase) => climaxTime >= phrase.startSeconds && climaxTime < phrase.endSeconds);
      const climaxItem = climaxPhrase?.items.reduce((best, item) => (
        Math.abs(item.sourceEvent.timeSeconds - climaxTime) < Math.abs(best.sourceEvent.timeSeconds - climaxTime) ? item : best
      ), climaxPhrase.items[0]);
      mStartBar = clamp(climaxItem?.barInPhrase ?? 1, 0, Math.max(0, prototype.barCount - 2));
    } else if (group === standardMGroup) {
      mVariant = 'standard';
      mStartBar = clamp(Math.floor(prototype.barCount / 2), 0, Math.max(0, prototype.barCount - 2));
    }
    const template = makeCanonicalTemplate({
      key: group.key,
      familyId,
      durationClass,
      phrases: group.phrases,
      trackId: track.id,
      mVariant,
      mStartBar,
      bars: structure.bars,
      familyIntent: group.intent,
      difficultyBoost: group === climaxGroup ? 0.18 : 0,
      auxiliaryCandidates: selectedAuxiliary,
    });
    group.template = template;
    familyTemplates.push(template);
  }

  const occurrenceTemplates = new Map();
  for (const group of templateGroups.values()) {
    for (const phrase of group.phrases) {
      occurrenceTemplates.set(phrase.id, group.template.slots.map((slot) => copySpec(slot)));
    }
  }
  const appliedReuseLinks = track.id === 'beat-this'
    ? applyStructuralReuse(
      structure,
      phraseContexts,
      occurrenceTemplates,
      templateGroups,
    )
    : [];
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
          orientation: firstSpec.transformId === 'mirror' ? 'right-pocket' : 'left-pocket',
          pocketLane: firstSpec.transformId === 'mirror' ? LANE_COUNT - 1 : 0,
          pocketStartSeconds: Number(blockItems[2].sourceEvent.timeSeconds.toFixed(5)),
          pocketEndSeconds: Number(blockItems[3].sourceEvent.timeSeconds.toFixed(5)),
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
      + `(slot=${failed?.occurrenceSlotKey}, bar=${failed?.barInPhrase}, lane=${failed?._preferredLane}, `
      + `prior=${prior?.timeSeconds}s/${prior?.barInPhrase}/${prior?._preferredLane}, `
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
  const overlayEntries = [];
  for (const [canonicalKey, entries] of auxiliaryGroups) {
    const bestByPhrase = new Map();
    for (const entry of entries) {
      const current = bestByPhrase.get(entry.phrase.id);
      if (!current || entry.candidate.quality > current.candidate.quality) bestByPhrase.set(entry.phrase.id, entry);
      if (entry.layer === 'overlay') overlayEntries.push(entry);
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
      // so retain every distinct real peak in the interval. Repeated families
      // still take exactly one consensus event per occurrence above.
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
  const acceptedTimes = new Set(acceptedAuxiliary.map((event) => event.timeSeconds.toFixed(6)));
  for (const entry of overlayEntries.sort((left, right) => right.candidate.quality - left.candidate.quality)) {
    if (acceptedTimes.has(entry.candidate.timeSeconds.toFixed(6))) continue;
    const event = toAuxEvent({ ...entry, layer: 'overlay' });
    const trial = [...combined, event].sort((left, right) => left.timeSeconds - right.timeSeconds);
    if (solveLaneRoute(trial)) {
      combined = trial;
      acceptedAuxiliary.push(event);
      acceptedTimes.add(entry.candidate.timeSeconds.toFixed(6));
    }
  }

  const comboRoute = solveLaneRoute(combined);
  if (!comboRoute) throw new Error(`Unable to build a full-combo route for ${track.id}.`);
  combined.forEach((event, index) => {
    const targetLane = comboRoute[index];
    if (event.layer === 'overlay' || event._adaptiveLane) {
      const adaptiveLayer = event.layer === 'overlay' ? 'overlay' : 'auxiliary-common';
      const adaptiveIntensity = event.timeSeconds < introEndSeconds
        ? 0
        : event.flow;
      event.obstacles = preserveMotifSurvival(
        makeAuxiliaryRow(
          targetLane,
          adaptiveIntensity,
          event.layer === 'overlay' ? `${event.relativeSlotKey}:${event.timeSeconds}` : event.relativeSlotKey,
          adaptiveLayer,
        ),
        event.pattern.replace(/-melody$/, ''),
        event.transformId,
        targetLane,
      );
      event._allowedLanes = [targetLane];
      event._preferredLane = targetLane;
    }
    event._routeLane = targetLane;
  });

  for (const section of flowSections) {
    section.eventCount = 0;
    section.noteCount = 0;
    section.dodgeCount = 0;
    section.spikeCount = 0;
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
  for (const event of combined) {
    const section = flowSections[event._sectionIndex];
    const phraseSection = phraseSectionById.get(event.phraseId);
    const barSection = barSections[event.barModule];
    const rowSpikes = event.obstacles.filter((cell) => cell === SPIKE).length;
    const rowTargets = event.obstacles.filter((cell) => cell === BREAKABLE).length;
    const safeLaneCount = LANE_COUNT - rowSpikes;
    section.eventCount += 1;
    section.noteCount += rowTargets;
    section.dodgeCount += event.kind === 'dodge' ? 1 : 0;
    section.spikeCount += rowSpikes;
    phraseSection.eventCount += 1;
    if (event.layer === 'core') phraseSection.coreEventCount += 1;
    else phraseSection.auxiliaryEventCount += 1;
    if (barSection) {
      barSection.eventCount += 1;
      barSection.noteCount += rowTargets;
      barSection.dodgeCount += event.kind === 'dodge' ? 1 : 0;
      barSection.spikeCount += rowSpikes;
    }
    targetCount += rowTargets;
    dodgeCount += event.kind === 'dodge' ? 1 : 0;
    spikeCount += rowSpikes;
    if (rowSpikes) guidanceRowCount += 1;
    if (safeLaneCount === 1) edgeGateCount += 1;
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
    const signatures = group.phrases.map((phrase) => occurrenceTemplates.get(phrase.id)
      .map((spec) => rowKey(spec.obstacles)).join(','));
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
    exactRatio: consistencyGroups.length ? Number((exactGroupCount / consistencyGroups.length).toFixed(3)) : 1,
    groups: consistencyGroups,
    appliedRangeLinks: appliedReuseLinks,
    policy: 'Core rows are canonical per familyId + durationClass; auxiliary rows require occurrence consensus, except labelled climax overlays.',
  };

  return {
    events: combined.map((event) => {
      const { _routeLane, ...withoutRoute } = event;
      return stripInternalFields(withoutRoute);
    }),
    targetCount,
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
        intensity: template.intensity,
        motifPlan: template.motifPlan,
        barProfiles: template.barProfiles,
        mVariant: template.mVariant,
        mStartBar: template.mStartBar,
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
    melodyBurst,
    musicalStructureAlgorithm: structure.algorithm,
    musicalStructureTimingPolicy: structure.timingPolicy,
    climaxTimeSeconds: Number(climaxTime.toFixed(3)),
    auxiliaryCandidateCount: selectedAuxiliary.length,
    auxiliaryNoteCount: acceptedAuxiliary.length,
    rejectedAuxiliaryCount: selectedAuxiliary.length - acceptedAuxiliary.length,
    maximumMelodyRun,
    layoutIntentProfile: {
      algorithm: 'music-description-to-layout-intent-v1',
      audioFingerprint: AUDIO_SEED,
      songProfile: LAYOUT_INTENT.songProfile,
      sections: LAYOUT_INTENT.sections,
    },
    layoutAlgorithm: 'music-responsive-template-v5',
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
      displayName: '音乐语义结构心流谱面',
      description: 'Beat This! 提供拍点骨架；librosa 段落与 Basic Pitch 音高走势共同决定重复形态、路线方向和压力。',
      difficulty: FLOW_MODE.id,
      difficultyLabel: FLOW_MODE.label,
      difficultyDescription: FLOW_MODE.description,
      noteCount: chart.targetCount,
      eventCount: chart.events.length,
      dodgeCount: chart.dodgeCount,
      guidanceRowCount: chart.guidanceRowCount,
      spikeCount: chart.spikeCount,
      edgeGateCount: chart.edgeGateCount,
      sourceEventCount: track.eventCount,
      auxiliaryCandidateCount: chart.auxiliaryCandidateCount,
      auxiliaryNoteCount: chart.auxiliaryNoteCount,
      rejectedAuxiliaryCount: chart.rejectedAuxiliaryCount,
      maximumMelodyRun: chart.maximumMelodyRun,
      averageLaneMovement: Number(chart.averageMovement.toFixed(3)),
      maximumLaneMovement: chart.maximumMovement,
      minTravelSecondsPerLane: FLOW_MODE.minTravelSecondsPerLane,
      motifCounts: chart.motifCounts,
      flowSections: chart.flowSections,
      phraseSections: chart.phraseSections,
      barSections: chart.barSections,
      familyTemplates: chart.familyTemplates,
      repeatConsistency: chart.repeatConsistency,
      melodyBurst: chart.melodyBurst,
      musicalStructureAlgorithm: chart.musicalStructureAlgorithm,
      musicalStructureTimingPolicy: chart.musicalStructureTimingPolicy,
      climaxTimeSeconds: chart.climaxTimeSeconds,
      layoutIntentProfile: chart.layoutIntentProfile,
      layoutAlgorithm: chart.layoutAlgorithm,
      timingPolicy: analysis.timingPolicy,
      audioCompression: analysis.song.audioCompression,
    },
    events: chart.events,
  };
}

const primarySource = analysis.eventSources.find((source) => source.id === analysis.primaryEventSourceId);
if (!primarySource) throw new Error(`Primary event source ${analysis.primaryEventSourceId} is missing.`);
const level = buildLevel(primarySource);

await mkdir(dirname(levelPath), { recursive: true });
await writeFile(levelPath, `${JSON.stringify(level, null, 2)}\n`);
console.log(
  `Generated ${level.id}: ${level.generation.noteCount} targets, `
  + `${level.generation.spikeCount} spikes, ${level.generation.auxiliaryNoteCount} melodic subdivisions.`,
);
