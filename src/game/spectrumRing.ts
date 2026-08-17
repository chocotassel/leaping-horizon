export interface SpectrumCluster {
  position: number;
  profile: number[];
  peakIndex: number;
  bandPosition: number;
  gain: number;
}

const GOLDEN_RATIO_FRACTION = 0.618033988749895;

export function getSpectrumNoise(seed: number, step: number): number {
  const value = Math.sin(seed * 12.9898 + step * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function getCircularDistance(a: number, b: number): number {
  const distance = Math.abs(a - b);
  return Math.min(distance, 1 - distance);
}

function createClusterProfile(seed: number, clusterIndex: number, size: number): {
  profile: number[];
  peakIndex: number;
} {
  const peakIndex = size === 2
    ? Math.floor(getSpectrumNoise(seed, clusterIndex * 11 + 3) * 2)
    : 1 + Math.floor(getSpectrumNoise(seed, clusterIndex * 11 + 3) * (size - 2));
  const leftEdge = 0.3 + getSpectrumNoise(seed, clusterIndex * 11 + 4) * 0.36;
  const rightEdge = 0.3 + getSpectrumNoise(seed, clusterIndex * 11 + 5) * 0.36;
  const leftCurve = 0.72 + getSpectrumNoise(seed, clusterIndex * 11 + 6) * 0.72;
  const rightCurve = 0.72 + getSpectrumNoise(seed, clusterIndex * 11 + 7) * 0.72;
  const profile = Array.from({ length: size }, (_, index) => {
    if (index === peakIndex) return 1;
    if (index < peakIndex) {
      const progress = peakIndex === 0 ? 0 : index / peakIndex;
      return leftEdge + (1 - leftEdge) * Math.pow(progress, leftCurve);
    }
    const sideLength = size - peakIndex - 1;
    const progress = sideLength === 0 ? 0 : (size - index - 1) / sideLength;
    return rightEdge + (1 - rightEdge) * Math.pow(progress, rightCurve);
  });
  return { profile, peakIndex };
}

export function createSpectrumClusters(
  seed: number,
  count: number,
  barCount: number,
  forbiddenPositions: readonly number[] = [],
): SpectrumCluster[] {
  const phase = getSpectrumNoise(seed, 0);
  const clusters: SpectrumCluster[] = [];
  for (let index = 0; index < count; index += 1) {
    const size = 2 + Math.floor(getSpectrumNoise(seed, index * 11 + 1) * 7);
    let position: number | null = null;
    let bestPosition = 0;
    let bestClearance = -Infinity;
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const rawPosition = (
        phase
        + index * GOLDEN_RATIO_FRACTION
        + attempt * GOLDEN_RATIO_FRACTION
        + getSpectrumNoise(seed, index * 48 + attempt + 20) * 0.035
      ) % 1;
      const candidate = Math.round(rawPosition * barCount) % barCount / barCount;
      const halfSpan = size / barCount / 2;
      const compositionClearance = Math.min(
        getCircularDistance(candidate, 0.25) - 0.035 - halfSpan,
        getCircularDistance(candidate, 0.75) - 0.06 - halfSpan,
      );
      const clusterClearance = clusters.length === 0
        ? 1
        : Math.min(...clusters.map((cluster) => (
          getCircularDistance(candidate, cluster.position)
          - (size + cluster.profile.length) / barCount / 2
          - 0.018
        )));
      const axisClearance = forbiddenPositions.length === 0
        ? 1
        : Math.min(...forbiddenPositions.map((forbidden) => {
          const distance = getCircularDistance(candidate, forbidden);
          return Math.min(distance, Math.abs(0.5 - distance)) - 0.03;
        }));
      const clearance = Math.min(compositionClearance, clusterClearance, axisClearance);
      if (clearance > bestClearance) {
        bestClearance = clearance;
        bestPosition = candidate;
      }
      if (clearance >= 0) {
        position = candidate;
        break;
      }
    }
    position ??= bestPosition;

    const { profile, peakIndex } = createClusterProfile(seed, index, size);
    clusters.push({
      position,
      profile,
      peakIndex,
      bandPosition: getSpectrumNoise(seed, index * 11 + 8),
      gain: 0.82 + getSpectrumNoise(seed, index * 11 + 9) * 0.3,
    });
  }
  return clusters;
}

export function getSpectrumBandEnergy(
  spectrum: Uint8Array,
  startBin: number,
  endBin: number,
  position: number,
): number {
  const start = Math.max(0, Math.min(startBin, spectrum.length - 1));
  const end = Math.max(start, Math.min(endBin, spectrum.length - 1));
  const center = Math.round(start + (end - start) * position);
  let total = 0;
  let samples = 0;
  for (let bin = Math.max(start, center - 1); bin <= Math.min(end, center + 1); bin += 1) {
    total += spectrum[bin] / 255;
    samples += 1;
  }
  return samples === 0 ? 0 : total / samples;
}

export function getSpectrumBandRise(
  spectrum: Uint8Array,
  previousSpectrum: Uint8Array,
  startBin: number,
  endBin: number,
  position: number,
): number {
  return Math.max(
    0,
    getSpectrumBandEnergy(spectrum, startBin, endBin, position)
      - getSpectrumBandEnergy(previousSpectrum, startBin, endBin, position)
      - 1 / 255,
  );
}

export function getSpectrumBarTarget(
  index: number,
  count: number,
  clusters: readonly SpectrumCluster[],
  amplitudes: readonly number[],
): number {
  let target = 1;
  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
    const cluster = clusters[clusterIndex];
    const center = Math.round(cluster.position * count) % count;
    const start = (center - cluster.peakIndex + count) % count;
    const localIndex = (index - start + count) % count;
    if (localIndex >= cluster.profile.length) continue;
    target = Math.max(target, 1 + cluster.profile[localIndex] * amplitudes[clusterIndex]);
  }
  return target;
}

export function followSpectrumImpulse(
  current: number,
  target: number,
  dt: number,
  releaseSpeed: number,
): number {
  if (target > current) return target;
  return 1 + (current - 1) * Math.exp(-releaseSpeed * dt);
}
