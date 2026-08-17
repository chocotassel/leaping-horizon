import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeRouteGraph,
  findLiteralMGestures,
} from './rhythm/route-analysis.mjs';
import { COLOR_SCHEME_IDS, colorSchemesDiffer } from './rhythm/color-timeline.mjs';
import { buildWaveRows } from './rhythm/wave-planner.mjs';

const root = resolve(import.meta.dirname, '..');
const performanceContractOnly = process.argv[2] === '--performance-contract-only';
const requestedLevelPath = performanceContractOnly ? process.argv[3] : process.argv[2];

function performanceScoreOf(level) {
  return level?.generation?.performanceScore ?? level?.performanceScore ?? null;
}

function assertNormalizedUnit(value, label) {
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${label} must be within 0..1.`);
}

function assertHitSound(hitSound, label) {
  assert.ok(hitSound && typeof hitSound === 'object', `${label} has no Hit Voice.`);
  assert.ok(
    Number.isFinite(hitSound.pitchMidi) && hitSound.pitchMidi >= 0 && hitSound.pitchMidi <= 127,
    `${label} has an invalid MIDI pitch.`,
  );
  assert.ok(
    Number.isInteger(hitSound.pitchClass) && hitSound.pitchClass >= 0 && hitSound.pitchClass <= 11,
    `${label} has an invalid pitch class.`,
  );
  assert.ok(typeof hitSound.sourceRole === 'string' && hitSound.sourceRole.length > 0, `${label} has no source role.`);
  assertNormalizedUnit(hitSound.velocity, `${label} velocity`);
  assertNormalizedUnit(hitSound.gain, `${label} gain`);
  assertNormalizedUnit(hitSound.brightness, `${label} brightness`);
}

function assertPerformanceContract(level) {
  const performanceScore = performanceScoreOf(level);
  if (performanceScore == null) return false;

  assert.equal(performanceScore.kind, 'performance-score', 'The Performance Score has an unknown kind.');
  assert.ok(Array.isArray(performanceScore.attackEvents), 'The Performance Score has no Attack Events.');
  assert.ok(performanceScore.attackEvents.length > 0, 'The Performance Score is empty.');
  assert.ok(Array.isArray(performanceScore.melodicTraces), 'The Performance Score has no Melodic Traces array.');

  const attacksById = new Map();
  for (const [index, attack] of performanceScore.attackEvents.entries()) {
    const label = `Attack Event ${index}`;
    assert.ok(typeof attack?.id === 'string' && attack.id.length > 0, `${label} has no id.`);
    assert.equal(attacksById.has(attack.id), false, `Attack Event ${attack.id} is duplicated.`);
    assert.ok(
      Number.isFinite(attack.timeSeconds)
        && attack.timeSeconds >= 0
        && attack.timeSeconds <= level.song.durationSeconds,
      `Attack Event ${attack.id} has an invalid measured time.`,
    );
    assert.ok(
      Number.isInteger(attack.lane) && attack.lane >= 0 && attack.lane <= 4,
      `Attack Event ${attack.id} has an invalid measured lane.`,
    );
    assert.ok(
      Array.isArray(attack.evidenceIds)
        && attack.evidenceIds.length > 0
        && attack.evidenceIds.every((evidenceId) => typeof evidenceId === 'string' && evidenceId.length > 0),
      `Attack Event ${attack.id} has no measured evidence.`,
    );
    assertHitSound(attack.hitSound, `Attack Event ${attack.id}`);
    attacksById.set(attack.id, attack);
  }

  const tracesById = new Map();
  for (const [index, trace] of performanceScore.melodicTraces.entries()) {
    assert.ok(typeof trace?.id === 'string' && trace.id.length > 0, `Melodic Trace ${index} has no id.`);
    assert.equal(tracesById.has(trace.id), false, `Melodic Trace ${trace.id} is duplicated.`);
    assert.ok(Array.isArray(trace.attackEventIds) && trace.attackEventIds.length > 0, `Melodic Trace ${trace.id} is empty.`);
    for (const attackEventId of trace.attackEventIds) {
      assert.ok(attacksById.has(attackEventId), `Melodic Trace ${trace.id} references an unknown Attack Event.`);
    }
    if (Array.isArray(trace.pitchContour)) {
      assert.deepEqual(
        trace.pitchContour,
        trace.attackEventIds.map((attackEventId) => attacksById.get(attackEventId).pitchMidi),
        `Melodic Trace ${trace.id} pitch contour differs from its Attack Events.`,
      );
    }
    if (Array.isArray(trace.laneContour)) {
      assert.deepEqual(
        trace.laneContour,
        trace.attackEventIds.map((attackEventId) => attacksById.get(attackEventId).lane),
        `Melodic Trace ${trace.id} lane contour differs from its Attack Events.`,
      );
    }
    tracesById.set(trace.id, trace);
  }

  const targetRows = level.events.filter((event) => event.kind === 'target');
  assert.ok(targetRows.length > 0, 'The Performance Score emitted no Target Rows.');
  const targetsByAttackId = new Map();
  const representedAttackIds = new Set();
  for (const [index, event] of targetRows.entries()) {
    const label = `Performance Target Row ${index}`;
    assert.equal(event.layer, 'core', `${label} is not a core performance row.`);
    assert.equal(event.pattern, 'performance', `${label} came from a beat/layout template.`);
    assert.ok(typeof event.performanceEventId === 'string', `${label} has no Attack Event identity.`);
    assert.equal(targetsByAttackId.has(event.performanceEventId), false, `${label} duplicates an Attack Event target.`);
    const attack = attacksById.get(event.performanceEventId);
    assert.ok(attack, `${label} references an unknown Attack Event.`);
    const targetLanes = event.obstacles.flatMap((cell, lane) => cell === 1 ? [lane] : []);
    assert.deepEqual(targetLanes, [attack.lane], `${label} moved away from its measured lane.`);
    assert.equal(event.timeSeconds, attack.timeSeconds, `${label} moved away from its measured time.`);
    assertHitSound(event.hitSound, label);
    assert.deepEqual(event.hitSound, attack.hitSound, `${label} substituted a generic Hit Voice.`);
    if (attack.continuity?.traceId != null) {
      assert.equal(event.melodicTraceId, attack.continuity.traceId, `${label} lost its Melodic Trace identity.`);
    } else if (event.melodicTraceId != null) {
      assert.ok(tracesById.has(event.melodicTraceId), `${label} references an unknown Melodic Trace.`);
      assert.ok(
        tracesById.get(event.melodicTraceId).attackEventIds.includes(event.performanceEventId),
        `${label} is not a member of its declared Melodic Trace.`,
      );
    }
    const memberIds = event.performanceEventIds ?? [event.performanceEventId];
    assert.ok(Array.isArray(memberIds) && memberIds.length > 0, `${label} has no represented Attack Events.`);
    assert.ok(memberIds.includes(event.performanceEventId), `${label} omits its primary Attack Event.`);
    for (const attackEventId of memberIds) {
      assert.ok(attacksById.has(attackEventId), `${label} represents an unknown Attack Event.`);
      assert.equal(representedAttackIds.has(attackEventId), false, `Attack Event ${attackEventId} is represented twice.`);
      representedAttackIds.add(attackEventId);
    }
    targetsByAttackId.set(event.performanceEventId, event);
  }

  for (const trace of performanceScore.melodicTraces) {
    const represented = trace.attackEventIds.flatMap((attackEventId) => {
      const event = targetsByAttackId.get(attackEventId);
      return event ? [{ attack: attacksById.get(attackEventId), event }] : [];
    });
    for (let index = 1; index < represented.length; index += 1) {
      const previous = represented[index - 1];
      const current = represented[index];
      if (!Number.isFinite(previous.attack.pitchMidi) || !Number.isFinite(current.attack.pitchMidi)) continue;
      const pitchDelta = current.attack.pitchMidi - previous.attack.pitchMidi;
      const laneDelta = current.attack.lane - previous.attack.lane;
      assert.ok(
        pitchDelta > 0.25 ? laneDelta >= 0 : pitchDelta < -0.25 ? laneDelta <= 0 : true,
        `Melodic Trace ${trace.id} reverses pitch direction in the lane contour.`,
      );
    }
  }

  const compilation = performanceScore.diagnostics?.compilation;
  assert.ok(compilation && typeof compilation === 'object', 'The Performance Score has no compilation diagnostics.');
  assert.equal(compilation.selectedTargetRowCount, targetRows.length, 'Selected Target Row count is stale.');
  assert.equal(compilation.representedAttackEventCount, representedAttackIds.size, 'Represented Attack Event count is stale.');
  assert.equal(
    compilation.mergedAttackEventCount,
    representedAttackIds.size - targetRows.length,
    'Merged Attack Event count is stale.',
  );
  assert.ok(Array.isArray(compilation.mergedGroups), 'Merged Attack Event diagnostics are missing.');
  assert.ok(Array.isArray(compilation.omittedAttackEvents), 'Omitted Attack Event diagnostics are missing.');
  assert.equal(
    compilation.omittedAttackEventCount,
    compilation.omittedAttackEvents.length,
    'Omitted Attack Event count is stale.',
  );
  assert.equal(level.generation.performanceAttackEventCount, performanceScore.attackEvents.length);
  assert.equal(level.generation.performanceTargetRowCount, targetRows.length);

  const hazardCellCount = level.events.reduce((sum, event) => (
    sum + event.obstacles.filter((cell) => cell === 2).length
  ), 0);
  assert.ok(
    hazardCellCount <= targetRows.length * 1.5,
    'Hazards, rather than Attack Events, are the primary chart-density source.',
  );
  return true;
}
if (!requestedLevelPath) {
  const songsDirectory = resolve(root, 'src/songs');
  const levelFiles = (await readdir(songsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(songsDirectory, entry.name, 'level.json'))
    .filter((path) => existsSync(path))
    .sort();
  assert.ok(levelFiles.length > 0, 'No generated levels were found.');
  for (const levelFile of levelFiles) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), levelFile],
      { cwd: root, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const selectableLevels = await Promise.all(levelFiles.map(async (levelFile) => (
    JSON.parse(await readFile(levelFile, 'utf8'))
  )));
  for (let leftIndex = 0; leftIndex < selectableLevels.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selectableLevels.length; rightIndex += 1) {
      const left = selectableLevels[leftIndex];
      const right = selectableLevels[rightIndex];
      if (left.generation.layoutIntentProfile.audioFingerprint === right.generation.layoutIntentProfile.audioFingerprint) continue;
      if (performanceScoreOf(left) || performanceScoreOf(right)) continue;
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
const performanceMode = assertPerformanceContract(level);
if (performanceContractOnly) {
  console.log(performanceMode ? 'Validated Performance Score contract.' : 'Legacy level has no Performance Score.');
  process.exit(0);
}

if (performanceMode) {
  assert.equal(level.version, 3);
  assert.equal(level.generation.difficulty, 'flow');
  assert.equal(level.generation.layoutAlgorithm, 'performance-score-row-compiler-v1');
  assert.equal(level.generation.realizationReceipt?.targetAuthority, 'performance-score');
  assert.equal(level.generation.realizationReceipt?.directorAuthority, 'hazard-pressure-color-visual-only');
  assert.ok(
    level.generation.realizationReceipt?.cues?.every((cue) => (
      cue.targetLaneAuthority === 'performance-score' && cue.directorMayRetarget === false
    )),
    'A Director cue may retarget a measured Attack Event.',
  );
  assert.ok(level.events.length > 0, 'The generated performance level is empty.');
  let previousTime = -Infinity;
  for (const [index, event] of level.events.entries()) {
    assert.ok(
      Number.isFinite(event.timeSeconds)
        && event.timeSeconds >= 0
        && event.timeSeconds <= level.song.durationSeconds
        && event.timeSeconds > previousTime,
      `Performance event ${index} is outside the song or not ordered.`,
    );
    assert.ok(
      Array.isArray(event.obstacles)
        && event.obstacles.length === 5
        && event.obstacles.some((cell) => cell !== 0)
        && event.obstacles.every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 2),
      `Performance event ${index} has an invalid lane row.`,
    );
    assert.equal('_routeLane' in event, false, `Performance event ${index} leaks a preferred route.`);
    assert.equal('_preferredLane' in event, false, `Performance event ${index} leaks a preferred lane.`);
    previousTime = event.timeSeconds;
  }
  const audioPath = level.song.audioUrl.startsWith('/')
    ? resolve(root, 'public', level.song.audioUrl.replace(/^\//, ''))
    : resolve(dirname(levelPath), level.song.audioUrl);
  await access(audioPath);
  const targetRowCount = level.events.filter((event) => event.kind === 'target').length;
  console.log(`Validated ${level.id}: ${targetRowCount} measured performance Target Rows.`);
  process.exit(0);
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

function signatureForPhrase(phraseId) {
  return level.events
    .filter((event) => event.phraseId === phraseId)
    .map((event) => `${event.relativeSlotKey}:${event.kind}:${event.obstacles.join('')}`);
}

function actionLanes(event) {
  const targets = event.obstacles.flatMap((cell, lane) => cell === 1 ? [lane] : []);
  if (targets.length) return targets;
  return event.obstacles.flatMap((cell, lane) => cell !== 2 ? [lane] : []);
}

function previousCoreEventIndex(eventIndex) {
  for (let index = eventIndex - 1; index >= 0; index -= 1) {
    if (level.events[index].layer === 'core') return index;
  }
  return -1;
}

function minimumLaneShift(fromLanes, toLanes) {
  return Math.min(...fromLanes.flatMap((fromLane) => (
    toLanes.map((toLane) => Math.abs(toLane - fromLane))
  )));
}

assert.equal(level.version, 3);
assert.equal(level.generation.difficulty, 'flow');
assert.equal(level.generation.layoutAlgorithm, 'evidence-directed-kinetic-compiler-v14');
assert.equal(level.generation.colorSchemeAlgorithm, 'director-color-scenes-v4');

const directorScore = level.generation.directorScore;
assert.equal(directorScore?.algorithm, 'music-evidence-song-director-v1');
assert.ok(
  typeof directorScore.audioFingerprint === 'string' && directorScore.audioFingerprint.length > 0,
  'The Director Score has no audio fingerprint.',
);
assert.equal(
  directorScore.audioFingerprint,
  level.generation.layoutIntentProfile.audioFingerprint,
  'The Director Score and layout intent describe different audio.',
);
assert.ok(Array.isArray(directorScore.anchors) && directorScore.anchors.length > 0);
const anchorsById = new Map();
let previousAnchorTime = -Infinity;
for (const [index, anchor] of directorScore.anchors.entries()) {
  assert.ok(typeof anchor.id === 'string' && anchor.id.length > 0, `Director anchor ${index} has no id.`);
  assert.equal(anchorsById.has(anchor.id), false, `Director anchor ${anchor.id} is duplicated.`);
  assert.ok(anchor.timeSeconds > previousAnchorTime, `Director anchor ${anchor.id} is not ordered.`);
  assert.ok(
    anchor.timeSeconds >= 0 && anchor.timeSeconds <= level.song.durationSeconds,
    `Director anchor ${anchor.id} is outside the song.`,
  );
  assert.ok(
    Array.isArray(anchor.evidenceIds) && anchor.evidenceIds.length > 0,
    `Director anchor ${anchor.id} has no measured evidence.`,
  );
  anchorsById.set(anchor.id, anchor);
  previousAnchorTime = anchor.timeSeconds;
}

function assertAnchorReference(anchorId, timeSeconds, label) {
  assert.ok(typeof anchorId === 'string' && anchorsById.has(anchorId), `${label} references an unknown anchor.`);
  if (Number.isFinite(Number(timeSeconds))) {
    assert.ok(
      Math.abs(anchorsById.get(anchorId).timeSeconds - Number(timeSeconds)) <= 1e-5,
      `${label} moved away from its measured anchor.`,
    );
  }
}

const directorScenes = Array.isArray(directorScore.scenes) ? directorScore.scenes : [];
const scenesById = new Map(directorScenes.map((scene) => [scene.id, scene]));
for (const scene of directorScenes) {
  if (scene.entryAnchorId != null) {
    assertAnchorReference(scene.entryAnchorId, scene.startSeconds, `Director scene ${scene.id}`);
  }
}
const directorMoments = Array.isArray(directorScore.moments) ? directorScore.moments : [];
const momentsById = new Map();
for (const moment of directorMoments) {
  assert.ok(typeof moment.id === 'string' && !momentsById.has(moment.id), 'A Directed Moment id is missing or duplicated.');
  assertAnchorReference(moment.anchorId, moment.timeSeconds, `Directed Moment ${moment.id}`);
  if (moment.sceneId == null) {
    assert.equal(moment.narrativeTurn, false, `Narrative Directed Moment ${moment.id} has no scene.`);
    assert.deepEqual(
      moment.requiredChannels,
      ['visual-accent'],
      `Only a pre-scene Visual Accent may omit sceneId (${moment.id}).`,
    );
  } else {
    assert.ok(scenesById.has(moment.sceneId), `Directed Moment ${moment.id} references an unknown scene.`);
  }
  assert.ok(['impact', 'arrival', 'rupture', 'release', 'breath'].includes(moment.type));
  assert.ok(['may', 'should', 'must'].includes(moment.commitment));
  assert.ok(
    Array.isArray(moment.requiredChannels) && moment.requiredChannels.length > 0,
    `Directed Moment ${moment.id} has no required realization channel.`,
  );
  momentsById.set(moment.id, moment);
}

const directorColorScenes = Array.isArray(directorScore.colorScenes) ? directorScore.colorScenes : [];
const colorScenesById = new Map();
for (const colorScene of directorColorScenes) {
  assert.ok(
    typeof colorScene.id === 'string' && !colorScenesById.has(colorScene.id),
    'A Director Color Scene id is missing or duplicated.',
  );
  assertAnchorReference(
    colorScene.anchorId,
    colorScene.timeSeconds ?? colorScene.startSeconds,
    `Director Color Scene ${colorScene.id}`,
  );
  const sourceMoment = momentsById.get(colorScene.sourceMomentId);
  assert.ok(sourceMoment, `Director Color Scene ${colorScene.id} has no source Directed Moment.`);
  assert.equal(sourceMoment.anchorId, colorScene.anchorId);
  assert.equal(sourceMoment.narrativeTurn, true);
  assert.ok(
    sourceMoment.commitment === 'should' || sourceMoment.commitment === 'must',
    `Director Color Scene ${colorScene.id} must originate from a committed Narrative Turn.`,
  );
  assert.ok(sourceMoment.requiredChannels.includes('color'));
  colorScenesById.set(colorScene.id, colorScene);
}

const directorVisualAccents = Array.isArray(directorScore.visualAccents)
  ? directorScore.visualAccents
  : [];
const directorVisualAccentsById = new Map();
for (const accent of directorVisualAccents) {
  assert.ok(
    typeof accent.id === 'string' && !directorVisualAccentsById.has(accent.id),
    'A Director Visual Accent id is missing or duplicated.',
  );
  assert.equal(accent.kind, 'pulse');
  assertAnchorReference(accent.anchorId, accent.timeSeconds, `Director Visual Accent ${accent.id}`);
  directorVisualAccentsById.set(accent.id, accent);
}
assert.equal(
  directorScore.diagnostics?.unresolvedAnchorReferenceCount,
  0,
  'The Director Score reports unresolved anchor references.',
);

assert.ok(Array.isArray(level.colorSchemeEvents) && level.colorSchemeEvents.length >= 1);
assert.equal(level.generation.colorSchemeEventCount, level.colorSchemeEvents.length);
assert.equal(level.colorSchemeEvents[0].timeSeconds, 0);
assert.equal(level.colorSchemeEvents[0].colorSchemeId, 'cyanWhite');
let previousColorSchemeTime = -Infinity;
for (const [index, event] of level.colorSchemeEvents.entries()) {
  assert.ok(event.timeSeconds > previousColorSchemeTime, `Color scheme event ${index} is not ordered.`);
  assert.ok(event.timeSeconds <= level.song.durationSeconds, `Color scheme event ${index} is outside the song.`);
  assert.ok(COLOR_SCHEME_IDS.includes(event.colorSchemeId), `Color scheme event ${index} uses an unknown preset.`);
  assert.equal(event.kind, 'section', `Color scheme event ${index} is not a persistent Color Scene.`);
  if (index > 0) {
    const directorColorScene = colorScenesById.get(event.source);
    assert.ok(directorColorScene, `Color scheme event ${index} did not originate from a Director Color Scene.`);
    assert.equal(event.anchorId, directorColorScene.anchorId);
    assertAnchorReference(event.anchorId, event.timeSeconds, `Color scheme event ${index}`);
    assert.ok(
      colorSchemesDiffer(level.colorSchemeEvents[index - 1].colorSchemeId, event.colorSchemeId),
      `Color scheme event ${index} repeats a region hue from the previous event.`,
    );
  }
  previousColorSchemeTime = event.timeSeconds;
}

const visualAccentEvents = Array.isArray(level.visualAccentEvents) ? level.visualAccentEvents : [];
assert.equal(level.generation.visualAccentEventCount, visualAccentEvents.length);
const visualAccentIds = new Set();
let previousVisualAccentTime = -Infinity;
for (const [index, accent] of visualAccentEvents.entries()) {
  assert.ok(accent.timeSeconds > previousVisualAccentTime, `Visual Accent ${index} is not strictly ordered.`);
  assert.ok(accent.timeSeconds <= level.song.durationSeconds, `Visual Accent ${index} is outside the song.`);
  assert.equal(accent.kind, 'pulse', `Visual Accent ${index} is not a pulse.`);
  assert.ok(typeof accent.id === 'string' && !visualAccentIds.has(accent.id), `Visual Accent ${index} has a duplicate id.`);
  assertAnchorReference(accent.anchorId, accent.timeSeconds, `Visual Accent ${index}`);
  const sourceAccent = directorVisualAccentsById.get(accent.source);
  const sourceMoment = momentsById.get(accent.source);
  assert.ok(sourceAccent || sourceMoment, `Visual Accent ${index} has no Director source.`);
  assert.equal((sourceAccent ?? sourceMoment).anchorId, accent.anchorId);
  visualAccentIds.add(accent.id);
  previousVisualAccentTime = accent.timeSeconds;
}
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

const audioPath = level.song.audioUrl.startsWith('/')
  ? resolve(root, 'public', level.song.audioUrl.replace(/^\//, ''))
  : resolve(dirname(levelPath), level.song.audioUrl);
await access(audioPath);
const audioStats = await stat(audioPath);
const compression = level.generation.audioCompression;
if (compression) {
  assert.equal(compression.format, 'MP3');
  assert.equal(compression.codec, 'MPEG Layer III');
  assert.ok(['constant', 'variable', 'existing'].includes(compression.bitrateMode));
  if (compression.bitrateMode === 'constant') assert.equal(compression.bitrateKbps, 96);
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
let densityFillCount = 0;
let solidDensityFillCount = 0;
let compactDensityFillCount = 0;
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
  if (event.directorAnchorId != null) {
    assert.ok(anchorsById.has(event.directorAnchorId), `${label} references an unknown Director anchor.`);
  }
  if (event.directedMomentIds != null) {
    assert.ok(Array.isArray(event.directedMomentIds) && event.directedMomentIds.length > 0);
    for (const momentId of event.directedMomentIds) {
      const moment = momentsById.get(momentId);
      assert.ok(moment, `${label} references an unknown Directed Moment.`);
      if (event.directorAnchorId != null) assert.equal(event.directorAnchorId, moment.anchorId);
    }
  }

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
  } else if (event.kind === 'dodge') {
    assert.equal(targets, 0, `${label} dodge row cannot contain a target.`);
    assert.ok(rowSpikes > 0, `${label} dodge row must contain a hazard.`);
    dodgeCount += 1;
    currentMultiTargetRun = 0;
  } else {
    assert.equal(event.kind, 'guide', `${label} has an unsupported kind.`);
    assert.equal(targets, 0, `${label} guide row cannot contain a Target Cell.`);
    assert.ok(rowSpikes > 0, `${label} guide row must contain a Hazard Cell.`);
    assert.equal(event.densityFill, true, `${label} is an unaccounted guide row.`);
    currentMultiTargetRun = 0;
  }

  spikeCount += rowSpikes;
  if (rowSpikes) guidanceRowCount += 1;
  if (event.densityFill) {
    densityFillCount += 1;
    solidDensityFillCount += Number(event.densityMode === 'solid');
    compactDensityFillCount += Number(event.densityMode === 'compact');
    assert.equal(event.kind, 'guide', `${label} density fill claims to be a gameplay Gate Row.`);
    assert.equal(event.layer, 'auxiliary-common', `${label} density fill has the wrong layer.`);
    assert.equal(event.source, 'layout-density-rule', `${label} density fill has the wrong source.`);
    assert.match(event.role, /^(solid|compact)-density-guide$/, `${label} density fill has the wrong role.`);
    assert.ok(rowSpikes > 0, `${label} density fill contains no wall.`);
  }
  assertNoIsolatedMiddleGap(event.obstacles, label);
  previousTime = event.timeSeconds;
}

assert.equal(level.generation.densityFillCount, densityFillCount);
assert.equal(level.generation.solidDensityFillCount, solidDensityFillCount);
assert.equal(level.generation.compactDensityFillCount, compactDensityFillCount);
assert.equal(densityFillCount, solidDensityFillCount + compactDensityFillCount);

for (const identity of directorScore.phraseIdentities ?? []) {
  if (identity.relation !== 'exact') continue;
  assert.equal(
    identity.developmentPolicy,
    'preserve-canonical-kinetic-form',
    `Exact Phrase Identity ${identity.id} does not preserve its canonical form.`,
  );
  assert.ok(
    Array.isArray(identity.occurrences) && identity.occurrences.length >= 2,
    `Exact Phrase Identity ${identity.id} has fewer than two occurrences.`,
  );
  const signatures = identity.occurrences.map((occurrence) => level.events
    .filter((event) => (
      event.layer === 'core'
      && event.timeSeconds >= occurrence.startSeconds
      && event.timeSeconds < occurrence.endSeconds
    ))
    .map((event) => `${event.kind}:${event.obstacles.join('')}:${event.routeBranch === true ? 'branch' : 'single'}`));
  assert.ok(signatures[0].length > 0, `Exact Phrase Identity ${identity.id} has no realized core rows.`);
  for (let index = 1; index < signatures.length; index += 1) {
    assert.deepEqual(
      signatures[index],
      signatures[0],
      `Exact Phrase Identity ${identity.id} occurrence ${index + 1} changed its rows or Route Branch topology.`,
    );
  }
}

const realizationReceipt = level.generation.realizationReceipt;
assert.equal(realizationReceipt?.algorithm, 'directed-song-score-compiler-receipt-v3');
assert.equal(realizationReceipt.kineticCompilerVersion, 'kinetic-form-row-compiler-v1');
assert.equal(realizationReceipt.audioFingerprint, directorScore.audioFingerprint);
assert.ok(Array.isArray(realizationReceipt.cues));
assert.equal(realizationReceipt.cueCount, realizationReceipt.cues.length);
assert.equal(realizationReceipt.cueCount, directorMoments.length);
assert.ok(Array.isArray(realizationReceipt.phraseIdentities));
assert.equal(realizationReceipt.phraseIdentityCount, directorScore.phraseIdentities.length);
assert.equal(realizationReceipt.phraseIdentityCount, realizationReceipt.phraseIdentities.length);
const identityReceiptsById = new Map();
for (const identityReceipt of realizationReceipt.phraseIdentities) {
  assert.ok(
    typeof identityReceipt.identityId === 'string' && !identityReceiptsById.has(identityReceipt.identityId),
    'A Phrase Identity receipt id is missing or duplicated.',
  );
  const identity = directorScore.phraseIdentities.find((candidate) => candidate.id === identityReceipt.identityId);
  assert.ok(identity, `Phrase Identity receipt ${identityReceipt.identityId} has no Director contract.`);
  assert.equal(identityReceipt.relation, identity.relation);
  assert.equal(identityReceipt.developmentPolicy, identity.developmentPolicy);
  assert.equal(identityReceipt.kineticFormVersion, identity.kineticForm.version);
  assert.deepEqual(identityReceipt.kineticVerbs, identity.kineticForm.verbs);
  assert.equal(identityReceipt.branchMode, identity.kineticForm.branchMode);
  assert.equal(identityReceipt.status, 'realized', `Phrase Identity ${identity.id} was not realized.`);
  assert.deepEqual(identityReceipt.missingContracts, []);
  assert.equal(identityReceipt.occurrences.length, identity.occurrences.length);
  for (const [occurrenceIndex, occurrenceReceipt] of identityReceipt.occurrences.entries()) {
    const occurrence = identity.occurrences[occurrenceIndex];
    assert.equal(occurrenceReceipt.occurrenceId, occurrence.id);
    assert.equal(occurrenceReceipt.startSeconds, occurrence.startSeconds);
    assert.equal(occurrenceReceipt.endSeconds, occurrence.endSeconds);
    assert.ok(occurrenceReceipt.eventIndices.length > 0, `${occurrence.id} has no realized core rows.`);
    const rows = occurrenceReceipt.eventIndices.map((eventIndex) => {
      assert.ok(
        Number.isInteger(eventIndex) && eventIndex >= 0 && eventIndex < level.events.length,
        `${occurrence.id} references an invalid row.`,
      );
      const event = level.events[eventIndex];
      assert.equal(event.layer, 'core', `${occurrence.id} references a non-core row.`);
      assert.ok(
        event.timeSeconds >= occurrence.startSeconds && event.timeSeconds < occurrence.endSeconds,
        `${occurrence.id} references a row outside its interval.`,
      );
      return event;
    });
    assert.deepEqual(
      occurrenceReceipt.rowSignature,
      rows.map((event) => `${event.kind}:${event.obstacles.join('')}`),
    );
    assert.deepEqual(
      occurrenceReceipt.routeBranchSignature,
      rows.map((event) => event.routeBranch === true),
    );
    assert.ok(occurrenceReceipt.consumedEventIndices.length > 0, `${occurrence.id} consumed no Kinetic Form rows.`);
    assert.ok(occurrenceReceipt.consumedEventIndices.every((index) => (
      occurrenceReceipt.eligibleEventIndices.includes(index)
    )));
    assert.equal(occurrenceReceipt.kineticProof.compilerVersion, realizationReceipt.kineticCompilerVersion);
    assert.equal(occurrenceReceipt.kineticProof.kineticFormVersion, identity.kineticForm.version);
    assert.deepEqual(occurrenceReceipt.kineticProof.evidenceIds, identity.evidenceIds);
    assert.equal(occurrenceReceipt.kineticProof.hasKineticConsumption, true);
    assert.ok(occurrenceReceipt.kineticProof.consumedTargetCoverage > 0);
    assert.deepEqual(
      occurrenceReceipt.kineticProof.consumedRowSignatures,
      occurrenceReceipt.consumedEventIndices.map((eventIndex) => level.events[eventIndex].obstacles.join('')),
    );
    for (const event of occurrenceReceipt.consumedEventIndices.map((eventIndex) => level.events[eventIndex])) {
      assert.ok(
        Array.isArray(event.directedIdentityIds) && event.directedIdentityIds.includes(identity.id),
        `${occurrence.id} row ${event.timeSeconds}s has no Phrase Identity provenance.`,
      );
      assert.equal(event.kineticCompilerVersion, realizationReceipt.kineticCompilerVersion);
      const proof = event.kineticProofs?.find((candidate) => candidate.identityId === identity.id);
      assert.ok(proof, `${occurrence.id} row ${event.timeSeconds}s has no Kinetic Form proof.`);
      assert.equal(proof.compilerVersion, realizationReceipt.kineticCompilerVersion);
      assert.ok(
        ['canonical-template-compiled', 'off-seam-kinetic-composition'].includes(proof.compilerMode),
        `${occurrence.id} has an unknown Kinetic Form compiler mode.`,
      );
      assert.equal(proof.kineticFormVersion, identity.kineticForm.version);
      assert.deepEqual(proof.verbs, identity.kineticForm.verbs);
      assert.equal(proof.motionKind, identity.kineticForm.motion.kind);
      assert.equal(proof.motionSlope, identity.kineticForm.motion.slope);
      assert.deepEqual(proof.pressureContour, identity.kineticForm.pressureContour);
      assert.equal(proof.branchMode, identity.kineticForm.branchMode);
      assert.equal(proof.attack, identity.kineticForm.attack);
      assert.equal(proof.development, identity.kineticForm.development);
      assert.equal(proof.developmentPolicy, identity.developmentPolicy);
      assert.deepEqual(proof.evidenceIds, identity.evidenceIds);
      assert.ok(proof.compositionIdentityIds.includes(identity.id));
      assert.equal(proof.finalRowSignature, event.obstacles.join(''));
      assert.equal(
        event.obstacles[proof.resolvedPreferredLane],
        1,
        `${occurrence.id} no longer exposes its Kinetic Form's resolved target lane.`,
      );
      assert.ok(
        Math.abs(event.obstacles.filter((cell) => cell !== 2).length - proof.compiledSafeWidth) <= 1,
        `${occurrence.id} row ${event.timeSeconds}s no longer represents its compiled pressure corridor.`,
      );
      assert.ok(Math.abs(proof.resolvedPreferredLane - proof.compiledPreferredLane) <= 2);
      if (proof.compilerMode === 'off-seam-kinetic-composition') {
        assert.ok(
          Math.abs(proof.resolvedPreferredLane - proof.desiredLane) <= 2,
          `${occurrence.id} composition no longer represents this identity's motion lane.`,
        );
        assert.ok(
          Math.abs(proof.resolvedSafeWidth - proof.desiredSafeWidth) <= 1,
          `${occurrence.id} composition no longer represents this identity's pressure.`,
        );
        const expectedPosition = (event.timeSeconds - occurrence.startSeconds)
          / Math.max(1e-6, occurrence.endSeconds - occurrence.startSeconds);
        assert.ok(
          Math.abs(proof.normalizedPosition - expectedPosition) <= 1e-4,
          `${occurrence.id} uses another occurrence's Kinetic Form position.`,
        );
      }
      assert.ok(Number.isFinite(proof.normalizedPosition));
      assert.ok(proof.normalizedPosition >= 0 && proof.normalizedPosition <= 1);
    }
    if (identity.kineticForm.branchMode === 'fork-converge') {
      const firstForkIndex = rows.findIndex((event) => (
        event.routeBranch === true
        && event.kind === 'target'
        && event.obstacles.filter((cell) => cell === 1).length >= 2
      ));
      assert.ok(firstForkIndex >= 0, `${occurrence.id} never realizes a reachable Route Branch.`);
      assert.ok(
        rows.slice(firstForkIndex + 1).some((event) => (
          event.routeBranch !== true
          && event.kind === 'target'
          && event.obstacles.filter((cell) => cell === 1).length === 1
        )),
        `${occurrence.id} never converges after its Route Branch.`,
      );
    }
  }
  identityReceiptsById.set(identityReceipt.identityId, identityReceipt);
}
assert.equal(
  realizationReceipt.realizedPhraseIdentityCount,
  realizationReceipt.phraseIdentities.filter((identity) => identity.status === 'realized').length,
);
const exactIdentityReceipts = realizationReceipt.phraseIdentities.filter((identity) => identity.relation === 'exact');
assert.equal(realizationReceipt.exactPhraseIdentityCount, exactIdentityReceipts.length);
assert.equal(
  realizationReceipt.realizedExactPhraseIdentityCount,
  exactIdentityReceipts.filter((identity) => identity.status === 'realized').length,
);
assert.equal(
  realizationReceipt.exactPhraseIdentityCoverage,
  exactIdentityReceipts.length ? 1 : null,
);
const receiptCuesByMomentId = new Map();
const validReceiptChannels = new Set(['movement', 'density', 'threat', 'color', 'visual-accent']);
for (const cue of realizationReceipt.cues) {
  assert.ok(
    typeof cue.momentId === 'string' && !receiptCuesByMomentId.has(cue.momentId),
    'A realization receipt cue id is missing or duplicated.',
  );
  const moment = momentsById.get(cue.momentId);
  assert.ok(moment, `Receipt cue ${cue.momentId} has no Directed Moment.`);
  assert.equal(cue.anchorId, moment.anchorId);
  assert.equal(cue.sceneId, moment.sceneId);
  assert.equal(cue.type, moment.type);
  assert.equal(cue.commitment, moment.commitment);
  assert.ok(Math.abs(cue.cueTimeSeconds - moment.timeSeconds) <= 1e-5);
  assert.deepEqual(cue.requiredChannels, moment.requiredChannels);
  assert.ok(cue.requiredChannels.length > 0, `Receipt cue ${cue.momentId} has no required channel.`);
  assert.ok(
    cue.requiredChannels.every((channel) => validReceiptChannels.has(channel)),
    `Receipt cue ${cue.momentId} contains an unknown realization channel.`,
  );
  assert.ok(cue.channels && typeof cue.channels === 'object', `Receipt cue ${cue.momentId} has no channel map.`);
  for (const channel of cue.requiredChannels) {
    const channelReceipt = cue.channels[channel];
    assert.ok(channelReceipt, `Receipt cue ${cue.momentId} has no ${channel} mapping.`);
    if (['movement', 'density', 'threat'].includes(channel)) {
      assert.ok(
        Number.isInteger(channelReceipt.eventIndex)
          && channelReceipt.eventIndex >= 0
          && channelReceipt.eventIndex < level.events.length,
        `Receipt cue ${cue.momentId} has an invalid ${channel} row index.`,
      );
      const realizedRow = level.events[channelReceipt.eventIndex];
      assert.ok(
        Array.isArray(realizedRow.directedMomentIds)
          && realizedRow.directedMomentIds.includes(cue.momentId),
        `Receipt cue ${cue.momentId} cannot be traced to its ${channel} row.`,
      );
      assert.ok(
        Math.abs(realizedRow.timeSeconds - channelReceipt.timeSeconds) <= 1e-5,
        `Receipt cue ${cue.momentId} has stale ${channel} row timing.`,
      );
      if (channel === 'movement') {
        assert.ok(
          channelReceipt.mode === 'forced-shift' || channelReceipt.mode === 'named-gesture',
          `Receipt cue ${cue.momentId} does not describe a real movement effect.`,
        );
        if (channelReceipt.mode === 'forced-shift') {
          const priorIndex = previousCoreEventIndex(channelReceipt.eventIndex);
          assert.equal(channelReceipt.previousEventIndex, priorIndex);
          assert.ok(priorIndex >= 0, `Receipt cue ${cue.momentId} has no movement origin row.`);
          const fromLanes = actionLanes(level.events[priorIndex]);
          const toLanes = actionLanes(realizedRow);
          const measuredShift = minimumLaneShift(fromLanes, toLanes);
          assert.deepEqual(channelReceipt.fromLanes, fromLanes);
          assert.deepEqual(channelReceipt.toLanes, toLanes);
          assert.equal(channelReceipt.minimumShiftLanes, measuredShift);
          assert.ok(measuredShift > 0, `Receipt cue ${cue.momentId} leaves a no-movement route open.`);
        } else {
          assert.ok(
            Array.isArray(channelReceipt.gestureEventIndices)
              && channelReceipt.gestureEventIndices.length >= 2,
            `Receipt cue ${cue.momentId} has no named-gesture movement sequence.`,
          );
          const gestureRows = channelReceipt.gestureEventIndices.map((index) => level.events[index]);
          assert.ok(
            gestureRows.every((event) => event?.pattern === realizedRow.pattern),
            `Receipt cue ${cue.momentId} names unrelated gesture rows.`,
          );
          assert.ok(
            new Set(gestureRows.map((event) => event.obstacles.join(''))).size > 1,
            `Receipt cue ${cue.momentId} gesture has no visible spatial motion.`,
          );
        }
      } else if (channel === 'density') {
        const priorIndex = previousCoreEventIndex(channelReceipt.eventIndex);
        assert.equal(channelReceipt.previousEventIndex, priorIndex);
        assert.ok(priorIndex >= 0, `Receipt cue ${cue.momentId} has no density comparison row.`);
        const beforeHazardCount = level.events[priorIndex].obstacles.filter((cell) => cell === 2).length;
        const afterHazardCount = realizedRow.obstacles.filter((cell) => cell === 2).length;
        assert.equal(channelReceipt.beforeHazardCount, beforeHazardCount);
        assert.equal(channelReceipt.afterHazardCount, afterHazardCount);
        assert.equal(channelReceipt.hazardDelta, afterHazardCount - beforeHazardCount);
        assert.notEqual(afterHazardCount, beforeHazardCount, `Receipt cue ${cue.momentId} has no density contrast.`);
      } else if (channel === 'threat') {
        const priorIndex = previousCoreEventIndex(channelReceipt.eventIndex);
        assert.equal(channelReceipt.previousEventIndex, priorIndex);
        assert.ok(priorIndex >= 0, `Receipt cue ${cue.momentId} has no threat comparison row.`);
        assert.equal(channelReceipt.previousObstacleRow, level.events[priorIndex].obstacles.join(''));
        assert.equal(channelReceipt.obstacleRow, realizedRow.obstacles.join(''));
        assert.ok(
          realizedRow.obstacles.includes(2)
            && channelReceipt.previousObstacleRow !== channelReceipt.obstacleRow,
          `Receipt cue ${cue.momentId} has no visible threat contrast.`,
        );
      }
    } else if (channel === 'color') {
      const realizedColor = level.colorSchemeEvents.find((event) => (
        event.anchorId === cue.anchorId
        && event.source === channelReceipt.source
        && Math.abs(event.timeSeconds - channelReceipt.timeSeconds) <= 1e-5
      ));
      assert.ok(realizedColor, `Receipt cue ${cue.momentId} cannot be traced to its Color Scene.`);
      assert.equal(realizedColor.colorSchemeId, channelReceipt.colorSchemeId);
    } else {
      const realizedAccent = visualAccentEvents.find((accent) => accent.id === channelReceipt.id);
      assert.ok(realizedAccent, `Receipt cue ${cue.momentId} cannot be traced to its Visual Accent.`);
      assert.equal(realizedAccent.anchorId, cue.anchorId);
      assert.equal(realizedAccent.kind, channelReceipt.kind);
      assert.ok(Math.abs(realizedAccent.timeSeconds - channelReceipt.timeSeconds) <= 1e-5);
    }
  }
  receiptCuesByMomentId.set(cue.momentId, cue);
}
for (const moment of directorMoments) {
  assert.ok(receiptCuesByMomentId.has(moment.id), `Directed Moment ${moment.id} has no receipt cue.`);
}
const mustReceiptCues = realizationReceipt.cues.filter((cue) => cue.commitment === 'must');
assert.equal(realizationReceipt.mustCueCount, mustReceiptCues.length);
assert.equal(
  realizationReceipt.realizedMustCueCount,
  mustReceiptCues.filter((cue) => cue.status === 'realized').length,
);
for (const cue of mustReceiptCues) {
  assert.equal(cue.status, 'realized', `Must cue ${cue.momentId} was not fully realized.`);
  assert.deepEqual(cue.missingChannels, [], `Must cue ${cue.momentId} is missing a required channel.`);
}
if (mustReceiptCues.length) {
  assert.equal(realizationReceipt.mustCueCoverage, 1, 'Must Director cues are not 100% realized.');
} else {
  assert.equal(realizationReceipt.mustCueCoverage, null);
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
const minimumChoiceBranches = (directorScore.phraseIdentities ?? [])
  .filter((identity) => identity.kineticForm?.branchMode === 'fork-converge')
  .reduce((count, identity) => count + Math.max(1, identity.occurrences?.length ?? 0), 0);
assert.ok(
  comboRoutes.meaningfulChoiceRows.length >= minimumChoiceBranches,
  `The chart offers too few meaningful Choice Rows (${comboRoutes.meaningfulChoiceRows.length}/${minimumChoiceBranches}).`,
);
if (minimumChoiceBranches > 0) {
  assert.ok(comboRoutes.pathCountCapped >= 2, 'The directed Route Branches create no player decision.');
}

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

const repeatConsistency = level.generation.repeatConsistency;
assert.equal(repeatConsistency.repeatedFamilyGroupCount, repeatConsistency.groups.length);
assert.equal(
  repeatConsistency.exactGroupCount,
  repeatConsistency.groups.filter((group) => group.exact).length,
);
for (const group of repeatConsistency.groups) {
  const signatures = group.phraseIds.map((phraseId) => signatureForPhrase(phraseId));
  for (const signature of signatures.slice(1)) {
    assert.deepEqual(signature, signatures[0], `${group.familyId} changed across repeated phrases.`);
  }
}
if (repeatConsistency.groups.length) {
  assert.equal(repeatConsistency.exactRatio, 1);
} else {
  assert.equal(repeatConsistency.exactRatio, null, 'An empty exact-repeat set cannot report perfect agreement.');
}
for (const link of repeatConsistency.appliedRangeLinks) {
  if (link.id.startsWith('analysis-overlap-')) {
    assert.ok(link.similarity >= 0.88, `${link.id} did not pass the exact-repeat threshold.`);
    continue;
  }
  assert.match(link.id, /^director-exact-/, 'An unknown structural reuse leaked into the chart.');
  const identity = directorScore.phraseIdentities.find((candidate) => candidate.id === link.directedIdentityId);
  assert.equal(identity?.relation, 'exact', `${link.id} does not reference an exact Phrase Identity.`);
  assert.equal(
    identity?.developmentPolicy,
    'preserve-canonical-kinetic-form',
    `${link.id} references a Phrase Identity that permits development.`,
  );
  assert.equal(link.realization, 'kinetic-form-compiled', `${link.id} only copied rows without compiling its form.`);
  assert.equal(link.compilerVersion, 'kinetic-form-row-compiler-v1');
}

const waveSections = level.generation.flowSections.filter((section) => section.motif === 'wave');
for (const section of waveSections) {
  const sectionIndex = level.generation.flowSections.indexOf(section);
  const emittedWaveRows = level.events.filter((event) => (
    event.section === sectionIndex && event.layer === 'core' && event.pattern === 'wave'
  ));
  assert.ok(section.slotCount >= 5, 'A wave section is too short to complete one crest.');
  const expectedWaveRows = buildWaveRows({
      length: section.slotCount,
      mirror: section.mirrored,
    }).map((row) => row.join(''));
  assert.deepEqual(
    section.templateRows,
    expectedWaveRows,
    'A wave section does not match the shared depth rule.',
  );
  assert.deepEqual(
    emittedWaveRows.map((event) => event.obstacles.join('')),
    expectedWaveRows,
    'The emitted Wave Gate differs from its declared geometry.',
  );
  assert.ok(
    emittedWaveRows.every((event) => event.kind === 'dodge' && !event.obstacles.includes(1)),
    'A named Wave Gate contains a Target Cell.',
  );
}

const mSections = level.generation.flowSections.filter((section) => section.motif === 'm');
const literalMGestures = findLiteralMGestures(level.events);
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
  level.generation.motifCounts.m ?? 0,
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
const sweepTravelSeconds = Math.min(
  travelSeconds,
  ...level.events.filter((event) => event.pattern === 'full-width-sweep')
    .map((event) => Number(event.travelSecondsPerLane) || travelSeconds),
);
const physicalFullWidthSeconds = sweepTravelSeconds * 4;
const maximumStrongStrokeSeconds = Math.max(
  physicalFullWidthSeconds + 0.05,
  beatSeconds * 1.35,
);

const declaredSweepGroups = new Map();
level.events.forEach((event, rowIndex) => {
  if (!event.sweepGestureId) return;
  const id = `${event.phraseId}:${event.sweepGestureId}`;
  if (!declaredSweepGroups.has(id)) declaredSweepGroups.set(id, []);
  declaredSweepGroups.get(id).push({ event, rowIndex });
});
const namedSweepRows = level.events.filter((event) => event.pattern === 'full-width-sweep');
assert.equal(
  namedSweepRows.filter((event) => event.sweepGestureId).length,
  namedSweepRows.length,
  'A named Full-width Drum Sweep row has no gesture identity.',
);
const actualSweepGestures = [];
let actualForcedEdgeTargetCount = 0;
let actualEdgeToEdgeTransitionCount = 0;
for (const [id, rows] of declaredSweepGroups) {
  assert.ok(
    rows.every(({ event }) => event.pattern === 'full-width-sweep' && event.layer === 'core'),
    `${id} contains a non-core or mislabeled row.`,
  );
  assert.ok(
    rows.every(({ event }) => event.travelSecondsPerLane === level.generation.fullWidthSweepTravelSecondsPerLane),
    `${id} does not use the declared full-width movement allowance.`,
  );
  const anchors = rows.flatMap(({ event, rowIndex }) => {
    if (event.sweepPhase !== 'edge-target') return [];
    const targets = event.obstacles.flatMap((cell, lane) => cell === 1 ? [lane] : []);
    assert.equal(targets.length, 1, `${id} edge hit must display exactly one target.`);
    const [lane] = targets;
    assert.ok(lane === 0 || lane === 4, `${id} edge hit is not on an outer lane.`);
    const expectedRow = event.sweepHazardMode === 'spiked'
      ? (lane === 0 ? '10222' : '22201')
      : (lane === 0 ? '10000' : '00001');
    assert.equal(event.obstacles.join(''), expectedRow, `${id} has a malformed ${event.sweepHazardMode} edge row.`);
    assert.deepEqual(
      comboRoutes.globallyViableLanesByRow[rowIndex],
      [lane],
      `${id} edge hit is not forced on every full-combo route.`,
    );
    return [{ event, rowIndex, lane }];
  });
  assert.ok(anchors.length >= 5, `${id} has fewer than five forced edge hits.`);
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
  + `${actualEdgeToEdgeTransitionCount} full-width edge transitions, `
  + `${spikeCount} spikes, MP3 ${(audioStats.size / 1_048_576).toFixed(2)} MiB.`,
);
