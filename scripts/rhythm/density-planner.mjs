const HAZARD = 2;
const LANE_COUNT = 5;
const PRESERVED_GESTURES = new Set(['m', 'full-width-sweep']);

export const DENSITY_GAP_SECONDS = {
  solid: 0.04,
  compact: 0.22,
};

function basePattern(pattern = '') {
  return pattern.replace(/-(?:melody|fill)$/, '');
}

function allowedLanes(event) {
  return event.obstacles.flatMap((cell, lane) => cell !== HAZARD ? [lane] : []);
}

export function planDensityInterval(before, after) {
  const patterns = [basePattern(before.pattern), basePattern(after.pattern)];
  if (
    before.phraseId !== after.phraseId
    || before._sectionIndex !== after._sectionIndex
    || patterns.some((pattern) => PRESERVED_GESTURES.has(pattern))
  ) return null;

  const safeLanes = [...new Set([...allowedLanes(before), ...allowedLanes(after)])].sort();
  if (!safeLanes.length) return null;
  let firstSafeLane = safeLanes[0];
  let lastSafeLane = safeLanes.at(-1);
  if (firstSafeLane === lastSafeLane && firstSafeLane > 0 && lastSafeLane < LANE_COUNT - 1) {
    if (firstSafeLane < Math.floor(LANE_COUNT / 2)) lastSafeLane += 1;
    else firstSafeLane -= 1;
  }
  const obstacles = Array.from(
    { length: LANE_COUNT },
    (_, lane) => lane >= firstSafeLane && lane <= lastSafeLane ? 0 : HAZARD,
  );
  if (!obstacles.includes(HAZARD)) return null;

  const pressure = Math.max(Number(before.pressure) || 0, Number(after.pressure) || 0);
  const mode = patterns.includes('wave') || pressure >= 0.72
    ? 'solid'
    : pressure >= 0.42 ? 'compact' : null;
  return mode ? { mode, obstacles, allowedLanes: allowedLanes({ obstacles }) } : null;
}

export function densityFillCount(durationSeconds, mode) {
  const maximumGap = DENSITY_GAP_SECONDS[mode];
  return maximumGap ? Math.max(0, Math.ceil(durationSeconds / maximumGap) - 1) : 0;
}
