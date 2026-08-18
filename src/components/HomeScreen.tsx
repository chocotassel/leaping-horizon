import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { isLevelUnlocked, type GameData } from '../data/localData';
import type { Level } from '../types';
import { albumArtworkStyle } from '../assets/ui/albumArtwork';
import { GameLaunchTimeoutError, waitForGameLaunch } from '../game/launchGate';
import { t } from '../i18n';
import { BrandHeader } from './BrandHeader';
import { StarRating } from './StarRating';

interface HomeScreenProps {
  level: Level;
  levels: readonly Level[];
  gameData: GameData;
  soundEnabled: boolean;
  onSelectLevel: (levelId: string) => void;
  onCancelStart: () => void;
  onPrepareStart: () => Promise<void>;
  onToggleSound: () => void;
  onStart: () => void;
}

type SwitchDirection = 'next' | 'previous';
type DragPosition = { direction: SwitchDirection; progress: number };

const SWITCH_DURATION_MS = 600;
const SWITCH_THRESHOLD = 0.2;

function durationLabel(level: Level): string {
  const duration = Math.ceil(level.song.durationSeconds);
  return `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
}

function artistLabel(level: Level): string {
  return level.song.artist.trim().toLowerCase() === 'unknown artist'
    ? t('songSelect.unknownArtist')
    : level.song.artist;
}

function VinylDisc({ locked = false }: { locked?: boolean }) {
  return (
    <span className={`vinyl-disc${locked ? ' is-locked' : ''}`} aria-hidden="true">
      <i className="vinyl-pulse-ring" />
      <i className="vinyl-label"><span className="label-flight-path" /></i>
      {locked && <i className="vinyl-lock" />}
    </span>
  );
}

export function HomeScreen({
  level,
  levels,
  gameData,
  soundEnabled,
  onSelectLevel,
  onCancelStart,
  onPrepareStart,
  onToggleSound,
  onStart,
}: HomeScreenProps) {
  const switchTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const launchAttemptRef = useRef(0);
  const [starting, setStarting] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [switchDirection, setSwitchDirection] = useState<SwitchDirection | null>(null);
  const [switchDuration, setSwitchDuration] = useState(SWITCH_DURATION_MS);
  const [dragPosition, setDragPosition] = useState<DragPosition | null>(null);
  const dragRef = useRef({
    pointerId: -1,
    startX: 0,
    moved: false,
    direction: 'next' as SwitchDirection,
    progress: 0,
  });
  const activeIndex = Math.max(0, levels.findIndex((option) => option.id === level.id));
  const previousLevel = levels[(activeIndex - 1 + levels.length) % levels.length];
  const nextLevel = levels[(activeIndex + 1) % levels.length];
  const unlocked = isLevelUnlocked(levels, level.id, gameData);
  const previousUnlocked = isLevelUnlocked(levels, previousLevel.id, gameData);
  const nextUnlocked = isLevelUnlocked(levels, nextLevel.id, gameData);
  const stars = gameData.levels[level.id]?.stars ?? 0;

  useEffect(() => () => {
    launchAttemptRef.current += 1;
    if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
  }, []);

  const selectWithTransition = (levelId: string, direction: SwitchDirection, progress = 0) => {
    if (starting || switchDirection) return;
    if (levelId === level.id) {
      setDragPosition(null);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDragPosition(null);
      onSelectLevel(levelId);
      return;
    }
    const duration = Math.max(120, Math.round(SWITCH_DURATION_MS * (1 - progress)));
    setSwitchDuration(duration);
    setSwitchDirection(direction);
    setDragPosition(null);
    switchTimerRef.current = window.setTimeout(() => {
      onSelectLevel(levelId);
      switchTimerRef.current = null;
      setSwitchDirection(null);
    }, duration);
  };

  const handleStart = async () => {
    if (!unlocked || starting || switchDirection) return;
    const attempt = ++launchAttemptRef.current;
    setStarting(true);
    setLaunchError(null);
    try {
      const minimumWait = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 80 : 720;
      await waitForGameLaunch(onPrepareStart(), minimumWait);
      if (attempt !== launchAttemptRef.current) return;
      onStart();
    } catch (error) {
      if (attempt !== launchAttemptRef.current) return;
      onCancelStart();
      setStarting(false);
      setLaunchError(t(
        error instanceof GameLaunchTimeoutError
          ? 'songSelect.startTimeout'
          : 'songSelect.startFailed',
      ));
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (starting || switchDirection || (event.pointerType === 'mouse' && event.button !== 0)) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      moved: false,
      direction: 'next',
      progress: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    const distance = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(distance) <= 8) return;
    drag.moved = true;
    drag.direction = distance < 0 ? 'next' : 'previous';
    drag.progress = Math.min(1, Math.abs(distance) / (event.currentTarget.clientWidth * 0.58));
    setDragPosition({ direction: drag.direction, progress: drag.progress });
    event.preventDefault();
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current.pointerId = -1;
    if (event.type === 'pointercancel' || !drag.moved) {
      setDragPosition(null);
      return;
    }
    suppressClickRef.current = true;
    if (drag.progress >= SWITCH_THRESHOLD) {
      selectWithTransition(
        drag.direction === 'next' ? nextLevel.id : previousLevel.id,
        drag.direction,
        drag.progress,
      );
    } else {
      setDragPosition(null);
    }
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  const progress = dragPosition?.progress ?? 0;
  const vinylStageStyle = {
    '--vinyl-switch-duration': `${switchDuration}ms`,
    ...(dragPosition?.direction === 'next' ? {
      '--vinyl-current-x': `${-105 * progress}%`,
      '--vinyl-current-scale': String(1 - 0.38 * progress),
      '--vinyl-current-opacity': String(1 - 0.54 * progress),
      '--vinyl-previous-x': `${-105 - 95 * progress}%`,
      '--vinyl-previous-scale': String(0.62 - 0.12 * progress),
      '--vinyl-previous-opacity': String(0.46 * (1 - progress)),
      '--vinyl-next-x': `${105 * (1 - progress)}%`,
      '--vinyl-next-scale': String(0.62 + 0.38 * progress),
      '--vinyl-next-opacity': String(0.46 + 0.54 * progress),
    } : dragPosition ? {
      '--vinyl-current-x': `${105 * progress}%`,
      '--vinyl-current-scale': String(1 - 0.38 * progress),
      '--vinyl-current-opacity': String(1 - 0.54 * progress),
      '--vinyl-previous-x': `${-105 * (1 - progress)}%`,
      '--vinyl-previous-scale': String(0.62 + 0.38 * progress),
      '--vinyl-previous-opacity': String(0.46 + 0.54 * progress),
      '--vinyl-next-x': `${105 + 95 * progress}%`,
      '--vinyl-next-scale': String(0.62 - 0.12 * progress),
      '--vinyl-next-opacity': String(0.46 * (1 - progress)),
    } : {}),
  } as CSSProperties;
  const navigationLocked = starting || Boolean(switchDirection) || Boolean(dragPosition);

  return (
    <main className="screen song-select-screen">
      <BrandHeader />

      <section className="song-select-heading">
        <h1>{t('songSelect.title')}</h1>
        <button
          className={`header-music-button ${soundEnabled ? 'is-enabled' : ''}`}
          type="button"
          aria-pressed={soundEnabled}
          onClick={onToggleSound}
        >
          <span aria-hidden="true">♪</span>
          <span className="header-music-label">
            {t('songSelect.musicToggle', { state: soundEnabled ? t('common.on') : t('common.off') })}
          </span>
          <i aria-hidden="true" />
        </button>
        <span>{String(activeIndex + 1).padStart(2, '0')} / {String(levels.length).padStart(2, '0')}</span>
      </section>

      <section
        className={`vinyl-stage ${starting ? 'is-starting' : ''} ${switchDirection ? `is-switching-${switchDirection}` : ''} ${dragPosition ? `is-dragging is-dragging-${dragPosition.direction}` : ''}`}
        aria-label={t('songSelect.gestureLabel')}
        style={vinylStageStyle}
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
            aria-label={t('songSelect.previousSong', { title: previousLevel.song.title })}
            style={albumArtworkStyle(previousLevel.id)}
            onClick={() => {
              if (!suppressClickRef.current) selectWithTransition(previousLevel.id, 'previous');
            }}
          >
            <VinylDisc locked={!previousUnlocked} />
          </button>

          <div className="vinyl-current" key={level.id} style={albumArtworkStyle(level.id)}>
            <VinylDisc locked={!unlocked} />
          </div>

          <button
            className="vinyl-peek vinyl-peek-next"
            key={`next-${level.id}`}
            type="button"
            aria-label={t('songSelect.nextSong', { title: nextLevel.song.title })}
            style={albumArtworkStyle(nextLevel.id)}
            onClick={() => {
              if (!suppressClickRef.current) selectWithTransition(nextLevel.id, 'next');
            }}
          >
            <VinylDisc locked={!nextUnlocked} />
          </button>

          <div className="orbit-scanner" aria-hidden="true"><i><span /></i></div>
        </div>

        <div className="vinyl-rating-slot">
          <StarRating
            className="song-level-stars"
            label={t('songSelect.starsLabel', { stars })}
            value={stars}
          />
        </div>

        <div className="vinyl-track-details">
          <div className="song-position" role="group" aria-label={t('songSelect.positionLabel', { current: activeIndex + 1, total: levels.length })}>
            <button
              className="song-nav-arrow song-nav-previous"
              type="button"
              aria-label={t('songSelect.previousSong', { title: previousLevel.song.title })}
              disabled={navigationLocked}
              onClick={() => selectWithTransition(previousLevel.id, 'previous')}
            />
            <span className="song-position-count">
              <strong>{String(activeIndex + 1).padStart(2, '0')}</strong>
              <span>/ {String(levels.length).padStart(2, '0')}</span>
            </span>
            <button
              className="song-nav-arrow song-nav-next"
              type="button"
              aria-label={t('songSelect.nextSong', { title: nextLevel.song.title })}
              disabled={navigationLocked}
              onClick={() => selectWithTransition(nextLevel.id, 'next')}
            />
          </div>
          <div className="vinyl-track-copy">
            <strong>{level.song.title}</strong>
            <small>{artistLabel(level)}</small>
            <span>
              <span>{t('common.bpm', { value: level.song.bpm })}</span>
              <i />
              <span>{durationLabel(level)}</span>
            </span>
          </div>
        </div>
      </section>

      <button
        className="shell-primary-button song-start-button"
        type="button"
        aria-busy={starting}
        disabled={navigationLocked || !unlocked}
        onClick={handleStart}
      >
        {starting ? t('songSelect.starting') : unlocked ? t('songSelect.start') : t('songSelect.locked')}
      </button>
      {launchError && <p className="launch-error-message" role="alert">{launchError}</p>}
    </main>
  );
}
