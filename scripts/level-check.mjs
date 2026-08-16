import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const requestedLevelPath = process.argv[2];
if (!requestedLevelPath) {
  const levelDirectory = resolve(root, 'src/levels');
  const levelFiles = (await readdir(levelDirectory))
    .filter((name) => name.endsWith('.level.json'))
    .sort();
  assert.ok(levelFiles.length > 0, 'No generated levels were found.');
  for (const levelFile of levelFiles) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), resolve(levelDirectory, levelFile)],
      { cwd: root, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const selectableLevels = await Promise.all(levelFiles.map(async (levelFile) => (
    JSON.parse(await readFile(resolve(levelDirectory, levelFile), 'utf8'))
  )));
  for (let leftIndex = 0; leftIndex < selectableLevels.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selectableLevels.length; rightIndex += 1) {
      const left = selectableLevels[leftIndex];
      const right = selectableLevels[rightIndex];
      if (left.generation.layoutIntentProfile.audioFingerprint === right.generation.layoutIntentProfile.audioFingerprint) continue;
      const layoutSignature = (candidate) => candidate.generation.familyTemplates
        .map((template) => `${template.transformId}:${template.motifPlan.join('/')}:${template.coreRowSignature}`)
        .join('|');
      assert.notEqual(
        layoutSignature(left),
        layoutSignature(right),
        `${left.song.title} and ${right.song.title} unexpectedly share an identical complete layout.`,
      );
      const rowCounts = (candidate) => {
        const counts = new Map();
        for (const event of candidate.events.filter((entry) => entry.layer === 'core')) {
          const row = event.obstacles.join('');
          counts.set(row, (counts.get(row) ?? 0) + 1);
        }
        return counts;
      };
      const leftRows = rowCounts(left);
      const rightRows = rowCounts(right);
      const rowKeys = new Set([...leftRows.keys(), ...rightRows.keys()]);
      let sharedWeight = 0;
      let totalWeight = 0;
      for (const row of rowKeys) {
        sharedWeight += Math.min(leftRows.get(row) ?? 0, rightRows.get(row) ?? 0);
        totalWeight += Math.max(leftRows.get(row) ?? 0, rightRows.get(row) ?? 0);
      }
      const weightedJaccard = sharedWeight / Math.max(1, totalWeight);
      assert.ok(
        weightedJaccard < 0.72,
        `${left.song.title} and ${right.song.title} are too layout-similar (${weightedJaccard.toFixed(3)}).`,
      );
    }
  }
  console.log(`Validated ${levelFiles.length} selectable songs.`);
  process.exit(0);
}

const levelPath = resolve(root, requestedLevelPath);
const level = JSON.parse(await readFile(levelPath, 'utf8'));

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

function signatureForPhrase(phraseId, includeOverlay = false) {
  return level.events
    .filter((event) => event.phraseId === phraseId && (includeOverlay || event.layer !== 'overlay'))
    .map((event) => `${event.relativeSlotKey}:${event.kind}:${event.obstacles.join('')}`);
}

assert.equal(level.version, 3);
assert.equal(level.generation.difficulty, 'flow');
assert.equal(level.generation.layoutAlgorithm, 'music-responsive-template-v5');
assert.match(level.generation.musicalStructureAlgorithm, /beat-this.*librosa.*agglomerative/i);
assert.ok(['melodic-drive', 'percussive-drive', 'rhythmic-drive', 'balanced-flow'].includes(
  level.generation.layoutIntentProfile.songProfile.dominantStyle,
));
assert.ok(typeof level.generation.layoutIntentProfile.audioFingerprint === 'string');
assert.equal(level.generation.layoutIntentProfile.algorithm, 'music-description-to-layout-intent-v1');
const intentSections = level.generation.layoutIntentProfile.sections;
const validSectionRoles = new Set(['intro', 'build', 'drive', 'peak', 'break', 'release', 'outro']);
assert.ok(Array.isArray(intentSections) && intentSections.length > 0);
assert.ok(intentSections.every((section, index) => (
  validSectionRoles.has(section.role)
  && section.pressure >= 0
  && section.pressure <= 1
  && (index === 0 || section.startSeconds >= intentSections[index - 1].startSeconds)
)));
assert.ok(intentSections.some((section) => section.role === 'peak'), 'The song arc has no detected peak section.');
if (level.song.durationSeconds >= 60) {
  assert.ok(new Set(intentSections.map((section) => section.role)).size >= 3, 'The song arc has too little role variety.');
}
const sectionPressures = intentSections.map((section) => section.pressure).sort((left, right) => left - right);
const pressure80 = sectionPressures[Math.floor((sectionPressures.length - 1) * 0.8)];
assert.ok(intentSections.some((section) => section.role === 'peak' && section.pressure >= pressure80));
assert.equal('ticksPerBeat' in level, false, 'The level must not contain a tick grid.');
assert.equal('beatOffsetSeconds' in level.song, false, 'The song must not contain a beat offset.');
assert.ok(level.song.audioUrl.toLowerCase().endsWith('.mp3'), 'Game audio must be MP3.');
assert.ok(Number.isFinite(level.song.bpm) && level.song.bpm > 0);
assert.ok(Number.isFinite(level.song.durationSeconds) && level.song.durationSeconds > 0);

const audioPath = resolve(root, 'public', level.song.audioUrl.replace(/^\//, ''));
await access(audioPath);
const audioStats = await stat(audioPath);
const compression = level.generation.audioCompression;
if (compression) {
  assert.equal(compression.format, 'MP3');
  assert.equal(compression.codec, 'MPEG Layer III');
  assert.ok(['variable', 'existing'].includes(compression.bitrateMode));
  assert.equal(compression.compressedBytes, audioStats.size);
  assert.ok(compression.sourceBytes > 0 && compression.compressedBytes > 0);
}

const travelSeconds = level.generation.minTravelSecondsPerLane;
let previousTime = 0;
let survivalLanes = new Set([2]);
let comboLanes = new Set([2]);
let targetCount = 0;
let dodgeCount = 0;
let spikeCount = 0;
let guidanceRowCount = 0;
const targetLanes = [];
const coreTargetLanes = [];

assert.ok(level.events.length > 0, 'The generated level is empty.');
for (let eventIndex = 0; eventIndex < level.events.length; eventIndex += 1) {
  const event = level.events[eventIndex];
  const label = `event ${eventIndex}`;
  assert.ok(event.timeSeconds > previousTime, `${label} is not ordered.`);
  assert.ok(event.timeSeconds <= level.song.durationSeconds, `${label} is outside the song.`);
  assert.equal(event.obstacles.length, 5);
  assert.ok(event.obstacles.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 2));
  assert.ok(event.obstacles.some((cell) => cell !== 0), `${label} is an empty stored row.`);
  assert.ok(event.flow >= 0 && event.flow <= 1, `${label} has invalid flow.`);
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
    assert.equal(targets, 1, `${label} must contain exactly one target.`);
    targetLanes.push(event.obstacles.indexOf(1));
    if (event.layer === 'core') coreTargetLanes.push(event.obstacles.indexOf(1));
    targetCount += 1;
  } else {
    assert.equal(event.kind, 'dodge', `${label} has an unsupported kind.`);
    assert.equal(targets, 0, `${label} dodge row cannot contain a target.`);
    assert.ok(rowSpikes > 0, `${label} dodge row must contain a hazard.`);
    dodgeCount += 1;
  }

  spikeCount += rowSpikes;
  if (rowSpikes) guidanceRowCount += 1;
  assertNoIsolatedMiddleGap(event.obstacles, label);
  survivalLanes = advanceReachableLanes(survivalLanes, event, previousTime, travelSeconds, false);
  comboLanes = advanceReachableLanes(comboLanes, event, previousTime, travelSeconds, true);
  assert.ok(survivalLanes.size > 0, `${label} has no survivable route.`);
  assert.ok(comboLanes.size > 0, `${label} breaks the full-combo route.`);
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
assert.ok(level.generation.barSections.every((section) => section.downbeatCue));
assert.ok(level.generation.familyTemplates.length > 0);
assert.ok(level.generation.motifCounts.m > 0, 'The chart lacks an M combo motif.');
assert.ok(Object.keys(level.generation.motifCounts).length >= 5, 'The chart uses too few route motif families.');
assert.ok(level.generation.familyTemplates.every((template) => (
  Array.isArray(template.motifPlan)
  && template.motifPlan.length > 0
  && Array.isArray(template.barProfiles)
  && template.barProfiles.length === template.motifPlan.length
  && ['identity', 'mirror'].includes(template.preferredTransform)
  && ['rising', 'falling', 'oscillating', 'steady', 'unknown'].includes(template.contour?.kind)
  && template.contour.confidence >= 0
  && template.contour.confidence <= 1
  && Array.isArray(template.motifBias)
  && template.motifBias.length > 0
)));
const pitchedTemplates = level.generation.familyTemplates.filter((template) => template.contour.confidence >= 0.45);
assert.ok(pitchedTemplates.length > 0, 'No family template uses a reliable Basic Pitch contour.');
for (const template of pitchedTemplates) {
  if (template.contour.kind === 'rising') assert.equal(template.preferredTransform, 'identity');
  if (template.contour.kind === 'falling') assert.equal(template.preferredTransform, 'mirror');
}

const pressureSections = level.generation.flowSections.filter((section) => section.eventCount > 0);
const orderedPressures = pressureSections.map((section) => section.pressure).sort((left, right) => left - right);
const lowPressure = orderedPressures[Math.floor((orderedPressures.length - 1) * 0.25)];
const highPressure = orderedPressures[Math.floor((orderedPressures.length - 1) * 0.75)];
const lowSections = pressureSections.filter((section) => section.pressure <= lowPressure);
const highSections = pressureSections.filter((section) => section.pressure >= highPressure);
const spikesPerEvent = (sections) => sections.reduce((sum, section) => sum + section.spikeCount, 0)
  / Math.max(1, sections.reduce((sum, section) => sum + section.eventCount, 0));
const lowSpikeRate = spikesPerEvent(lowSections);
const highSpikeRate = spikesPerEvent(highSections);
assert.ok(
  highSpikeRate >= lowSpikeRate * 1.2 || highSpikeRate >= lowSpikeRate + 0.25,
  `High-pressure sections are not harder than low-pressure sections (${highSpikeRate.toFixed(2)} vs ${lowSpikeRate.toFixed(2)} spikes/event).`,
);

const laneCounts = Array.from({ length: 5 }, (_, lane) => targetLanes.filter((value) => value === lane).length);
const centerLaneRatio = laneCounts[2] / Math.max(1, targetLanes.length);
const edgeLaneRatio = (laneCounts[0] + laneCounts[4]) / Math.max(1, targetLanes.length);
const representedLaneCount = laneCounts.filter((count) => count / Math.max(1, targetLanes.length) >= 0.02).length;
const stationaryRatio = coreTargetLanes.slice(1).filter((lane, index) => lane === coreTargetLanes[index]).length
  / Math.max(1, coreTargetLanes.length - 1);
assert.ok(centerLaneRatio <= 0.68, `The chart is too center-heavy (${(centerLaneRatio * 100).toFixed(1)}%).`);
assert.ok(edgeLaneRatio >= 0.05, `The chart barely uses the edge lanes (${(edgeLaneRatio * 100).toFixed(1)}%).`);
assert.ok(representedLaneCount >= 4, 'The chart does not make meaningful use of at least four lanes.');
assert.ok(stationaryRatio <= 0.58, `The core route is too static (${(stationaryRatio * 100).toFixed(1)}%).`);

for (const group of level.generation.repeatConsistency.groups) {
  const signatures = group.phraseIds.map((phraseId) => signatureForPhrase(phraseId));
  for (const signature of signatures.slice(1)) {
    assert.deepEqual(signature, signatures[0], `${group.familyId} changed across repeated phrases.`);
  }
}
assert.equal(level.generation.repeatConsistency.exactRatio, 1);
for (const link of level.generation.repeatConsistency.appliedRangeLinks) {
  assert.match(link.id, /^analysis-overlap-/, 'A non-analysis structural reuse leaked into the chart.');
  assert.ok(link.similarity >= 0.88, `${link.id} did not pass the exact-repeat threshold.`);
}

const standardMSections = level.generation.flowSections.filter((section) => (
  section.motif === 'm' && section.variant === 'standard'
));
if (standardMSections.length) {
  assert.ok(standardMSections.some((section) => (
    section.templateRows.join(',') === '22200,00000,10000,10000,00000,22200'
    || section.templateRows.join(',') === '00222,00000,00001,00001,00000,00222'
  )), 'The standard M pocket is malformed.');
}

for (const section of level.generation.flowSections.filter((item) => item.motif === 'c')) {
  const sectionIndex = level.generation.flowSections.indexOf(section);
  const rows = level.events.filter((event) => event.section === sectionIndex);
  const leftEdgeSafe = rows.every((event) => event.obstacles[0] !== 2);
  const rightEdgeSafe = rows.every((event) => event.obstacles[4] !== 2);
  assert.ok(leftEdgeSafe || rightEdgeSafe, 'A C motif lost its edge-camping survival route.');
}

console.log(
  `Validated ${level.id}: ${targetCount} targets, ${dodgeCount} dodge gates, `
  + `${spikeCount} spikes, MP3 ${(audioStats.size / 1_048_576).toFixed(2)} MiB.`,
);
