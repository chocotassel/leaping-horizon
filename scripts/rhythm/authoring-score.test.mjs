import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuthoringScore } from './authoring-score.mjs';

function measuredAnalysis({ continuousPitch = null } = {}) {
  return {
    song: {
      id: 'authoring-fixture',
      title: 'Authoring Fixture',
      artist: 'Fixture Artist',
      durationSeconds: 24,
      audioFingerprint: 'fixture-audio-1234',
    },
    performanceScore: {
      kind: 'performance-score',
      attackEvents: [
        {
          id: 'attack-00002',
          timeSeconds: 2.5,
          strength: 0.7,
          pitchMidi: 67,
          sourceRole: 'melody',
        },
        {
          id: 'attack-00001',
          timeSeconds: 1.25,
          strength: 0.9,
          pitchMidi: null,
          sourceRole: 'percussion',
        },
      ],
    },
    eventSources: [],
    musicalStructure: {
      sections: [],
      phrases: [],
      families: [],
      overlappingPhrases: [],
      overlappingPhraseFamilies: [],
    },
    ...(continuousPitch ? { continuousPitch } : {}),
  };
}

test('stem evidence becomes separate timing, lane, and accent streams on the game-audio clock', () => {
  const analysis = measuredAnalysis();
  analysis.musicalStructure.sections = [{ id: 'S01', index: 0, startSeconds: 0, endSeconds: 4 }];
  analysis.musicalStructure.phrases = [
    { id: 'P01', index: 0, sectionIndex: 0, startSeconds: 0, endSeconds: 4 },
  ];
  analysis.stemEvidence = {
    kind: 'core4-stem-evidence',
    schemaVersion: '1.0.0',
    algorithm: 'fixture-separator',
    status: 'ok',
    audioFingerprint: 'fixture-audio-1234',
    evidenceFingerprint: 'fixture-stems-5678',
    timeOriginSeconds: 0,
    stems: {
      vocals: {
        role: 'vocals',
        status: 'ok',
        timingEvents: [{ id: 'syllable-a', timeSeconds: 0.5, confidence: 0.9, kind: 'onset' }],
        pitchTraces: [{
          id: 'vocal-trace',
          startSeconds: 0.5,
          endSeconds: 2.5,
          confidence: 0.85,
          points: [
            { id: 'f0-a', timeSeconds: 0.5, pitchMidi: 60, confidence: 0.8 },
            { id: 'f0-b', timeSeconds: 1.5, pitchMidi: 64, confidence: 0.9 },
            { id: 'f0-c', timeSeconds: 2.5, pitchMidi: 67, confidence: 0.82 },
          ],
        }],
        pitchLandmarks: [
          { id: 'turn-a', timeSeconds: 1.5, pitchMidi: 64, confidence: 0.88, traceId: 'vocal-trace' },
        ],
        accentEvents: [{ id: 'accent-a', timeSeconds: 0.5, confidence: 0.75, kind: 'vocal-accent' }],
        diagnostics: {},
      },
      drums: {
        role: 'drums',
        status: 'ok',
        timingEvents: [{ id: 'kick-a', timeSeconds: 0.52, confidence: 0.95, kind: 'drum-hit' }],
        pitchTraces: [],
        pitchLandmarks: [],
        accentEvents: [{ id: 'kick-accent-a', timeSeconds: 0.52, confidence: 0.95, kind: 'kick' }],
        diagnostics: {},
      },
      bass: {
        role: 'bass', status: 'unavailable', timingEvents: [], pitchTraces: [], pitchLandmarks: [], accentEvents: [], diagnostics: {},
      },
      other: {
        role: 'other', status: 'unavailable', timingEvents: [], pitchTraces: [], pitchLandmarks: [], accentEvents: [], diagnostics: {},
      },
    },
  };

  const score = buildAuthoringScore(analysis);

  assert.equal(score.schemaVersion, '2.0.0');
  assert.equal(score.evidenceFingerprint, 'fixture-stems-5678');
  assert.deepEqual(
    score.evidenceStreams.timing
      .filter((stream) => stream.id.startsWith('stem:'))
      .map((stream) => [stream.id, stream.events.map((event) => event.timeSeconds)]),
    [
      ['stem:vocals:timing', [0.5]],
      ['stem:vocals:pitch-landmarks', [1.5]],
      ['stem:drums:timing', [0.52]],
      ['stem:drums:pitch-landmarks', []],
      ['stem:bass:timing', []],
      ['stem:bass:pitch-landmarks', []],
      ['stem:other:timing', []],
      ['stem:other:pitch-landmarks', []],
    ],
  );
  assert.deepEqual(
    score.evidenceStreams.lane.find((stream) => stream.id === 'stem:vocals:pitch')
      .events.map((event) => event.timeSeconds),
    [0.5, 1.5, 2.5],
  );
  assert.deepEqual(
    score.evidenceStreams.accent.find((stream) => stream.id === 'stem:drums:accents')
      .events.map((event) => event.timeSeconds),
    [0.52],
  );
});

test('instrument and bass pitch landmarks also drive lanes without becoming implicit timing targets', () => {
  const analysis = measuredAnalysis();
  analysis.stemEvidence = {
    kind: 'core4-stem-evidence', schemaVersion: '1.0.0', status: 'ok',
    audioFingerprint: 'fixture-audio-1234', evidenceFingerprint: 'landmark-lanes', timeOriginSeconds: 0,
    stems: {
      vocals: { role: 'vocals', status: 'unavailable', timingEvents: [], pitchTraces: [], pitchLandmarks: [], accentEvents: [], diagnostics: {} },
      drums: { role: 'drums', status: 'unavailable', timingEvents: [], pitchTraces: [], pitchLandmarks: [], accentEvents: [], diagnostics: {} },
      bass: {
        role: 'bass', status: 'ok', timingEvents: [],
        pitchTraces: [{ id: 'bass-trace', points: [
          { id: 'bass-shared', timeSeconds: 1, pitchMidi: 40, confidence: 0.8 },
        ] }],
        pitchLandmarks: [
          { id: 'bass-shared', timeSeconds: 1, pitchMidi: 40, confidence: 0.9 },
          { id: 'bass-note-b', timeSeconds: 2, pitchMidi: 45, confidence: 0.85 },
        ],
        accentEvents: [], diagnostics: {},
      },
      other: {
        role: 'other', status: 'ok', timingEvents: [], pitchTraces: [],
        pitchLandmarks: [
          { id: 'other-note-a', timeSeconds: 3, pitchMidi: 60, confidence: 0.8 },
          { id: 'other-note-b', timeSeconds: 4, pitchMidi: 67, confidence: 0.9 },
        ],
        accentEvents: [], diagnostics: {},
      },
    },
  };

  const score = buildAuthoringScore(analysis);

  assert.deepEqual(
    score.evidenceStreams.lane.find((stream) => stream.id === 'stem:bass:pitch').events
      .map(({ id, timeSeconds }) => [id, timeSeconds]),
    [
      ['stem:bass:pitch:bass-shared', 1],
      ['stem:bass:pitch:bass-note-b', 2],
    ],
  );
  assert.deepEqual(
    score.evidenceStreams.lane.find((stream) => stream.id === 'stem:other:pitch').events
      .map((event) => event.timeSeconds),
    [3, 4],
  );
  assert.deepEqual(
    score.evidenceStreams.timing.find((stream) => stream.id === 'stem:other:timing').events,
    [],
  );
});

test('preset suggestions combine covered stems but reject a pitch island as a whole-Region lane driver', () => {
  const analysis = measuredAnalysis();
  analysis.song.durationSeconds = 8;
  analysis.performanceScore.attackEvents = [];
  analysis.musicalStructure.sections = [{ id: 'S01', index: 0, startSeconds: 0, endSeconds: 8 }];
  analysis.musicalStructure.phrases = [
    { id: 'P01', index: 0, sectionIndex: 0, startSeconds: 0, endSeconds: 8 },
  ];
  analysis.stemEvidence = {
    kind: 'core4-stem-evidence',
    schemaVersion: '1.0.0',
    status: 'ok',
    audioFingerprint: 'fixture-audio-1234',
    evidenceFingerprint: 'fixture-island',
    timeOriginSeconds: 0,
    stems: {
      vocals: {
        role: 'vocals', status: 'ok',
        timingEvents: [{ id: 'vocal-a', timeSeconds: 4, confidence: 0.9, kind: 'onset' }],
        pitchTraces: [{
          id: 'island', startSeconds: 3.9, endSeconds: 4.1, confidence: 0.9,
          points: [
            { id: 'p1', timeSeconds: 3.9, pitchMidi: 60, confidence: 0.9 },
            { id: 'p2', timeSeconds: 4, pitchMidi: 67, confidence: 0.9 },
            { id: 'p3', timeSeconds: 4.1, pitchMidi: 62, confidence: 0.9 },
          ],
        }],
        pitchLandmarks: [], accentEvents: [], diagnostics: {},
      },
      drums: {
        role: 'drums', status: 'ok',
        timingEvents: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]
          .map((timeSeconds, index) => ({ id: `d${index}`, timeSeconds, confidence: 0.9, kind: 'drum-hit' })),
        pitchTraces: [], pitchLandmarks: [],
        accentEvents: [{ id: 'downbeat', timeSeconds: 0.5, confidence: 1, kind: 'kick' }],
        diagnostics: {},
      },
      bass: { role: 'bass', status: 'unavailable', timingEvents: [], pitchTraces: [], pitchLandmarks: [], accentEvents: [], diagnostics: {} },
      other: { role: 'other', status: 'unavailable', timingEvents: [], pitchTraces: [], pitchLandmarks: [], accentEvents: [], diagnostics: {} },
    },
  };

  const score = buildAuthoringScore(analysis);
  const pitchSummary = score.regionEvidence[0].streams.find((stream) => (
    stream.kind === 'lane' && stream.streamId === 'stem:vocals:pitch'
  ));
  const suggestion = score.suggestions[0];

  assert.deepEqual(
    { eventCount: pitchSummary.eventCount, maximumGapSeconds: pitchSummary.maximumGapSeconds },
    { eventCount: 3, maximumGapSeconds: 3.9 },
  );
  assert.deepEqual(
    suggestion.preset.timingLayers.map((layer) => [layer.sourceId, layer.role]),
    [
      ['stem:drums:timing', 'target'],
      ['stem:drums:accents', 'accent'],
    ],
  );
  assert.deepEqual(suggestion.preset.laneDriver, {
    kind: 'gesture', pattern: 'alternating', motion: 0.75,
  });
});

test('preset resolver chooses vocal, instrumental, and qualified bass leads from Region evidence', () => {
  const analysis = measuredAnalysis();
  analysis.song.durationSeconds = 12;
  analysis.performanceScore.attackEvents = [];
  analysis.musicalStructure.sections = [{ id: 'S01', index: 0, startSeconds: 0, endSeconds: 12 }];
  analysis.musicalStructure.phrases = [
    { id: 'VOCAL', index: 0, sectionIndex: 0, startSeconds: 0, endSeconds: 4 },
    { id: 'INSTRUMENTAL', index: 1, sectionIndex: 0, startSeconds: 4, endSeconds: 8 },
    { id: 'BASS', index: 2, sectionIndex: 0, startSeconds: 8, endSeconds: 12 },
  ];
  const timing = (prefix, times, pitchBase = null) => times.map((timeSeconds, index) => ({
    id: `${prefix}-${index}`,
    timeSeconds,
    confidence: 0.9,
    kind: prefix.startsWith('drum') ? 'drum-hit' : 'note-onset',
    ...(pitchBase == null ? {} : { pitchMidi: pitchBase + index * 2 }),
  }));
  const landmarks = (prefix, times, pitchBase) => times.map((timeSeconds, index) => ({
    id: `${prefix}-${index}`,
    timeSeconds,
    pitchMidi: pitchBase + index * 3,
    confidence: 0.9,
  }));
  const emptyStem = (role) => ({
    role, status: 'ok', timingEvents: [], pitchTraces: [], pitchLandmarks: [], accentEvents: [], diagnostics: {},
  });
  analysis.stemEvidence = {
    kind: 'core4-stem-evidence', schemaVersion: '1.0.0', status: 'ok',
    audioFingerprint: 'fixture-audio-1234', evidenceFingerprint: 'role-presets', timeOriginSeconds: 0,
    stems: {
      vocals: {
        ...emptyStem('vocals'),
        timingEvents: timing('vocal', [0.4, 1.4, 2.4, 3.4]).concat(timing('vocal-island', [6])),
        pitchTraces: [{ id: 'vocal-line', points: landmarks('vocal-f0', [0.4, 1.4, 2.4, 3.4], 60) }],
        pitchLandmarks: landmarks('vocal-turn', [0.8, 1.8, 2.8], 61),
      },
      drums: {
        ...emptyStem('drums'),
        timingEvents: timing('drum', [
          0.5, 1.5, 2.5, 3.5,
          4.5, 5.5, 6.5, 7.5,
          8.5, 9.5, 10.5, 11.5,
        ]),
        accentEvents: timing('drum-accent', [0.5, 4.5, 8.5]),
      },
      bass: {
        ...emptyStem('bass'),
        timingEvents: timing('bass', [8.4, 9.4, 10.4, 11.4], 40),
        pitchLandmarks: landmarks('bass-note', [8.4, 9.4, 10.4, 11.4], 40),
      },
      other: {
        ...emptyStem('other'),
        timingEvents: timing('other', [
          0.3, 1.3, 2.3, 3.3,
          4.3, 5.3, 6.3, 7.3,
        ], 55),
        pitchLandmarks: landmarks('other-note', [4.3, 5.3, 6.3, 7.3], 55),
      },
    },
  };

  const suggestions = buildAuthoringScore(analysis).suggestions;
  const shape = suggestions.map((suggestion) => ({
    regionId: suggestion.regionId,
    timing: suggestion.preset.timingLayers.map((layer) => [layer.sourceId, layer.role, layer.weight]),
    lane: suggestion.preset.laneDriver,
  }));

  assert.deepEqual(shape, [
    {
      regionId: 'region:VOCAL',
      timing: [
        ['stem:vocals:timing', 'target', 1],
        ['stem:vocals:pitch-landmarks', 'target', 0.35],
        ['stem:drums:timing', 'target', 0.55],
        ['stem:drums:accents', 'accent', 0.8],
      ],
      lane: { kind: 'source', sourceId: 'stem:vocals:pitch', motion: 0.9 },
    },
    {
      regionId: 'region:INSTRUMENTAL',
      timing: [
        ['stem:other:timing', 'target', 1],
        ['stem:drums:timing', 'target', 0.55],
        ['stem:drums:accents', 'accent', 0.8],
      ],
      lane: { kind: 'source', sourceId: 'stem:other:pitch', motion: 0.9 },
    },
    {
      regionId: 'region:BASS',
      timing: [
        ['stem:bass:timing', 'target', 1],
        ['stem:drums:timing', 'target', 0.55],
        ['stem:drums:accents', 'accent', 0.8],
      ],
      lane: { kind: 'source', sourceId: 'stem:bass:pitch', motion: 0.9 },
    },
  ]);
});

test('the same measured analysis produces one stable Authoring Score', () => {
  const analysis = measuredAnalysis();
  const first = buildAuthoringScore(analysis);
  const second = buildAuthoringScore(analysis);

  assert.deepEqual(second, first);
  assert.deepEqual(
    {
      kind: first.kind,
      schemaVersion: first.schemaVersion,
      algorithm: first.algorithm,
      levelId: first.levelId,
      audioFingerprint: first.audioFingerprint,
      performanceSource: first.sources.find((source) => source.id === 'performance-attacks'),
    },
    {
      kind: 'authoring-score',
      schemaVersion: '2.0.0',
      algorithm: 'measured-authoring-score-v2',
      levelId: 'authoring-fixture-flow',
      audioFingerprint: 'fixture-audio-1234',
      performanceSource: {
        id: 'performance-attacks',
        label: '综合击打',
        availability: 'measured',
        capabilities: { onsets: true, pitch: true, continuousPitch: false },
        events: [
          {
            id: 'performance-attacks:attack-00001',
            timeSeconds: 1.25,
            strength: 0.9,
          },
          {
            id: 'performance-attacks:attack-00002',
            timeSeconds: 2.5,
            strength: 0.7,
            pitchMidi: 67,
          },
        ],
      },
    },
  );
});

test('missing continuous F0 stays visible as an unavailable source instead of falling back', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [
    {
      id: 'beat-this',
      events: [
        { index: 1, timeSeconds: 0.5, confidence: 0.72, isDownbeat: false },
        { index: 0, timeSeconds: 0.1, confidence: 1, isDownbeat: true },
      ],
    },
    {
      id: 'librosa-percussive',
      events: [{ timeSeconds: 0.22, confidence: 0.81 }],
    },
    {
      id: 'basic-pitch',
      events: [{ timeSeconds: 0.3, confidence: 0.74, midiPitch: 64, durationSeconds: 0.4 }],
    },
  ];

  const score = buildAuthoringScore(analysis);

  assert.deepEqual(score.sources, [
    {
      id: 'performance-attacks',
      label: '综合击打',
      availability: 'measured',
      capabilities: { onsets: true, pitch: true, continuousPitch: false },
      events: [
        { id: 'performance-attacks:attack-00001', timeSeconds: 1.25, strength: 0.9 },
        { id: 'performance-attacks:attack-00002', timeSeconds: 2.5, strength: 0.7, pitchMidi: 67 },
      ],
    },
    {
      id: 'rhythm-grid',
      label: '节拍网格',
      availability: 'measured',
      capabilities: { onsets: true, pitch: false, continuousPitch: false },
      events: [
        { id: 'rhythm-grid:beat-0', timeSeconds: 0.1, strength: 1, isDownbeat: true },
        { id: 'rhythm-grid:beat-1', timeSeconds: 0.5, strength: 0.72, isDownbeat: false },
      ],
    },
    {
      id: 'percussion-onsets',
      label: '打击 / 起音',
      availability: 'measured',
      capabilities: { onsets: true, pitch: false, continuousPitch: false },
      events: [
        { id: 'percussion-onsets:librosa-percussive:1', timeSeconds: 0.22, strength: 0.81 },
      ],
    },
    {
      id: 'discrete-melody',
      label: '旋律音符',
      availability: 'estimated',
      capabilities: { onsets: true, pitch: true, continuousPitch: false },
      events: [
        {
          id: 'discrete-melody:basic-pitch:1',
          timeSeconds: 0.3,
          strength: 0.74,
          pitchMidi: 64,
          durationSeconds: 0.4,
        },
      ],
    },
    {
      id: 'melody-contour',
      label: '连续音高',
      availability: 'unavailable',
      capabilities: { onsets: false, pitch: true, continuousPitch: true },
      events: [],
    },
  ]);
});

test('continuous F0 exposes every contour point with its trace identity', () => {
  const analysis = measuredAnalysis({
    continuousPitch: {
      schemaVersion: '1.0.0',
      traces: [
        {
          id: 'f0-trace-002',
          confidence: 0.8,
          points: [
            { id: 'f0-00003', timeSeconds: 5.4, pitchMidi: 69.25, confidence: 0.83 },
          ],
        },
        {
          id: 'f0-trace-001',
          confidence: 0.9,
          points: [
            { id: 'f0-00002', timeSeconds: 4.4, pitchMidi: 65.1, confidence: 0.92 },
            { id: 'f0-00001', timeSeconds: 4.1, pitchMidi: 60, confidence: 0.88 },
          ],
        },
      ],
    },
  });

  const contour = buildAuthoringScore(analysis).sources
    .find((source) => source.id === 'melody-contour');

  assert.deepEqual(contour, {
    id: 'melody-contour',
    label: '连续音高',
    availability: 'estimated',
    capabilities: { onsets: false, pitch: true, continuousPitch: true },
    events: [
      {
        id: 'melody-contour:f0-00001',
        timeSeconds: 4.1,
        strength: 0.88,
        pitchMidi: 60,
        traceId: 'f0-trace-001',
      },
      {
        id: 'melody-contour:f0-00002',
        timeSeconds: 4.4,
        strength: 0.92,
        pitchMidi: 65.1,
        traceId: 'f0-trace-001',
      },
      {
        id: 'melody-contour:f0-00003',
        timeSeconds: 5.4,
        strength: 0.83,
        pitchMidi: 69.25,
        traceId: 'f0-trace-002',
      },
    ],
  });
});

test('adaptive phrases become the stable section-level authoring regions', () => {
  const analysis = measuredAnalysis();
  analysis.musicalStructure.sections = [
    { id: 'S01', index: 0, startSeconds: 0, endSeconds: 8 },
    { id: 'S02', index: 1, startSeconds: 8, endSeconds: 16 },
  ];
  analysis.musicalStructure.phrases = [
    { id: 'P03', index: 2, sectionIndex: 1, startSeconds: 8, endSeconds: 16 },
    { id: 'P01', index: 0, sectionIndex: 0, startSeconds: 0, endSeconds: 4 },
    { id: 'P02', index: 1, sectionIndex: 0, startSeconds: 4, endSeconds: 8 },
  ];

  const score = buildAuthoringScore(analysis);

  assert.deepEqual(score.regions, [
    {
      id: 'region:P01',
      label: '片段 01',
      startSeconds: 0,
      endSeconds: 4,
      sourceSectionId: 'S01',
      sourcePhraseId: 'P01',
    },
    {
      id: 'region:P02',
      label: '片段 02',
      startSeconds: 4,
      endSeconds: 8,
      sourceSectionId: 'S01',
      sourcePhraseId: 'P02',
    },
    {
      id: 'region:P03',
      label: '片段 03',
      startSeconds: 8,
      endSeconds: 16,
      sourceSectionId: 'S02',
      sourcePhraseId: 'P03',
    },
  ]);
});

test('trusted primary and overlapping repetitions keep explicit occurrence region references', () => {
  const analysis = measuredAnalysis();
  analysis.musicalStructure.sections = [
    { id: 'S01', index: 0, startSeconds: 0, endSeconds: 8 },
    { id: 'S02', index: 1, startSeconds: 8, endSeconds: 16 },
  ];
  analysis.musicalStructure.phrases = [
    { id: 'P01', index: 0, sectionIndex: 0, startSeconds: 0, endSeconds: 4 },
    { id: 'P02', index: 1, sectionIndex: 0, startSeconds: 4, endSeconds: 8 },
    { id: 'P03', index: 2, sectionIndex: 1, startSeconds: 8, endSeconds: 12 },
    { id: 'P04', index: 3, sectionIndex: 1, startSeconds: 12, endSeconds: 16 },
  ];
  analysis.musicalStructure.families = [
    { id: 'FA', kind: 'repeated', confidence: 0.95, phraseIds: ['P01', 'P03'] },
    { id: 'UNTRUSTED', kind: 'repeated', confidence: 0.6, phraseIds: ['P02', 'P04'] },
  ];
  analysis.musicalStructure.overlappingPhrases = [
    { id: 'O01', startSeconds: 1, endSeconds: 7 },
    { id: 'O02', startSeconds: 9, endSeconds: 15 },
  ];
  analysis.musicalStructure.overlappingPhraseFamilies = [
    { id: 'OFA', kind: 'repeated', confidence: 0.9, phraseIds: ['O01', 'O02'] },
  ];

  const score = buildAuthoringScore(analysis);

  assert.deepEqual(score.repeatSets, [
    {
      id: 'repeat-set:FA',
      confidence: 0.95,
      occurrences: [
        {
          id: 'occurrence:FA:P01',
          regionId: 'region:P01',
          startSeconds: 0,
          endSeconds: 4,
        },
        {
          id: 'occurrence:FA:P03',
          regionId: 'region:P03',
          startSeconds: 8,
          endSeconds: 12,
        },
      ],
    },
    {
      id: 'repeat-set:OFA',
      confidence: 0.9,
      occurrences: [
        {
          id: 'occurrence:OFA:O01',
          regionId: 'region:P01',
          startSeconds: 1,
          endSeconds: 7,
        },
        {
          id: 'occurrence:OFA:O02',
          regionId: 'region:P03',
          startSeconds: 9,
          endSeconds: 15,
        },
      ],
    },
  ]);
});

test('each region gets one evidence-only suggestion and missing evidence becomes an explicit rest', () => {
  const analysis = measuredAnalysis({
    continuousPitch: {
      traces: [{
        id: 'f0-trace-001',
        points: [
          { id: 'f0-00001', timeSeconds: 0.5, pitchMidi: 60, confidence: 0.9 },
          { id: 'f0-00002', timeSeconds: 1.5, pitchMidi: 64, confidence: 0.92 },
          { id: 'f0-00003', timeSeconds: 2.5, pitchMidi: 67, confidence: 0.91 },
        ],
      }],
    },
  });
  analysis.musicalStructure.sections = [
    { id: 'S01', index: 0, startSeconds: 0, endSeconds: 8 },
  ];
  analysis.musicalStructure.phrases = [
    { id: 'P01', index: 0, sectionIndex: 0, startSeconds: 0, endSeconds: 4 },
    { id: 'P02', index: 1, sectionIndex: 0, startSeconds: 4, endSeconds: 8 },
  ];

  const suggestions = buildAuthoringScore(analysis).suggestions;

  assert.deepEqual(suggestions, [
    {
      regionId: 'region:P01',
      preset: {
        mode: 'play',
        timingLayers: [{ sourceId: 'performance-attacks', role: 'target', weight: 1 }],
        laneDriver: { kind: 'source', sourceId: 'melody-contour', motion: 1 },
        density: 0.85,
        challenge: 0.25,
        feel: 'natural',
        maxGapBeats: 4,
      },
      reasonCodes: ['continuous-pitch-evidence'],
    },
    {
      regionId: 'region:P02',
      preset: { mode: 'rest' },
      reasonCodes: ['no-event-evidence'],
    },
  ]);
});

test('local evidence separates melody, dense percussion, and sparse percussion recipes', () => {
  const analysis = measuredAnalysis();
  analysis.musicalStructure.sections = [
    { id: 'S01', index: 0, startSeconds: 0, endSeconds: 12 },
  ];
  analysis.musicalStructure.phrases = [
    { id: 'P01', index: 0, sectionIndex: 0, startSeconds: 0, endSeconds: 4 },
    { id: 'P02', index: 1, sectionIndex: 0, startSeconds: 4, endSeconds: 8 },
    { id: 'P03', index: 2, sectionIndex: 0, startSeconds: 8, endSeconds: 12 },
  ];
  analysis.eventSources = [
    {
      id: 'beat-this',
      events: [0.5, 2.5, 4.5, 6.5, 8.5, 10.5]
        .map((timeSeconds, index) => ({ index, timeSeconds, confidence: 0.72 })),
    },
    {
      id: 'basic-pitch',
      events: [
        { timeSeconds: 0.4, confidence: 0.8, midiPitch: 60 },
        { timeSeconds: 1.4, confidence: 0.8, midiPitch: 64 },
        { timeSeconds: 2.4, confidence: 0.8, midiPitch: 67 },
      ],
    },
    {
      id: 'librosa-percussive',
      events: [4.2, 4.6, 5.0, 5.4, 5.8, 6.2, 6.6, 7.0, 9.5]
        .map((timeSeconds) => ({ timeSeconds, confidence: 0.82 })),
    },
  ];

  const suggestions = buildAuthoringScore(analysis).suggestions;

  assert.deepEqual(suggestions, [
    {
      regionId: 'region:P01',
      preset: {
        mode: 'play',
        timingLayers: [{ sourceId: 'discrete-melody', role: 'target', weight: 1 }],
        laneDriver: { kind: 'source', sourceId: 'discrete-melody', motion: 0.8 },
        density: 0.75,
        challenge: 0.3,
        feel: 'natural',
        maxGapBeats: 4,
      },
      reasonCodes: ['discrete-pitch-evidence'],
    },
    {
      regionId: 'region:P02',
      preset: {
        mode: 'play',
        timingLayers: [{ sourceId: 'percussion-onsets', role: 'target', weight: 1 }],
        laneDriver: { kind: 'gesture', pattern: 'alternating', motion: 0.75 },
        density: 0.68,
        challenge: 0.35,
        feel: 'natural',
        maxGapBeats: 4,
      },
      reasonCodes: ['dense-percussive-evidence'],
    },
    {
      regionId: 'region:P03',
      preset: {
        mode: 'play',
        timingLayers: [{ sourceId: 'percussion-onsets', role: 'target', weight: 1 }],
        laneDriver: { kind: 'gesture', pattern: 'pulse', motion: 0.2 },
        density: 0.48,
        challenge: 0.18,
        feel: 'natural',
        maxGapBeats: 4,
      },
      reasonCodes: ['sparse-percussive-evidence'],
    },
  ]);
});
