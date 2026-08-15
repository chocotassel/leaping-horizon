import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import levelCollection from '../levels/slice-at-two.levels.json';
import type { Level } from '../types';

interface MatchMetrics {
  toleranceMs: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
  meanAbsoluteErrorMs: number | null;
}

interface RhythmEvent {
  timeSeconds: number;
  confidence: number;
  sources?: string[];
}

interface RhythmTrack {
  id: string;
  name: string;
  description: string;
  kind: string;
  color: string;
  eventCount: number;
  eventsPerMinute: number;
  medianIntervalSeconds: number | null;
  metrics: {
    at50ms: MatchMetrics;
    at80ms: MatchMetrics;
    at120ms: MatchMetrics;
  };
  events: RhythmEvent[];
}

interface RhythmAnalysis {
  timingPolicy: string;
  primaryTrackId: string;
  song: {
    title: string;
    artist: string;
    audioUrl: string;
    durationSeconds: number;
  };
  waveform: { peaks: number[] };
  labels: {
    count: number;
    possibleDuplicateMarkerIndices: number[];
    markersWithoutCandidateWithin150ms: number[];
    policy: string;
  };
  models: Array<{
    id: string;
    name: string;
    version: string | null;
    available: boolean;
    eventCount?: number;
  }>;
  preferenceModel: {
    blockedCrossValidationFolds?: number;
    selectedThreshold?: number;
    minimumGapMs?: number;
    timingPolicy?: string;
  };
  tracks: RhythmTrack[];
}

const levels = (levelCollection as unknown as { levels: Record<string, Level> }).levels;
const WINDOW_SECONDS = 5;

function formatTime(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function RhythmLabApp() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clickContextRef = useRef<AudioContext | null>(null);
  const previousAudioTimeRef = useRef(0);
  const [analysis, setAnalysis] = useState<RhythmAnalysis | null>(null);
  const [activeTrackId, setActiveTrackId] = useState('preference-fusion');
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [clickEnabled, setClickEnabled] = useState(true);
  const [showReference, setShowReference] = useState(true);
  const [pulse, setPulse] = useState(0);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void fetch('/analysis/slice-at-two.rhythm-analysis.json')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<RhythmAnalysis>;
      })
      .then((payload) => {
        if (cancelled) return;
        setAnalysis(payload);
        setActiveTrackId(payload.primaryTrackId);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, []);

  const activeTrack = useMemo(
    () => analysis?.tracks.find((track) => track.id === activeTrackId) ?? analysis?.tracks[0],
    [activeTrackId, analysis],
  );
  const humanTrack = useMemo(
    () => analysis?.tracks.find((track) => track.id === 'human-reference'),
    [analysis],
  );
  const activeLevel = activeTrack ? levels[activeTrack.id] : undefined;

  const playClick = useCallback((confidence: number) => {
    if (!clickEnabled) return;
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return;
    const context = clickContextRef.current ?? new AudioContextClass({ latencyHint: 'interactive' });
    clickContextRef.current = context;
    if (context.state === 'suspended') void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 760 + confidence * 460;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.055 + confidence * 0.045, context.currentTime + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.045);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.05);
  }, [clickEnabled]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => {
      previousAudioTimeRef.current = audio.currentTime;
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onSeeked = () => {
      previousAudioTimeRef.current = audio.currentTime;
      setCurrentTime(audio.currentTime);
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onPause);
    audio.addEventListener('seeked', onSeeked);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onPause);
      audio.removeEventListener('seeked', onSeeked);
    };
  }, [analysis]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !playing || !activeTrack) return;
    let frame = 0;
    const update = () => {
      const now = audio.currentTime;
      const previous = previousAudioTimeRef.current;
      if (now >= previous && now - previous < 0.25) {
        const crossed = activeTrack.events.filter((event) => event.timeSeconds > previous && event.timeSeconds <= now);
        if (crossed.length) {
          playClick(Math.max(...crossed.map((event) => event.confidence)));
          setPulse((value) => value + 1);
        }
      }
      previousAudioTimeRef.current = now;
      setCurrentTime(now);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [activeTrack, playClick, playing]);

  const drawTimeline = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analysis || !activeTrack) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#0a0e18';
    context.fillRect(0, 0, width, height);

    const peaks = analysis.waveform.peaks;
    context.strokeStyle = '#2d374a';
    context.lineWidth = Math.max(1, ratio);
    context.beginPath();
    peaks.forEach((peak, index) => {
      const x = index / Math.max(1, peaks.length - 1) * width;
      const half = peak * height * 0.34;
      context.moveTo(x, height / 2 - half);
      context.lineTo(x, height / 2 + half);
    });
    context.stroke();

    if (showReference && humanTrack && humanTrack.id !== activeTrack.id) {
      context.strokeStyle = 'rgba(244,247,255,.45)';
      context.lineWidth = ratio;
      for (const event of humanTrack.events) {
        const x = event.timeSeconds / analysis.song.durationSeconds * width;
        context.beginPath();
        context.moveTo(x, height * 0.69);
        context.lineTo(x, height);
        context.stroke();
      }
    }

    context.strokeStyle = activeTrack.color;
    context.lineWidth = Math.max(1, ratio * 1.25);
    for (const event of activeTrack.events) {
      const x = event.timeSeconds / analysis.song.durationSeconds * width;
      context.globalAlpha = 0.32 + event.confidence * 0.68;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height * 0.68);
      context.stroke();
    }
    context.globalAlpha = 1;
    const playhead = currentTime / analysis.song.durationSeconds * width;
    context.fillStyle = '#fff';
    context.fillRect(playhead - ratio, 0, ratio * 2, height);
  }, [activeTrack, analysis, currentTime, humanTrack, showReference]);

  useEffect(() => {
    drawTimeline();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(drawTimeline);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawTimeline]);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (clickContextRef.current?.state === 'suspended') await clickContextRef.current.resume();
      await audio.play();
    } else {
      audio.pause();
    }
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio || !analysis) return;
    audio.currentTime = Math.max(0, Math.min(analysis.song.durationSeconds, time));
    previousAudioTimeRef.current = audio.currentTime;
    setCurrentTime(audio.currentTime);
  }, [analysis]);

  const seekFromTimeline = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!analysis) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seek((event.clientX - rect.left) / rect.width * analysis.song.durationSeconds);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('button, a, input, select, textarea')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void togglePlayback();
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        seek(currentTime - 5);
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        seek(currentTime + 5);
      } else if (event.key.toLowerCase() === 'c') {
        setClickEnabled((value) => !value);
      } else if (/^[1-9]$/.test(event.key) && analysis) {
        const track = analysis.tracks[Number(event.key) - 1];
        if (track) setActiveTrackId(track.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [analysis, currentTime, seek, togglePlayback]);

  const nearbyEvents = useMemo(() => activeLevel?.events.filter((event) => (
    event.timeSeconds >= currentTime - 0.35 && event.timeSeconds <= currentTime + WINDOW_SECONDS
  )) ?? [], [activeLevel, currentTime]);
  const nextEvents = useMemo(() => activeTrack?.events.filter((event) => event.timeSeconds >= currentTime).slice(0, 5) ?? [], [activeTrack, currentTime]);

  if (loadError) {
    return <main className="lab-loading"><strong>分析结果加载失败</strong><span>{loadError}</span></main>;
  }
  if (!analysis || !activeTrack) {
    return <main className="lab-loading"><span className="lab-spinner" /><strong>正在载入真实模型结果…</strong></main>;
  }

  const activeStyle = { '--active-track': activeTrack.color } as CSSProperties;
  return (
    <main className="rhythm-lab" style={activeStyle}>
      <audio ref={audioRef} src={analysis.song.audioUrl} preload="auto" />
      <header className="lab-header">
        <div>
          <p>NEON SLICE · RHYTHM LAB</p>
          <h1>节奏算法试听室</h1>
          <span>听同一段音乐，切换算法，直接感受障碍会在什么时候抵达。</span>
        </div>
        <nav><a href="/beat-marker.html">重新标注</a><a href="/">返回游戏</a></nav>
      </header>

      <section className="lab-model-strip" aria-label="模型运行状态">
        {analysis.models.map((model) => (
          <span key={model.id} className={model.available ? 'is-ready' : 'is-failed'}>
            <i />{model.name} {model.version ? `v${model.version}` : ''}
          </span>
        ))}
        <b>全部事件保持原始秒数 · 0 次网格吸附</b>
      </section>

      <div className="lab-layout">
        <aside className="lab-track-list">
          <div className="lab-section-title"><span>01</span><strong>选择结果</strong></div>
          {analysis.tracks.map((track, index) => (
            <button
              key={track.id}
              type="button"
              className={`lab-track-card ${track.id === activeTrack.id ? 'is-active' : ''}`}
              style={{ '--track-color': track.color } as CSSProperties}
              onClick={() => {
                setActiveTrackId(track.id);
                previousAudioTimeRef.current = audioRef.current?.currentTime ?? currentTime;
              }}
            >
              <span className="track-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="track-copy"><strong>{track.name}</strong><small>{track.description}</small></span>
              <span className="track-count"><b>{track.eventCount}</b><small>事件</small></span>
              {track.kind === 'recommended' && <em>推荐</em>}
            </button>
          ))}
        </aside>

        <section className="lab-stage">
          <div className="lab-now">
            <div><span>当前方案</span><strong>{activeTrack.name}</strong><small>{activeTrack.description}</small></div>
            <a href={`/?algorithm=${encodeURIComponent(activeTrack.id)}`}>用这个方案试玩</a>
          </div>

          <div className={`lab-runway ${pulse % 2 ? 'pulse-a' : 'pulse-b'}`} aria-label="未来五秒障碍预览">
            <div className="runway-glow" />
            {[0, 1, 2, 3, 4].map((lane) => <i key={lane} className="runway-lane" style={{ left: `${lane * 20}%` }} />)}
            <div className="runway-hit-line"><span>NOW</span></div>
            {nearbyEvents.map((event, eventIndex) => {
              const delta = event.timeSeconds - currentTime;
              const bottom = 13 + delta / WINDOW_SECONDS * 78;
              return event.obstacles.map((type, lane) => type ? (
                <span
                  key={`${event.timeSeconds}-${eventIndex}-${lane}`}
                  className={`runway-event ${type === 2 ? 'is-spike' : 'is-block'} ${Math.abs(delta) < 0.065 ? 'is-hit' : ''}`}
                  style={{ left: `calc(${lane * 20}% + 2.5%)`, bottom: `${bottom}%` }}
                />
              ) : null);
            })}
            <div className="runway-disc" />
          </div>

          <div className="lab-time-row"><strong>{formatTime(currentTime)}</strong><span>{formatTime(analysis.song.durationSeconds)}</span></div>
          <canvas ref={canvasRef} className="lab-waveform" onPointerDown={seekFromTimeline} />
          <div className="lab-legend">
            <span><i style={{ background: activeTrack.color }} />{activeTrack.name}</span>
            {showReference && activeTrack.id !== 'human-reference' && <span><i className="is-reference" />人工标注参考</span>}
          </div>

          <div className="lab-controls">
            <button type="button" onClick={() => seek(currentTime - 5)}>−5s</button>
            <button type="button" className="lab-play" onClick={() => void togglePlayback()}>{playing ? 'Ⅱ 暂停' : '▶ 播放并试听'}</button>
            <button type="button" onClick={() => seek(currentTime + 5)}>+5s</button>
            <button type="button" className={clickEnabled ? 'is-on' : ''} onClick={() => setClickEnabled((value) => !value)}>障碍提示音 {clickEnabled ? '开' : '关'}</button>
            <button type="button" className={showReference ? 'is-on' : ''} onClick={() => setShowReference((value) => !value)}>人工参考线 {showReference ? '开' : '关'}</button>
          </div>

          <div className="lab-next-events">
            <span>接下来</span>
            {nextEvents.map((event) => <button key={event.timeSeconds} type="button" onClick={() => seek(event.timeSeconds - 0.5)}>{formatTime(event.timeSeconds)}</button>)}
          </div>
        </section>

        <aside className="lab-inspector">
          <div className="lab-section-title"><span>02</span><strong>这一版的感觉</strong></div>
          <div className="lab-metrics">
            <div><span>事件数量</span><strong>{activeTrack.eventCount}</strong><small>{activeTrack.eventsPerMinute} / 分钟</small></div>
            <div><span>中位间隔</span><strong>{activeTrack.medianIntervalSeconds?.toFixed(3) ?? '—'}</strong><small>秒</small></div>
            <div><span>与手标相似度</span><strong>{percent(activeTrack.metrics.at80ms.f1)}</strong><small>±80ms F1</small></div>
            <div><span>宽松召回</span><strong>{percent(activeTrack.metrics.at120ms.recall)}</strong><small>±120ms</small></div>
          </div>
          <p className="lab-metric-note">相似度只是和这一遍人工点击比较，不代表音乐上的绝对正确。请优先相信实际听感。</p>

          <div className="lab-section-title lab-diagnostics-title"><span>03</span><strong>标注诊断</strong></div>
          <div className="lab-diagnostic">
            <b>{analysis.labels.count}</b><span>个人节奏点参与比较</span>
          </div>
          <div className="lab-diagnostic warning">
            <b>{analysis.labels.possibleDuplicateMarkerIndices.length}</b><span>个过近点击只标记存疑，未删除</span>
          </div>
          <div className="lab-diagnostic good">
            <b>{analysis.labels.markersWithoutCandidateWithin150ms.length}</b><span>个点击附近完全没有音频候选</span>
          </div>

          <div className="lab-recommendation">
            <span>当前默认</span>
            <strong>偏好融合</strong>
            <p>它只负责从现成模型事件中选择；不会移动事件，也不会补成等间隔节拍。</p>
          </div>
        </aside>
      </div>

      <footer className="lab-footer">
        <span><kbd>Space</kbd> 播放 / 暂停</span><span><kbd>1–6</kbd> 切换方案</span><span><kbd>← →</kbd> 前后 5 秒</span><span><kbd>C</kbd> 提示音</span>
      </footer>
    </main>
  );
}
