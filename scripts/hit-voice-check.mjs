import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const param = (value = 0) => ({
  value,
  events: [],
  cancelScheduledValues(time) { this.events.push(['cancel', time]); },
  exponentialRampToValueAtTime(next, time) {
    this.value = next;
    this.events.push(['exponential', next, time]);
  },
  linearRampToValueAtTime(next, time) {
    this.value = next;
    this.events.push(['linear', next, time]);
  },
  setValueAtTime(next, time) {
    this.value = next;
    this.events.push(['set', next, time]);
  },
});

const audioNode = (kind) => ({
  kind,
  connections: [],
  connect(target) { this.connections.push(target); return target; },
  disconnect() { this.connections.length = 0; },
});

class FakeAudioContext {
  constructor() {
    this.currentTime = 8;
    this.sampleRate = 48_000;
    this.state = 'running';
    this.destination = audioNode('destination');
    this.gains = [];
    this.filters = [];
    this.oscillators = [];
  }

  createGain() {
    const gain = { ...audioNode('gain'), gain: param(1) };
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter() {
    const filter = {
      ...audioNode('filter'),
      type: 'lowpass',
      frequency: param(350),
      Q: param(1),
    };
    this.filters.push(filter);
    return filter;
  }

  createOscillator() {
    const oscillator = {
      ...audioNode('oscillator'),
      type: 'sine',
      frequency: param(440),
      detune: param(0),
      start(time) { oscillator.startedAt = time; },
      stop(time) { oscillator.stoppedAt = time; },
      onended: null,
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }
}

const source = readFileSync(new URL('../src/audio/HitVoice.ts', import.meta.url), 'utf8')
  .replace(
    "import type { HitSoundIntent } from '../types';",
    'interface HitSoundIntent { pitchMidi: number; pitchClass: number; sourceRole: string; velocity: number; gain: number; brightness: number; }',
  );
const temporaryRoot = fileURLToPath(new URL('../node_modules/.cache/leaping-horizon-hit-voice-check/', import.meta.url));
mkdirSync(temporaryRoot, { recursive: true });
const temporaryDirectory = mkdtempSync(join(temporaryRoot, 'run-'));
const fixturePath = join(temporaryDirectory, 'hit-voice.ts');
const outputDir = join(temporaryDirectory, 'compiled');
process.once('exit', () => rmSync(temporaryDirectory, { recursive: true, force: true }));
writeFileSync(fixturePath, source);
execFileSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
  fixturePath,
  '--ignoreConfig',
  '--target', 'ES2020',
  '--module', 'CommonJS',
  '--outDir', outputDir,
  '--skipLibCheck',
]);

const require = createRequire(import.meta.url);
const { HitVoice } = require(`${outputDir}/hit-voice.js`);
const context = new FakeAudioContext();
const voice = new HitVoice(context, context.destination);
const outputBus = context.gains[0];

assert.equal(voice.play(undefined), false, 'legacy rows without hitSound stay silent');
assert.equal(context.oscillators.length, 0);
assert.equal(voice.play({
  pitchMidi: 69,
  pitchClass: 9,
  sourceRole: 'vocal-like',
  velocity: 0.8,
  gain: 0.9,
  brightness: 0.65,
}), true);

const firstOscillator = context.oscillators[0];
const firstEnvelope = context.gains[1];
assert.ok(Math.abs(firstOscillator.frequency.value - 440) < 0.001, 'MIDI A4 must sound as 440 Hz');
assert.equal(firstOscillator.startedAt, context.currentTime, 'the voice starts without look-ahead latency');
assert.ok(firstOscillator.stoppedAt - firstOscillator.startedAt <= 0.12, 'the voice has no masking tail');
assert.ok(outputBus.gain.value <= 0.1, 'the voice mix remains subordinate to the song');
assert.ok(
  firstEnvelope.gain.events.some(([kind, value]) => kind === 'linear' && value > 0.1),
  'the hit has a fast audible attack',
);
assert.ok(
  firstEnvelope.gain.events.some(([kind, value]) => kind === 'exponential' && value <= 0.0001),
  'the hit decays to silence',
);

context.currentTime = 8.03;
voice.play({
  pitchMidi: 72,
  pitchClass: 0,
  sourceRole: 'melody',
  velocity: 1,
  gain: 1,
  brightness: 0.8,
});
assert.equal(context.gains[0], outputBus, 'rapid hits reuse one output bus');
assert.equal(outputBus.connections.length, 1, 'rapid hits do not reconnect the shared output graph');

voice.dispose();
assert.equal(outputBus.connections.length, 0);
console.log('hit voice check passed');
