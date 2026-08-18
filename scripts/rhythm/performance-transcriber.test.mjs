import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PERFORMANCE_TRANSCRIBER_ALGORITHM,
  transcribePerformance,
} from './performance-transcriber.mjs';

function measuredAnalysis() {
  return {
    song: {
      id: 'fixture-song',
      title: 'Fixture Song',
      artist: 'Fixture Artist',
      durationSeconds: 8,
      audioFingerprint: 'performance-fixture-audio',
    },
    eventSources: [
      {
        id: 'beat-this',
        events: [
          { timeSeconds: 1, confidence: 1, isDownbeat: true, barIndex: 0, beatInBar: 1 },
          { timeSeconds: 2, confidence: 0.72, isDownbeat: false, barIndex: 0, beatInBar: 2 },
          { timeSeconds: 3, confidence: 0.72, isDownbeat: false, barIndex: 0, beatInBar: 3 },
          { timeSeconds: 4, confidence: 1, isDownbeat: true, barIndex: 1, beatInBar: 1 },
        ],
      },
      {
        id: 'librosa-onset',
        events: [
          { timeSeconds: 1.018, confidence: 0.92 },
          { timeSeconds: 1.42, confidence: 0.88 },
        ],
      },
      {
        id: 'librosa-percussive',
        events: [
          { timeSeconds: 1.02, confidence: 0.95 },
          { timeSeconds: 1.421, confidence: 0.9 },
        ],
      },
      {
        id: 'basic-pitch',
        events: [
          {
            timeSeconds: 1.01,
            confidence: 0.84,
            midiPitch: 60,
            durationSeconds: 0.18,
            polyphony: 1,
          },
          {
            timeSeconds: 1.09,
            confidence: 0.82,
            midiPitch: 62,
            durationSeconds: 0.16,
            polyphony: 1,
          },
          {
            timeSeconds: 2.26,
            confidence: 0.86,
            midiPitch: 67,
            durationSeconds: 0.22,
            polyphony: 1,
          },
        ],
      },
    ],
    musicalStructure: {
      phrases: [
        { id: 'P01', startSeconds: 0, endSeconds: 4 },
        { id: 'P02', startSeconds: 4, endSeconds: 8 },
      ],
      overlappingPhrases: [],
    },
  };
}

test('returns an explicit empty Performance Score when measured analysis is unavailable', () => {
  const score = transcribePerformance(null);

  assert.equal(PERFORMANCE_TRANSCRIBER_ALGORITHM, 'measured-performance-transcriber-v1');
  assert.deepEqual(score, {
    schemaVersion: '1.0.0',
    kind: 'performance-score',
    algorithm: PERFORMANCE_TRANSCRIBER_ALGORITHM,
    audioFingerprint: 'missing-audio-fingerprint',
    attackEvents: [],
    melodicTraces: [],
    diagnostics: {
      sourceEventCounts: {},
      candidateCount: 0,
      attackEventCount: 0,
      fusedAttackCount: 0,
      melodicTraceCount: 0,
      pitchedAttackCount: 0,
      percussiveAttackCount: 0,
      constrainedLaneCount: 0,
      polyphonicApproximationCount: 0,
      timeSourceCounts: {},
      metricOnlyBeatEvidenceCount: 0,
      warnings: ['missing-measured-analysis'],
    },
  });
});

test('fuses coincident detector evidence without beat-snapping or dropping dense adjacent notes', () => {
  const analysis = measuredAnalysis();
  const before = structuredClone(analysis);

  const first = transcribePerformance(analysis);
  const second = transcribePerformance(analysis);
  const atFirstNote = first.attackEvents.find((event) => event.timeSeconds === 1.018);

  assert.deepEqual(first, second);
  assert.deepEqual(analysis, before, 'transcribePerformance must not mutate measured analysis');
  assert.equal(first.audioFingerprint, 'performance-fixture-audio');
  assert.deepEqual(
    first.attackEvents.filter((event) => event.pitchMidi != null).map((event) => event.timeSeconds),
    [1.018, 1.09, 2.26],
    '80ms pitched attacks and an off-beat note must remain at their measured onset times',
  );
  assert.equal(first.attackEvents.filter((event) => event.timeSeconds === 1.018).length, 1);
  assert.deepEqual(atFirstNote?.evidenceIds, [
    'event:basic-pitch:1',
    'event:beat-this:1',
    'event:librosa-onset:1',
    'event:librosa-percussive:1',
  ]);
  assert.equal(atFirstNote?.sourceRole, 'melody');
  assert.deepEqual(atFirstNote?.sourceTimeEvidence, {
    evidenceId: 'event:librosa-onset:1',
    sourceId: 'librosa-onset',
    kind: 'onset',
  });
  assert.equal(atFirstNote?.phraseId, 'P01');
  assert.deepEqual(atFirstNote?.phraseIds, ['P01']);
  assert.ok(Number.isInteger(atFirstNote?.lane) && atFirstNote.lane >= 0 && atFirstNote.lane <= 4);
  assert.ok(first.attackEvents.every((event) => event.evidenceIds.length > 0));
  assert.ok(first.attackEvents.every((event) => event.continuity != null));
  assert.ok(first.diagnostics.fusedAttackCount >= 2);
});

test('maps a dense local pitch turn into a playable five-lane S trace without using the whole-song range', () => {
  const analysis = measuredAnalysis();
  const pitchSource = analysis.eventSources.find((source) => source.id === 'basic-pitch');
  pitchSource.events = [60, 64, 67, 64, 60, 57, 60].map((midiPitch, index) => ({
    timeSeconds: 0.5 + index * 0.1,
    confidence: 0.9,
    midiPitch,
    durationSeconds: 0.42,
    polyphony: 1,
  }));
  pitchSource.events.push({
    timeSeconds: 5,
    confidence: 0.9,
    midiPitch: 96,
    durationSeconds: 0.2,
    polyphony: 1,
  });
  analysis.eventSources = [pitchSource];

  const score = transcribePerformance(analysis);
  const trace = score.melodicTraces.find((candidate) => candidate.phraseId === 'P01');
  const tracedEvents = trace.attackEventIds.map((id) => (
    score.attackEvents.find((event) => event.id === id)
  ));

  assert.deepEqual(trace.pitchContour, [60, 64, 67, 64, 60, 57, 60]);
  assert.deepEqual(trace.laneContour, [1, 2, 3, 2, 1, 0, 1]);
  assert.equal(trace.contourKind, 's-curve');
  assert.equal(trace.sourceRole, 'vocal-like');
  assert.deepEqual(
    tracedEvents.map((event) => event.timeSeconds),
    [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1],
    'dense melodic attacks remain individually playable',
  );
  assert.deepEqual(
    tracedEvents.map((event) => event.continuity.direction),
    ['start', 'up', 'up', 'down', 'down', 'down', 'up'],
  );
  assert.ok(tracedEvents.every((event) => event.continuity.traceId === trace.id));
  assert.ok(tracedEvents.every((event) => event.continuity.sustained));
  assert.equal(score.attackEvents.find((event) => event.pitchMidi === 96).phraseId, 'P02');
});

test('keeps a measured off-beat percussion attack instead of replacing it with the beat grid', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [
    {
      id: 'beat-this',
      events: [
        { timeSeconds: 1, confidence: 0.8, isDownbeat: true },
        { timeSeconds: 2, confidence: 0.72, isDownbeat: false },
      ],
    },
    {
      id: 'librosa-percussive',
      events: [{ timeSeconds: 1.37, confidence: 0.96 }],
    },
  ];

  const score = transcribePerformance(analysis);
  const offBeat = score.attackEvents.find((event) => event.timeSeconds === 1.37);

  assert.ok(offBeat, 'the detector time must remain an authoritative Attack Event');
  assert.equal(offBeat.sourceRole, 'percussion');
  assert.equal(offBeat.pitchMidi, null);
  assert.deepEqual(offBeat.evidenceIds, ['event:librosa-percussive:1']);
});

test('keeps long chromatic rises inside the five physical lanes', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [{
    id: 'basic-pitch',
    events: Array.from({ length: 11 }, (_, index) => ({
      timeSeconds: 0.5 + index * 0.1,
      confidence: 0.9,
      midiPitch: 60 + index,
      durationSeconds: 0.12,
      polyphony: 1,
    })),
  }];

  const score = transcribePerformance(analysis);
  const trace = score.melodicTraces[0];

  assert.ok(trace.laneContour.every((lane) => Number.isInteger(lane) && lane >= 0 && lane <= 4));
  assert.ok(trace.laneContour.slice(1).every((lane, index) => lane >= trace.laneContour[index]));
  assert.equal(trace.laneContour.at(-1), 4);
});

test('uses harmonic frequency-band evidence as a lane fallback before MIDI pitch is available', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [
    {
      id: 'librosa-harmonic',
      events: [{ timeSeconds: 1.333, confidence: 0.9 }],
    },
    {
      id: 'librosa-band-high',
      events: [{ timeSeconds: 1.335, confidence: 0.88 }],
    },
  ];

  const score = transcribePerformance(analysis);
  const attack = score.attackEvents[0];

  assert.equal(attack.timeSeconds, 1.333);
  assert.equal(attack.sourceRole, 'melody');
  assert.equal(attack.pitchMidi, null);
  assert.equal(attack.lane, 4);
  assert.deepEqual(attack.evidenceIds, [
    'event:librosa-band-high:1',
    'event:librosa-harmonic:1',
  ]);
});

test('realizes one globally reachable lane path while keeping interleaved percussion near the melody', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [
    {
      id: 'basic-pitch',
      events: [
        { timeSeconds: 0.5, confidence: 0.9, midiPitch: 60, durationSeconds: 0.15, polyphony: 1 },
        { timeSeconds: 0.7, confidence: 0.9, midiPitch: 67, durationSeconds: 0.15, polyphony: 1 },
      ],
    },
    {
      id: 'librosa-percussive',
      events: [{ timeSeconds: 0.6, confidence: 0.92 }],
    },
  ];

  const score = transcribePerformance(analysis);
  const lanes = score.attackEvents.map((event) => event.lane);

  assert.deepEqual(lanes, [0, 1, 2]);
  assert.deepEqual(score.melodicTraces[0].laneContour, [0, 2]);
  assert.equal(score.diagnostics.constrainedLaneCount, 1);
  assert.ok(score.attackEvents.every((event, index, events) => {
    const previousLane = index === 0 ? 2 : events[index - 1].lane;
    const previousTime = index === 0 ? 0 : events[index - 1].timeSeconds;
    return event.timeSeconds - previousTime + 1e-6 >= Math.abs(event.lane - previousLane) * 0.08;
  }));
});

test('constrains the first Attack Event to a lane reachable from center at time zero', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [
    { id: 'librosa-harmonic', events: [{ timeSeconds: 0.02, confidence: 0.9 }] },
    { id: 'librosa-band-high', events: [{ timeSeconds: 0.021, confidence: 0.9 }] },
  ];

  const score = transcribePerformance(analysis);

  assert.equal(score.attackEvents[0].lane, 2);
  assert.equal(score.diagnostics.constrainedLaneCount, 1);
});

test('uses isolated Beat This peaks as metric evidence without inventing standalone Attack Events', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [{
    id: 'beat-this',
    events: [
      { timeSeconds: 1, confidence: 1, isDownbeat: true },
      { timeSeconds: 2, confidence: 0.72, isDownbeat: false },
    ],
  }];

  const score = transcribePerformance(analysis);

  assert.deepEqual(score.attackEvents, []);
  assert.equal(score.diagnostics.metricOnlyBeatEvidenceCount, 2);
  assert.ok(score.diagnostics.warnings.includes('missing-attack-evidence'));
});

test('selects a continuous main-voice approximation from polyphonic pitch bounds', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [{
    id: 'basic-pitch',
    events: [
      {
        timeSeconds: 0.5, confidence: 0.9, midiPitch: 54,
        pitchMin: 48, pitchMax: 72, durationSeconds: 0.2, polyphony: 4,
      },
      {
        timeSeconds: 0.8, confidence: 0.9, midiPitch: 55,
        pitchMin: 50, pitchMax: 71, durationSeconds: 0.2, polyphony: 4,
      },
      {
        timeSeconds: 1.1, confidence: 0.9, midiPitch: 56,
        pitchMin: 52, pitchMax: 70, durationSeconds: 0.2, polyphony: 3,
      },
    ],
  }];

  const score = transcribePerformance(analysis);

  assert.deepEqual(score.attackEvents.map((event) => event.pitchMidi), [72, 71, 70]);
  assert.deepEqual(score.melodicTraces[0].pitchContour, [72, 71, 70]);
  assert.equal(score.diagnostics.polyphonicApproximationCount, 3);
});

test('coalesces sub-18ms detector-boundary duplicates into one evidenced Attack Event', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources = [
    { id: 'beat-this', events: [{ timeSeconds: 1, confidence: 0.8 }] },
    { id: 'librosa-onset', events: [{ timeSeconds: 1.05, confidence: 0.9 }] },
    { id: 'librosa-percussive', events: [{ timeSeconds: 1.061, confidence: 0.88 }] },
  ];

  const score = transcribePerformance(analysis);

  assert.equal(score.attackEvents.length, 1);
  assert.equal(score.attackEvents[0].timeSeconds, 1.05);
  assert.deepEqual(score.attackEvents[0].evidenceIds, [
    'event:beat-this:1',
    'event:librosa-onset:1',
    'event:librosa-percussive:1',
  ]);
});
