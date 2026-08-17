import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLOR_SCHEME_HUES,
  colorSchemesDiffer,
  planColorSchemeEvents,
} from './color-timeline.mjs';

function fixture(strong = true) {
  const sections = [
    { id: 'S01', startSeconds: 0, endSeconds: 8, role: 'intro', pressure: 0.2, energy: 0.2, activity: { melodic: 0.4, percussive: 0.2, rhythmic: 0.2 } },
    { id: 'S02', startSeconds: 8, endSeconds: 16, role: 'build', pressure: 0.5, energy: 0.5, activity: { melodic: 0.3, percussive: 0.5, rhythmic: 0.8 } },
    { id: 'S03', startSeconds: 16, endSeconds: 28, role: 'peak', pressure: 0.95, energy: 0.9, activity: { melodic: 0.2, percussive: 1, rhythmic: 0.8 } },
    { id: 'S04', startSeconds: 28, endSeconds: 32, role: 'outro', pressure: 0.15, energy: 0.15, activity: { melodic: 0.1, percussive: 0.1, rhythmic: 0.1 } },
  ];
  const confidence = strong ? 1 : 0.1;
  return {
    analysis: {
      song: { bpm: 120, durationSeconds: 32, audioFingerprint: 'color-fixture' },
      eventSources: [
        {
          id: 'librosa-percussive',
          events: [16.5, 17, 18, 19, 20, 21, 22, 23].map((timeSeconds) => ({ timeSeconds, confidence })),
        },
        { id: 'beat-this', events: [] },
      ],
    },
    intent: { sections },
  };
}

test('changes persistent themes at structural transitions and alternates on strong drum peaks', () => {
  const { analysis, intent } = fixture();
  const events = planColorSchemeEvents(analysis, intent);
  const sectionEvents = events.filter((event) => event.kind === 'section');
  const accentEvents = events.filter((event) => event.kind === 'accent');

  assert.equal(events[0].timeSeconds, 0);
  assert.equal(events[0].colorSchemeId, 'cyanWhite');
  assert.deepEqual(sectionEvents.map((event) => event.timeSeconds), [0, 8, 16, 28]);
  assert.ok(accentEvents.length >= 2 && accentEvents.length % 2 === 0);
  assert.notEqual(accentEvents[0].colorSchemeId, accentEvents[1].colorSchemeId);
  events.slice(1).forEach((event, index) => {
    const previous = events[index];
    assert.ok(colorSchemesDiffer(previous.colorSchemeId, event.colorSchemeId));
    assert.notEqual(
      COLOR_SCHEME_HUES[previous.colorSchemeId].primary,
      COLOR_SCHEME_HUES[event.colorSchemeId].primary,
    );
    assert.notEqual(
      COLOR_SCHEME_HUES[previous.colorSchemeId].accent,
      COLOR_SCHEME_HUES[event.colorSchemeId].accent,
    );
  });
  assert.deepEqual(planColorSchemeEvents(analysis, intent), events, 'theme planning must be deterministic');
});

test('defines twelve color-wheel themes with white accents and minimal green', () => {
  assert.equal(Object.keys(COLOR_SCHEME_HUES).length, 12);
  assert.ok(Object.values(COLOR_SCHEME_HUES).filter(({ accent }) => accent === 'white').length >= 6);
  assert.ok(Object.values(COLOR_SCHEME_HUES).filter(({ primary }) => primary >= 90 && primary <= 150).length <= 1);
  Object.values(COLOR_SCHEME_HUES).forEach(({ primary, accent }) => {
    if (accent !== 'white') assert.equal((primary + 180) % 360, accent);
  });
  assert.equal(colorSchemesDiffer('redWhite', 'blueWhite'), false);
  assert.equal(colorSchemesDiffer('redWhite', 'yellowBlue'), true);
});

test('does not emit drum accents for weak sections', () => {
  const { analysis, intent } = fixture(false);
  intent.sections[2].role = 'drive';
  intent.sections[2].pressure = 0.3;
  assert.equal(planColorSchemeEvents(analysis, intent).some((event) => event.kind === 'accent'), false);
});
