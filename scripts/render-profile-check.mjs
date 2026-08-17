import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  DESIGN_ASPECT,
  getCameraZoom,
  getGameplayViewport,
  getRenderPixelRatio,
  selectRenderProfile,
} from '../node_modules/.cache/leaping-horizon-render-profile-check/renderProfile.js';

function measureGameplayViewport(width, height) {
  const layout = getGameplayViewport(width / height);
  const camera = new THREE.PerspectiveCamera(76, width / height, 0.1, 900);
  camera.position.set(0, 6.8, 9.35);
  camera.lookAt(0, layout.cameraTargetY, -14.9);
  camera.zoom = layout.cameraZoom;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const player = new THREE.Vector3(0, 0.32, -2.4);
  const playerNdcY = player.clone().project(camera).y;
  const targetNdcY = layout.playerBottomRatio * 2 - 1;
  camera.setViewOffset(
    width,
    height,
    0,
    (targetNdcY - playerNdcY) * height / 2,
    width,
    height,
  );

  const project = (point) => {
    const projected = point.project(camera);
    return {
      x: (projected.x + 1) * width / 2,
      y: (1 - projected.y) * height / 2,
    };
  };
  const ringCenter = new THREE.Vector3(0, 15, -64);
  const ringRadius = 14 * layout.ringScale;
  const center = project(ringCenter.clone());
  const right = project(ringCenter.clone().add(new THREE.Vector3(ringRadius, 0, 0)));
  const top = project(ringCenter.clone().add(new THREE.Vector3(
    0,
    Math.cos(camera.rotation.x) * ringRadius,
    Math.sin(camera.rotation.x) * ringRadius,
  )));
  const playerScreen = project(player);
  const farRoad = project(new THREE.Vector3(0, 0, -64));
  return {
    ringRadiusX: right.x - center.x,
    ringRadiusY: center.y - top.y,
    ringTop: top.y,
    roadLength: playerScreen.y - farRoad.y,
  };
}

const iphoneAspect = 390 / 844;
const iphoneZoom = getCameraZoom(iphoneAspect);
assert.ok(iphoneZoom < 1, 'a tall iPhone must zoom out instead of enlarging the scene');
assert.ok(Math.abs(iphoneAspect / iphoneZoom - DESIGN_ASPECT) < 1e-9);
assert.equal(getCameraZoom(DESIGN_ASPECT), 1);
assert.equal(getCameraZoom(16 / 9), 1);

const designGameplay = measureGameplayViewport(360, 640);
const tallGameplay = measureGameplayViewport(360, 840);
assert.ok(
  tallGameplay.ringTop <= designGameplay.ringTop + 32,
  '9:21 must not dump the added height above the ring',
);
assert.ok(
  tallGameplay.roadLength > designGameplay.roadLength,
  '9:21 must reveal a longer road through camera pitch',
);
assert.ok(
  Math.abs(tallGameplay.ringRadiusX / tallGameplay.ringRadiusY - 1) < 0.01,
  'the ring plane must remain circular in camera projection',
);
assert.ok(
  Math.abs(tallGameplay.ringRadiusX - designGameplay.ringRadiusX) < 2,
  'the responsive transition must not visibly resize the ring',
);

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
