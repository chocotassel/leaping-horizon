import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLOR_SCHEME_HUES,
  colorSchemesDiffer,
  planColorSchemeEvents,
  planVisualAccentEvents,
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

test('uses only Director Color Scenes for persistent theme changes', () => {
  const { analysis, intent } = fixture();
  const direction = {
    colorScenes: [
      {
        id: 'color-opening',
        sceneId: 'opening',
        startSeconds: 0,
        anchorId: 'anchor-opening',
        affect: 'calm',
        evidenceIds: ['section-opening'],
      },
      {
        id: 'color-arrival',
        sceneId: 'arrival',
        startSeconds: 12,
        anchorId: 'anchor-arrival',
        affect: 'urgent',
        evidenceIds: ['turn-arrival'],
      },
      {
        id: 'color-release',
        sceneId: 'release',
        startSeconds: 24,
        anchorId: 'anchor-release',
        affect: 'open',
        evidenceIds: ['turn-release'],
      },
    ],
    visualAccents: [
      { id: 'accent-kick', timeSeconds: 16.5, anchorId: 'anchor-kick', strength: 0.9 },
    ],
  };

  const events = planColorSchemeEvents(analysis, intent, direction);

  assert.deepEqual(events.map((event) => event.timeSeconds), [0, 12, 24]);
  assert.deepEqual(events.map((event) => event.source), [
    'color-opening',
    'color-arrival',
    'color-release',
  ]);
  assert.ok(events.every((event) => event.kind === 'section'));
  events.slice(1).forEach((event, index) => {
    assert.ok(colorSchemesDiffer(events[index].colorSchemeId, event.colorSchemeId));
  });
  assert.equal(events[1].anchorId, 'anchor-arrival');
  assert.deepEqual(events[1].evidenceIds, ['turn-arrival']);
});

test('plans ordinary strong anchors as independent Visual Accents', () => {
  const events = planVisualAccentEvents({
    visualAccents: [
      {
        id: 'accent-snare',
        timeSeconds: 18.25,
        anchorId: 'anchor-snare',
        sceneId: 'arrival',
        strength: 0.82,
        kind: 'pulse',
        evidenceIds: ['percussive-snare'],
      },
      {
        id: 'accent-kick',
        timeSeconds: 16.5,
        anchorId: 'anchor-kick',
        strength: 1,
        source: 'impact',
        evidenceIds: ['percussive-kick', 'downbeat-09'],
      },
    ],
  });

  assert.deepEqual(events, [
    {
      id: 'accent-kick',
      timeSeconds: 16.5,
      anchorId: 'anchor-kick',
      kind: 'pulse',
      strength: 1,
      source: 'impact',
      evidenceIds: ['percussive-kick', 'downbeat-09'],
    },
    {
      id: 'accent-snare',
      timeSeconds: 18.25,
      anchorId: 'anchor-snare',
      sceneId: 'arrival',
      kind: 'pulse',
      strength: 0.82,
      source: 'accent-snare',
      evidenceIds: ['percussive-snare'],
    },
  ]);
  assert.ok(events.every((event) => !Object.hasOwn(event, 'colorSchemeId')));
});

test('holds a Director Color Scene through sub-second reversals', () => {
  const { analysis, intent } = fixture();
  const direction = {
    colorScenes: [
      { id: 'scene-start', timeSeconds: 0, startAnchorId: 'anchor-start', sceneId: 'calm' },
      { id: 'scene-turn', timeSeconds: 10, startAnchorId: 'anchor-turn', sceneId: 'urgent' },
      { id: 'scene-feint', timeSeconds: 10.4, startAnchorId: 'anchor-feint', sceneId: 'calm' },
      { id: 'scene-return', timeSeconds: 10.8, startAnchorId: 'anchor-return', sceneId: 'urgent' },
      { id: 'scene-release', timeSeconds: 11.2, startAnchorId: 'anchor-release', sceneId: 'open' },
    ],
  };

  const events = planColorSchemeEvents(analysis, intent, direction);

  assert.deepEqual(events.map((event) => event.timeSeconds), [0, 10, 11.2]);
  events.slice(1).forEach((event, index) => {
    assert.ok(colorSchemesDiffer(events[index].colorSchemeId, event.colorSchemeId));
  });
});

test('fallback changes persistent themes only at structural transitions', () => {
  const { analysis, intent } = fixture();
  const events = planColorSchemeEvents(analysis, intent);
  const sectionEvents = events.filter((event) => event.kind === 'section');

  assert.equal(events[0].timeSeconds, 0);
  assert.equal(events[0].colorSchemeId, 'cyanWhite');
  assert.deepEqual(sectionEvents.map((event) => event.timeSeconds), [0, 8, 16, 28]);
  assert.ok(events.every((event) => event.kind === 'section'));
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

test('fallback also holds structural themes through sub-second role changes', () => {
  const { analysis, intent } = fixture();
  intent.sections = [
    { id: 'S01', startSeconds: 0, endSeconds: 10, role: 'intro', pressure: 0.2, energy: 0.2 },
    { id: 'S02', startSeconds: 10, endSeconds: 10.4, role: 'peak', pressure: 1, energy: 1 },
    { id: 'S03', startSeconds: 10.4, endSeconds: 10.8, role: 'break', pressure: 0.1, energy: 0.1 },
    { id: 'S04', startSeconds: 10.8, endSeconds: 14, role: 'outro', pressure: 0.2, energy: 0.2 },
  ];

  assert.deepEqual(
    planColorSchemeEvents(analysis, intent).map((event) => event.timeSeconds),
    [0, 10],
  );
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

test('fallback palette is independent of detector peak strength', () => {
  const strong = fixture(true);
  const weak = fixture(false);
  assert.deepEqual(
    planColorSchemeEvents(strong.analysis, strong.intent),
    planColorSchemeEvents(weak.analysis, weak.intent),
  );
});
