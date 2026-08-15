import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { DEMO_LEVEL } from '../chart';

interface BeatMarker {
  captureOrder: number;
  timeSeconds: number;
  performanceMilliseconds: number;
}

interface StoredSession {
  schemaVersion: 1;
  markers: BeatMarker[];
}

const STORAGE_KEY = `neon-slice:human-beats:${DEMO_LEVEL.id}`;
const MIN_MARKER_GAP_SECONDS = 0.06;
const WAVEFORM_BUCKETS = 960;

function round(value: number, digits = 5): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return '0:00.000';
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`;
}

function loadStoredMarkers(): BeatMarker[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const stored = JSON.parse(raw) as StoredSession;
    if (stored.schemaVersion !== 1 || !Array.isArray(stored.markers)) return [];
    return stored.markers.filter((marker) => (
      Number.isFinite(marker.captureOrder) &&
      Number.isFinite(marker.timeSeconds) &&
      Number.isFinite(marker.performanceMilliseconds)
    ));
  } catch {
    return [];
  }
}

export function BeatMarkerApp() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const firstTapPerformanceRef = useRef<number | null>(null);
  const [markers, setMarkers] = useState<BeatMarker[]>(loadStoredMarkers);
  const [duration, setDuration] = useState(DEMO_LEVEL.song.durationSeconds);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waveform, setWaveform] = useState<Float32Array | null>(null);
  const [message, setMessage] = useState(markers.length
    ? `已恢复 ${markers.length} 个未导出的节奏点。`
    : '点击播放，从你第一次想按空格的地方开始。');

  const chronologicalMarkers = useMemo(
    () => [...markers].sort((a, b) => a.timeSeconds - b.timeSeconds),
    [markers],
  );

  const intervalStats = useMemo(() => {
    const intervals = chronologicalMarkers
      .slice(1)
      .map((marker, index) => marker.timeSeconds - chronologicalMarkers[index].timeSeconds)
      .filter((interval) => interval >= 0.12 && interval <= 4);
    if (!intervals.length) return null;
    const sorted = [...intervals].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
    return { median, shortest: sorted[0], longest: sorted[sorted.length - 1] };
  }, [chronologicalMarkers]);

  useEffect(() => {
    const session: StoredSession = { schemaVersion: 1, markers };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }, [markers]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const updateTime = () => setCurrentTime(audio.currentTime);
    const updateDuration = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    const handleEnded = () => {
      setPlaying(false);
      setMessage(`播放结束，共记录 ${markers.length} 个节奏点。可以导出文件了。`);
    };
    audio.addEventListener('loadedmetadata', updateDuration);
    audio.addEventListener('durationchange', updateDuration);
    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    return () => {
      audio.removeEventListener('loadedmetadata', updateDuration);
      audio.removeEventListener('durationchange', updateDuration);
      audio.removeEventListener('timeupdate', updateTime);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [markers.length]);

  useEffect(() => {
    if (!playing) return;
    let frameId = 0;
    const update = () => {
      if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
      frameId = requestAnimationFrame(update);
    };
    frameId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frameId);
  }, [playing]);

  useEffect(() => {
    let cancelled = false;
    const buildWaveform = async () => {
      try {
        const response = await fetch(DEMO_LEVEL.song.audioUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const AudioContextClass = window.AudioContext;
        const context = new AudioContextClass({ sampleRate: 22050 });
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const samples = buffer.getChannelData(0);
        const peaks = new Float32Array(WAVEFORM_BUCKETS);
        const bucketSize = Math.max(1, Math.floor(samples.length / WAVEFORM_BUCKETS));
        for (let bucket = 0; bucket < WAVEFORM_BUCKETS; bucket += 1) {
          const start = bucket * bucketSize;
          const end = Math.min(samples.length, start + bucketSize);
          let peak = 0;
          for (let index = start; index < end; index += 1) {
            peak = Math.max(peak, Math.abs(samples[index]));
          }
          peaks[bucket] = peak;
        }
        await context.close();
        if (!cancelled) setWaveform(peaks);
      } catch {
        if (!cancelled) setMessage('波形加载失败，但播放和节奏记录仍然可以正常使用。');
      }
    };
    void buildWaveform();
    return () => { cancelled = true; };
  }, []);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#0c101b';
    context.fillRect(0, 0, width, height);

    context.strokeStyle = 'rgba(255,255,255,0.055)';
    context.lineWidth = pixelRatio;
    for (let part = 1; part < 8; part += 1) {
      const x = (part / 8) * width;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }

    if (waveform) {
      context.strokeStyle = '#45526b';
      context.lineWidth = Math.max(1, pixelRatio);
      context.beginPath();
      waveform.forEach((peak, index) => {
        const x = (index / (waveform.length - 1)) * width;
        const halfHeight = Math.max(1, peak * height * 0.43);
        context.moveTo(x, height / 2 - halfHeight);
        context.lineTo(x, height / 2 + halfHeight);
      });
      context.stroke();
    }

    if (duration > 0) {
      chronologicalMarkers.forEach((marker, index) => {
        const x = (marker.timeSeconds / duration) * width;
        context.strokeStyle = index === chronologicalMarkers.length - 1 ? '#ff4f9a' : '#36e7ef';
        context.lineWidth = index === chronologicalMarkers.length - 1 ? pixelRatio * 2 : pixelRatio;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      });

      const playheadX = (currentTime / duration) * width;
      context.strokeStyle = '#f7fbff';
      context.lineWidth = pixelRatio * 2;
      context.beginPath();
      context.moveTo(playheadX, 0);
      context.lineTo(playheadX, height);
      context.stroke();
    }
  }, [chronologicalMarkers, currentTime, duration, waveform]);

  useEffect(() => {
    drawWaveform();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(drawWaveform);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawWaveform]);

  const captureMarker = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused || audio.ended) {
      setMessage('音乐还没有播放。请先点击“播放音乐”，再用空格记录。');
      return;
    }
    const timeSeconds = round(audio.currentTime);
    const previous = markers[markers.length - 1];
    if (previous && Math.abs(previous.timeSeconds - timeSeconds) < MIN_MARKER_GAP_SECONDS) return;
    const now = performance.now();
    if (firstTapPerformanceRef.current === null) firstTapPerformanceRef.current = now;
    const marker: BeatMarker = {
      captureOrder: (previous?.captureOrder ?? 0) + 1,
      timeSeconds,
      performanceMilliseconds: round(now - firstTapPerformanceRef.current, 2),
    };
    setMarkers((current) => [...current, marker]);
    setMessage(`已记录第 ${marker.captureOrder} 个节奏点：${formatTime(timeSeconds)}`);
  }, [markers]);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setMessage(`已暂停在 ${formatTime(audio.currentTime)}。`);
      return;
    }
    if (audio.ended || audio.currentTime >= duration - 0.02) audio.currentTime = 0;
    try {
      await audio.play();
      setMessage('正在播放：听到你认为应该出现障碍的位置，就按空格。');
    } catch {
      setMessage('浏览器阻止了播放，请再次点击播放按钮。');
    }
  }, [duration]);

  const undoMarker = useCallback(() => {
    setMarkers((current) => {
      if (!current.length) return current;
      const removed = current[current.length - 1];
      setMessage(`已撤销 ${formatTime(removed.timeSeconds)} 的节奏点。`);
      return current.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        captureMarker();
      } else if (event.code === 'Enter') {
        event.preventDefault();
        void togglePlayback();
      } else if (event.code === 'Backspace') {
        event.preventDefault();
        undoMarker();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [captureMarker, togglePlayback, undoMarker]);

  const restartAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    setCurrentTime(0);
    setMessage('已回到歌曲开头，已有节奏点不会被清除。');
  };

  const clearMarkers = () => {
    if (!markers.length) return;
    if (!window.confirm(`确定清空全部 ${markers.length} 个节奏点吗？此操作无法撤销。`)) return;
    setMarkers([]);
    firstTapPerformanceRef.current = null;
    localStorage.removeItem(STORAGE_KEY);
    setMessage('节奏点已清空，可以重新标注。');
  };

  const seekFromPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  };

  const seekWithKeyboard = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const audio = audioRef.current;
    if (!audio || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -2 : 2;
    audio.currentTime = Math.min(duration, Math.max(0, audio.currentTime + delta));
    setCurrentTime(audio.currentTime);
  };

  const seekToMarker = (timeSeconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = timeSeconds;
    setCurrentTime(timeSeconds);
  };

  const exportMarkers = () => {
    if (!markers.length) return;
    const sortedMarkers = [...markers].sort((a, b) => a.timeSeconds - b.timeSeconds);
    const firstPerformance = Math.min(...markers.map((marker) => marker.performanceMilliseconds));
    const payload = {
      schemaVersion: 1,
      kind: 'human-rhythm-markers',
      createdAt: new Date().toISOString(),
      song: {
        levelId: DEMO_LEVEL.id,
        title: DEMO_LEVEL.song.title,
        artist: DEMO_LEVEL.song.artist,
        audioUrl: DEMO_LEVEL.song.audioUrl,
        durationSeconds: round(duration),
        existingReferenceBpm: DEMO_LEVEL.song.bpm,
      },
      capture: {
        tool: 'neon-slice-beat-marker',
        input: 'keyboard-space-or-screen-button',
        clock: 'HTMLMediaElement.currentTime',
        playbackRate: audioRef.current?.playbackRate ?? 1,
        markerCount: markers.length,
        note: 'These are raw subjective taps. No latency correction or beat quantization has been applied.',
      },
      markers: sortedMarkers.map((marker, index) => ({
        index: index + 1,
        captureOrder: marker.captureOrder,
        timeSeconds: round(marker.timeSeconds),
        intervalFromPreviousSeconds: index
          ? round(marker.timeSeconds - sortedMarkers[index - 1].timeSeconds)
          : null,
        elapsedSinceFirstTapMilliseconds: round(marker.performanceMilliseconds - firstPerformance, 2),
      })),
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${DEMO_LEVEL.id}.human-beats.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setMessage(`已导出 ${markers.length} 个节奏点。把下载的 JSON 文件发给我即可。`);
  };

  return (
    <main className="marker-app">
      <audio ref={audioRef} src={DEMO_LEVEL.song.audioUrl} preload="auto" />

      <header className="marker-header">
        <div>
          <p className="marker-kicker">NEON SLICE · TEMP TOOL</p>
          <h1>人工节奏标注器</h1>
          <p>不必考虑现有 BPM 或算法。只在你主观认为“这里应该出现障碍”时按下空格。</p>
        </div>
        <a href="/" className="marker-back">返回游戏</a>
      </header>

      <section className="marker-song" aria-label="当前歌曲">
        <div className="marker-cover">S<span>//</span>D</div>
        <div>
          <span>当前音乐</span>
          <strong>{DEMO_LEVEL.song.title}</strong>
          <small>{DEMO_LEVEL.song.artist} · {formatTime(duration)}</small>
        </div>
        <div className={`marker-state ${playing ? 'is-playing' : ''}`}>
          <i />{playing ? '播放中' : '已暂停'}
        </div>
      </section>

      <section className="marker-workbench">
        <div className="marker-timeline-head">
          <strong>{formatTime(currentTime)}</strong>
          <span>{formatTime(duration)}</span>
        </div>
        <canvas
          ref={canvasRef}
          className="marker-waveform"
          role="slider"
          tabIndex={0}
          aria-label="歌曲时间轴，可点击跳转"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          onPointerDown={seekFromPointer}
          onKeyDown={seekWithKeyboard}
        />
        <div className="marker-controls">
          <button type="button" className="marker-control secondary" onClick={(event) => { event.currentTarget.blur(); restartAudio(); }}>
            ↺ 回到开头
          </button>
          <button type="button" className="marker-control primary" onClick={(event) => { event.currentTarget.blur(); void togglePlayback(); }}>
            {playing ? 'Ⅱ 暂停音乐' : '▶ 播放音乐'}
          </button>
          <button type="button" className="marker-control secondary" disabled={!markers.length} onClick={(event) => { event.currentTarget.blur(); undoMarker(); }}>
            ↶ 撤销上一个
          </button>
        </div>

        <button
          type="button"
          className={`marker-tap ${playing ? 'is-ready' : ''}`}
          onPointerDown={(event) => { event.currentTarget.blur(); captureMarker(); }}
        >
          <span>SPACE</span>
          <strong>按空格记录节奏点</strong>
          <small>{playing ? '现在可以开始点击' : '播放音乐后启用'}</small>
        </button>
        <p className="marker-message" aria-live="polite">{message}</p>
      </section>

      <section className="marker-results">
        <div className="marker-summary">
          <div><span>已记录</span><strong>{markers.length}</strong><small>个节奏点</small></div>
          <div><span>中位间隔</span><strong>{intervalStats ? intervalStats.median.toFixed(3) : '—'}</strong><small>秒</small></div>
          <div><span>建议数量</span><strong>{Math.min(markers.length, 40)} / 40</strong><small>{markers.length >= 40 ? '足够分析' : '至少标 40 个'}</small></div>
        </div>

        <div className="marker-list-head">
          <h2>最近记录</h2>
          <span>点击时间可回听</span>
        </div>
        <div className="marker-list">
          {!markers.length && <p>还没有记录。播放音乐后，跟着你的感觉按空格。</p>}
          {markers.slice(-10).reverse().map((marker, reverseIndex) => {
            const previous = markers[markers.length - reverseIndex - 2];
            const delta = previous ? marker.timeSeconds - previous.timeSeconds : null;
            return (
              <button type="button" key={marker.captureOrder} onClick={() => seekToMarker(marker.timeSeconds)}>
                <span>#{String(marker.captureOrder).padStart(3, '0')}</span>
                <strong>{formatTime(marker.timeSeconds)}</strong>
                <small>{delta === null ? 'FIRST' : `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s`}</small>
              </button>
            );
          })}
        </div>

        <div className="marker-export-row">
          <button type="button" className="marker-clear" disabled={!markers.length} onClick={clearMarkers}>清空全部</button>
          <button type="button" className="marker-export" disabled={!markers.length} onClick={exportMarkers}>
            下载节奏文件 JSON
          </button>
        </div>
        <p className="marker-save-note">记录会自动保存在这个浏览器中。建议完整听完一遍后再导出。</p>
      </section>

      <aside className="marker-shortcuts" aria-label="快捷键">
        <span><kbd>Space</kbd> 记录</span>
        <span><kbd>Enter</kbd> 播放 / 暂停</span>
        <span><kbd>Backspace</kbd> 撤销</span>
      </aside>
    </main>
  );
}
