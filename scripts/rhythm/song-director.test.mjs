import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRECTOR_ALGORITHM, directSong } from './song-director.mjs';

function measuredAnalysis() {
  const beats = Array.from({ length: 32 }, (_, index) => ({
    index,
    timeSeconds: index,
    confidence: index % 4 === 0 ? 1 : 0.72,
    isDownbeat: index % 4 === 0,
    barIndex: Math.floor(index / 4),
    beatInBar: index % 4 + 1,
  }));
  return {
    song: {
      id: 'fixture-id',
      title: 'Fixture title',
      artist: 'Fixture artist',
      durationSeconds: 32,
      bpm: 60,
      audioFingerprint: 'director-fixture-audio',
    },
    waveform: { peaks: [0.12, 0.18, 0.28, 0.34, 0.88, 0.94, 0.75, 0.64, 0.5, 0.42, 0.25, 0.18] },
    eventSources: [
      { id: 'beat-this', events: beats },
      {
        id: 'librosa-onset',
        events: [2.02, 6.01, 8.02, 10.01, 12.02, 14.01, 18.02, 22.01, 26.02, 30.01]
          .map((timeSeconds, index) => ({ timeSeconds, confidence: index === 2 ? 1 : 0.82 })),
      },
      {
        id: 'basic-pitch',
        events: [1.2, 3.4, 5.5, 9.2, 10.8, 13.4, 17.2, 19.4, 21.5, 25.2, 27.4, 29.5]
          .map((timeSeconds, index) => ({ timeSeconds, confidence: 0.76, midiPitch: 60 + index })),
      },
    ],
    musicalStructure: {
      beats,
      downbeats: beats.filter((beat) => beat.isDownbeat),
      sections: [
        { index: 0, id: 'S01', startSeconds: 0, endSeconds: 8, intensity: 0.18, boundarySupport: 1 },
        {
          index: 1,
          id: 'S02',
          startSeconds: 8,
          endSeconds: 16,
          intensity: 0.95,
          boundarySupport: 0.96,
          harmonicNovelty: 0.9,
        },
        { index: 2, id: 'S03', startSeconds: 16, endSeconds: 24, intensity: 0.58, boundarySupport: 0.55 },
        { index: 3, id: 'S04', startSeconds: 24, endSeconds: 32, intensity: 0.24, boundarySupport: 0.9 },
      ],
      phrases: [
        { index: 0, id: 'P01', familyId: 'FA', startSeconds: 0, endSeconds: 8, intensity: 0.2 },
        { index: 1, id: 'P02', familyId: 'FB', startSeconds: 8, endSeconds: 16, intensity: 0.9 },
        { index: 2, id: 'P03', familyId: 'FA', startSeconds: 16, endSeconds: 24, intensity: 0.55 },
        { index: 3, id: 'P04', familyId: 'FC', startSeconds: 24, endSeconds: 32, intensity: 0.25 },
      ],
      families: [
        { id: 'FA', kind: 'repeated', phraseIds: ['P01', 'P03'], occurrenceCount: 2, confidence: 0.94 },
        { id: 'FB', kind: 'unique-low-confidence', phraseIds: ['P02'], occurrenceCount: 1, confidence: 0.58 },
        { id: 'FC', kind: 'unique-low-confidence', phraseIds: ['P04'], occurrenceCount: 1, confidence: 0.61 },
      ],
      overlappingPhrases: [
        { index: 0, id: 'O01', familyId: 'OFA', startSeconds: 4, endSeconds: 12, intensity: 0.54 },
        { index: 1, id: 'O02', familyId: 'OFA', startSeconds: 20, endSeconds: 28, intensity: 0.43 },
      ],
      overlappingPhraseFamilies: [
        { id: 'OFA', kind: 'repeated', phraseIds: ['O01', 'O02'], occurrenceCount: 2, confidence: 0.91 },
      ],
      phraseLinks: [
        { sourcePhraseId: 'P01', targetPhraseId: 'P03', relationship: 'same-family', similarity: 0.94 },
        { sourcePhraseId: 'P02', targetPhraseId: 'P04', relationship: 'related-variant', similarity: 0.84 },
        { sourcePhraseId: 'O01', targetPhraseId: 'O02', relationship: 'same-family', similarity: 0.91 },
      ],
    },
  };
}

function replacePitchProfile(analysis, makePolyphony) {
  analysis.eventSources.find((source) => source.id === 'basic-pitch').events = Array.from(
    { length: 64 },
    (_, index) => {
      const timeSeconds = index * 0.5 + 0.25;
      return {
        timeSeconds,
        confidence: 0.9,
        midiPitch: 60 + index % 8,
        polyphony: makePolyphony(timeSeconds),
      };
    },
  );
  return analysis;
}

test('returns a complete safe Director Score when measured analysis is unavailable', () => {
  const score = directSong(null);

  assert.equal(DIRECTOR_ALGORITHM, 'music-evidence-song-director-v1');
  assert.equal(score.algorithm, DIRECTOR_ALGORITHM);
  assert.equal(score.audioFingerprint, 'missing-audio-fingerprint');
  assert.deepEqual(score.anchors, []);
  assert.deepEqual(score.scenes, []);
  assert.deepEqual(score.phraseIdentities, []);
  assert.deepEqual(score.moments, []);
  assert.deepEqual(score.colorScenes, []);
  assert.deepEqual(score.visualAccents, []);
  assert.equal(score.diagnostics.phraseCoverage, 0);
  assert.equal(score.diagnostics.repetitionAgreement, null);
  assert.ok(score.diagnostics.warnings.includes('missing-measured-analysis'));
});

test('derives deterministic Musical Anchors only from measured evidence and ignores display metadata', () => {
  const analysis = measuredAnalysis();
  const before = structuredClone(analysis);
  const renamed = structuredClone(analysis);
  renamed.song.id = 'unknown-id';
  renamed.song.title = 'A title the director has never seen';
  renamed.song.artist = 'Unknown artist';

  const first = directSong(analysis);
  const second = directSong(analysis);
  const renamedScore = directSong(renamed);
  const measuredTimes = new Set([
    ...analysis.eventSources.flatMap((source) => source.events.map((event) => event.timeSeconds)),
    ...analysis.musicalStructure.sections.flatMap((section) => [section.startSeconds, section.endSeconds]),
    ...analysis.musicalStructure.phrases.flatMap((phrase) => [phrase.startSeconds, phrase.endSeconds]),
    ...analysis.musicalStructure.overlappingPhrases.flatMap((phrase) => [phrase.startSeconds, phrase.endSeconds]),
  ]);

  assert.deepEqual(first, second);
  assert.deepEqual(first, renamedScore);
  assert.deepEqual(analysis, before, 'directSong must not mutate measured analysis');
  assert.ok(first.anchors.length > 0);
  assert.ok(first.anchors.every((anchor) => measuredTimes.has(anchor.timeSeconds)));
  assert.ok(first.anchors.every((anchor) => anchor.evidenceIds.length > 0));
});

test('fuses exact families, related variants, and overlapping windows into covered Phrase Identities', () => {
  const score = directSong(measuredAnalysis());
  const identityContaining = (...phraseIds) => score.phraseIdentities.find((identity) => {
    const sourceIds = identity.occurrences.flatMap((occurrence) => occurrence.sourcePhraseIds);
    return phraseIds.every((phraseId) => sourceIds.includes(phraseId));
  });

  const exact = identityContaining('P01', 'P03');
  const developed = identityContaining('P02', 'P04');
  const overlapping = identityContaining('O01', 'O02');

  assert.equal(exact?.relation, 'exact');
  assert.equal(exact?.occurrences.length, 2);
  assert.equal(developed?.relation, 'developed');
  assert.equal(developed?.developmentPolicy, 'preserve-form-with-directed-development');
  assert.equal(overlapping?.relation, 'exact');
  assert.ok(score.phraseIdentities.every((identity) => identity.coverage > 0));
  assert.ok(score.diagnostics.phraseCoverage > 0);
  assert.ok(score.diagnostics.repetitionCoverage > 0);
  assert.ok(score.diagnostics.repetitionAgreement > 0 && score.diagnostics.repetitionAgreement < 1);
});

test('converges nested exact overlap recurrences into the largest trustworthy contract', () => {
  const analysis = measuredAnalysis();
  analysis.musicalStructure.overlappingPhrases = [
    { id: 'O-short-a', familyId: 'OF-short', startSeconds: 4, endSeconds: 12, intensity: 0.54 },
    { id: 'O-short-b', familyId: 'OF-short', startSeconds: 20, endSeconds: 28, intensity: 0.43 },
    { id: 'O-short-c', familyId: 'OF-short', startSeconds: 36, endSeconds: 44, intensity: 0.49 },
    { id: 'O-long-a', familyId: 'OF-long', startSeconds: 2, endSeconds: 14, intensity: 0.58 },
    { id: 'O-long-b', familyId: 'OF-long', startSeconds: 18, endSeconds: 30, intensity: 0.47 },
  ];
  analysis.musicalStructure.overlappingPhraseFamilies = [
    {
      id: 'OF-short',
      kind: 'repeated',
      phraseIds: ['O-short-a', 'O-short-b', 'O-short-c'],
      occurrenceCount: 3,
      confidence: 0.95,
    },
    {
      id: 'OF-long',
      kind: 'repeated',
      phraseIds: ['O-long-a', 'O-long-b'],
      occurrenceCount: 2,
      confidence: 0.91,
    },
  ];
  analysis.musicalStructure.phraseLinks = [
    { sourcePhraseId: 'P01', targetPhraseId: 'P03', relationship: 'same-family', similarity: 0.94 },
    { sourcePhraseId: 'P02', targetPhraseId: 'P04', relationship: 'related-variant', similarity: 0.84 },
    { sourcePhraseId: 'O-short-a', targetPhraseId: 'O-short-b', relationship: 'same-family', similarity: 0.95 },
    { sourcePhraseId: 'O-short-b', targetPhraseId: 'O-short-c', relationship: 'same-family', similarity: 0.93 },
    { sourcePhraseId: 'O-long-a', targetPhraseId: 'O-long-b', relationship: 'same-family', similarity: 0.91 },
  ];

  const first = directSong(analysis);
  const second = directSong(analysis);
  const overlapExact = first.phraseIdentities.filter((identity) => (
    identity.relation === 'exact'
    && identity.occurrences.some((occurrence) => (
      occurrence.sourcePhraseIds.some((phraseId) => phraseId.startsWith('O-'))
    ))
  ));

  assert.deepEqual(first, second);
  assert.equal(overlapExact.length, 1);
  assert.deepEqual(
    overlapExact[0].occurrences.flatMap((occurrence) => occurrence.sourcePhraseIds),
    ['O-long-a', 'O-long-b'],
  );
  assert.ok(overlapExact[0].supportingExactEvidenceIds.some((id) => id.includes('O-short')));
  assert.equal(first.diagnostics.suppressedExactContractCount, 1);
});

test('turns an abrupt measured scene boundary into a must Directed Moment without recoloring ordinary beats', () => {
  const score = directSong(measuredAnalysis());
  const anchorAt = (timeSeconds) => score.anchors.find((anchor) => anchor.timeSeconds === timeSeconds);
  const turnAnchor = anchorAt(8);
  const ordinaryDownbeat = anchorAt(12);
  const turnMoment = score.moments.find((moment) => moment.anchorId === turnAnchor?.id);

  assert.equal(score.scenes.length, 4);
  assert.ok(score.scenes[1].changeFromPrevious.salience > 0.7);
  assert.equal(turnMoment?.commitment, 'must');
  assert.match(turnMoment?.type ?? '', /^(impact|arrival|rupture|release|breath)$/);
  assert.deepEqual(turnMoment?.requiredChannels, ['color', 'density', 'movement', 'threat']);
  assert.equal(turnMoment?.sceneId, score.scenes[1].id);
  assert.ok(turnMoment?.evidenceIds.length > 0);
  assert.ok(score.colorScenes.some((scene) => scene.anchorId === turnAnchor?.id));
  assert.equal(
    score.colorScenes.length,
    score.moments.filter((moment) => moment.narrativeTurn).length,
  );
  assert.ok(score.visualAccents.some((accent) => accent.anchorId === ordinaryDownbeat?.id));
  assert.ok(score.colorScenes.every((scene) => scene.anchorId !== ordinaryDownbeat?.id));
  const releaseAnalysis = measuredAnalysis();
  releaseAnalysis.musicalStructure.sections[2].intensity = 0.98;
  releaseAnalysis.musicalStructure.sections[3].intensity = 0.04;
  releaseAnalysis.musicalStructure.sections[3].boundarySupport = 1;
  releaseAnalysis.waveform.peaks = [0.12, 0.18, 0.28, 0.34, 0.88, 0.94, 0.9, 0.92, 0.86, 0.04, 0.03, 0.02];
  for (const source of releaseAnalysis.eventSources) {
    if (source.id !== 'beat-this') source.events = source.events.filter((event) => event.timeSeconds < 24);
  }
  const releaseScore = directSong(releaseAnalysis);
  const releaseAnchor = releaseScore.anchors.find((anchor) => anchor.timeSeconds === 24);
  const releaseMoment = releaseScore.moments.find((moment) => moment.anchorId === releaseAnchor?.id);
  assert.ok(releaseMoment, 'The measured pressure drop should produce a release cue.');
  assert.equal(releaseMoment.type, 'release');
  assert.ok(releaseMoment.requiredChannels.includes('density'));
  assert.equal(releaseMoment.requiredChannels.includes('movement'), false);
});

test('keeps every Director Score reference attached to a known Musical Anchor', () => {
  const score = directSong(measuredAnalysis());
  const anchorsById = new Map(score.anchors.map((anchor) => [anchor.id, anchor]));
  const referenced = [
    ...score.scenes.map((scene) => ({ anchorId: scene.entryAnchorId, timeSeconds: scene.startSeconds })),
    ...score.moments,
    ...score.colorScenes,
    ...score.visualAccents,
  ].filter((item) => item.anchorId != null);

  assert.ok(referenced.length > 0);
  assert.ok(referenced.every((item) => anchorsById.has(item.anchorId)));
  assert.ok(referenced.every((item) => anchorsById.get(item.anchorId).timeSeconds === item.timeSeconds));
  assert.equal(score.diagnostics.unresolvedAnchorReferenceCount, 0);
});

test('assigns each Phrase Identity one lane-independent Kinetic Form from its measured contour', () => {
  const score = directSong(measuredAnalysis());
  const exact = score.phraseIdentities.find((identity) => (
    identity.occurrences.flatMap((occurrence) => occurrence.sourcePhraseIds).includes('P01')
  ));
  const allowedVerbs = new Set([
    'hold', 'drift', 'bend', 'reverse', 'open', 'close',
    'fork', 'converge', 'strike', 'rest', 'release',
  ]);

  assert.equal(exact?.kineticForm.motion.kind, 'rising');
  assert.equal(exact?.kineticForm.pressureContour.length, 5);
  assert.ok(exact?.kineticForm.verbs.length > 0);
  assert.ok(exact?.kineticForm.verbs.every((verb) => allowedVerbs.has(verb)));
  assert.equal(exact?.kineticForm.development, 'locked');
  assert.ok(score.phraseIdentities.every((identity) => identity.kineticForm.version === 'continuous-kinetic-form-v1'));
});

test('does not treat uniformly high song polyphony as a branch cue in every phrase', () => {
  const score = directSong(replacePitchProfile(measuredAnalysis(), () => 3));

  assert.ok(score.phraseIdentities.length > 1);
  assert.ok(score.phraseIdentities.every((identity) => (
    identity.kineticForm.branchMode === 'single-route'
  )));
});

test('uses a locally salient and well-supported polyphony peak as a branch cue', () => {
  const analysis = replacePitchProfile(measuredAnalysis(), (timeSeconds) => (
    (timeSeconds < 8 || (timeSeconds >= 16 && timeSeconds < 24)) ? 4 : 1
  ));

  const first = directSong(analysis);
  const second = directSong(analysis);
  const repeated = first.phraseIdentities.find((identity) => (
    identity.occurrences.flatMap((occurrence) => occurrence.sourcePhraseIds).includes('P01')
  ));

  assert.deepEqual(first, second);
  assert.equal(repeated?.kineticForm.branchMode, 'fork-converge');
  assert.ok(repeated?.kineticForm.verbs.includes('fork'));
  assert.ok(repeated?.kineticForm.verbs.includes('converge'));
});

test('keeps sparse polyphony evidence on a single route', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources.find((source) => source.id === 'basic-pitch').events = [
    { timeSeconds: 1, confidence: 1, midiPitch: 60, polyphony: 6 },
    { timeSeconds: 3, confidence: 1, midiPitch: 64, polyphony: 6 },
    { timeSeconds: 17, confidence: 1, midiPitch: 60, polyphony: 6 },
    { timeSeconds: 19, confidence: 1, midiPitch: 64, polyphony: 6 },
  ];

  const score = directSong(analysis);
  const repeated = score.phraseIdentities.find((identity) => (
    identity.occurrences.flatMap((occurrence) => occurrence.sourcePhraseIds).includes('P01')
  ));

  assert.equal(repeated?.kineticForm.branchMode, 'single-route');
});

test('promotes the strongest supported in-song contrast even when its absolute dynamics are moderate', () => {
  const analysis = measuredAnalysis();
  analysis.musicalStructure.sections[1].intensity = 0.55;
  analysis.musicalStructure.sections[1].harmonicNovelty = 0;
  analysis.musicalStructure.sections[1].boundarySupport = 0.85;
  const score = directSong(analysis);
  const turnAnchor = score.anchors.find((anchor) => anchor.timeSeconds === 8);
  const turnMoment = score.moments.find((moment) => moment.anchorId === turnAnchor?.id);

  assert.equal(turnMoment?.commitment, 'must');
  assert.equal(turnMoment?.narrativeTurn, true);
  assert.ok(score.colorScenes.some((scene) => scene.anchorId === turnAnchor?.id));
});

test('reports exact-repeat agreement even when that Phrase Identity also has a developed occurrence', () => {
  const analysis = measuredAnalysis();
  analysis.musicalStructure.overlappingPhrases = [];
  analysis.musicalStructure.overlappingPhraseFamilies = [];
  analysis.musicalStructure.phraseLinks = [
    { sourcePhraseId: 'P01', targetPhraseId: 'P03', relationship: 'same-family', similarity: 0.94 },
    { sourcePhraseId: 'P03', targetPhraseId: 'P04', relationship: 'related-variant', similarity: 0.84 },
  ];
  const score = directSong(analysis);

  assert.ok(score.phraseIdentities.some((identity) => identity.relation === 'developed'));
  assert.equal(score.diagnostics.repetitionAgreement, 0.94);
});

test('degrades incomplete detector output to an explicit empty score instead of inventing evidence', () => {
  const score = directSong({
    song: { durationSeconds: 8 },
    eventSources: [{ id: 'beat-this', events: [{ timeSeconds: 'unknown' }] }],
    musicalStructure: {
      sections: [{ id: 'broken', startSeconds: 5, endSeconds: 2 }],
      phrases: [],
    },
  });

  assert.deepEqual(score.anchors, []);
  assert.deepEqual(score.scenes, []);
  assert.deepEqual(score.phraseIdentities, []);
  assert.deepEqual(score.moments, []);
  assert.ok(score.diagnostics.warnings.includes('missing-audio-fingerprint'));
  assert.ok(score.diagnostics.warnings.includes('missing-musical-anchors'));
  assert.ok(score.diagnostics.warnings.includes('missing-musical-scenes'));
  assert.ok(score.diagnostics.warnings.includes('missing-phrase-evidence'));
});

test('uses Visual Accents for reinforced strong anchors without pulsing every ordinary downbeat', () => {
  const analysis = measuredAnalysis();
  analysis.musicalStructure.overlappingPhrases = [];
  analysis.musicalStructure.overlappingPhraseFamilies = [];
  analysis.musicalStructure.phraseLinks = analysis.musicalStructure.phraseLinks
    .filter((link) => !link.sourcePhraseId.startsWith('O'));
  const score = directSong(analysis);
  const anchorAt = (timeSeconds) => score.anchors.find((anchor) => anchor.timeSeconds === timeSeconds);
  const plainDownbeat = anchorAt(4);
  const onsetReinforcedDownbeat = anchorAt(12);

  assert.ok(score.visualAccents.some((accent) => accent.anchorId === onsetReinforcedDownbeat?.id));
  assert.ok(score.visualAccents.every((accent) => accent.anchorId !== plainDownbeat?.id));
});

test('keeps reinforced Visual Accents sparse enough to remain perceptible', () => {
  const analysis = measuredAnalysis();
  analysis.eventSources.find((source) => source.id === 'librosa-onset').events = Array.from(
    { length: 30 },
    (_, index) => ({ timeSeconds: index + 0.01, confidence: 1 }),
  );
  analysis.eventSources.find((source) => source.id === 'beat-this').events.forEach((event) => {
    event.isDownbeat = true;
  });
  analysis.musicalStructure.beats.forEach((event) => {
    event.isDownbeat = true;
  });
  const score = directSong(analysis);
  const minimumSpacingSeconds = Math.max(1.5, 60 / analysis.song.bpm * 2.5);

  assert.ok(score.visualAccents.length > 1);
  assert.ok(score.visualAccents.slice(1).every((accent, index) => (
    accent.timeSeconds - score.visualAccents[index].timeSeconds >= minimumSpacingSeconds
  )));
});
