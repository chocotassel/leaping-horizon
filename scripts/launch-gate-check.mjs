import assert from 'node:assert/strict';
import {
  afterNextPaint,
  GameLaunchTimeoutError,
  waitForGameLaunch,
} from '../node_modules/.cache/leaping-horizon-launch-check/launchGate.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const scheduledFrames = [];
let preparationStarted = false;
afterNextPaint(() => { preparationStarted = true; }, (callback) => scheduledFrames.push(callback));
assert.equal(preparationStarted, false, 'preparation must not start in the click frame');
scheduledFrames.shift()();
assert.equal(preparationStarted, false, 'the launch animation must receive a paint before preparation');
scheduledFrames.shift()();
assert.equal(preparationStarted, true, 'preparation should start on the following frame');

const slowStartedAt = Date.now();
await waitForGameLaunch(delay(35), 5, 200);
assert.ok(Date.now() - slowStartedAt >= 25, 'launch must wait for preparation beyond its minimum animation');

const minimumStartedAt = Date.now();
await waitForGameLaunch(Promise.resolve(), 30, 200);
assert.ok(Date.now() - minimumStartedAt >= 20, 'launch must preserve its minimum animation');

await assert.rejects(
  waitForGameLaunch(new Promise(() => {}), 0, 20),
  GameLaunchTimeoutError,
  'launch must fail instead of waiting forever',
);

const preparationFailure = new Error('prepare failed');
await assert.rejects(
  waitForGameLaunch(Promise.reject(preparationFailure), 0, 200),
  (error) => error === preparationFailure,
  'launch must preserve the real preparation failure',
);

console.log('launch gate check passed');
