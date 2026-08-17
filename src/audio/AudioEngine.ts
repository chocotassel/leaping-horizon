import { t } from '../i18n';

type WindowWithWebkitAudio = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

/** 加载关卡音频；资源不可用时退回本地合成音轨。 */
export class AudioEngine {
  private static sharedContext: AudioContext | null = null;
  private static musicEnabled = false;
  private static activeGains = new Set<GainNode>();
  private context: AudioContext;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private spectrumData: Uint8Array<ArrayBuffer>;
  private startedAt = 0;
  private pausedAt = 0;
  private isPaused = false;
  private readonly duration: number;
  private readonly bpm: number;
  private readonly audioUrl: string;
  private stopped = false;

  /** 必须从用户点击回调直接调用，以满足移动浏览器的音频播放策略。 */
  static async unlock(): Promise<void> {
    if (!this.sharedContext || this.sharedContext.state === 'closed') {
      const AudioContextClass = window.AudioContext ||
        (window as WindowWithWebkitAudio).webkitAudioContext;
      if (!AudioContextClass) return;
      this.sharedContext = new AudioContextClass({ latencyHint: 'interactive', sampleRate: 22050 });
    }
    if (this.sharedContext.state === 'suspended') await this.sharedContext.resume();
  }

  static setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    this.activeGains.forEach((gain) => {
      gain.gain.setValueAtTime(enabled ? 0.48 : 0, gain.context.currentTime);
    });
  }

  constructor(duration: number, bpm: number, audioUrl: string) {
    const AudioContextClass = window.AudioContext ||
      (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AudioContextClass) throw new Error(t('error.webAudioUnsupported'));
    this.context = AudioEngine.sharedContext && AudioEngine.sharedContext.state !== 'closed'
      ? AudioEngine.sharedContext
      : new AudioContextClass({ latencyHint: 'interactive', sampleRate: 22050 });
    AudioEngine.sharedContext = this.context;
    this.gain = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.62;
    this.spectrumData = new Uint8Array(this.analyser.frequencyBinCount);
    this.gain.gain.value = AudioEngine.musicEnabled ? 0.48 : 0;
    AudioEngine.activeGains.add(this.gain);
    this.analyser.connect(this.gain);
    this.gain.connect(this.context.destination);
    this.duration = duration;
    this.bpm = bpm;
    this.audioUrl = audioUrl;
  }

  async start(): Promise<void> {
    if (this.context.state === 'suspended') void this.context.resume();
    const buffer = await this.loadTrack();
    if (this.stopped) return;
    this.source = this.context.createBufferSource();
    this.source.buffer = buffer;
    this.source.connect(this.analyser);
    this.source.start();
    this.startedAt = this.context.currentTime;
    this.pausedAt = 0;
    this.isPaused = false;
  }

  private async loadTrack(): Promise<AudioBuffer> {
    try {
      const response = await fetch(this.audioUrl);
      if (!response.ok) throw new Error(t('error.httpStatus', { status: response.status }));
      return await this.context.decodeAudioData(await response.arrayBuffer());
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
    this.pausedAt = this.currentTime;
    this.isPaused = true;
    await this.context.suspend();
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;
    await this.context.resume();
    this.startedAt = this.context.currentTime - this.pausedAt;
    this.isPaused = false;
  }

  stop(): void {
    this.stopped = true;
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.source?.disconnect();
    this.analyser.disconnect();
    this.gain.disconnect();
    AudioEngine.activeGains.delete(this.gain);
    this.source = null;
  }
}
