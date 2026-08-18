import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createServer } from 'vite';

let server;
let draftModule;
let editsModule;

before(async () => {
  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
  draftModule = await server.ssrLoadModule('/src/editor/arrangementDraft.ts');
  editsModule = await server.ssrLoadModule('/src/levelEdits.ts');
});

after(async () => {
  await server?.close();
});

function stream(id, kind, stemRole, availability = 'estimated') {
  return {
    id,
    label: id,
    kind,
    stemRole,
    identity: stemRole === 'mix' ? 'direct' : 'model-estimated',
    availability,
    capabilities: {
      onsets: kind === 'timing' || kind === 'accent',
      pitch: kind === 'lane',
      continuousPitch: kind === 'lane',
    },
    events: [],
  };
}

function authoringScore() {
  const timing = [
    stream('stem:vocals:timing', 'timing', 'vocals'),
    stream('stem:drums:timing', 'timing', 'drums'),
    stream('stem:bass:timing', 'timing', 'bass'),
    stream('stem:other:timing', 'timing', 'other'),
    stream('performance-attacks', 'timing', 'mix', 'measured'),
    stream('stem:vocals:pitch-landmarks', 'timing', 'vocals'),
  ];
  const lane = [
    stream('stem:vocals:pitch', 'lane', 'vocals'),
    stream('stem:bass:pitch', 'lane', 'bass'),
    stream('stem:other:pitch', 'lane', 'other', 'unavailable'),
  ];
  const accent = [
    stream('stem:drums:accents', 'accent', 'drums'),
    stream('stem:vocals:accents', 'accent', 'vocals'),
  ];
  return {
    kind: 'authoring-score',
    schemaVersion: '2.0.0',
    algorithm: 'fixture-authoring-v2',
    levelId: 'fixture-flow',
    audioFingerprint: 'fixture-audio',
    evidenceFingerprint: 'fixture-evidence',
    sources: [],
    evidenceStreams: { timing, lane, accent, metric: [] },
    regions: [
      { id: 'region:b', label: '片段 02', startSeconds: 4, endSeconds: 8 },
      { id: 'region:a', label: '片段 01', startSeconds: 0, endSeconds: 4 },
    ],
    regionEvidence: [
      {
        regionId: 'region:a',
        streams: [
          { streamId: 'stem:vocals:timing', kind: 'timing', eventCount: 8, activeCoverageRatio: 0.75, maximumGapSeconds: 0.8 },
          { streamId: 'stem:drums:timing', kind: 'timing', eventCount: 10, activeCoverageRatio: 0.88, maximumGapSeconds: 0.5 },
        ],
      },
      {
        regionId: 'region:b',
        streams: [
          { streamId: 'stem:drums:timing', kind: 'timing', eventCount: 1, activeCoverageRatio: 0.125, maximumGapSeconds: 3.4 },
        ],
      },
    ],
    repeatSets: [],
    suggestions: [
      {
        regionId: 'region:b',
        preset: {
          mode: 'play',
          timingLayers: [{ sourceId: 'stem:drums:timing', role: 'target', weight: 1 }],
          laneDriver: { kind: 'gesture', pattern: 'alternating', motion: 0.75 },
          density: 0.68,
          challenge: 0.35,
          feel: 'natural',
          maxGapBeats: 4,
        },
        reasonCodes: ['metric-grid-only'],
      },
      {
        regionId: 'region:a',
        preset: {
          mode: 'play',
          timingLayers: [
            { sourceId: 'stem:vocals:timing', role: 'target', weight: 1 },
            { sourceId: 'stem:drums:accents', role: 'accent', weight: 0.8 },
          ],
          laneDriver: { kind: 'source', sourceId: 'stem:vocals:pitch', motion: 0.9 },
          density: 0.78,
          challenge: 0.28,
          feel: 'natural',
          maxGapBeats: 3,
        },
        reasonCodes: ['separated-stem-coverage'],
      },
    ],
  };
}

function baseLevel() {
  return {
    id: 'fixture-flow', version: 3,
    song: { title: 'Fixture', artist: 'Fixture', audioUrl: '', bpm: 120, durationSeconds: 8 },
    generation: { algorithm: 'fixture', noteCount: 1 },
    rhythmPoints: [{
      id: 'point-0', timeSeconds: 0, suggestedLane: 2, kind: 'attack',
      strength: 1, sourceRole: 'fixture', hasBaseRow: true,
    }],
    colorSchemeEvents: [{
      timeSeconds: 0, colorSchemeId: 'cyanWhite', kind: 'section', source: 'fixture', strength: 1,
    }],
    events: [{ timeSeconds: 0, kind: 'target', obstacles: [0, 0, 1, 0, 0] }],
  };
}

test('materializes all v3 suggestions into stable Region Recipes in song order', () => {
  assert.deepEqual(draftModule.recipesFromSuggestions(authoringScore()), [
    {
      id: 'recipe:region:a', regionId: 'region:a', mode: 'play',
      timingLayers: [
        { sourceId: 'stem:vocals:timing', role: 'target', weight: 1 },
        { sourceId: 'stem:drums:accents', role: 'accent', weight: 0.8 },
      ],
      laneDriver: { kind: 'source', sourceId: 'stem:vocals:pitch', motion: 0.9 },
      density: 0.78, challenge: 0.28, feel: 'natural', maxGapBeats: 3,
    },
    {
      id: 'recipe:region:b', regionId: 'region:b', mode: 'play',
      timingLayers: [{ sourceId: 'stem:drums:timing', role: 'target', weight: 1 }],
      laneDriver: { kind: 'gesture', pattern: 'alternating', motion: 0.75 },
      density: 0.68, challenge: 0.35, feel: 'natural', maxGapBeats: 4,
    },
  ]);
});

test('materializes friendly presets without exposing model-specific rules to the caller', () => {
  const score = authoringScore();
  const vocal = draftModule.materializePerformancePreset(score, 'region:a', 'vocal-lead');
  assert.equal(vocal.mode, 'play');
  assert.deepEqual(vocal.timingLayers, [
    { sourceId: 'stem:vocals:timing', role: 'target', weight: 1 },
    { sourceId: 'stem:drums:accents', role: 'accent', weight: 0.75 },
  ]);
  assert.deepEqual(vocal.laneDriver, {
    kind: 'source', sourceId: 'stem:vocals:pitch', motion: 0.9,
  });
  assert.equal(draftModule.materializePerformancePreset(score, 'region:a', 'rest').mode, 'rest');
});

test('target and accent multi-select is deterministic, de-duplicated, and fail-closed', () => {
  const score = authoringScore();
  let draft = draftModule.materializePerformancePreset(score, 'region:a', 'vocal-lead');
  draft = draftModule.setTimingLayerSelection(score, draft, {
    sourceId: 'stem:drums:timing', role: 'target', selected: true,
  });
  draft = draftModule.setTimingLayerSelection(score, draft, {
    sourceId: 'stem:drums:timing', role: 'target', selected: true,
  });
  assert.equal(draft.timingLayers.filter((layer) => layer.sourceId === 'stem:drums:timing').length, 1);
  assert.equal(draft.timingLayers.filter((layer) => layer.role === 'target').length, 2);
  assert.throws(() => draftModule.setTimingLayerSelection(score, draft, {
    sourceId: 'stem:other:pitch', role: 'target', selected: true,
  }), /不可用|unavailable/i);
});

test('unavailable evidence is reported as disabled for each editor role', () => {
  const score = authoringScore();
  assert.equal(draftModule.isEvidenceSelectable(score, 'lane', 'stem:other:pitch'), false);
  assert.equal(draftModule.isEvidenceSelectable(score, 'lane', 'stem:vocals:pitch'), true);
  assert.equal(draftModule.isEvidenceSelectable(score, 'timing', 'stem:vocals:pitch'), false);
});

test('a migrated v2 edit remains editable through the same draft seam', () => {
  const migrated = editsModule.parseLevelEdits({
    version: 2, levelId: 'fixture-flow', baseFingerprint: 'fixture-audio',
    arrangements: [{
      id: 'recipe:region:a', regionId: 'region:a', sourceId: 'performance-attacks',
      mapping: 'alternating', density: 0.55, motion: 0.7, challenge: 0.25,
    }], rowOverrides: [], colorRanges: [],
  }, baseLevel());
  assert.deepEqual(draftModule.draftForRegion(authoringScore(), migrated, 'region:a'), {
    mode: 'play',
    timingLayers: [{
      sourceId: 'performance-attacks',
      role: 'target',
      weight: 1,
      compatibility: 'legacy-single-source-v2',
    }],
    laneDriver: { kind: 'gesture', pattern: 'alternating', motion: 0.7 },
    density: 0.55, challenge: 0.25, feel: 'natural',
  });
});

test('review queue contains only low-coverage or uncertain regions', () => {
  assert.deepEqual(draftModule.buildRegionReviewQueue(authoringScore()), [{
    regionId: 'region:b', reasons: ['低覆盖', '建议不确定'],
  }]);
});

test('upsert and delete keep exactly one v3 recipe per region without mutation', () => {
  const score = authoringScore();
  const original = {
    version: 3, levelId: 'fixture-flow', baseFingerprint: 'fixture-audio',
    evidenceFingerprint: 'fixture-evidence',
    arrangements: [draftModule.materializePerformancePreset(score, 'region:a', 'drum-groove')],
    rowOverrides: [], colorRanges: [],
  };
  const replacement = draftModule.materializePerformancePreset(score, 'region:a', 'vocal-lead');
  const snapshot = structuredClone(original);
  const updated = draftModule.upsertRegionRecipe(original, replacement);
  const deleted = draftModule.deleteRegionRecipe(updated, 'region:a');
  assert.deepEqual(original, snapshot);
  assert.deepEqual(updated.arrangements, [replacement]);
  assert.deepEqual(deleted.arrangements, []);
});

test('repeat selection and linked upsert preserve v3 recipes while replacing overlaps', () => {
  const score = authoringScore();
  score.regions.push({ id: 'region:c', label: 'C', startSeconds: 8, endSeconds: 12 });
  score.repeatSets = [{
    id: 'repeat-set:chorus', confidence: 0.96,
    occurrences: [
      { id: 'chorus-a', regionId: 'region:a', startSeconds: 0, endSeconds: 4 },
      { id: 'chorus-b', regionId: 'region:b', startSeconds: 4, endSeconds: 8 },
    ],
  }];
  const selection = draftModule.repeatSelectionForRegion(score, 'region:a');
  assert.deepEqual(selection, {
    repeatSetId: 'repeat-set:chorus', occurrenceIds: ['chorus-a', 'chorus-b'],
  });
  const retained = draftModule.materializePerformancePreset(score, 'region:c', 'bass-drive');
  const linked = {
    ...draftModule.materializePerformancePreset(score, 'region:a', 'vocal-lead'),
    repeatSetId: selection.repeatSetId,
    occurrenceIds: selection.occurrenceIds,
  };
  const edits = {
    version: 3, levelId: 'fixture-flow', arrangements: [
      draftModule.materializePerformancePreset(score, 'region:a', 'drum-groove'),
      draftModule.materializePerformancePreset(score, 'region:b', 'drum-groove'),
      retained,
    ], rowOverrides: [], colorRanges: [],
  };
  assert.deepEqual(
    draftModule.upsertLinkedRegionRecipe(edits, score, linked).arrangements,
    [linked, retained],
  );
});

test('editor preparation fills both fingerprints but never hides an existing mismatch', () => {
  const score = authoringScore();
  const edits = {
    version: 3, levelId: 'fixture-flow', arrangements: [], rowOverrides: [], colorRanges: [],
  };
  const prepared = draftModule.prepareEditorEdits(edits, score);
  assert.equal(prepared.baseFingerprint, 'fixture-audio');
  assert.equal(prepared.evidenceFingerprint, 'fixture-evidence');
  const old = draftModule.prepareEditorEdits({
    ...edits, baseFingerprint: 'old-audio', evidenceFingerprint: 'old-evidence',
  }, score);
  assert.equal(old.baseFingerprint, 'old-audio');
  assert.equal(old.evidenceFingerprint, 'old-evidence');
});

test('normalizes a legacy Authoring Score for the v3 editor without changing its evidence times', () => {
  const legacy = {
    kind: 'authoring-score', schemaVersion: '1.0.0', algorithm: 'legacy',
    levelId: 'fixture-flow', audioFingerprint: 'fixture-audio',
    sources: [{
      id: 'percussion-onsets', label: '鼓', availability: 'measured',
      capabilities: { onsets: true, pitch: false, continuousPitch: false },
      events: [{ id: 'hit', timeSeconds: 1.25, strength: 0.9 }],
    }],
    regions: [{ id: 'region:a', label: 'A', startSeconds: 0, endSeconds: 4 }],
    repeatSets: [],
    suggestions: [{
      regionId: 'region:a', sourceId: 'percussion-onsets', mapping: 'alternating',
      density: 0.7, motion: 0.8, challenge: 0.3, reasonCodes: ['dense-percussive-evidence'],
    }],
  };
  const normalized = draftModule.normalizeAuthoringScoreForEditor(legacy);
  assert.equal(normalized.schemaVersion, '2.0.0');
  assert.equal(normalized.evidenceStreams.timing[0].events[0].timeSeconds, 1.25);
  assert.equal(normalized.suggestions[0].preset.mode, 'play');
  assert.deepEqual(normalized.suggestions[0].preset.laneDriver, {
    kind: 'gesture', pattern: 'alternating', motion: 0.8,
  });
});
