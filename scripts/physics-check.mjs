import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('/tmp/leaping-horizon-physics-check/physics.js', 'utf8');
const physics = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

assert.equal(physics.overlapsPlayer(0, 0, 0), true);
assert.equal(physics.overlapsPlayer(0, 0, -0.1), false);
assert.equal(physics.hasPassedPlayer(-0.1), true);
assert.ok(physics.getObstacleZ(-0.1) - physics.PLAYER_Z > 2);
assert.equal(physics.getRingApproach(0), 0);
assert.equal(physics.getRingApproach(0.85), 0);
assert.equal(physics.getRingApproach(1), 1);
console.log('physics check passed');
