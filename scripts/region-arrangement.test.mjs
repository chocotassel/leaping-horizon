import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createServer } from 'vite';

let server;
let arrangementModule;
let levelEditsModule;

before(async () => {
  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
  arrangementModule = await server.ssrLoadModule('/src/regionArrangement.ts');
  levelEditsModule = await server.ssrLoadModule('/src/levelEdits.ts');
});

after(async () => {
  await server?.close();
});

function fixtureLevel(times = [0, 1, 2, 3]) {
  const durationSeconds = Math.max(4, (times.at(-1) ?? 3) + 1);
  return {
    id: 'fixture-flow',
    version: 3,
    song: {
      title: 'Fixture',
      artist: 'Fixture',
      audioUrl: './audio.mp3',
      bpm: 60,
      durationSeconds,
    },
    generation: { algorithm: 'measured-pitch-base-v1', noteCount: 0 },
    rhythmPoints: times.map((timeSeconds, index) => ({
      id: `point-${index}`,
      timeSeconds,
      suggestedLane: 2,
      kind: 'attack',
      strength: 0.8,
      sourceRole: 'fixture',
      hasBaseRow: false,
    })),
    colorSchemeEvents: [
      { timeSeconds: 0, colorSchemeId: 'cyanWhite', kind: 'section', source: 'base', strength: 0 },
    ],
    events: [],
  };
}

function fixtureScore(source, endSeconds = 4) {
  return {
    kind: 'authoring-score',
    schemaVersion: '1.0.0',
    algorithm: 'fixture-authoring-v1',
    levelId: 'fixture-flow',
    audioFingerprint: 'fixture-audio',
    regions: [{
      id: 'verse',
      kind: 'phrase',
      sourceId: 'fixture-phrase',
      startSeconds: 0,
      endSeconds,
      intensity: 0.7,
    }],
    sources: [source],
    repeatSets: [],
    suggestions: [],
  };
}

function arrangementEdits(recipe) {
  return {
    version: 2,
    levelId: 'fixture-flow',
    arrangements: [recipe],
    rowOverrides: [],
    colorRanges: [],
  };
}

test('compilePerformance combines timing layers while lane and accent evidence never create row times', () => {
  const base = fixtureLevel([0.2, 0.23, 1, 2]);
  const stream = (id, kind, events, capabilities) => ({
    id,
    label: id,
    kind,
    stemRole: id.split(':')[1] ?? 'mix',
    identity: 'model-estimated',
    availability: 'estimated',
    capabilities,
    events,
  });
  const score = {
    kind: 'authoring-score',
    schemaVersion: '2.0.0',
    algorithm: 'fixture-authoring-v2',
    levelId: base.id,
    audioFingerprint: 'fixture-audio',
    evidenceFingerprint: 'fixture-evidence',
    sources: [],
    evidenceStreams: {
      timing: [
        stream('stem:vocals:timing', 'timing', [
          { id: 'vocal-a', timeSeconds: 0.2, strength: 0.8 },
          { id: 'vocal-b', timeSeconds: 1, strength: 0.9 },
        ], { onsets: true, pitch: false, continuousPitch: false }),
        stream('stem:drums:timing', 'timing', [
          { id: 'drum-a', timeSeconds: 0.23, strength: 1 },
          { id: 'drum-b', timeSeconds: 2, strength: 0.9 },
        ], { onsets: true, pitch: false, continuousPitch: false }),
      ],
      lane: [
        stream('stem:vocals:pitch', 'lane', [
          { id: 'pitch-a', timeSeconds: 0.2, pitchMidi: 60, strength: 0.9 },
          { id: 'pitch-only', timeSeconds: 0.5, pitchMidi: 62, strength: 0.9 },
          { id: 'pitch-b', timeSeconds: 1, pitchMidi: 66, strength: 0.9 },
          { id: 'pitch-c', timeSeconds: 2, pitchMidi: 72, strength: 0.9 },
        ], { onsets: false, pitch: true, continuousPitch: true }),
      ],
      accent: [
        stream('stem:drums:accents', 'accent', [
          { id: 'accent-only', timeSeconds: 0.5, strength: 1 },
        ], { onsets: true, pitch: false, continuousPitch: false }),
      ],
      metric: [],
    },
    regions: [{ id: 'verse', label: 'Verse', startSeconds: 0, endSeconds: 3 }],
    regionEvidence: [],
    repeatSets: [],
    suggestions: [],
  };
  const edits = {
    version: 3,
    levelId: base.id,
    baseFingerprint: 'fixture-audio',
    evidenceFingerprint: 'fixture-evidence',
    arrangements: [{
      id: 'layered-verse',
      regionId: 'verse',
      mode: 'play',
      timingLayers: [
        { sourceId: 'stem:vocals:timing', role: 'target', weight: 1 },
        { sourceId: 'stem:drums:timing', role: 'target', weight: 0.6 },
        { sourceId: 'stem:drums:accents', role: 'accent', weight: 1 },
      ],
      laneDriver: { kind: 'source', sourceId: 'stem:vocals:pitch', motion: 1 },
      density: 1,
      challenge: 0,
      feel: 'natural',
    }],
    rowOverrides: [],
    colorRanges: [],
  };

  const compiled = arrangementModule.compilePerformance(base, score, edits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), [0.2, 1, 2]);
  assert.deepEqual(targetLanes(compiled.level), [0, 2, 4]);
});

test('v3 cannot use a lane-only F0 stream as timing evidence', () => {
  const base = fixtureLevel([0, 1]);
  const legacyContour = {
    id: 'melody-contour', label: 'Contour', availability: 'estimated',
    capabilities: { onsets: false, pitch: true, continuousPitch: true },
    events: [60, 64].map((pitchMidi, index) => ({
      id: `f0-${index}`, timeSeconds: index, pitchMidi, strength: 0.9,
    })),
  };
  const score = {
    ...fixtureScore(legacyContour, 2),
    schemaVersion: '2.0.0',
    evidenceFingerprint: 'f0-only-evidence',
    evidenceStreams: {
      timing: [],
      lane: [{
        ...legacyContour, kind: 'lane', stemRole: 'mix', identity: 'model-estimated',
      }],
      accent: [], metric: [],
    },
  };
  const edits = {
    version: 3,
    levelId: base.id,
    evidenceFingerprint: 'f0-only-evidence',
    arrangements: [{
      id: 'invalid-f0-timing', regionId: 'verse', mode: 'play',
      timingLayers: [{ sourceId: 'melody-contour', role: 'target', weight: 1 }],
      laneDriver: { kind: 'source', sourceId: 'melody-contour', motion: 1 },
      density: 1, challenge: 0, feel: 'natural',
    }],
    rowOverrides: [], colorRanges: [],
  };

  assert.throws(
    () => arrangementModule.compilePerformance(base, score, edits),
    /unavailable timing evidence/i,
  );
});

test('v3 density keeps temporal coverage before globally strongest clustered anchors', () => {
  const times = [0, 1, 2, 3, 4, 5, 6, 7];
  const base = fixtureLevel(times);
  const score = {
    ...fixtureScore({ id: 'unused', availability: 'unavailable', capabilities: { onsets: false, pitch: false, continuousPitch: false }, events: [] }, 8),
    schemaVersion: '2.0.0',
    evidenceFingerprint: 'coverage-evidence',
    evidenceStreams: {
      timing: [{
        id: 'stem:drums:timing', label: 'Drums', kind: 'timing', stemRole: 'drums', identity: 'model-estimated',
        availability: 'estimated', capabilities: { onsets: true, pitch: false, continuousPitch: false },
        events: times.map((timeSeconds, index) => ({
          id: `hit-${index}`,
          timeSeconds,
          strength: index === 3 || index === 4 ? 1 : 0.1,
        })),
      }],
      lane: [], accent: [], metric: [],
    },
  };
  const edits = {
    version: 3,
    levelId: base.id,
    evidenceFingerprint: 'coverage-evidence',
    arrangements: [{
      id: 'covered-drums', regionId: 'verse', mode: 'play',
      timingLayers: [{ sourceId: 'stem:drums:timing', role: 'target', weight: 1 }],
      laneDriver: { kind: 'gesture', pattern: 'pulse', motion: 0 },
      density: 0.25, challenge: 0, feel: 'natural', maxGapBeats: 8,
    }],
    rowOverrides: [], colorRanges: [],
  };

  const compiled = arrangementModule.compilePerformance(base, score, edits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), [2, 6]);
});

test('insufficient v3 timing evidence preserves Base Rows and still applies Row Override last', () => {
  const base = fixtureLevel([0, 1, 2, 3]);
  base.events = [0, 1, 2, 3].map((timeSeconds) => ({
    timeSeconds, obstacles: [0, 0, 1, 0, 0], kind: 'target',
  }));
  base.generation.noteCount = 4;
  const score = {
    ...fixtureScore({ id: 'unused', availability: 'unavailable', capabilities: { onsets: false, pitch: false, continuousPitch: false }, events: [] }),
    schemaVersion: '2.0.0',
    evidenceFingerprint: 'sparse-evidence',
    evidenceStreams: {
      timing: [{
        id: 'stem:vocals:timing', label: 'Vocals', kind: 'timing', stemRole: 'vocals', identity: 'model-estimated',
        availability: 'estimated', capabilities: { onsets: true, pitch: false, continuousPitch: false },
        events: [{ id: 'only-syllable', timeSeconds: 1, strength: 1 }],
      }],
      lane: [], accent: [], metric: [],
    },
  };
  const edits = {
    version: 3,
    levelId: base.id,
    evidenceFingerprint: 'sparse-evidence',
    arrangements: [{
      id: 'sparse-vocals', regionId: 'verse', mode: 'play',
      timingLayers: [{ sourceId: 'stem:vocals:timing', role: 'target', weight: 1 }],
      laneDriver: { kind: 'gesture', pattern: 'pulse', motion: 0 },
      density: 1, challenge: 0, feel: 'steady', maxGapBeats: 0.5,
    }],
    rowOverrides: [{ timeSeconds: 2, obstacles: [0, 0, 0, 0, 1] }],
    colorRanges: [],
  };

  const compiled = arrangementModule.compilePerformance(base, score, edits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), [0, 1, 2, 3]);
  assert.deepEqual(compiled.level.events[2].obstacles, [0, 0, 0, 0, 1]);
  assert.ok(compiled.notices.some((notice) => notice.code === 'insufficient-timing-evidence-preserved-base'));
});

function targetLanes(level) {
  return level.events.map((event) => event.obstacles.indexOf(1));
}

test('compilePerformance accepts runtime-normalized v3 edits with a v1 Authoring Score', () => {
  const times = [0.16, 1.16, 2.16, 3.16];
  const base = fixtureLevel(times);
  const score = fixtureScore({
    id: 'percussion-onsets',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: times.map((timeSeconds, index) => ({
      id: `hit-${index}`,
      timeSeconds,
      strength: 0.9,
    })),
  });
  const normalizedEdits = levelEditsModule.parseLevelEdits(arrangementEdits({
    id: 'legacy-runtime-percussion',
    regionId: 'verse',
    sourceId: 'percussion-onsets',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
  }), base);

  assert.equal(normalizedEdits.version, 3);
  const compiled = arrangementModule.compilePerformance(base, score, normalizedEdits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), times);
  assert.deepEqual(targetLanes(compiled.level), [0, 4, 0, 4]);
});

test('runtime migration retains a v2 pitch-contour recipe against an Authoring Score v2', () => {
  const times = [0.16, 1.16, 2.16, 3.16];
  const base = fixtureLevel(times);
  const contour = {
    id: 'melody-contour',
    label: 'Contour',
    availability: 'estimated',
    capabilities: { onsets: false, pitch: true, continuousPitch: true },
    events: [60, 62, 67, 72].map((pitchMidi, index) => ({
      id: `contour-${index}`,
      timeSeconds: times[index],
      pitchMidi,
      strength: 0.9,
    })),
  };
  const melodyAnchors = {
    id: 'discrete-melody',
    label: 'Notes',
    availability: 'estimated',
    capabilities: { onsets: true, pitch: true, continuousPitch: false },
    events: [60, 62, 67, 72].map((pitchMidi, index) => ({
      id: `note-${index}`,
      timeSeconds: times[index],
      pitchMidi,
      strength: 0.85,
    })),
  };
  const score = {
    ...fixtureScore(contour),
    schemaVersion: '2.0.0',
    evidenceFingerprint: 'fixture-evidence-v2',
    sources: [contour, melodyAnchors],
    evidenceStreams: {
      timing: [{
        ...melodyAnchors,
        kind: 'timing',
        stemRole: 'mix',
        identity: 'model-estimated',
      }],
      lane: [{
        ...contour,
        kind: 'lane',
        stemRole: 'mix',
        identity: 'model-estimated',
      }],
      accent: [],
      metric: [],
    },
  };
  const normalizedEdits = levelEditsModule.parseLevelEdits(arrangementEdits({
    id: 'legacy-runtime-contour',
    regionId: 'verse',
    sourceId: 'melody-contour',
    mapping: 'pitch-contour',
    density: 1,
    motion: 1,
    challenge: 0,
  }), base);

  const compiled = arrangementModule.compilePerformance(base, score, normalizedEdits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), times);
  assert.deepEqual(targetLanes(compiled.level), [0, 1, 3, 4]);
});

test('maps a rising measured pitch contour to ascending lanes', () => {
  const times = [0.16, 1.16, 2.16, 3.16];
  const base = fixtureLevel(times);
  const score = fixtureScore({
    id: 'lead',
    kind: 'discrete-pitch',
    availability: 'measured',
    capabilities: { onsets: true, pitch: true, continuousPitch: false },
    events: [60, 62, 67, 72].map((pitchMidi, index) => ({
      id: `lead-${index}`,
      timeSeconds: times[index],
      pitchMidi,
      strength: 0.9,
    })),
  });
  const edits = arrangementEdits({
    id: 'verse-lead',
    regionId: 'verse',
    sourceId: 'lead',
    mapping: 'pitch-contour',
    density: 1,
    motion: 1,
    challenge: 0,
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), times);
  assert.deepEqual(targetLanes(compiled.level), [0, 1, 3, 4]);
});

test('alternates a high-motion pulse between the outer lanes', () => {
  const times = [0.16, 1.16, 2.16, 3.16];
  const base = fixtureLevel(times);
  const score = fixtureScore({
    id: 'drums',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: times.map((timeSeconds, index) => ({
      id: `drum-${index}`,
      timeSeconds,
      strength: 0.9,
    })),
  });
  const edits = arrangementEdits({
    id: 'verse-drums',
    regionId: 'verse',
    sourceId: 'drums',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(targetLanes(compiled.level), [0, 4, 0, 4]);
});

test('keeps lower-density rows nested inside higher-density rows', () => {
  const times = [0, 1, 2, 3, 4, 5, 6, 7];
  const strengths = [0.1, 0.8, 0.3, 0.9, 0.2, 0.7, 0.4, 0.6];
  const base = fixtureLevel(times);
  const score = fixtureScore({
    id: 'drums',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: times.map((timeSeconds, index) => ({
      id: `drum-${index}`,
      timeSeconds,
      strength: strengths[index],
    })),
  }, 8);
  const compileAtDensity = (density) => arrangementModule.compileRegionRecipes(
    base,
    score,
    arrangementEdits({
      id: `verse-drums-${density}`,
      regionId: 'verse',
      sourceId: 'drums',
      mapping: 'alternating',
      density,
      motion: 1,
      challenge: 0,
    }),
  ).level.events.map((event) => event.timeSeconds);

  const light = compileAtDensity(0.25);
  const medium = compileAtDensity(0.5);
  const dense = compileAtDensity(0.75);

  assert.deepEqual(light, [1, 3]);
  assert.deepEqual(medium, [1, 3, 5, 7]);
  assert.deepEqual(dense, [1, 2, 3, 5, 6, 7]);
  assert.ok(light.every((time) => medium.includes(time)));
  assert.ok(medium.every((time) => dense.includes(time)));
});

test('reuses one gesture across linked occurrences at each occurrence measured times', () => {
  const times = [0.16, 1.16, 2.16, 3.16, 10, 10.5, 12, 13.5];
  const base = fixtureLevel(times);
  const score = fixtureScore({
    id: 'drums',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: times.map((timeSeconds, index) => ({
      id: `drum-${index}`,
      timeSeconds,
      strength: 0.9,
    })),
  }, 14);
  score.regions = [
    { id: 'chorus-a', kind: 'phrase', sourceId: 'a', label: 'Chorus A', startSeconds: 0, endSeconds: 4, intensity: 0.8 },
    { id: 'chorus-b', kind: 'phrase', sourceId: 'b', label: 'Chorus B', startSeconds: 10, endSeconds: 14, intensity: 0.8 },
  ];
  score.repeatSets = [{
    id: 'chorus-repeat',
    sourceFamilyId: 'chorus-family',
    familyKind: 'primary',
    confidence: 0.95,
    occurrences: [
      { id: 'chorus-occurrence-a', regionId: 'chorus-a', startSeconds: 0, endSeconds: 4 },
      { id: 'chorus-occurrence-b', regionId: 'chorus-b', startSeconds: 10, endSeconds: 14 },
    ],
  }];
  const edits = arrangementEdits({
    id: 'linked-chorus-drums',
    regionId: 'chorus-a',
    sourceId: 'drums',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
    repeatSetId: 'chorus-repeat',
    occurrenceIds: ['chorus-occurrence-a', 'chorus-occurrence-b'],
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), times);
  assert.deepEqual(targetLanes(compiled.level), [0, 4, 0, 4, 0, 4, 0, 4]);
});

test('fails closed when a continuous-F0 recipe has no available F0 evidence', () => {
  const base = fixtureLevel();
  const score = fixtureScore({
    id: 'melody-contour',
    kind: 'continuous-pitch',
    availability: 'unavailable',
    capabilities: { onsets: false, pitch: true, continuousPitch: true },
    events: [],
  });
  const edits = arrangementEdits({
    id: 'verse-f0',
    regionId: 'verse',
    sourceId: 'melody-contour',
    mapping: 'pitch-contour',
    density: 1,
    motion: 1,
    challenge: 0,
  });

  assert.throws(
    () => arrangementModule.compileRegionRecipes(base, score, edits),
    /continuous F0/i,
  );
});

test('fails closed when a continuous-F0 source is paired with a non-contour mapping', () => {
  const base = fixtureLevel();
  const score = fixtureScore({
    id: 'melody-contour',
    kind: 'continuous-pitch',
    availability: 'estimated',
    capabilities: { onsets: false, pitch: true, continuousPitch: true },
    events: [60, 62, 64, 66].map((pitchMidi, index) => ({
      id: `f0-${index}`,
      timeSeconds: index,
      pitchMidi,
      traceId: 'trace-1',
      strength: 0.8,
    })),
  });
  const edits = arrangementEdits({
    id: 'verse-f0-alternating',
    regionId: 'verse',
    sourceId: 'melody-contour',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
  });

  assert.throws(
    () => arrangementModule.compileRegionRecipes(base, score, edits),
    /continuous F0.*pitch-contour/i,
  );
});

test('fails closed when an available continuous-F0 source has no evidence in the selected region', () => {
  const base = fixtureLevel();
  const score = fixtureScore({
    id: 'melody-contour',
    kind: 'continuous-pitch',
    availability: 'estimated',
    capabilities: { onsets: false, pitch: true, continuousPitch: true },
    events: [{ id: 'f0-outside', timeSeconds: 3, pitchMidi: 64, traceId: 'trace-1', strength: 0.8 }],
  }, 2);
  const edits = arrangementEdits({
    id: 'verse-f0-empty',
    regionId: 'verse',
    sourceId: 'melody-contour',
    mapping: 'pitch-contour',
    density: 1,
    motion: 1,
    challenge: 0,
  });

  assert.throws(
    () => arrangementModule.compileRegionRecipes(base, score, edits),
    /continuous F0.*selected region/i,
  );
});

test('applies a Row Override after the Region Recipe so the manual row wins', () => {
  const base = fixtureLevel();
  const score = fixtureScore({
    id: 'drums',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [{ id: 'drum-0', timeSeconds: 0, strength: 1 }],
  });
  const edits = arrangementEdits({
    id: 'verse-drums',
    regionId: 'verse',
    sourceId: 'drums',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
  });
  edits.rowOverrides = [{ timeSeconds: 0, obstacles: [0, 0, 0, 0, 1] }];

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(compiled.level.events[0].obstacles, [0, 0, 0, 0, 1]);
});

test('keeps a Row Override that restores an original Base Row changed by a Recipe', () => {
  const base = fixtureLevel();
  base.events = [{ timeSeconds: 0, obstacles: [0, 0, 1, 0, 0], kind: 'target' }];
  base.generation.noteCount = 1;
  const score = fixtureScore({
    id: 'percussion-onsets',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [{ id: 'hit-0', timeSeconds: 0, strength: 1 }],
  });
  const edits = arrangementEdits({
    id: 'verse-alternating',
    regionId: 'verse',
    sourceId: 'percussion-onsets',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
  });
  edits.rowOverrides = [{ timeSeconds: 0, obstacles: [0, 0, 1, 0, 0] }];

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(compiled.level.events[0].obstacles, [0, 0, 1, 0, 0]);
});

test('preserves Base Rows when arrangements are empty before applying Row Overrides', () => {
  const base = fixtureLevel();
  base.events = [
    { timeSeconds: 0, obstacles: [0, 1, 0, 0, 0], kind: 'target' },
    { timeSeconds: 2, obstacles: [0, 0, 0, 1, 0], kind: 'target' },
  ];
  base.generation.noteCount = 2;
  const score = fixtureScore({
    id: 'drums',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [],
  });
  const edits = {
    version: 2,
    levelId: base.id,
    arrangements: [],
    rowOverrides: [{ timeSeconds: 0, obstacles: [0, 0, 0, 0, 1] }],
    colorRanges: [],
  };

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(compiled.level.events, [
    { timeSeconds: 0, obstacles: [0, 0, 0, 0, 1], kind: 'target' },
    { timeSeconds: 2, obstacles: [0, 0, 0, 1, 0], kind: 'target' },
  ]);
});

test('a rest recipe clears only its left-closed right-open region', () => {
  const base = fixtureLevel();
  base.events = [0, 1, 2, 3].map((timeSeconds) => ({
    timeSeconds,
    obstacles: [0, 0, 1, 0, 0],
    kind: 'target',
  }));
  base.generation.noteCount = 4;
  const score = fixtureScore({
    id: 'rhythm-grid',
    kind: 'rhythm',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [],
  }, 2);
  const edits = arrangementEdits({
    id: 'quiet-intro',
    regionId: 'verse',
    sourceId: 'rhythm-grid',
    mapping: 'rest',
    density: 0,
    motion: 0,
    challenge: 0,
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), [2, 3]);
});

test('rest does not require its informational source to be available', () => {
  const base = fixtureLevel();
  base.events = [0, 1, 2].map((timeSeconds) => ({
    timeSeconds,
    obstacles: [0, 0, 1, 0, 0],
    kind: 'target',
  }));
  base.generation.noteCount = 3;
  const score = fixtureScore({
    id: 'rhythm-grid',
    kind: 'rhythm',
    availability: 'unavailable',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [],
  }, 2);
  const edits = arrangementEdits({
    id: 'intentional-rest',
    regionId: 'verse',
    sourceId: 'rhythm-grid',
    mapping: 'rest',
    density: 0,
    motion: 0,
    challenge: 0,
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(compiled.level.events.map((event) => event.timeSeconds), [2]);
});

test('rejects Region Recipes whose occurrence intervals overlap', () => {
  const base = fixtureLevel();
  const source = {
    id: 'drums',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [0, 1, 2, 3].map((timeSeconds) => ({
      id: `drum-${timeSeconds}`,
      timeSeconds,
      strength: 1,
    })),
  };
  const score = fixtureScore(source);
  score.regions = [
    { id: 'first', kind: 'phrase', sourceId: 'a', label: 'First', startSeconds: 0, endSeconds: 3, intensity: 0.5 },
    { id: 'second', kind: 'phrase', sourceId: 'b', label: 'Second', startSeconds: 2, endSeconds: 4, intensity: 0.5 },
  ];
  const edits = {
    version: 2,
    levelId: base.id,
    arrangements: [
      { id: 'first-recipe', regionId: 'first', sourceId: 'drums', mapping: 'pulse', density: 1, motion: 0.5, challenge: 0 },
      { id: 'second-recipe', regionId: 'second', sourceId: 'drums', mapping: 'pulse', density: 1, motion: 0.5, challenge: 0 },
    ],
    rowOverrides: [],
    colorRanges: [],
  };

  assert.throws(
    () => arrangementModule.compileRegionRecipes(base, score, edits),
    /overlap/i,
  );
});

test('pulse maps an unpitched measured source to a stable center performance', () => {
  const base = fixtureLevel();
  const score = fixtureScore({
    id: 'percussion-onsets',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [0, 1, 2, 3].map((timeSeconds) => ({
      id: `hit-${timeSeconds}`,
      timeSeconds,
      strength: 0.8,
    })),
  });
  const edits = arrangementEdits({
    id: 'verse-pulse',
    regionId: 'verse',
    sourceId: 'percussion-onsets',
    mapping: 'pulse',
    density: 1,
    motion: 0.2,
    challenge: 0,
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(targetLanes(compiled.level), [2, 2, 2, 2]);
});

test('motion narrows a pitch contour toward the center without changing its timing', () => {
  const times = [0.16, 1.16, 2.16, 3.16, 4.16];
  const base = fixtureLevel(times);
  const score = fixtureScore({
    id: 'discrete-melody',
    kind: 'discrete-pitch',
    availability: 'estimated',
    capabilities: { onsets: true, pitch: true, continuousPitch: false },
    events: [60, 62, 64, 66, 68].map((pitchMidi, index) => ({
      id: `note-${index}`,
      timeSeconds: times[index],
      pitchMidi,
      strength: 0.9,
    })),
  }, 5);
  const compileAtMotion = (motion) => arrangementModule.compileRegionRecipes(
    base,
    score,
    arrangementEdits({
      id: `melody-motion-${motion}`,
      regionId: 'verse',
      sourceId: 'discrete-melody',
      mapping: 'pitch-contour',
      density: 1,
      motion,
      challenge: 0,
    }),
  ).level;

  assert.deepEqual(targetLanes(compileAtMotion(0)), [2, 2, 2, 2, 2]);
  assert.deepEqual(targetLanes(compileAtMotion(1)), [0, 1, 2, 3, 4]);
});

test('high challenge adds one counter-lane Spike without replacing reachable performance targets', () => {
  const times = [0, 0.08, 0.16, 0.24];
  const base = fixtureLevel(times);
  const score = fixtureScore({
    id: 'percussion-onsets',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: times.map((timeSeconds, index) => ({
      id: `hit-${index}`,
      timeSeconds,
      strength: 1,
    })),
  }, 0.32);
  const compileAtChallenge = (challenge) => arrangementModule.compileRegionRecipes(
    base,
    score,
    arrangementEdits({
      id: `fast-alternating-${challenge}`,
      regionId: 'verse',
      sourceId: 'percussion-onsets',
      mapping: 'alternating',
      density: 1,
      motion: 1,
      challenge,
    }),
  );

  const easy = compileAtChallenge(0);
  const hard = compileAtChallenge(1);
  const hardTargetLanes = targetLanes(hard.level);

  assert.deepEqual(hard.level.events.map((event) => event.timeSeconds), easy.level.events.map((event) => event.timeSeconds));
  assert.ok(hard.level.events.every((event) => event.obstacles.filter((cell) => cell === 1).length === 1));
  assert.ok(hard.level.events.every((event) => event.obstacles.filter((cell) => cell === 2).length === 1));
  assert.ok(hardTargetLanes.slice(1).every((lane, index) => Math.abs(lane - hardTargetLanes[index]) <= 1));
  assert.ok(hard.notices.some((notice) => notice.code === 'lane-reachability-clamped'));
});

test('rejects an Authoring Score belonging to another base level', () => {
  const base = fixtureLevel();
  const score = fixtureScore({
    id: 'rhythm-grid',
    kind: 'rhythm',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [],
  });
  score.levelId = 'another-flow';
  const edits = {
    version: 2,
    levelId: base.id,
    arrangements: [],
    rowOverrides: [],
    colorRanges: [],
  };

  assert.throws(
    () => arrangementModule.compileRegionRecipes(base, score, edits),
    /base level/i,
  );
});

test('rejects Level Edits pinned to a different Authoring Score fingerprint', () => {
  const base = fixtureLevel();
  const score = fixtureScore({
    id: 'rhythm-grid',
    kind: 'rhythm',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [],
  });
  const edits = {
    version: 2,
    levelId: base.id,
    baseFingerprint: 'another-audio',
    arrangements: [],
    rowOverrides: [],
    colorRanges: [],
  };

  assert.throws(
    () => arrangementModule.compileRegionRecipes(base, score, edits),
    /fingerprint/i,
  );
});

test('keeps the first Recipe target reachable from the preceding Base Row target', () => {
  const times = [0, 0.08, 0.16];
  const base = fixtureLevel(times);
  base.events = [{ timeSeconds: 0, obstacles: [0, 0, 1, 0, 0], kind: 'target' }];
  base.generation.noteCount = 1;
  const score = fixtureScore({
    id: 'percussion-onsets',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [0.08, 0.16].map((timeSeconds, index) => ({
      id: `fast-${index}`,
      timeSeconds,
      strength: 1,
    })),
  });
  score.regions = [{
    id: 'fast-region',
    kind: 'phrase',
    sourceId: 'fast',
    label: 'Fast',
    startSeconds: 0.08,
    endSeconds: 0.24,
    intensity: 1,
  }];
  const edits = arrangementEdits({
    id: 'fast-recipe',
    regionId: 'fast-region',
    sourceId: 'percussion-onsets',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(targetLanes(compiled.level), [2, 1, 2]);
  assert.ok(compiled.notices.some((notice) => notice.code === 'lane-reachability-clamped'));
});

test('adjusts a Recipe target backward from the next fixed Base Row without moving that Base Row', () => {
  const times = [0, 0.08, 0.16];
  const base = fixtureLevel(times);
  base.events = [
    { timeSeconds: 0, obstacles: [0, 0, 1, 0, 0], kind: 'target' },
    { timeSeconds: 0.16, obstacles: [0, 0, 0, 0, 1], kind: 'target' },
  ];
  base.generation.noteCount = 2;
  const score = fixtureScore({
    id: 'percussion-onsets',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [{ id: 'middle-hit', timeSeconds: 0.08, strength: 1 }],
  });
  score.regions = [{
    id: 'middle-region',
    kind: 'phrase',
    sourceId: 'middle',
    label: 'Middle',
    startSeconds: 0.08,
    endSeconds: 0.16,
    intensity: 1,
  }];
  const edits = arrangementEdits({
    id: 'middle-recipe',
    regionId: 'middle-region',
    sourceId: 'percussion-onsets',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(targetLanes(compiled.level), [2, 3, 4]);
  assert.deepEqual(compiled.level.events[2].obstacles, [0, 0, 0, 0, 1]);
});

test('starts an immediate first Recipe target from the player center lane', () => {
  const base = fixtureLevel([0]);
  const score = fixtureScore({
    id: 'percussion-onsets',
    kind: 'percussion',
    availability: 'measured',
    capabilities: { onsets: true, pitch: false, continuousPitch: false },
    events: [{ id: 'first-hit', timeSeconds: 0, strength: 1 }],
  });
  const edits = arrangementEdits({
    id: 'immediate-recipe',
    regionId: 'verse',
    sourceId: 'percussion-onsets',
    mapping: 'alternating',
    density: 1,
    motion: 1,
    challenge: 0,
  });

  const compiled = arrangementModule.compileRegionRecipes(base, score, edits);

  assert.deepEqual(targetLanes(compiled.level), [2]);
});
