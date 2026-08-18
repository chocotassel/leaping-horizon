import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const param = (value = 0) => ({
  value,
  cancelScheduledValues() {},
  exponentialRampToValueAtTime(next) { this.value = next; },
  linearRampToValueAtTime(next) { this.value = next; },
  setValueAtTime(next) { this.value = next; },
});
const audioNode = (kind) => ({
  kind,
  connections: [],
  connect(target) { this.connections.push(target); },
  disconnect() { this.connections.length = 0; },
});

class FakeAudioContext {
  static instance;
  static instances = [];

  constructor(options) {
    FakeAudioContext.instance = this;
    FakeAudioContext.instances.push(this);
    this.options = options;
    this.currentTime = 0;
    this.destination = audioNode('destination');
    this.analysers = [];
    this.sampleRate = 22050;
    this.sources = [];
    this.oscillators = [];
    this.state = 'running';
  }

  createAnalyser() {
    this.analyser = { ...audioNode('analyser'), frequencyBinCount: 128, getByteFrequencyData() {} };
    this.analysers.push(this.analyser);
    return this.analyser;
  }

  createBiquadFilter() {
    return { ...audioNode('filter'), frequency: param(), Q: param() };
  }

  createBufferSource() {
    const source = {
      ...audioNode('source'),
      detune: param(),
      playbackRate: param(1),
      start: (_when = 0, offset = 0) => { source.startOffset = offset; },
      stop: () => { source.stopped = true; },
    };
    this.sources.push(source);
    return source;
  }

  createGain() {
    return { ...audioNode('gain'), gain: param() };
  }

  createOscillator() {
    const oscillator = {
      ...audioNode('oscillator'),
      frequency: param(440),
      detune: param(),
      type: 'sine',
      start: (when = 0) => { oscillator.startedAt = when; },
      stop: (when = 0) => { oscillator.stoppedAt = when; },
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createWaveShaper() {
    return audioNode('distortion');
  }

  decodeAudioData() {
    return Promise.resolve({ duration: 60 });
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

const source = readFileSync(new URL('../src/audio/AudioEngine.ts', import.meta.url), 'utf8')
  .replace("import { t } from '../i18n';", "const t = (key: string) => key;");
const temporaryRoot = fileURLToPath(new URL('../node_modules/.cache/leaping-horizon-audio-check/', import.meta.url));
mkdirSync(temporaryRoot, { recursive: true });
const temporaryDirectory = mkdtempSync(join(temporaryRoot, 'run-'));
const fixturePath = join(temporaryDirectory, 'leaping-horizon-audio-engine.ts');
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

globalThis.window = { AudioContext: FakeAudioContext };
const require = createRequire(import.meta.url);
const {
  AudioEngine,
  hitSoundIntentForOutcome,
  normalizeHitSoundIntent,
} = require(`${outputDir}/leaping-horizon-audio-engine.js`);
AudioEngine.setMusicEnabled(false);
await AudioEngine.unlock();
const engine = new AudioEngine(60, 120, 'data:audio/mp3;base64,AA==');
let context = FakeAudioContext.instance;
await engine.start();

assert.deepEqual(normalizeHitSoundIntent({
  sourceRole: 'vocals',
  pitchMidi: 69,
  velocity: 0.8,
  gain: 0.5,
  brightness: 0.75,
}), {
  sourceRole: 'vocals',
  pitchMidi: 69,
  pitchClass: 9,
  velocity: 0.8,
  gain: 0.5,
  brightness: 0.75,
}, 'hit-sound intent has a stable compact runtime shape');
assert.equal(hitSoundIntentForOutcome('target-miss', {
  hitSound: { sourceRole: 'vocals', pitchMidi: 69 },
}), null, 'a miss must not play a musical hit');
assert.equal(hitSoundIntentForOutcome('dodge', {
  hitSound: { sourceRole: 'drums' },
}), null, 'a successful dodge must not play a musical hit');
assert.deepEqual(hitSoundIntentForOutcome('target-hit', {
  hitSound: {
    sourceRole: 'vocals',
    pitchMidi: 69,
    velocity: 0.8,
    gain: 0.5,
    brightness: 0.75,
  },
}), {
  sourceRole: 'vocals',
  pitchMidi: 69,
  pitchClass: 9,
  velocity: 0.8,
  gain: 0.5,
  brightness: 0.75,
}, 'one satisfied target row yields one normalized hit intent');
const contextsBeforeHit = FakeAudioContext.instances.length;
assert.equal(engine.playHitSound({
  sourceRole: 'vocals',
  pitchMidi: 69,
  velocity: 0.8,
  gain: 0.5,
  brightness: 0.75,
}), true);
assert.equal(FakeAudioContext.instances.length, contextsBeforeHit, 'hit sound reuses the song AudioContext');
assert.equal(context.oscillators.length, 1, 'one target row creates one synthesized hit');
assert.equal(context.oscillators[0].frequency.value, 440);

assert.equal(context.options?.sampleRate, undefined, 'AudioContext must use the output device sample rate');
assert.equal(context.analyser.connections[0].kind, 'gain', 'normal music must bypass crash DSP');
assert.equal(context.sources.length, 0, 'muted music should not start at the beginning');
context.currentTime = 12;
AudioEngine.setMusicEnabled(true);
assert.equal(context.sources.at(-1).startOffset, 12, 'enabling music should seek to game time');

context.currentTime = 15;
await engine.pause();
context.currentTime = 18;
AudioEngine.setMusicEnabled(false);
await AudioEngine.unlock();
AudioEngine.setMusicEnabled(true);
assert.equal(context.sources.length, 1, 'music must stay stopped while the game is paused');

await engine.resume();
assert.equal(context.sources.at(-1).startOffset, 15, 'resume should restart music at paused game time');
context.currentTime = 19;
assert.equal(engine.currentTime, 16, 'game time should continue from the paused position');

const degradedContext = context;
await AudioEngine.recover();
context = FakeAudioContext.instance;
assert.notEqual(context, degradedContext, 'route recovery must replace the AudioContext');
assert.equal(degradedContext.state, 'closed');
assert.equal(context.sources.at(-1).startOffset, 16, 'route recovery must preserve game time');

let finishDecode;
context.decodeAudioData = () => new Promise((resolve) => { finishDecode = resolve; });
const loadingEngine = new AudioEngine(60, 120, 'data:audio/mp3;base64,AA==');
const start = loadingEngine.start();
await loadingEngine.pause();
finishDecode({ duration: 60 });
await start;
assert.equal(loadingEngine.paused, true, 'pausing during audio decode must stay paused');
engine.crash();
assert.ok(
  context.analysers.some((analyser) => analyser.connections[0]?.kind === 'distortion'),
  'only a crash enables DSP',
);
engine.stop();
assert.equal(context.state, 'running', 'a shared context stays alive while another game uses it');
loadingEngine.stop();
assert.equal(context.state, 'closed', 'the last game must release a potentially degraded context');
await AudioEngine.unlock();
assert.equal(FakeAudioContext.instances.length, 3, 'the next session must get a fresh context');

console.log('audio sync check passed');
