import assert from 'node:assert/strict';
import {
  createSpectrumClusters,
  followSpectrumImpulse,
  getSpectrumBandRise,
  getSpectrumBarTarget,
  getSpectrumNoise,
} from '../node_modules/.cache/leaping-horizon-spectrum-ring-check/spectrumRing.js';

const circularDistance = (a, b) => {
  const distance = Math.abs(a - b);
  return Math.min(distance, 1 - distance);
};

const outerCounts = new Set();
const innerCounts = new Set();
const clusterSizes = new Set();
const steadySpectrum = new Uint8Array(128).fill(128);
const onsetSpectrum = new Uint8Array(128).fill(210);

for (let bar = 0; bar < 80; bar += 1) {
  const seed = bar * 101 + 17;
  const outerCount = 2 + Math.floor(getSpectrumNoise(seed, 31) * 3);
  const innerCount = 2 + Math.floor(getSpectrumNoise(seed, 47) * 4);
  const outer = createSpectrumClusters(seed, outerCount, 112);
  const inner = createSpectrumClusters(seed + 7919, innerCount, 88, outer.map(({ position }) => position));
  outerCounts.add(outerCount);
  innerCounts.add(innerCount);

  for (const cluster of [...outer, ...inner]) {
    clusterSizes.add(cluster.profile.length);
    assert.ok(cluster.profile.length >= 2 && cluster.profile.length <= 8);
    assert.equal(Math.max(...cluster.profile), 1);
    assert.ok(Math.min(...cluster.profile) >= 0.3);
    assert.equal(new Set(cluster.profile.map((height) => height.toFixed(4))).size, cluster.profile.length);
  }
  for (const outerCluster of outer) {
    for (const innerCluster of inner) {
      const distance = circularDistance(outerCluster.position, innerCluster.position);
      assert.ok(Math.min(distance, Math.abs(0.5 - distance)) > 0.015);
    }
  }

  const steadyAmplitudes = outer.map((cluster) => (
    getSpectrumBandRise(steadySpectrum, steadySpectrum, 1, 28, cluster.bandPosition) * 13
  ));
  const steadyTargets = Array.from(
    { length: 112 },
    (_, index) => getSpectrumBarTarget(index, 112, outer, steadyAmplitudes),
  );
  assert.equal(Math.max(...steadyTargets), 1, 'steady music must return every bar to baseline');

  const amplitudes = outer.map((cluster) => Math.min(
    1.9,
    getSpectrumBandRise(onsetSpectrum, steadySpectrum, 1, 28, cluster.bandPosition)
      * 13 * cluster.gain,
  ));
  const targets = Array.from(
    { length: 112 },
    (_, index) => getSpectrumBarTarget(index, 112, outer, amplitudes),
  );
  assert.ok(Math.max(...targets) > 2.5, 'an onset must create a clearly visible peak');
  assert.ok(targets.filter((target) => target > 1).length <= outer.reduce((sum, cluster) => (
    sum + cluster.profile.length
  ), 0));
}

assert.deepEqual([...outerCounts].sort(), [2, 3, 4]);
assert.deepEqual([...innerCounts].sort(), [2, 3, 4, 5]);
assert.deepEqual([...clusterSizes].sort(), [2, 3, 4, 5, 6, 7, 8]);
assert.equal(followSpectrumImpulse(1, 2.4, 1 / 60, 5.6), 2.4, 'attack must happen in one frame');
let height = 2.4;
for (let frame = 0; frame < 30; frame += 1) {
  height = followSpectrumImpulse(height, 1, 1 / 60, 5.6);
}
assert.ok(height > 1 && height < 1.16, 'a peak must visibly decay back to baseline');
const falling = followSpectrumImpulse(2.4, 1, 1 / 60, 5.6);
assert.equal(followSpectrumImpulse(falling, 2.4, 1 / 60, 5.6), 2.4, 'a repeated onset must retrigger the peak');
