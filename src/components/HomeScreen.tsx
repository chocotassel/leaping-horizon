import { useEffect, useMemo, useRef } from 'react';
import type { Level } from '../types';

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

export function HomeScreen({
  level,
  levels,
  musicEnabled,
  onSelectLevel,
  onToggleMusic,
  onStart,
}: HomeScreenProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const activeIndex = useMemo(
    () => Math.max(0, levels.findIndex((option) => option.id === level.id)),
    [level.id, levels],
  );

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof IntersectionObserver === 'undefined') return;
    const slides = Array.from(rail.querySelectorAll<HTMLElement>('[data-level-id]'));
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      const levelId = (visible?.target as HTMLElement | undefined)?.dataset.levelId;
      if (levelId && levelId !== level.id) onSelectLevel(levelId);
    }, { root: rail, threshold: [0.62, 0.78] });
    slides.forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, [level.id, levels, onSelectLevel]);

  const moveSelection = (offset: number) => {
    const nextIndex = (activeIndex + offset + levels.length) % levels.length;
    const nextLevel = levels[nextIndex];
    onSelectLevel(nextLevel.id);
    const slide = railRef.current?.querySelector<HTMLElement>(`[data-level-id="${nextLevel.id}"]`);
    slide?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  };

  return (
    <main className="screen song-select-screen">
      <header className="shell-header">
        <div>
          <strong>跃动地平线</strong>
          <span>选择你的节拍航线</span>
        </div>
        <button
          className={`header-music-button ${musicEnabled ? 'is-enabled' : ''}`}
          type="button"
          aria-pressed={musicEnabled}
          onClick={onToggleMusic}
        >
          音乐 {musicEnabled ? '开' : '关'}
        </button>
      </header>

      <section className="song-select-heading">
        <h1>选择歌曲</h1>
        <span>{String(activeIndex + 1).padStart(2, '0')} / {String(levels.length).padStart(2, '0')}</span>
      </section>

      <section className="vinyl-stage" aria-label="左右滑动选择歌曲">
        <div className="tonearm" aria-hidden="true"><i /><span /></div>
        <div className="vinyl-rail" ref={railRef}>
          {levels.map((option, index) => (
            <button
              className={`vinyl-slide vinyl-tone-${index % 4} ${option.id === level.id ? 'is-active' : ''}`}
              data-level-id={option.id}
              key={option.id}
              type="button"
              aria-pressed={option.id === level.id}
              onClick={() => onSelectLevel(option.id)}
            >
              <span className="vinyl-disc" aria-hidden="true">
                <i className="vinyl-label"><b>{option.song.title.slice(0, 1).toUpperCase()}</b></i>
              </span>
              <span className="vinyl-track-copy">
                <small>{option.song.artist}</small>
                <strong>{option.song.title}</strong>
                <span>{option.song.bpm} BPM <i /> {durationLabel(option)}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <nav className="vinyl-controls" aria-label="切换歌曲">
        <button type="button" onClick={() => moveSelection(-1)}>上一首</button>
        <span>左右滑动唱片选择</span>
        <button type="button" onClick={() => moveSelection(1)}>下一首</button>
      </nav>

      <section className="selected-track-summary">
        <div>
          <span>当前曲目</span>
          <strong>{level.song.title}</strong>
        </div>
        <small>{String(level.generation.displayName ?? '心流谱面')}</small>
      </section>

      <button className="shell-primary-button song-start-button" type="button" onClick={onStart}>
        开始游戏
      </button>
    </main>
  );
}
