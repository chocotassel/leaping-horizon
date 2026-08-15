import type { Level } from '../types';

interface HomeScreenProps {
  level: Level;
  onStart: () => void;
}

export function HomeScreen({ level, onStart }: HomeScreenProps) {
  const duration = Math.ceil(level.song.durationSeconds);
  const durationLabel = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
  return (
    <main className="screen home-screen">
      <div className="home-glow" />
      <header className="brand-row">
        <div className="brand-mark"><span /></div>
        <span>NEON SLICE</span>
      </header>

      <section className="hero-copy">
        <p className="eyebrow">RHYTHM RUN // 001</p>
        <h1>追上节拍，<br /><em>切开星河。</em></h1>
        <p className="intro">左右滑动飞盘，穿过每一个节拍方块。</p>
      </section>

      <section className="song-card">
        <div className="album-art" aria-hidden="true">
          <div className="album-orbit orbit-one" />
          <div className="album-orbit orbit-two" />
          <div className="album-core">S<span>//</span>D</div>
        </div>
        <div className="song-info">
          <span className="now-playing">本次航行</span>
          <strong>{level.song.title}</strong>
          <span>{level.song.artist}</span>
          <div className="song-meta"><b>{level.song.bpm}</b> BPM <i /> {durationLabel}</div>
          <small className="song-algorithm">{String(level.generation.displayName ?? level.generation.algorithm)} · {level.generation.noteCount} 个事件</small>
        </div>
      </section>

      <button className="primary-button" type="button" onClick={onStart}>
        <span className="play-icon">▶</span>
        开始航行
      </button>
      <a className="rhythm-lab-link" href="/rhythm-lab.html">试听并比较生成算法</a>
      <p className="touch-tip"><span>↔</span> 单指左右滑动操控</p>
    </main>
  );
}
