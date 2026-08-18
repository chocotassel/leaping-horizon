import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDemucsCore4Separator, ensureCore4Evidence } from './stem-separation.mjs';

const ROLES = ['vocals', 'drums', 'bass', 'other'];

test('production adapter is pinned to local CPU htdemucs core-4', () => {
  const separator = createDemucsCore4Separator({ pythonPath: 'fixture-python' });

  assert.equal(separator.id, 'demucs-core4');
  assert.equal(separator.model, 'htdemucs');
  assert.equal(separator.device, 'cpu');
  assert.match(separator.checksum, /^[a-f0-9]{64}$/);
});

test('separates core-4 once and reuses a checksum-addressed manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-core4-'));
  try {
    const audioPath = join(directory, 'audio.mp3');
    const workDirectory = join(directory, 'work');
    await writeFile(audioPath, 'fixture-audio');
    let calls = 0;
    const separator = {
      id: 'fixture-core4',
      model: 'fixture-model',
      version: '1.0.0',
      checksum: 'fixture-model-checksum',
      async separate({ outputDirectory }) {
        calls += 1;
        const stems = {};
        for (const role of ROLES) {
          const path = join(outputDirectory, `${role}.wav`);
          await writeFile(path, `fixture-${role}`);
          stems[role] = path;
        }
        return { stems, sampleRate: 32_000, durationSeconds: 12.5, timeOriginSeconds: 0 };
      },
    };

    const first = await ensureCore4Evidence(audioPath, { workDirectory, separator });
    const second = await ensureCore4Evidence(audioPath, { workDirectory, separator });

    assert.equal(calls, 1);
    assert.equal(first.schemaVersion, '1.0.0');
    assert.equal(first.status, 'ready');
    assert.equal(first.timeOriginSeconds, 0);
    assert.equal(first.separator.model, 'fixture-model');
    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
    assert.equal(second.cache.key, first.cache.key);
    assert.equal(second.audioFingerprint, first.audioFingerprint);
    assert.deepEqual(Object.keys(second.stems), ROLES);
    for (const role of ROLES) {
      assert.equal(second.stems[role].status, 'ready');
      assert.match(second.stems[role].checksum, /^[a-f0-9]{64}$/);
      assert.equal(await readFile(second.stems[role].path, 'utf8'), `fixture-${role}`);
    }
    const persisted = JSON.parse(await readFile(second.cache.manifestPath, 'utf8'));
    assert.equal(persisted.cache.key, first.cache.key);
    assert.equal(persisted.cache.hit, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports unavailable without inventing stems when separation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'leaping-horizon-core4-failure-'));
  try {
    const audioPath = join(directory, 'audio.mp3');
    await writeFile(audioPath, 'fixture-audio');
    const result = await ensureCore4Evidence(audioPath, {
      workDirectory: join(directory, 'work'),
      separator: {
        id: 'fixture-core4',
        model: 'fixture-model',
        version: '1.0.0',
        checksum: 'fixture-model-checksum',
        async separate() {
          throw new Error('fixture separator unavailable');
        },
      },
    });

    assert.equal(result.status, 'unavailable');
    assert.match(result.diagnostics.error, /fixture separator unavailable/);
    assert.equal(result.timeOriginSeconds, 0);
    assert.deepEqual(Object.keys(result.stems), ROLES);
    assert.ok(ROLES.every((role) => result.stems[role].status === 'unavailable'));
    assert.ok(ROLES.every((role) => !Object.hasOwn(result.stems[role], 'path')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
