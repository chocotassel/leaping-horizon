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

const MIN_COLOR_SCENE_DWELL_SECONDS = 1;

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
      && enoughTime
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

function buildDirectedSceneEvents(analysis, colorScenes) {
  const fingerprint = String(analysis?.song?.audioFingerprint ?? 'missing-audio-fingerprint');
  const scenes = colorScenes
    .map((scene) => ({
      ...scene,
      resolvedTimeSeconds: finite(scene?.timeSeconds, finite(scene?.startSeconds, Number.NaN)),
    }))
    .filter((scene) => Number.isFinite(scene.resolvedTimeSeconds) && scene.resolvedTimeSeconds >= 0)
    .sort((left, right) => left.resolvedTimeSeconds - right.resolvedTimeSeconds);
  const events = [{
    timeSeconds: 0,
    colorSchemeId: 'cyanWhite',
    kind: 'section',
    source: 'song-start',
    strength: 0,
  }];

  for (const scene of scenes) {
    const timeSeconds = Number(scene.resolvedTimeSeconds.toFixed(5));
    if (timeSeconds === 0 && events.length === 1) {
      events[0] = {
        ...events[0],
        source: String(scene.id ?? scene.sceneId ?? 'director-scene-start'),
        strength: Number(clamp(finite(scene.strength)).toFixed(3)),
        sceneId: scene.sceneId,
        anchorId: scene.startAnchorId ?? scene.anchorId,
        evidenceIds: Array.isArray(scene.evidenceIds) ? [...scene.evidenceIds] : [],
      };
      continue;
    }
    if (timeSeconds - events.at(-1).timeSeconds < MIN_COLOR_SCENE_DWELL_SECONDS) continue;
    events.push({
      timeSeconds,
      colorSchemeId: chooseDifferentScheme(
        COLOR_SCHEME_IDS,
        `${fingerprint}|${scene.id}|${scene.sceneId}|${JSON.stringify(scene.affect ?? null)}`,
        events.at(-1).colorSchemeId,
      ),
      kind: 'section',
      source: String(scene.id ?? scene.sceneId ?? 'director-color-scene'),
      strength: Number(clamp(finite(scene.strength, 1)).toFixed(3)),
      sceneId: scene.sceneId,
      anchorId: scene.startAnchorId ?? scene.anchorId,
      evidenceIds: Array.isArray(scene.evidenceIds) ? [...scene.evidenceIds] : [],
    });
  }
  return events;
}

/** Keep ordinary strong Musical Anchors separate from persistent Color Scenes. */
export function planVisualAccentEvents(direction) {
  const accents = Array.isArray(direction?.visualAccents) ? direction.visualAccents : [];
  return accents
    .map((accent) => ({
      accent,
      resolvedTimeSeconds: finite(accent?.timeSeconds, Number.NaN),
    }))
    .filter(({ resolvedTimeSeconds }) => Number.isFinite(resolvedTimeSeconds) && resolvedTimeSeconds >= 0)
    .sort((left, right) => left.resolvedTimeSeconds - right.resolvedTimeSeconds)
    .map(({ accent, resolvedTimeSeconds }, index) => ({
      id: String(accent.id ?? `visual-accent-${index + 1}`),
      timeSeconds: Number(resolvedTimeSeconds.toFixed(5)),
      anchorId: accent.anchorId,
      ...(accent.sceneId == null ? {} : { sceneId: accent.sceneId }),
      kind: 'pulse',
      strength: Number(clamp(finite(accent.strength)).toFixed(3)),
      source: String(accent.source ?? accent.id ?? 'director-visual-accent'),
      evidenceIds: Array.isArray(accent.evidenceIds) ? [...accent.evidenceIds] : [],
    }));
}

/** Compile supported Color Scenes into the runtime color timeline. */
export function planColorSchemeEvents(analysis, layoutIntent, direction) {
  if (direction != null) {
    return buildDirectedSceneEvents(
      analysis,
      Array.isArray(direction?.colorScenes) ? direction.colorScenes : [],
    );
  }
  const sections = Array.isArray(layoutIntent?.sections)
    ? [...layoutIntent.sections].sort((left, right) => left.startSeconds - right.startSeconds)
    : [];
  const beatSeconds = 60 / Math.max(1, finite(analysis?.song?.bpm, 120));
  const events = buildSectionEvents(analysis, sections, beatSeconds);
  for (let index = 1; index < events.length; index += 1) {
    if (!colorSchemesDiffer(events[index - 1].colorSchemeId, events[index].colorSchemeId)) {
      throw new Error(`Color scheme event ${index} repeats a region hue from the previous event.`);
    }
  }
  return events;
}
