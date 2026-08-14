import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('/tmp/leaping-horizon-physics-check/physics.js', 'utf8');
const physics = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

assert.equal(physics.overlapsPlayer(0, 0), true);
assert.equal(physics.overlapsPlayer(0, 0.949), true);
assert.equal(physics.overlapsPlayer(0, 0.95), false);
assert.equal(physics.overlapsPlayer(-1.9999999999999998, -1), false);
assert.ok(physics.getObstacleZ(-0.1) - physics.PLAYER_Z > 2);
assert.equal(physics.shouldRenderObstacle('miss'), true);
assert.equal(physics.shouldRenderObstacle('hit'), false);
assert.equal(physics.getRingApproach(38, 40.5, 38.1), 0);
assert.equal(physics.getRingApproach(38.1, 40.5, 38.1), 0);
assert.equal(physics.getRingApproach(40.5, 40.5, 38.1), 1);
assert.equal(physics.getRingApproach(38.49, 40.5, 40), 0);
assert.ok(physics.getRingApproach(39.5, 40.5, 40) > 0);
console.log('physics check passed');
