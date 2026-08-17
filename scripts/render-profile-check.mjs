import assert from 'node:assert/strict';
import {
  DESIGN_ASPECT,
  getCameraZoom,
  getRenderPixelRatio,
  selectRenderProfile,
} from '../node_modules/.cache/leaping-horizon-render-profile-check/renderProfile.js';

const iphoneAspect = 390 / 844;
const iphoneZoom = getCameraZoom(iphoneAspect);
assert.ok(iphoneZoom < 1, 'a tall iPhone must zoom out instead of enlarging the scene');
assert.ok(Math.abs(iphoneAspect / iphoneZoom - DESIGN_ASPECT) < 1e-9);
assert.equal(getCameraZoom(DESIGN_ASPECT), 1);
assert.equal(getCameraZoom(16 / 9), 1);

const high = selectRenderProfile({ hardwareConcurrency: 6 });
assert.equal(high.tier, 'high');
assert.equal(high.antialias, true);
assert.equal(getRenderPixelRatio(high, 390, 844, 3), 3);

const iphoneProMax = selectRenderProfile({
  hardwareConcurrency: 4,
  devicePixelRatio: 3,
  screenWidth: 440,
  screenHeight: 956,
});
assert.equal(iphoneProMax.tier, 'high', 'a Pro Max-class display must not be downgraded by WebKit core limits');
assert.equal(getRenderPixelRatio(iphoneProMax, 440, 956, 3), 3);

const balanced = selectRenderProfile({ hardwareConcurrency: 5, deviceMemory: 4 });
assert.equal(balanced.tier, 'balanced');
assert.equal(getRenderPixelRatio(balanced, 390, 844, 3), 1.5);

const low = selectRenderProfile({ hardwareConcurrency: 4, deviceMemory: 2 });
assert.equal(low.tier, 'low');
assert.equal(low.lowGeometry, true);
assert.equal(getRenderPixelRatio(low, 390, 844, 3), 1.25);

const largeScreenRatio = getRenderPixelRatio(high, 1024, 1366, 3);
assert.ok(largeScreenRatio < 1.7, 'large screens must stay within the high-tier pixel budget');
