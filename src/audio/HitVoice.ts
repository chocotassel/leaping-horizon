import type { HitSoundIntent } from '../types';

const OUTPUT_GAIN = 0.09;
const SILENCE = 0.0001;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function midiToFrequency(pitchMidi: number): number {
  return 440 * 2 ** ((pitchMidi - 69) / 12);
}

function voiceDuration(sourceRole: string): number {
  const role = sourceRole.toLowerCase();
  if (role.includes('percussion') || role.includes('drum')) return 0.052;
  if (role.includes('vocal') || role.includes('wind')) return 0.1;
  if (role.includes('bass')) return 0.085;
  return 0.075;
}

function oscillatorType(sourceRole: string): OscillatorType {
  const role = sourceRole.toLowerCase();
  if (role.includes('vocal') || role.includes('wind') || role.includes('bass')) return 'sine';
  return 'triangle';
}

/**
 * Schedules event-specific, deliberately tiny performance sounds on an
 * injected audio graph. One output bus is reused; only disposable oscillator,
 * filter and envelope nodes are created for each audible hit.
 */
export class HitVoice {
  private readonly output: GainNode;
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    destination: AudioNode,
  ) {
    this.output = context.createGain();
    this.output.gain.value = OUTPUT_GAIN;
    this.output.connect(destination);
  }

  play(intent: HitSoundIntent | undefined): boolean {
    if (
      this.disposed
      || !intent
      || this.context.state !== 'running'
      || !Number.isFinite(intent.pitchMidi)
      || !Number.isFinite(intent.velocity)
      || !Number.isFinite(intent.gain)
      || !Number.isFinite(intent.brightness)
    ) return false;

    const now = this.context.currentTime;
    const pitchMidi = clamp(intent.pitchMidi, 0, 127);
    const velocity = clamp(intent.velocity, 0, 1);
    const gain = clamp(intent.gain, 0, 1);
    const brightness = clamp(intent.brightness, 0, 1);
    const duration = voiceDuration(intent.sourceRole);
    const end = now + duration;
    const peak = (0.2 + velocity * 0.26) * gain;

    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    oscillator.type = oscillatorType(intent.sourceRole);
    oscillator.frequency.value = midiToFrequency(pitchMidi);
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(
      this.context.sampleRate * 0.45,
      850 + brightness * 7_200 + oscillator.frequency.value * 2,
    );
    filter.Q.value = 0.55 + brightness * 0.9;

    envelope.gain.cancelScheduledValues(now);
    envelope.gain.setValueAtTime(SILENCE, now);
    envelope.gain.linearRampToValueAtTime(Math.max(SILENCE, peak), now + 0.002);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, end);

    oscillator.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.output);
    oscillator.onended = () => {
      oscillator.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
    oscillator.start(now);
    oscillator.stop(end + 0.006);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.output.disconnect();
  }
}
