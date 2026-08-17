import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Level } from '../types';
import { albumArtworkStyle } from '../assets/ui/albumArtwork';

interface HomeScreenProps {
  level: Level;
  levels: readonly Level[];
  musicEnabled: boolean;
  onSelectLevel: (levelId: string) => void;
  onPrepareStart: () => void;
  onToggleMusic: () => void;
  onStart: () => void;
}

type SwitchDirection = 'next' | 'previous';

function durationLabel(level: Level): string {
  const duration = Math.ceil(level.song.durationSeconds);
  return `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
}

function artistLabel(level: Level): string {
  return level.song.artist.trim().toLowerCase() === 'unknown artist'
    ? '未知音乐人'
    : level.song.artist;
}

function VinylDisc() {
  return (
    <span className="vinyl-disc" aria-hidden="true">
      <i className="vinyl-pulse-ring" />
      <i className="vinyl-label"><span className="label-flight-path" /></i>
    </span>
  );
}

export function HomeScreen({
  level,
  levels,
  musicEnabled,
  onSelectLevel,
  onPrepareStart,
  onToggleMusic,
  onStart,
}: HomeScreenProps) {
  const startTimerRef = useRef<number | null>(null);
  const switchTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const [switchDirection, setSwitchDirection] = useState<SwitchDirection | null>(null);
  const dragRef = useRef({ pointerId: -1, startX: 0, moved: false });
  const activeIndex = Math.max(0, levels.findIndex((option) => option.id === level.id));
  const previousLevel = levels[(activeIndex - 1 + levels.length) % levels.length];
  const nextLevel = levels[(activeIndex + 1) % levels.length];

  useEffect(() => () => {
    if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
    if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
  }, []);

  const selectWithTransition = (levelId: string, direction: SwitchDirection) => {
    if (starting || switchDirection || levelId === level.id) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onSelectLevel(levelId);
      return;
    }
    setSwitchDirection(direction);
    switchTimerRef.current = window.setTimeout(() => {
      onSelectLevel(levelId);
      switchTimerRef.current = null;
      setSwitchDirection(null);
    }, 600);
  };

  const handleStart = () => {
    if (starting || switchDirection) return;
    onPrepareStart();
    setStarting(true);
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 80 : 720;
    startTimerRef.current = window.setTimeout(() => {
      startTimerRef.current = null;
      onStart();
    }, delay);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > 8) drag.moved = true;
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current.pointerId = -1;
    if (event.type === 'pointercancel') return;
    if (!drag.moved) return;
    suppressClickRef.current = true;
    const direction = event.clientX < drag.startX ? 'next' : 'previous';
    selectWithTransition(direction === 'next' ? nextLevel.id : previousLevel.id, direction);
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  return (
    <main className="screen song-select-screen">
      <header className="shell-header">
        <strong>跃动地平线</strong>
      </header>

      <section className="song-select-heading">
        <h1>选择歌曲</h1>
        <button
          className={`header-music-button ${musicEnabled ? 'is-enabled' : ''}`}
          type="button"
          aria-pressed={musicEnabled}
          onClick={onToggleMusic}
        >
          <span aria-hidden="true">♪</span>
          音乐 {musicEnabled ? '开' : '关'}
          <i aria-hidden="true" />
        </button>
        <span>{String(activeIndex + 1).padStart(2, '0')} / {String(levels.length).padStart(2, '0')}</span>
      </section>

      <section
        className={`vinyl-stage ${starting ? 'is-starting' : ''} ${switchDirection ? `is-switching-${switchDirection}` : ''}`}
        aria-label="左右滑动选择歌曲"
      >
        <div
          className="vinyl-deck"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerDrag}
          onPointerCancel={finishPointerDrag}
        >
          <button
            className="vinyl-peek vinyl-peek-previous"
            key={`previous-${level.id}`}
            type="button"
            aria-label={`上一首：${previousLevel.song.title}`}
            style={albumArtworkStyle(previousLevel.id)}
            onClick={() => {
              if (!suppressClickRef.current) selectWithTransition(previousLevel.id, 'previous');
            }}
          >
            <VinylDisc />
          </button>

          <div className="vinyl-current" key={level.id} style={albumArtworkStyle(level.id)}>
            <VinylDisc />
          </div>

          <button
            className="vinyl-peek vinyl-peek-next"
            key={`next-${level.id}`}
            type="button"
            aria-label={`下一首：${nextLevel.song.title}`}
            style={albumArtworkStyle(nextLevel.id)}
            onClick={() => {
              if (!suppressClickRef.current) selectWithTransition(nextLevel.id, 'next');
            }}
          >
            <VinylDisc />
          </button>

          <div className="orbit-scanner" aria-hidden="true"><i><span /></i></div>
        </div>

        <div className="vinyl-track-details">
          <div className="song-position" aria-label={`第 ${activeIndex + 1} 首，共 ${levels.length} 首`}>
            <i aria-hidden="true" />
            <strong>{String(activeIndex + 1).padStart(2, '0')}</strong>
            <span>/ {String(levels.length).padStart(2, '0')}</span>
            <i aria-hidden="true" />
          </div>
          <div className="vinyl-track-copy">
            <strong>{level.song.title}</strong>
            <small>{artistLabel(level)}</small>
            <span>{level.song.bpm} BPM <i /> {durationLabel(level)}</span>
          </div>
        </div>
      </section>

      <section
        className="selected-track-summary"
        style={albumArtworkStyle(level.id)}
      >
        <span className="selected-track-art" aria-hidden="true"><i /></span>
        <div className="selected-track-copy">
          <strong>{level.song.title}</strong>
          <small>{artistLabel(level)}</small>
        </div>
        <span className={`summary-equalizer ${musicEnabled ? 'is-enabled' : ''}`} aria-hidden="true">
          <i /><i /><i /><i /><i /><i />
        </span>
      </section>

      <button
        className="shell-primary-button song-start-button"
        type="button"
        aria-busy={starting}
        disabled={starting || Boolean(switchDirection)}
        onClick={handleStart}
      >
        {starting ? '正在落针' : '开始游戏'}
      </button>
    </main>
  );
}
