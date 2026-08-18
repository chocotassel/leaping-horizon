import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLOR_SCHEME_HUES,
  colorSchemesDiffer,
  planColorSchemeEvents,
} from './color-timeline.mjs';

const analysis = {
  song: { bpm: 120, durationSeconds: 32, audioFingerprint: 'color-fixture' },
};
const intent = {
  sections: [
    { id: 'S01', startSeconds: 0, role: 'intro', pressure: 0.2, energy: 0.2 },
    { id: 'S02', startSeconds: 8, role: 'build', pressure: 0.5, energy: 0.5 },
    { id: 'S03', startSeconds: 16, role: 'peak', pressure: 0.95, energy: 0.9 },
    { id: 'S04', startSeconds: 28, role: 'outro', pressure: 0.15, energy: 0.15 },
  ],
};

test('creates a deterministic conservative base palette at structural boundaries', () => {
  const events = planColorSchemeEvents(analysis, intent);
  assert.deepEqual(events.map((event) => event.timeSeconds), [0, 8, 16, 28]);
  assert.deepEqual(planColorSchemeEvents(analysis, intent), events);
  events.slice(1).forEach((event, index) => {
    assert.ok(colorSchemesDiffer(events[index].colorSchemeId, event.colorSchemeId));
  });
});

test('keeps the twelve runtime schemes available to the editor', () => {
  assert.equal(Object.keys(COLOR_SCHEME_HUES).length, 12);
  assert.equal(colorSchemesDiffer('redWhite', 'blueWhite'), false);
  assert.equal(colorSchemesDiffer('redWhite', 'yellowBlue'), true);
});
