import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { detect, spectralFlux } from '@audio/beat';

const [inputPath, outputPath, audioUrl, suppliedTitle, artist = 'NEON SYSTEM', configPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !audioUrl) {
  throw new Error('Usage: npm run generate:level -- <input.wav> <output.json> <audio-url> [title] [artist] [config.json]');
}

function decodePcm16Wav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Only RIFF/WAVE input is supported.');
  }
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let format = 0;
  let dataOffset = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      format = buffer.readUInt16LE(offset + 8);
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(size, buffer.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (format !== 1 || bitsPerSample !== 16 || channels < 1 || !dataOffset) {
    throw new Error('The generator currently expects PCM 16-bit WAV audio.');
  }
  const frameCount = Math.floor(dataSize / (channels * 2));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += buffer.readInt16LE(dataOffset + (frame * channels + channel) * 2);
    }
    samples[frame] = sum / channels / 32768;
  }
  return { samples, sampleRate };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

const config = configPath
  ? JSON.parse(await readFile(configPath, 'utf8'))
  : { ticksPerBeat: 2, spikeRatios: { single: 0.45, double: 0.35, triple: 0.2 }, accents: [] };
const { samples, sampleRate } = decodePcm16Wav(await readFile(inputPath));
const analysis = detect(samples, { fs: sampleRate, minBpm: 80, maxBpm: 160, delta: 1.25 });
if (!analysis.beats.length || analysis.confidence < 0.35) throw new Error('Could not detect a stable beat grid.');

const bpm = Math.round(analysis.bpm * 100) / 100;
const beatDuration = 60 / bpm;
const detectedBeats = [...analysis.beats];
const beatOffsetSeconds = detectedBeats.length > 1 && detectedBeats[1] - detectedBeats[0] < beatDuration * 0.8
  ? detectedBeats[1]
  : detectedBeats[0];
const durationSeconds = samples.length / sampleRate;
const ticksPerBeat = config.ticksPerBeat;
const tickDuration = beatDuration / ticksPerBeat;
const tickCount = Math.ceil((durationSeconds - beatOffsetSeconds) / tickDuration);
const flux = spectralFlux(samples, { fs: sampleRate });
const rawStrengths = Array.from({ length: tickCount }, (_, tick) => {
  const frame = Math.round((beatOffsetSeconds + tick * tickDuration) * sampleRate / flux.hopSize);
  let strength = 0;
  for (let offset = -4; offset <= 4; offset += 1) strength = Math.max(strength, flux.odf[frame + offset] ?? 0);
  return strength;
});
const quiet = percentile(rawStrengths, 0.2);
const loud = percentile(rawStrengths, 0.9);
const strengths = rawStrengths.map((value) => Math.max(0, Math.min(1, (value - quiet) / Math.max(1e-9, loud - quiet))));
const accents = config.accents.map((accent) => ({
  label: accent.label,
  tick: Math.round(accent.beat * ticksPerBeat),
  timeSeconds: Math.round((beatOffsetSeconds + accent.beat * beatDuration) * 1000) / 1000,
  intensity: accent.intensity,
}));
const accentByTick = new Map(accents.map((accent) => [accent.tick, accent]));

const firstPlayableTick = Math.max(ticksPerBeat * 4, Math.ceil((2.5 - beatOffsetSeconds) / tickDuration));
const lastPlayableTime = durationSeconds - 2.5;
const candidates = [];
for (let tick = firstPlayableTick; tick < tickCount; tick += 1) {
  const time = beatOffsetSeconds + tick * tickDuration;
  if (time > lastPlayableTime) break;
  const accent = accentByTick.get(tick);
  if (accent || tick % ticksPerBeat === 0 || strengths[tick] >= 0.78) {
    candidates.push({ tick, strength: accent ? 2 : strengths[tick], accent });
  }
}

const ranked = [...candidates].sort((left, right) => right.strength - left.strength);
const tripleCount = Math.round(candidates.length * config.spikeRatios.triple);
const doubleCount = Math.round(candidates.length * config.spikeRatios.double);
const difficultyByTick = new Map(ranked.map((candidate, index) => [
  candidate.tick,
  index < tripleCount ? 3 : index < tripleCount + doubleCount ? 2 : 1,
]));

const rows = Array.from({ length: tickCount }, () => [0, 0, 0, 0, 0]);
const spikeRows = { single: 0, double: 0, triple: 0 };
let lane = 2;
let direction = 1;
let previousTick = firstPlayableTick;
let spikeCount = 0;

for (let index = 0; index < candidates.length; index += 1) {
  const candidate = candidates[index];
  const availableSteps = Math.max(1, candidate.tick - previousTick);
  const currentAccentIndex = accents.findIndex((accent) => accent.tick === candidate.tick);
  const nextAccentIndex = accents.findIndex((accent) => accent.tick >= candidate.tick);
  const nextAccent = accents[nextAccentIndex];
  const accentEdge = nextAccentIndex % 2 === 0 ? 4 : 0;

  if (currentAccentIndex >= 0) {
    lane += Math.max(-availableSteps, Math.min(availableSteps, accentEdge - lane));
  } else if (nextAccent && nextAccent.tick - candidate.tick <= Math.abs(accentEdge - lane) + 4) {
    lane += Math.sign(accentEdge - lane) * Math.min(1, availableSteps);
  } else {
    if (lane === 0) direction = 1;
    if (lane === 4) direction = -1;
    lane += direction * Math.min(1, availableSteps);
  }

  let difficulty = difficultyByTick.get(candidate.tick);
  if (candidate.accent) difficulty = 3;
  lane = Math.max(0, Math.min(4, lane));
  rows[candidate.tick][lane] = 1;

  const spikeLanes = lane >= 3
    ? [0, 1, 2]
    : lane <= 1
      ? [4, 3, 2]
      : direction > 0 ? [0, 1, 4] : [4, 3, 0];
  for (const spikeLane of spikeLanes.slice(0, difficulty)) rows[candidate.tick][spikeLane] = 2;
  spikeCount += difficulty;
  spikeRows[difficulty === 1 ? 'single' : difficulty === 2 ? 'double' : 'triple'] += 1;
  previousTick = candidate.tick;
}

const title = suppliedTitle || basename(inputPath, extname(inputPath));
const level = {
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
  version: 2,
  ticksPerBeat,
  song: {
    title,
    artist,
    audioUrl,
    bpm,
    beatOffsetSeconds: Math.round(beatOffsetSeconds * 10000) / 10000,
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
  },
  generation: {
    algorithm: 'spectral-flux-guided-lane-path-v2',
    confidence: Math.round(analysis.confidence * 1000) / 1000,
    noteCount: candidates.length,
    spikeCount,
    spikeRows,
  },
  accents,
  obstacles: rows,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(level, null, 2)}\n`);
console.log(`Generated ${candidates.length} notes, ${spikeCount} spikes (${spikeRows.single}/${spikeRows.double}/${spikeRows.triple}) at ${bpm} BPM.`);
