import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createServer } from 'vite';

let server;
let editsModule;
let auditionModule;

before(async () => {
  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
  editsModule = await server.ssrLoadModule('/src/levelEdits.ts');
  auditionModule = await server.ssrLoadModule('/src/editor/beatAudition.ts');
});

after(async () => {
  await server?.close();
});

function fixtureLevel() {
  return {
    id: 'fixture-flow',
    version: 3,
    song: { title: 'Fixture', artist: 'Fixture', audioUrl: './audio.mp3', bpm: 120, durationSeconds: 4 },
    generation: { algorithm: 'measured-pitch-base-v1', noteCount: 1 },
    rhythmPoints: [0, 1, 2, 3].map((timeSeconds, index) => ({
      id: `point-${index}`,
      timeSeconds,
      suggestedLane: 2,
      kind: index % 2 ? 'attack' : 'beat',
      strength: 0.8,
      sourceRole: 'fixture',
      hasBaseRow: timeSeconds === 1,
    })),
    colorSchemeEvents: [
      { timeSeconds: 0, colorSchemeId: 'cyanWhite', kind: 'section', source: 'base-1', strength: 0 },
      { timeSeconds: 2, colorSchemeId: 'redWhite', kind: 'section', source: 'base-2', strength: 1 },
    ],
    events: [{
      timeSeconds: 1,
      obstacles: [0, 1, 0, 0, 0],
      kind: 'target',
    }],
  };
}

test('applies sparse manual rows at existing and empty rhythm points', () => {
  const level = fixtureLevel();
  const edited = editsModule.applyLevelEdits(level, {
    version: 1,
    levelId: level.id,
    rowOverrides: [
      { timeSeconds: 0, obstacles: [2, 0, 0, 0, 0] },
      { timeSeconds: 1, obstacles: [0, 0, 0, 0, 0] },
      { timeSeconds: 2, obstacles: [0, 1, 0, 2, 0] },
    ],
    colorRanges: [],
  });

  assert.deepEqual(edited.events.map((event) => event.timeSeconds), [0, 2]);
  assert.equal(edited.events[0].kind, 'dodge');
  assert.equal(edited.events[1].kind, 'target');
  assert.deepEqual(edited.events[1].obstacles, [0, 1, 0, 2, 0]);
});

test('compiles a manual color range and restores the base palette afterward', () => {
  const level = fixtureLevel();
  const edited = editsModule.applyLevelEdits(level, {
    version: 1,
    levelId: level.id,
    rowOverrides: [],
    colorRanges: [{
      id: 'manual-yellow',
      startSeconds: 1,
      endSeconds: 3,
      colorSchemeId: 'yellowBlue',
    }],
  });
  assert.deepEqual(
    edited.colorSchemeEvents.map((event) => [event.timeSeconds, event.colorSchemeId]),
    [[0, 'cyanWhite'], [1, 'yellowBlue'], [3, 'redWhite']],
  );
});

test('rejects off-grid row edits and overlapping color ranges', () => {
  const level = fixtureLevel();
  assert.throws(() => editsModule.parseLevelEdits({
    version: 1,
    levelId: level.id,
    rowOverrides: [{ timeSeconds: 1.5, obstacles: [1, 0, 0, 0, 0] }],
    colorRanges: [],
  }, level), /节奏点/);
  assert.throws(() => editsModule.parseLevelEdits({
    version: 1,
    levelId: level.id,
    rowOverrides: [],
    colorRanges: [
      { id: 'a', startSeconds: 0, endSeconds: 2, colorSchemeId: 'redWhite' },
      { id: 'b', startSeconds: 1, endSeconds: 3, colorSchemeId: 'blueWhite' },
    ],
  }, level), /不能重叠/);
});

test('auditions exactly one beat without passing the end of the song', () => {
  assert.deepEqual(auditionModule.getBeatAuditionRange(10, 120, 30), {
    startSeconds: 10,
    endSeconds: 10.5,
  });
  assert.deepEqual(auditionModule.getBeatAuditionRange(29.8, 60, 30), {
    startSeconds: 29.8,
    endSeconds: 30,
  });
});
