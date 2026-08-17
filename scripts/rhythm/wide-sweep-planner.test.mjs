import assert from 'node:assert/strict';
import test from 'node:test';

import { planFullWidthSweeps } from './wide-sweep-planner.mjs';

function makeSlots(count, { interval = 0.4, sectionRole = 'peak', score = 0.9 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    baseLane: 2,
    barInPhrase: Math.floor(index / 4),
    beatInBar: index % 4,
    blocked: false,
    sectionRole,
    score,
    timeSecondsByOccurrence: [index * interval, 20 + index * interval],
  }));
}

test('plans an alternating edge drum run from real timestamps and lane capacities', () => {
  const result = planFullWidthSweeps({
    slots: makeSlots(18),
    mobility: [0, ...Array.from({ length: 17 }, () => 4)],
    laneCount: 5,
    secondsPerBeat: 0.4,
    orientationSeed: 0.2,
  });

  assert.equal(result.gestures.length, 1);
  const [gesture] = result.gestures;
  assert.deepEqual(gesture.anchorLanes, [0, 4, 0, 4, 0]);
  assert.equal(gesture.anchorSlots.every((slot, index) => (
    result.slotPlans[slot].kind === 'edge-target'
    && result.slotPlans[slot].lane === gesture.anchorLanes[index]
  )), true);
  assert.equal(gesture.anchorSlots.every((slot, index, slots) => index === 0 || slot === slots[index - 1] + 1), true);
  assert.equal(gesture.edgeToEdgeTransitionCount, 4);
  assert.equal(result.slotPlans.slice(gesture.startSlot, gesture.endSlot + 1).every(Boolean), true);
  assert.equal(result.slotPlans.filter((plan) => plan?.kind === 'silent-slot').length, 0);
});

test('does not invent a full-width transition when timestamps or mobility are too tight', () => {
  const slots = makeSlots(14, { interval: 0.16 });
  const result = planFullWidthSweeps({
    slots,
    mobility: Array.from({ length: 14 }, () => 0),
    laneCount: 5,
    secondsPerBeat: 0.4,
  });

  assert.deepEqual(result.gestures, []);
  assert.equal(result.slotPlans.every((plan) => plan === null), true);
});

test('keeps blocked gesture slots out of a sweep window', () => {
  const slots = makeSlots(34);
  for (let index = 10; index <= 15; index += 1) slots[index].blocked = true;
  const result = planFullWidthSweeps({
    slots,
    mobility: [0, ...Array.from({ length: 33 }, () => 4)],
    laneCount: 5,
    secondsPerBeat: 0.4,
  });

  assert.equal(result.gestures.length > 0, true);
  assert.equal(result.gestures.every((gesture) => (
    gesture.endSlot < 10 || gesture.startSlot > 15
  )), true);
});
