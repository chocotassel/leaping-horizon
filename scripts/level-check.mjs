import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const collection = JSON.parse(await readFile(new URL('../src/levels/slice-at-two.levels.json', import.meta.url)));
const rhythmAnalysis = JSON.parse(await readFile(new URL('../public/analysis/slice-at-two.rhythm-analysis.json', import.meta.url)));
assert.equal(collection.kind, 'rhythm-level-collection');
assert.equal(collection.schemaVersion, 2);
assert.equal(collection.primaryDifficulty, 'flow');
assert.deepEqual(Object.keys(collection.levels), ['flow']);
assert.ok(collection.levels.flow[collection.primaryTrackId]);

const musicalStructure = rhythmAnalysis.musicalStructure;
assert.ok(musicalStructure?.analysis?.available, 'Musical structure analysis is unavailable.');
assert.match(musicalStructure.algorithm, /beat-this.*librosa.*agglomerative/i);
assert.equal(musicalStructure.beats.length, 318);
assert.equal(musicalStructure.downbeats.length, 80);
assert.equal(musicalStructure.bars.length, 80);
assert.ok(musicalStructure.sections.length >= 8, 'The song is still under-segmented.');
assert.ok(
  Math.max(...musicalStructure.sections.map((section) => section.barCount)) <= 16,
  'A musical structure section spans more than 16 bars.',
);
assert.ok(musicalStructure.phrases.length >= 10);
assert.ok(musicalStructure.families.some((family) => family.occurrenceCount > 1));

const downbeatTimes = musicalStructure.downbeats.map((downbeat) => downbeat.timeSeconds);
const nearestDownbeatError = (timeSeconds) => Math.min(...downbeatTimes.map((downbeat) => Math.abs(downbeat - timeSeconds)));

function eventsInRange(level, startSeconds, endSeconds, layer = 'core') {
  return level.events.filter((event) => (
    (layer === 'ordinary' ? event.layer !== 'overlay' : event.layer === layer)
    && event.timeSeconds >= startSeconds - 0.08
    && event.timeSeconds < endSeconds - 0.08
  ));
}

function rowSequence(events) {
  return events.map((event) => `${event.kind}:${event.obstacles.join('')}`);
}

function assertSameSequence(left, right, label) {
  assert.deepEqual(rowSequence(left), rowSequence(right), label);
}

function maximumLaneSteps(deltaSeconds, travelSeconds) {
  return Math.min(4, Math.max(0, Math.floor((deltaSeconds + 1e-6) / travelSeconds)));
}

function advanceReachableLanes(reachable, event, previousTime, travelSeconds, requireCombo) {
  const maximumSteps = maximumLaneSteps(event.timeSeconds - previousTime, travelSeconds);
  const targets = event.obstacles.flatMap((cell, lane) => cell === 1 ? [lane] : []);
  const allowed = requireCombo && targets.length
    ? targets
    : event.obstacles.flatMap((cell, lane) => cell !== 2 ? [lane] : []);
  return new Set(allowed.filter((lane) => [...reachable].some((previousLane) => (
    Math.abs(lane - previousLane) <= maximumSteps
  ))));
}

function assertNoIsolatedMiddleGap(row, label) {
  let runStart = null;
  for (let lane = 0; lane <= row.length; lane += 1) {
    const safe = lane < row.length && row[lane] !== 2;
    if (safe && runStart === null) runStart = lane;
    if (!safe && runStart !== null) {
      const runEnd = lane - 1;
      const runLength = runEnd - runStart + 1;
      const touchesEdge = runStart === 0 || runEnd === 4;
      assert.ok(runLength >= 2 || touchesEdge, `${label} contains an isolated middle-lane gap.`);
      runStart = null;
    }
  }
}

function windowStats(level, startSeconds, endSeconds) {
  const events = level.events.filter((event) => (
    event.timeSeconds >= startSeconds && event.timeSeconds <= endSeconds
  ));
  const duration = Math.max(1e-6, endSeconds - startSeconds);
  const notes = events.filter((event) => event.obstacles.includes(1)).length;
  const spikes = events.reduce((sum, event) => (
    sum + event.obstacles.filter((cell) => cell === 2).length
  ), 0);
  return { events, notes, spikes, noteRate: notes / duration, spikeRate: spikes / duration };
}

let checkedLevels = 0;
for (const [trackId, level] of Object.entries(collection.levels.flow)) {
  const label = `${trackId}/flow`;
  assert.equal(level.version, 3);
  assert.equal(level.generation.difficulty, 'flow');
  assert.equal(level.generation.layoutAlgorithm, 'music-structure-template-v3');
  assert.match(level.generation.musicalStructureAlgorithm, /beat-this.*librosa.*agglomerative/i);
  assert.equal('ticksPerBeat' in level, false, `${label} must not contain a tick grid.`);
  assert.equal('beatOffsetSeconds' in level.song, false, `${label} must not contain a beat offset.`);
  await access(new URL(`../public${level.song.audioUrl}`, import.meta.url));

  const travelSeconds = level.generation.minTravelSecondsPerLane;
  let previousTime = 0;
  let survivalLanes = new Set([2]);
  let comboLanes = new Set([2]);
  let targetCount = 0;
  let dodgeCount = 0;
  let spikeCount = 0;
  let guidanceRowCount = 0;

  for (let eventIndex = 0; eventIndex < level.events.length; eventIndex += 1) {
    const event = level.events[eventIndex];
    const eventLabel = `${label} event ${eventIndex}`;
    assert.ok(event.timeSeconds > previousTime, `${eventLabel} is not ordered.`);
    assert.ok(event.timeSeconds <= level.song.durationSeconds);
    assert.equal(event.obstacles.length, 5);
    assert.ok(event.obstacles.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 2));
    assert.ok(event.obstacles.some((cell) => cell !== 0), `${eventLabel} is an empty stored row.`);
    assert.ok(event.flow >= 0 && event.flow <= 1, `${eventLabel} has invalid flow.`);
    assert.ok(typeof event.pattern === 'string' && event.pattern.length > 0);
    assert.ok(typeof event.role === 'string' && event.role.length > 0);
    assert.ok(Number.isInteger(event.section) && level.generation.flowSections[event.section]);
    assert.ok(typeof event.phraseId === 'string' && event.phraseId.length > 0);
    assert.ok(typeof event.familyId === 'string' && event.familyId.length > 0);
    assert.ok(typeof event.templateId === 'string' && event.templateId.length > 0);
    assert.ok(typeof event.relativeSlotKey === 'string' && event.relativeSlotKey.length > 0);
    assert.ok(['core', 'auxiliary-common', 'overlay'].includes(event.layer));
    assert.ok(Number.isInteger(event.barIndex) && event.barIndex >= 0);
    assert.ok(Number.isInteger(event.barInPhrase) && event.barInPhrase >= 0);
    assert.equal(typeof event.downbeatCue, 'boolean');
    assert.ok(Number.isInteger(event.barModule) && level.generation.barSections[event.barModule]);

    const targets = event.obstacles.filter((cell) => cell === 1).length;
    const rowSpikes = event.obstacles.filter((cell) => cell === 2).length;
    if (event.kind === 'target') {
      assert.equal(targets, 1, `${eventLabel} must contain exactly one combo target.`);
      targetCount += 1;
    } else {
      assert.equal(event.kind, 'dodge', `${eventLabel} has an unsupported kind.`);
      assert.equal(targets, 0, `${eventLabel} dodge row cannot contain a target.`);
      assert.ok(rowSpikes > 0, `${eventLabel} dodge row must contain a hazard.`);
      dodgeCount += 1;
    }

    spikeCount += rowSpikes;
    if (rowSpikes) guidanceRowCount += 1;
    assertNoIsolatedMiddleGap(event.obstacles, eventLabel);

    survivalLanes = advanceReachableLanes(survivalLanes, event, previousTime, travelSeconds, false);
    comboLanes = advanceReachableLanes(comboLanes, event, previousTime, travelSeconds, true);
    assert.ok(survivalLanes.size > 0, `${eventLabel} has no survivable route.`);
    assert.ok(comboLanes.size > 0, `${eventLabel} breaks the full-combo route.`);
    previousTime = event.timeSeconds;
  }

  assert.equal(level.generation.noteCount, targetCount);
  assert.equal(level.generation.eventCount, level.events.length);
  assert.equal(level.generation.dodgeCount, dodgeCount);
  assert.equal(level.generation.spikeCount, spikeCount);
  assert.equal(level.generation.guidanceRowCount, guidanceRowCount);
  assert.equal(level.generation.flowSections.reduce((sum, section) => sum + section.eventCount, 0), level.events.length);
  assert.equal(level.generation.phraseSections.reduce((sum, section) => sum + section.eventCount, 0), level.events.length);
  assert.equal(level.generation.barSections.reduce((sum, section) => sum + section.eventCount, 0), level.events.length);
  assert.ok(level.generation.barSections.every((section) => section.downbeatCue), `${label} has an unmarked bar cue.`);
  assert.ok(level.generation.familyTemplates.length > 0);
  assert.equal(level.generation.repeatConsistency.exactRatio, 1, `${label} changed a repeated core template.`);

  for (const phrase of level.generation.phraseSections) {
    assert.ok(nearestDownbeatError(phrase.startSeconds) <= 0.001, `${label}/${phrase.phraseId} is not downbeat-aligned.`);
    assert.ok(Number.isInteger(phrase.barCount) && phrase.barCount > 0);
    assert.ok(phrase.coreEventCount > 0);
  }

  for (const group of level.generation.repeatConsistency.groups) {
    const signatures = group.phraseIds.map((phraseId) => level.events
      .filter((event) => event.phraseId === phraseId && event.layer === 'core')
      .map((event) => `${event.relativeSlotKey}:${event.kind}:${event.obstacles.join('')}`));
    for (const signature of signatures.slice(1)) {
      assert.deepEqual(signature, signatures[0], `${label}/${group.familyId} core rows are not identical.`);
    }
    const completeSignatures = group.phraseIds.map((phraseId) => level.events
      .filter((event) => event.phraseId === phraseId && event.layer !== 'overlay')
      .map((event) => `${event.relativeSlotKey}:${event.kind}:${event.obstacles.join('')}`));
    for (const signature of completeSignatures.slice(1)) {
      assert.deepEqual(
        signature,
        completeSignatures[0],
        `${label}/${group.familyId} common melody rows are not identical.`,
      );
    }
  }
  assert.ok(Object.keys(level.generation.motifCounts).length >= 3, `${label} lacks motif variety.`);

  const introEvents = level.events.filter((event) => event.timeSeconds < 13);
  assert.ok(introEvents.length > 0);
  assert.ok(introEvents.every((event) => event.pattern.startsWith('focus')));
  assert.ok(introEvents.every((event) => event.obstacles.every((cell) => cell !== 2)));
  checkedLevels += 1;
}

const primary = collection.levels.flow[collection.primaryTrackId];
assert.ok(primary.generation.noteCount >= 314, 'The primary chart must preserve or exceed the original block count.');
assert.ok(primary.generation.eventCount >= 420, 'The primary chart must preserve the previous playable density.');
assert.ok(primary.generation.eventCount > primary.generation.noteCount, 'The chart must include pure dodge rows.');
assert.ok(primary.generation.spikeCount >= 600, 'The primary chart does not contain enough route guidance.');
assert.ok(primary.generation.auxiliaryNoteCount >= 100, 'The primary chart lacks real melodic subdivisions.');
assert.ok(primary.generation.maximumMelodyRun >= 4, 'The primary chart lacks a four-note melody run.');
assert.ok(primary.generation.motifCounts.c > 0, 'The primary chart must contain a C motif.');
assert.ok(primary.generation.motifCounts.s > 0, 'The primary chart must contain an S motif.');
assert.ok(primary.generation.motifCounts.m > 0, 'The primary chart must contain an M motif.');
assert.equal(primary.generation.phraseSections.length, 10, 'The primary chart must compile ten eight-bar phrase units.');
assert.equal(primary.generation.barSections.length, 79, 'The playable chart must expose every non-empty bar module.');
assert.equal(primary.generation.repeatConsistency.repeatedFamilyGroupCount, 2);
assert.equal(primary.generation.repeatConsistency.exactGroupCount, 2);
assert.equal(primary.generation.repeatConsistency.exactRatio, 1);
const repeatedTemplates = primary.generation.familyTemplates.filter((template) => template.occurrenceCount > 1);
assert.ok(repeatedTemplates.length >= 2);
assert.equal(
  new Set(repeatedTemplates.map((template) => template.coreRowSignature)).size,
  repeatedTemplates.length,
  'Different repeated phrase families collapsed to the same obstacle sentence.',
);

const exactOverlapFamily = musicalStructure.overlappingPhraseFamilies.find((family) => {
  const starts = family.phraseIds.map((phraseId) => (
    musicalStructure.overlappingPhrases.find((phrase) => phrase.id === phraseId)?.startSeconds
  ));
  return [42.44, 92.06, 133.34].every((expected) => starts.some((actual) => Math.abs(actual - expected) < 0.02));
});
assert.ok(exactOverlapFamily, 'The three verified melody returns are not in one exact structure family.');
assert.ok(exactOverlapFamily.confidence >= 0.88);

assertSameSequence(
  eventsInRange(primary, 34.16, 67.26),
  eventsInRange(primary, 83.8, 116.84),
  'The repeated 16-bar passage must reuse the same core obstacles.',
);
assertSameSequence(
  eventsInRange(primary, 42.44, 58.98),
  eventsInRange(primary, 92.06, 108.58),
  'The second occurrence of the repeated melody changed its core obstacles.',
);
assertSameSequence(
  eventsInRange(primary, 42.44, 58.98),
  eventsInRange(primary, 133.34, 149.82),
  'The third occurrence of the repeated melody changed its core obstacles.',
);
assertSameSequence(
  eventsInRange(primary, 42.44, 58.98, 'ordinary'),
  eventsInRange(primary, 92.06, 108.58, 'ordinary'),
  'The second occurrence changed a shared melodic subdivision or obstacle row.',
);
assertSameSequence(
  eventsInRange(primary, 42.44, 58.98, 'ordinary'),
  eventsInRange(primary, 133.34, 149.82, 'ordinary'),
  'The third occurrence changed a shared melodic subdivision or obstacle row.',
);

const targetEvents = primary.events.filter((event) => event.kind === 'target');
const targetGaps = targetEvents.slice(1).map((event, index) => event.timeSeconds - targetEvents[index].timeSeconds);
assert.ok(targetGaps.filter((gap) => gap < 0.23).length >= 40, 'The chart lacks close melody notes.');
assert.ok(targetGaps.filter((gap) => gap >= 0.23 && gap < 0.4).length >= 60, 'The chart lacks medium note spacing.');
assert.ok(targetGaps.filter((gap) => gap >= 0.4 && gap < 0.58).length >= 100, 'The chart lost its Beat This skeleton.');

const standardMSections = primary.generation.flowSections.filter((section) => (
  section.motif === 'm' && section.variant === 'standard'
));
assert.ok(standardMSections.length > 0, 'The chart must teach at least one exact M pocket.');
assert.ok(
  standardMSections.some((section) => section.templateRows.join(',') === '22200,00000,10000,10000,00000,22200'),
  'The chart must contain the requested left-pocket M shape.',
);
for (const section of standardMSections) {
  assert.equal(section.slotTimes.length, 6);
  assert.equal(section.templateRows.length, 6);
  for (let slot = 0; slot < section.slotTimes.length; slot += 1) {
    const expected = section.templateRows[slot];
    const matching = primary.events.filter((event) => (
      event.section === primary.generation.flowSections.indexOf(section)
      && Math.abs(event.timeSeconds - section.slotTimes[slot]) < 1e-5
    ));
    if (expected === '00000') {
      assert.equal(matching.length, 0, 'An exact M travel slot must stay empty.');
    } else {
      assert.equal(matching.length, 1, 'An exact M anchor row is missing.');
      assert.equal(matching[0].obstacles.join(''), expected, 'An exact M anchor row was changed.');
    }
  }
}

const climaxTime = primary.generation.climaxTimeSeconds;
const climaxSection = primary.generation.flowSections.find((section) => (
  climaxTime >= section.startSeconds && climaxTime <= section.endSeconds
));
assert.equal(climaxSection?.motif, 'm', 'The sustained-energy climax must sit inside an M pocket.');
assert.equal(climaxSection?.variant, 'melodic', 'The climax M must accept real melody subdivisions.');
const intro = windowStats(primary, 1.2, 13);
const climax = windowStats(primary, climaxTime - 4, climaxTime + 6);
assert.ok(
  climax.noteRate >= intro.noteRate + 0.15,
  'The climax block density must be meaningfully higher than the intro.',
);
assert.ok(climax.spikeRate >= 4, 'The climax must sustain dense route pressure.');

const cSections = primary.generation.flowSections.filter((section) => section.motif === 'c');
for (const section of cSections) {
  const sectionIndex = primary.generation.flowSections.indexOf(section);
  const rows = primary.events.filter((event) => event.section === sectionIndex);
  const leftEdgeSafe = rows.every((event) => event.obstacles[0] !== 2);
  const rightEdgeSafe = rows.every((event) => event.obstacles[4] !== 2);
  assert.ok(leftEdgeSafe || rightEdgeSafe, 'Every C motif must preserve one edge-camping survival route.');
}

console.log(
  `Validated ${checkedLevels} single-flow levels; primary=${primary.generation.noteCount} targets, `
  + `${primary.generation.dodgeCount} dodge gates, ${primary.generation.spikeCount} spikes.`,
);
