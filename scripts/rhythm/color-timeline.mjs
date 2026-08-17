export const COLOR_SCHEME_HUES = {
  redWhite: { primary: 0, accent: 'white' },
  redCyan: { primary: 0, accent: 180 },
  orangeAzure: { primary: 30, accent: 210 },
  yellowBlue: { primary: 60, accent: 240 },
  yellowWhite: { primary: 60, accent: 'white' },
  greenWhite: { primary: 120, accent: 'white' },
  cyanWhite: { primary: 180, accent: 'white' },
  cyanRed: { primary: 180, accent: 0 },
  azureOrange: { primary: 210, accent: 30 },
  blueWhite: { primary: 240, accent: 'white' },
  violetWhite: { primary: 270, accent: 'white' },
  magentaWhite: { primary: 300, accent: 'white' },
};

export const COLOR_SCHEME_IDS = Object.keys(COLOR_SCHEME_HUES);

const ROLE_SCHEMES = {
  intro: ['cyanWhite', 'cyanRed', 'blueWhite', 'orangeAzure'],
  build: ['redWhite', 'orangeAzure', 'yellowWhite', 'yellowBlue'],
  drive: ['cyanWhite', 'cyanRed', 'azureOrange', 'blueWhite', 'violetWhite', 'magentaWhite', 'redCyan'],
  peak: ['redWhite', 'redCyan', 'orangeAzure', 'yellowBlue', 'violetWhite', 'magentaWhite'],
  break: ['cyanWhite', 'blueWhite', 'greenWhite', 'yellowBlue', 'redCyan'],
  release: ['azureOrange', 'violetWhite', 'cyanWhite', 'magentaWhite', 'redCyan'],
  outro: ['cyanWhite', 'blueWhite', 'redWhite', 'redCyan', 'orangeAzure'],
};

const ACTIVITY_SCHEMES = {
  melodic: ['violetWhite', 'magentaWhite', 'cyanWhite'],
  percussive: ['redWhite', 'redCyan', 'orangeAzure', 'yellowBlue'],
  rhythmic: ['cyanRed', 'azureOrange', 'blueWhite', 'yellowWhite'],
};

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.round((sorted.length - 1) * clamp(ratio))];
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sourceEvents(analysis, id) {
  const source = analysis?.eventSources?.find((candidate) => candidate?.id === id);
  return Array.isArray(source?.events) ? source.events : [];
}

function sectionAt(sections, timeSeconds) {
  return sections.find((section, index) => (
    timeSeconds >= section.startSeconds
    && (index === sections.length - 1 || timeSeconds < section.endSeconds)
  ));
}

export function colorSchemesDiffer(leftSchemeId, rightSchemeId) {
  const left = COLOR_SCHEME_HUES[leftSchemeId];
  const right = COLOR_SCHEME_HUES[rightSchemeId];
  return Boolean(left && right && left.primary !== right.primary && left.accent !== right.accent);
}

function chooseDifferentScheme(candidates, fingerprint, previousSchemeId) {
  const pool = candidates.filter((schemeId, index, all) => (
    all.indexOf(schemeId) === index && colorSchemesDiffer(previousSchemeId, schemeId)
  ));
  if (!pool.length) throw new Error(`No full-region color change is available after ${previousSchemeId}.`);
  return pool[hashText(fingerprint) % pool.length];
}

function chooseSectionScheme(section, fingerprint, previousSchemeId) {
  const roleSchemes = ROLE_SCHEMES[section.role] ?? ROLE_SCHEMES.drive;
  const activity = Object.entries(section.activity ?? {})
    .sort((left, right) => finite(right[1]) - finite(left[1]))[0]?.[0];
  const activitySchemes = ACTIVITY_SCHEMES[activity] ?? [];
  return chooseDifferentScheme([
    ...activitySchemes.filter((schemeId) => roleSchemes.includes(schemeId)),
    ...roleSchemes,
  ], `${fingerprint}|${section.id}|${section.role}`, previousSchemeId);
}

function buildSectionEvents(analysis, sections, beatSeconds) {
  const fingerprint = String(analysis?.song?.audioFingerprint ?? 'missing-audio-fingerprint');
  const events = [{
    timeSeconds: 0,
    colorSchemeId: 'cyanWhite',
    kind: 'section',
    source: 'song-start',
    strength: 0,
  }];
  let previousSection = sections[0];
  let lastChangeTime = 0;
  for (const section of sections.slice(1)) {
    const pressureChange = Math.abs(finite(section.pressure) - finite(previousSection?.pressure));
    const energyChange = Math.abs(finite(section.energy) - finite(previousSection?.energy));
    const roleChanged = section.role !== previousSection?.role;
    const mandatoryRole = ['peak', 'break', 'outro'].includes(section.role);
    const timeSeconds = finite(section.startSeconds);
    const enoughTime = timeSeconds - lastChangeTime >= Math.max(4, beatSeconds * 8);
    if (
      (mandatoryRole || roleChanged || pressureChange >= 0.14 || energyChange >= 0.16)
      && (enoughTime || mandatoryRole)
    ) {
      const colorSchemeId = chooseSectionScheme(section, fingerprint, events.at(-1).colorSchemeId);
      if (colorSchemeId !== events.at(-1).colorSchemeId) {
        events.push({
          timeSeconds: Number(timeSeconds.toFixed(5)),
          colorSchemeId,
          kind: 'section',
          source: section.id,
          strength: Number(clamp(Math.max(pressureChange, energyChange, finite(section.pressure))).toFixed(3)),
        });
        lastChangeTime = timeSeconds;
      }
    }
    previousSection = section;
  }
  return events;
}

function buildAccentEvents(analysis, sections, sectionEvents, beatSeconds) {
  const percussiveEvents = sourceEvents(analysis, 'librosa-percussive');
  const onsetEvents = percussiveEvents.length
    ? percussiveEvents.map((event) => ({ ...event, sourceId: 'librosa-percussive' }))
    : sourceEvents(analysis, 'librosa-onset').map((event) => ({ ...event, sourceId: 'librosa-onset' }));
  const downbeats = sourceEvents(analysis, 'beat-this')
    .filter((event) => event.isDownbeat)
    .map((event) => ({ ...event, sourceId: 'beat-this' }));
  const onsetThreshold = percentile(onsetEvents.map((event) => finite(event.confidence)), 0.78);
  const pressureThreshold = Math.max(0.72, percentile(sections.map((section) => finite(section.pressure)), 0.72));
  const candidates = [...onsetEvents, ...downbeats].flatMap((event) => {
    const timeSeconds = finite(event.timeSeconds, Number.NaN);
    const section = sectionAt(sections, timeSeconds);
    const confidence = finite(event.confidence);
    if (
      !section
      || (section.role !== 'peak' && finite(section.pressure) < pressureThreshold)
      || (event.sourceId !== 'beat-this' && confidence < onsetThreshold)
      || sectionEvents.some((change) => Math.abs(change.timeSeconds - timeSeconds) < 0.08)
    ) return [];
    return [{
      timeSeconds,
      section,
      sourceId: event.sourceId,
      score: clamp(confidence * 0.62 + finite(section.pressure) * 0.28 + finite(section.energy) * 0.1),
    }];
  });

  const accentEvents = [];
  for (const section of sections) {
    const ranked = candidates
      .filter((candidate) => candidate.section === section)
      .sort((left, right) => right.score - left.score || left.timeSeconds - right.timeSeconds);
    const selected = [];
    for (const candidate of ranked) {
      if (selected.length >= 8) break;
      if (selected.every((chosen) => Math.abs(chosen.timeSeconds - candidate.timeSeconds) >= Math.max(0.28, beatSeconds * 0.5))) {
        selected.push(candidate);
      }
    }
    selected.sort((left, right) => left.timeSeconds - right.timeSeconds);
    if (selected.length % 2 === 1) selected.pop();
    if (selected.length < 2) continue;

    const baseSchemeId = [...sectionEvents]
      .reverse()
      .find((event) => event.timeSeconds <= section.startSeconds)?.colorSchemeId ?? 'cyanWhite';
    const fingerprint = String(analysis?.song?.audioFingerprint ?? 'missing-audio-fingerprint');
    const accentSchemeId = chooseDifferentScheme(
      COLOR_SCHEME_IDS,
      `${fingerprint}|${section.id}|accent`,
      baseSchemeId,
    );
    selected.forEach((candidate, index) => accentEvents.push({
      timeSeconds: Number(candidate.timeSeconds.toFixed(5)),
      colorSchemeId: index % 2 === 0 ? accentSchemeId : baseSchemeId,
      kind: 'accent',
      source: candidate.sourceId,
      strength: Number(candidate.score.toFixed(3)),
    }));
  }
  return accentEvents;
}

/** Compile detector peaks and structural downbeats into the runtime color timeline. */
export function planColorSchemeEvents(analysis, layoutIntent) {
  const sections = Array.isArray(layoutIntent?.sections)
    ? [...layoutIntent.sections].sort((left, right) => left.startSeconds - right.startSeconds)
    : [];
  const beatSeconds = 60 / Math.max(1, finite(analysis?.song?.bpm, 120));
  const sectionEvents = buildSectionEvents(analysis, sections, beatSeconds);
  const events = [...sectionEvents, ...buildAccentEvents(analysis, sections, sectionEvents, beatSeconds)]
    .sort((left, right) => left.timeSeconds - right.timeSeconds || (left.kind === 'section' ? -1 : 1));
  for (let index = 1; index < events.length; index += 1) {
    if (!colorSchemesDiffer(events[index - 1].colorSchemeId, events[index].colorSchemeId)) {
      throw new Error(`Color scheme event ${index} repeats a region hue from the previous event.`);
    }
  }
  return events;
}
