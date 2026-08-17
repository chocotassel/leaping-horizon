import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Level } from '../types';
import { albumArtworkStyle } from '../assets/ui/albumArtwork';

interface HomeScreenProps {
  level: Level;
  levels: readonly Level[];
  musicEnabled: boolean;
  onSelectLevel: (levelId: string) => void;
  onToggleMusic: () => void;
  onStart: () => void;
}

function durationLabel(level: Level): string {
  const duration = Math.ceil(level.song.durationSeconds);
  return `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
}

function artistLabel(level: Level): string {
  return level.song.artist.trim().toLowerCase() === 'unknown artist'
    ? '未知音乐人'
    : level.song.artist;
}

export function HomeScreen({
  level,
  levels,
  musicEnabled,
  onSelectLevel,
  onToggleMusic,
  onStart,
}: HomeScreenProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const levelIdRef = useRef(level.id);
  const scrollFrameRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef({ pointerId: -1, startX: 0, startScrollLeft: 0, moved: false });
  const activeIndex = useMemo(
    () => Math.max(0, levels.findIndex((option) => option.id === level.id)),
    [level.id, levels],
  );
  const initialIndexRef = useRef(activeIndex);

  levelIdRef.current = level.id;

  const getSlides = useCallback(() => (
    Array.from(railRef.current?.querySelectorAll<HTMLElement>('[data-level-id]') ?? [])
  ), []);

  const closestSlideIndex = useCallback(() => {
    const rail = railRef.current;
    const slides = getSlides();
    if (!rail || slides.length === 0) return 0;
    const center = rail.scrollLeft + rail.clientWidth / 2;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;

    slides.forEach((slide, index) => {
      const slideCenter = slide.offsetLeft + slide.offsetWidth / 2;
      const distance = Math.abs(slideCenter - center);
      if (distance < closestDistance) {
        closestIndex = index;
        closestDistance = distance;
      }
    });

    return closestIndex;
  }, [getSlides]);

  const selectClosestSlide = useCallback(() => {
    const nextLevelId = getSlides()[closestSlideIndex()]?.dataset.levelId;
    if (!nextLevelId || nextLevelId === levelIdRef.current) return;
    levelIdRef.current = nextLevelId;
    onSelectLevel(nextLevelId);
  }, [closestSlideIndex, getSlides, onSelectLevel]);

  const scrollToSlide = useCallback((index: number, behavior: ScrollBehavior = 'smooth') => {
    const rail = railRef.current;
    const slide = getSlides()[index];
    if (!rail || !slide) return;
    const requestedLeft = slide.offsetLeft - (rail.clientWidth - slide.offsetWidth) / 2;
    const maximumLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    rail.scrollTo({ left: Math.min(maximumLeft, Math.max(0, requestedLeft)), behavior });
  }, [getSlides]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => scrollToSlide(initialIndexRef.current, 'auto'));
    return () => cancelAnimationFrame(frame);
  }, [scrollToSlide]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const handleRailScroll = () => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      selectClosestSlide();
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const rail = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: rail.scrollLeft,
      moved: false,
    };
    rail.setPointerCapture(event.pointerId);
    rail.classList.add('is-dragging');
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    const distance = event.clientX - drag.startX;
    if (Math.abs(distance) > 5) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.startScrollLeft - distance;
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = event.currentTarget;
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    rail.classList.remove('is-dragging');
    dragRef.current.pointerId = -1;
    if (!drag.moved) return;
    suppressClickRef.current = true;
    const nextIndex = closestSlideIndex();
    selectClosestSlide();
    scrollToSlide(nextIndex);
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  return (
    <main className="screen song-select-screen">
      <header className="shell-header">
        <strong>跃动地平线</strong>
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
      </header>

      <section className="song-select-heading">
        <h1>选择歌曲</h1>
        <span>{String(activeIndex + 1).padStart(2, '0')} / {String(levels.length).padStart(2, '0')}</span>
      </section>

      <section className="vinyl-stage" aria-label="左右滑动选择歌曲">
        <div className="orbit-scanner" aria-hidden="true"><i><span /></i></div>
        <div
          className="vinyl-rail"
          ref={railRef}
          onScroll={handleRailScroll}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerDrag}
          onPointerCancel={finishPointerDrag}
        >
          {levels.map((option, index) => (
            <button
              className={`vinyl-slide orbital-tone-${index % 4} ${option.id === level.id ? 'is-active' : ''}`}
              data-level-id={option.id}
              key={option.id}
              type="button"
              aria-pressed={option.id === level.id}
              style={albumArtworkStyle(option.id)}
              onClick={() => {
                if (suppressClickRef.current) return;
                levelIdRef.current = option.id;
                onSelectLevel(option.id);
                scrollToSlide(index);
              }}
            >
              <span className="vinyl-disc" aria-hidden="true">
                <i className="vinyl-pulse-ring" />
                <i className="vinyl-label">
                  <span className="label-flight-path" />
                </i>
              </span>
              <span className="vinyl-track-copy">
                <strong>{option.song.title}</strong>
                <small>{artistLabel(option)}</small>
                <span>{option.song.bpm} BPM <i /> {durationLabel(option)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="song-position" aria-label={`第 ${activeIndex + 1} 首，共 ${levels.length} 首`}>
        <i aria-hidden="true" />
        <strong>{String(activeIndex + 1).padStart(2, '0')}</strong>
        <span>/ {String(levels.length).padStart(2, '0')}</span>
        <i aria-hidden="true" />
      </div>

      <section
        className="selected-track-summary"
        style={albumArtworkStyle(level.id)}
      >
        <span className="selected-track-art" aria-hidden="true"><i /></span>
        <div className="selected-track-copy">
          <span>当前曲目</span>
          <strong>{level.song.title}</strong>
          <small>{artistLabel(level)}</small>
        </div>
        <span className={`summary-equalizer ${musicEnabled ? 'is-enabled' : ''}`} aria-hidden="true">
          <i /><i /><i /><i /><i /><i />
        </span>
      </section>

      <button className="shell-primary-button song-start-button" type="button" onClick={onStart}>
        开始游戏
      </button>
    </main>
  );
}
