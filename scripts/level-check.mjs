import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeEdgeSweepWindow,
  analyzeRouteGraph,
  findLiteralMGestures,
} from './rhythm/route-analysis.mjs';

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

function signatureForPhrase(phraseId) {
  return level.events
    .filter((event) => event.phraseId === phraseId)
    .map((event) => `${event.relativeSlotKey}:${event.kind}:${event.obstacles.join('')}`);
}

assert.equal(level.version, 3);
assert.equal(level.generation.difficulty, 'flow');
assert.equal(level.generation.layoutAlgorithm, 'music-responsive-choice-template-v6');
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
let choiceRowCount = 0;
let targetCellCount = 0;
let multiTargetChoiceRowCount = 0;
let currentMultiTargetRun = 0;
let maximumConsecutiveMultiTargetRows = 0;
let dodgeCount = 0;
let spikeCount = 0;
let guidanceRowCount = 0;
const targetLaneWeights = Array(5).fill(0);

assert.ok(level.events.length > 0, 'The generated level is empty.');
for (let eventIndex = 0; eventIndex < level.events.length; eventIndex += 1) {
  const event = level.events[eventIndex];
  const label = `event ${eventIndex}`;
  assert.ok(event.timeSeconds > previousTime, `${label} is not ordered.`);
  assert.ok(event.timeSeconds <= level.song.durationSeconds, `${label} is outside the song.`);
  assert.equal(event.obstacles.length, 5);
  assert.equal('_routeLane' in event, false, `${label} leaks a preferred route.`);
  assert.equal('_preferredLane' in event, false, `${label} leaks a preferred lane.`);
  assert.equal('_allowedLanes' in event, false, `${label} leaks generator-only choices.`);
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
    assert.ok(targets >= 1, `${label} Choice Row has no Target Cell.`);
    assert.equal(event.choiceLaneCount, targets, `${label} has stale Choice Row metadata.`);
    assert.equal(event.routeBranch, targets > 1, `${label} has stale Route Branch metadata.`);
    for (let lane = 0; lane < event.obstacles.length; lane += 1) {
      if (event.obstacles[lane] === 1) targetLaneWeights[lane] += 1 / targets;
    }
    choiceRowCount += 1;
    targetCellCount += targets;
    if (targets > 1) {
      multiTargetChoiceRowCount += 1;
      currentMultiTargetRun += 1;
      maximumConsecutiveMultiTargetRows = Math.max(
        maximumConsecutiveMultiTargetRows,
        currentMultiTargetRun,
      );
    } else {
      currentMultiTargetRun = 0;
    }
  } else {
    assert.equal(event.kind, 'dodge', `${label} has an unsupported kind.`);
    assert.equal(targets, 0, `${label} dodge row cannot contain a target.`);
    assert.ok(rowSpikes > 0, `${label} dodge row must contain a hazard.`);
    dodgeCount += 1;
    currentMultiTargetRun = 0;
  }

  spikeCount += rowSpikes;
  if (rowSpikes) guidanceRowCount += 1;
  assertNoIsolatedMiddleGap(event.obstacles, label);
  previousTime = event.timeSeconds;
}

const survivalRoutes = analyzeRouteGraph(level.events, {
  secondsPerLane: travelSeconds,
  requireCombo: false,
});
const comboRoutes = analyzeRouteGraph(level.events, {
  secondsPerLane: travelSeconds,
  requireCombo: true,
});
assert.ok(survivalRoutes.feasible, 'The chart has no survivable route.');
assert.ok(comboRoutes.feasible, 'The chart has no full-combo route.');
assert.deepEqual(comboRoutes.deadChoiceCells, [], 'The chart displays Target Cells that cannot complete the song.');
const minimumChoiceBranches = Math.max(4, Math.ceil(choiceRowCount * 0.08));
assert.ok(
  comboRoutes.meaningfulChoiceRows.length >= minimumChoiceBranches,
  `The chart offers too few meaningful Choice Rows (${comboRoutes.meaningfulChoiceRows.length}/${minimumChoiceBranches}).`,
);
assert.ok(comboRoutes.pathCountCapped >= 32, 'The full-combo route graph has too few player decisions.');
assert.ok(
  comboRoutes.consecutiveChoicePairs.length >= Math.max(1, Math.floor(level.song.durationSeconds / 90)),
  'The chart lacks consecutive Route Branches.',
);
assert.ok(comboRoutes.maximumConsecutiveChoiceRows >= 2, 'No consecutive multi-choice sequence survived validation.');
assert.ok(
  comboRoutes.wideChoiceRowCount >= Math.max(1, Math.floor(comboRoutes.meaningfulChoiceRows.length * 0.2)),
  'The chart offers too few wide Route Branches.',
);

assert.equal(level.generation.noteCount, choiceRowCount);
assert.equal(level.generation.targetCellCount, targetCellCount);
assert.equal(level.generation.multiTargetChoiceRowCount, multiTargetChoiceRowCount);
assert.equal(level.generation.maximumConsecutiveMultiTargetRows, maximumConsecutiveMultiTargetRows);
assert.equal(level.generation.fullRouteBranchCount, comboRoutes.meaningfulChoiceRows.length);
assert.equal(level.generation.deadBranchTargetCellCount, comboRoutes.deadChoiceCells.length);
assert.equal(
  level.generation.maximumConsecutiveFullRouteBranches,
  comboRoutes.maximumConsecutiveChoiceRows,
);
assert.equal(level.generation.pathCountCapped, comboRoutes.pathCountCapped);
assert.equal(level.generation.consecutiveChoicePairCount, comboRoutes.consecutiveChoicePairs.length);
assert.equal(level.generation.wideChoiceRowCount, comboRoutes.wideChoiceRowCount);
assert.equal(level.generation.eventCount, level.events.length);
assert.equal(level.generation.dodgeCount, dodgeCount);
assert.equal(level.generation.spikeCount, spikeCount);
assert.equal(level.generation.guidanceRowCount, guidanceRowCount);
assert.equal(level.generation.flowSections.reduce((sum, section) => sum + section.eventCount, 0), level.events.length);
assert.equal(level.generation.flowSections.reduce((sum, section) => sum + section.noteCount, 0), choiceRowCount);
assert.equal(level.generation.flowSections.reduce((sum, section) => sum + section.targetCellCount, 0), targetCellCount);
assert.equal(level.generation.phraseSections.reduce((sum, section) => sum + section.eventCount, 0), level.events.length);
assert.equal(level.generation.barSections.reduce((sum, section) => sum + section.eventCount, 0), level.events.length);
assert.equal(level.generation.barSections.reduce((sum, section) => sum + section.noteCount, 0), choiceRowCount);
assert.equal(level.generation.barSections.reduce((sum, section) => sum + section.targetCellCount, 0), targetCellCount);
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

const centerLaneRatio = targetLaneWeights[2] / Math.max(1, choiceRowCount);
const edgeLaneRatio = (targetLaneWeights[0] + targetLaneWeights[4]) / Math.max(1, choiceRowCount);
const representedLaneCount = targetLaneWeights
  .filter((weight) => weight / Math.max(1, choiceRowCount) >= 0.02).length;
assert.ok(centerLaneRatio <= 0.68, `The chart is too center-heavy (${(centerLaneRatio * 100).toFixed(1)}%).`);
assert.ok(edgeLaneRatio >= 0.05, `The chart barely uses the edge lanes (${(edgeLaneRatio * 100).toFixed(1)}%).`);
assert.ok(representedLaneCount >= 4, 'The chart does not make meaningful use of at least four lanes.');

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

const mSections = level.generation.flowSections.filter((section) => section.motif === 'm');
const literalMGestures = findLiteralMGestures(level.events);
assert.ok(
  literalMGestures.some((gesture) => gesture.orientation === 'identity'),
  'The visible chart lacks the literal 00222→00001→22200→00001→00222→00001 M Gesture.',
);
if (level.song.durationSeconds >= 120) {
  assert.ok(literalMGestures.length >= 2, 'A long song must contain at least two literal visible M Gestures.');
}
const coveredMEventIndices = literalMGestures.flatMap((gesture) => (
  Array.from(
    { length: gesture.endIndex - gesture.startIndex + 1 },
    (_, offset) => gesture.startIndex + offset,
  )
));
const declaredMEventIndices = level.events.flatMap((event, index) => event.pattern === 'm' ? [index] : []);
assert.deepEqual(
  coveredMEventIndices,
  declaredMEventIndices,
  'A declared M Gesture is malformed or interrupted by an overlay/auxiliary row.',
);
assert.equal(
  literalMGestures.length,
  mSections.length,
  'M section metadata does not match the literal visible gesture count.',
);
assert.equal(
  literalMGestures.length,
  level.generation.motifCounts.m,
  'M motif metadata does not match the literal visible gesture count.',
);
const expectedMSummary = {
  count: literalMGestures.length,
  identityCount: literalMGestures.filter((gesture) => gesture.orientation === 'identity').length,
  mirrorCount: literalMGestures.filter((gesture) => gesture.orientation === 'mirror').length,
  windows: literalMGestures.map((gesture) => ({
    startEventIndex: gesture.startIndex,
    endEventIndex: gesture.endIndex,
    startSeconds: gesture.startSeconds,
    endSeconds: gesture.endSeconds,
    orientation: gesture.orientation,
    rows: gesture.rows,
  })),
};
assert.deepEqual(
  level.generation.mGestureSummary,
  expectedMSummary,
  'M diagnostic summary was not derived from the actual visible event stream.',
);
for (const gesture of literalMGestures) {
  const actualEvents = level.events.slice(gesture.startIndex, gesture.endIndex + 1);
  const sectionIndices = new Set(actualEvents.map((event) => event.section));
  assert.equal(sectionIndices.size, 1, 'One literal M Gesture was split across flow sections.');
  const [sectionIndex] = sectionIndices;
  const section = level.generation.flowSections[sectionIndex];
  assert.equal(section?.motif, 'm', 'A literal M Gesture is missing its M section label.');
  const gestureEventIndices = Array.from(
    { length: gesture.endIndex - gesture.startIndex + 1 },
    (_, offset) => gesture.startIndex + offset,
  );
  assert.equal(section.gestureStartEventIndex, gesture.startIndex);
  assert.equal(section.gestureEndEventIndex, gesture.endIndex);
  assert.deepEqual(section.gestureEventIndices, gestureEventIndices);
  if (Array.isArray(section.gestureRows)) {
    assert.deepEqual(
      section.gestureRows.map((row) => row.row),
      gesture.rows,
      'M diagnostic metadata differs from the actual visible rows.',
    );
  }
}

const beatSeconds = 60 / level.song.bpm;
const physicalFullWidthSeconds = travelSeconds * 4;
const maximumStrongStrokeSeconds = Math.max(
  physicalFullWidthSeconds + 0.05,
  Math.min(4.5, beatSeconds * 8),
);
const minimumAlternatingGestureSeconds = physicalFullWidthSeconds * 2;
const eligiblePeakIntentSections = intentSections.filter((section) => (
  section.role === 'peak'
  && section.endSeconds - section.startSeconds >= minimumAlternatingGestureSeconds
));
const fallbackStrongSection = intentSections
  .filter((section) => section.endSeconds - section.startSeconds >= minimumAlternatingGestureSeconds)
  .sort((left, right) => right.pressure - left.pressure)[0];
const strongIntentSections = eligiblePeakIntentSections.length
  ? eligiblePeakIntentSections
  : [fallbackStrongSection].filter(Boolean);
if (level.song.durationSeconds >= 30) {
  assert.ok(strongIntentSections.length > 0, 'No strong section is long enough for a full-width alternating gesture.');
}
const strongSweepMetrics = strongIntentSections.map((section) => ({
  section,
  metrics: analyzeEdgeSweepWindow(level.events, comboRoutes, {
    startSeconds: section.startSeconds,
    endSeconds: section.endSeconds,
    maxStrokeSeconds: maximumStrongStrokeSeconds,
  }),
}));
for (const { section, metrics } of strongSweepMetrics) {
  assert.ok(
    metrics.maximumAlternatingEdgeStrokeCount >= 2,
    `${section.id} ${section.role} section has no forced edge-to-edge-to-edge drum sweep.`,
  );
  assert.equal(
    metrics.centerOnlyRouteExists,
    false,
    `${section.id} ${section.role} section still permits a full-combo route that micro-moves only in lanes 1–3.`,
  );
}

const declaredSweepGroups = new Map();
level.events.forEach((event, rowIndex) => {
  if (!event.sweepGestureId) return;
  const id = `${event.phraseId}:${event.sweepGestureId}`;
  if (!declaredSweepGroups.has(id)) declaredSweepGroups.set(id, []);
  declaredSweepGroups.get(id).push({ event, rowIndex });
});
const actualSweepGestures = [];
let actualForcedEdgeTargetCount = 0;
let actualEdgeToEdgeTransitionCount = 0;
for (const [id, rows] of declaredSweepGroups) {
  assert.ok(
    rows.every(({ event }) => event.pattern === 'full-width-sweep' && event.layer === 'core'),
    `${id} contains a non-core or mislabeled row.`,
  );
  const anchors = rows.flatMap(({ event, rowIndex }) => {
    if (event.sweepPhase !== 'edge-target') return [];
    const targets = event.obstacles.flatMap((cell, lane) => cell === 1 ? [lane] : []);
    assert.equal(targets.length, 1, `${id} edge hit must display exactly one target.`);
    const [lane] = targets;
    assert.ok(lane === 0 || lane === 4, `${id} edge hit is not on an outer lane.`);
    assert.deepEqual(
      comboRoutes.globallyViableLanesByRow[rowIndex],
      [lane],
      `${id} edge hit is not forced on every full-combo route.`,
    );
    return [{ event, rowIndex, lane }];
  });
  assert.ok(anchors.length >= 3, `${id} has fewer than three forced edge hits.`);
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1];
    const current = anchors[index];
    assert.equal(Math.abs(current.lane - previous.lane), 4, `${id} does not alternate outer lanes.`);
    assert.ok(
      current.event.timeSeconds - previous.event.timeSeconds <= maximumStrongStrokeSeconds,
      `${id} contains an edge stroke that is too slow to read as one gesture.`,
    );
  }
  const firstEvent = rows[0].event;
  const lastEvent = rows.at(-1).event;
  const intentSectionIndices = [...new Set(anchors.flatMap(({ event }) => {
    const section = intentSections.find((candidate) => (
      event.timeSeconds >= candidate.startSeconds && event.timeSeconds < candidate.endSeconds
    )) ?? intentSections.at(-1);
    return Number.isInteger(section?.index) ? [section.index] : [];
  }))];
  actualForcedEdgeTargetCount += anchors.length;
  actualEdgeToEdgeTransitionCount += anchors.length - 1;
  actualSweepGestures.push({
    id,
    phraseId: firstEvent.phraseId,
    templateId: firstEvent.templateId,
    startSeconds: Number(firstEvent.timeSeconds.toFixed(3)),
    endSeconds: Number(lastEvent.timeSeconds.toFixed(3)),
    sectionRole: anchors.some(({ event }) => event.sectionRole === 'peak')
      ? 'peak'
      : anchors[0].event.sectionRole,
    intentSectionIndices,
    anchorTimes: anchors.map(({ event }) => Number(event.timeSeconds.toFixed(5))),
    anchorLanes: anchors.map(({ lane }) => lane),
    edgeToEdgeTransitionCount: anchors.length - 1,
  });
}
assert.equal(level.generation.fullWidthSweepCount, actualSweepGestures.length);
assert.equal(level.generation.edgeToEdgeTransitionCount, actualEdgeToEdgeTransitionCount);
assert.equal(level.generation.strongSweepMetrics.fullWidthSweepCount, actualSweepGestures.length);
assert.equal(level.generation.strongSweepMetrics.alternatingEdgeRunCount, actualSweepGestures.length);
assert.equal(
  level.generation.strongSweepMetrics.edgeToEdgeTransitionCount,
  actualEdgeToEdgeTransitionCount,
);
assert.equal(
  level.generation.strongSweepMetrics.forcedEdgeTargetCount,
  actualForcedEdgeTargetCount,
);
assert.deepEqual(
  level.generation.strongSweepMetrics.gestures,
  actualSweepGestures,
  'Strong-sweep metadata was not derived from the actual globally viable event graph.',
);
assert.match(level.generation.strongSweepMetrics.policy, /globally viable.*actual emitted event graph/i);

for (const section of level.generation.flowSections.filter((item) => item.motif === 'c')) {
  const sectionIndex = level.generation.flowSections.indexOf(section);
  const rows = level.events.filter((event) => event.section === sectionIndex);
  const leftEdgeSafe = rows.every((event) => event.obstacles[0] !== 2);
  const rightEdgeSafe = rows.every((event) => event.obstacles[4] !== 2);
  assert.ok(leftEdgeSafe || rightEdgeSafe, 'A C motif lost its edge-camping survival route.');
}

console.log(
  `Validated ${level.id}: ${choiceRowCount} Choice Rows / ${targetCellCount} Target Cells, `
  + `${comboRoutes.meaningfulChoiceRows.length} Route Branches, ${dodgeCount} Gate Rows, `
  + `${literalMGestures.length} literal M Gestures, `
  + `${strongSweepMetrics.reduce((sum, item) => sum + item.metrics.edgeToEdgeStrokes.length, 0)} strong-section full-width strokes, `
  + `${spikeCount} spikes, MP3 ${(audioStats.size / 1_048_576).toFixed(2)} MiB.`,
);
