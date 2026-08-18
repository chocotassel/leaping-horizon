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

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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

/** Generate a conservative starting palette. Manual ranges are applied later. */
export function planColorSchemeEvents(analysis, layoutIntent) {
  const sections = Array.isArray(layoutIntent?.sections)
    ? [...layoutIntent.sections].sort((left, right) => left.startSeconds - right.startSeconds)
    : [];
  const fingerprint = String(analysis?.song?.audioFingerprint ?? 'missing-audio-fingerprint');
  const beatSeconds = 60 / Math.max(1, finite(analysis?.song?.bpm, 120));
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
    const importantRole = ['peak', 'break', 'outro'].includes(section.role);
    const timeSeconds = finite(section.startSeconds);
    if (
      (importantRole || section.role !== previousSection?.role || pressureChange >= 0.14 || energyChange >= 0.16)
      && timeSeconds - lastChangeTime >= Math.max(4, beatSeconds * 8)
    ) {
      events.push({
        timeSeconds: Number(timeSeconds.toFixed(5)),
        colorSchemeId: chooseSectionScheme(section, fingerprint, events.at(-1).colorSchemeId),
        kind: 'section',
        source: section.id,
        strength: Number(clamp(Math.max(pressureChange, energyChange, finite(section.pressure))).toFixed(3)),
      });
      lastChangeTime = timeSeconds;
    }
    previousSection = section;
  }
  return events;
}
