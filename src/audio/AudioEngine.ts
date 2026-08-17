import { t } from '../i18n';

type WindowWithWebkitAudio = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function createAudioContext(): AudioContext {
  const AudioContextClass = window.AudioContext ||
    (window as WindowWithWebkitAudio).webkitAudioContext;
  if (!AudioContextClass) throw new Error(t('error.webAudioUnsupported'));
  return new AudioContextClass();
}

function createCrashDistortionCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(256);
  const drive = 3.2;
  for (let index = 0; index < curve.length; index += 1) {
    const input = index / (curve.length - 1) * 2 - 1;
    curve[index] = Math.tanh(input * drive) / Math.tanh(drive);
  }
  return curve;
}

function decodeBase64Audio(value: string): ArrayBuffer {
  const decoded = atob(value.slice(value.indexOf(',') + 1));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

/** 加载关卡音频；资源不可用时退回本地合成音轨。 */
export class AudioEngine {
  private static sharedContext: AudioContext | null = null;
  private static musicEnabled = false;
  private static activeEngines = new Set<AudioEngine>();
  private context: AudioContext;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private gain!: GainNode;
  private analyser!: AnalyserNode;
  private distortion!: WaveShaperNode;
  private filter!: BiquadFilterNode;
  private spectrumData!: Uint8Array<ArrayBuffer>;
  private startedAt = 0;
  private pausedAt = 0;
  private isPaused = false;
  private readonly duration: number;
  private readonly bpm: number;
  private readonly audioUrl: string;
  private stopped = false;
  private crashing = false;

  /** 必须从用户点击回调直接调用，以满足移动浏览器的音频播放策略。 */
  static async unlock(): Promise<void> {
    if (!this.sharedContext || this.sharedContext.state === 'closed') {
      this.sharedContext = createAudioContext();
      this.activeEngines.forEach((engine) => {
        engine.replaceContext(this.sharedContext!, engine.currentTime);
      });
    }
    try {
      if (this.sharedContext.state !== 'running') await this.sharedContext.resume();
    } catch { /* the next user gesture will retry */ }
    if (this.sharedContext.state === 'running') {
      this.activeEngines.forEach((engine) => engine.syncSource());
    }
  }

  /** Rebuild Web Audio after page/output-route changes that can corrupt iOS contexts. */
  static async recover(): Promise<void> {
    const previous = this.sharedContext;
    if (!previous) return;
    const engines = Array.from(this.activeEngines, (engine) => ({
      engine,
      time: engine.currentTime,
    }));
    this.sharedContext = null;
    if (engines.length === 0) {
      try { await previous.close(); } catch { /* already closed */ }
      return;
    }
    const context = createAudioContext();
    this.sharedContext = context;
    engines.forEach(({ engine, time }) => engine.replaceContext(context, time));
    try { await previous.close(); } catch { /* already closed */ }
    try {
      if (context.state !== 'running') await context.resume();
    } catch { /* the next user gesture will retry */ }
    if (context.state === 'running') engines.forEach(({ engine }) => engine.syncSource());
  }

  static setMusicEnabled(enabled: boolean): void {
    if (this.musicEnabled === enabled) return;
    this.musicEnabled = enabled;
    this.activeEngines.forEach((engine) => engine.syncSource());
  }

  static playEffect(audioData: string): void {
    const context = this.sharedContext;
    if (!context || context.state === 'closed') return;
    void context.decodeAudioData(decodeBase64Audio(audioData)).then((buffer) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => source.disconnect();
      source.start();
    }).catch(() => {});
  }

  constructor(duration: number, bpm: number, audioUrl: string) {
    this.context = AudioEngine.sharedContext && AudioEngine.sharedContext.state !== 'closed'
      ? AudioEngine.sharedContext
      : createAudioContext();
    AudioEngine.sharedContext = this.context;
    this.connectGraph();
    AudioEngine.activeEngines.add(this);
    this.duration = duration;
    this.bpm = bpm;
    this.audioUrl = audioUrl;
  }

  private connectGraph(): void {
    this.gain = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.distortion = this.context.createWaveShaper();
    this.filter = this.context.createBiquadFilter();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.62;
    this.distortion.oversample = '2x';
    this.filter.type = 'lowpass';
    this.filter.frequency.value = this.context.sampleRate * 0.48;
    this.filter.Q.value = 0.0001;
    this.spectrumData = new Uint8Array(this.analyser.frequencyBinCount);
    this.gain.gain.value = 0.48;
    this.analyser.connect(this.gain);
    this.distortion.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(this.context.destination);
  }

  private disconnectGraph(): void {
    this.stopSource();
    this.analyser.disconnect();
    this.distortion.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }

  private replaceContext(context: AudioContext, time: number): void {
    this.disconnectGraph();
    this.context = context;
    this.startedAt = context.currentTime - time;
    if (this.isPaused) this.pausedAt = time;
    this.connectGraph();
  }

  async start(): Promise<void> {
    const track = this.loadTrack();
    await AudioEngine.unlock();
    const buffer = await track;
    if (this.stopped) return;
    this.buffer = buffer;
    this.startedAt = this.context.currentTime;
    this.pausedAt = 0;
    this.syncSource();
  }

  private stopSource(): void {
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.source?.disconnect();
    this.source = null;
  }

  /** Recreate the one-shot Web Audio source at the authoritative game time. */
  private syncSource(): void {
    this.stopSource();
    if (!AudioEngine.musicEnabled || !this.buffer || this.isPaused || this.stopped) return;
    const offset = this.currentTime;
    if (offset >= this.buffer.duration) return;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.analyser);
    source.start(0, offset);
    this.source = source;
  }

  private async loadTrack(): Promise<AudioBuffer> {
    try {
      return await this.context.decodeAudioData(decodeBase64Audio(this.audioUrl));
    } catch (error) {
      console.warn(t('warning.audioFallback'), error);
      return this.createTrack();
    }
  }

  private createTrack(): AudioBuffer {
    const rate = this.context.sampleRate;
    const length = Math.ceil(this.duration * rate);
    const buffer = this.context.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    const beatLength = 60 / this.bpm;
    const notes = [110, 130.81, 164.81, 196, 164.81, 130.81, 146.83, 196];
    let noiseSeed = 9317;

    for (let i = 0; i < length; i += 1) {
      const t = i / rate;
      const beatPhase = (t % beatLength) / beatLength;
      const eighthPhase = (t % (beatLength / 2)) / (beatLength / 2);
      const step = Math.floor(t / (beatLength * 2)) % notes.length;
      const bassFreq = notes[step];
      const kick = Math.sin(2 * Math.PI * (54 + 58 * (1 - beatPhase)) * t) *
        Math.exp(-beatPhase * 11);
      const bass = Math.sin(2 * Math.PI * bassFreq * t) *
        (0.55 + 0.45 * Math.sin(Math.PI * beatPhase));
      const leadGate = Math.max(0, 1 - eighthPhase * 3.8);
      const lead = Math.sin(2 * Math.PI * bassFreq * 4 * t + Math.sin(t * 5) * 0.7) * leadGate;
      noiseSeed = (noiseSeed * 16807) % 2147483647;
      const noise = (noiseSeed / 1073741823.5 - 1) * Math.exp(-eighthPhase * 28);
      const intro = Math.min(1, t / 1.2);
      const outro = Math.min(1, (this.duration - t) / 1.4);
      data[i] = (kick * 0.37 + bass * 0.15 + lead * 0.082 + noise * 0.045) * intro * outro;
    }
    return buffer;
  }

  get currentTime(): number {
    if (!this.buffer) return 0;
    if (this.isPaused) return this.pausedAt;
    return Math.min(this.duration, Math.max(0, this.context.currentTime - this.startedAt));
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get spectrum(): Uint8Array<ArrayBuffer> {
    this.analyser.getByteFrequencyData(this.spectrumData);
    return this.spectrumData;
  }

  async pause(): Promise<void> {
    if (this.isPaused) return;
    this.pausedAt = this.buffer ? this.currentTime : 0;
    this.isPaused = true;
    this.stopSource();
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    await AudioEngine.unlock();
    this.startedAt = this.context.currentTime - this.pausedAt;
    this.isPaused = false;
    this.syncSource();
  }

  crash(): void {
    if (this.crashing || !this.source) return;
    this.crashing = true;
    const now = this.context.currentTime;
    const end = now + 1.05;

    this.analyser.disconnect();
    this.analyser.connect(this.distortion);
    this.distortion.curve = createCrashDistortionCurve();
    this.source.playbackRate.cancelScheduledValues(now);
    this.source.playbackRate.setValueAtTime(Math.max(0.01, this.source.playbackRate.value), now);
    this.source.playbackRate.exponentialRampToValueAtTime(0.42, end);
    this.source.detune.cancelScheduledValues(now);
    this.source.detune.setValueAtTime(this.source.detune.value, now);
    this.source.detune.linearRampToValueAtTime(-500, end);

    this.filter.frequency.cancelScheduledValues(now);
    this.filter.frequency.setValueAtTime(this.context.sampleRate * 0.48, now);
    this.filter.frequency.exponentialRampToValueAtTime(280, end);
    this.filter.Q.cancelScheduledValues(now);
    this.filter.Q.setValueAtTime(0.0001, now);
    this.filter.Q.linearRampToValueAtTime(7, end * 0.78 + now * 0.22);

    if (this.gain.gain.value > 0) {
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.exponentialRampToValueAtTime(0.0001, end);
    }
  }

  stop(): void {
    this.stopped = true;
    this.disconnectGraph();
    AudioEngine.activeEngines.delete(this);
    if (AudioEngine.activeEngines.size === 0 && AudioEngine.sharedContext === this.context) {
      const context = this.context;
      AudioEngine.sharedContext = null;
      void context.close().catch(() => {});
    }
  }
}
