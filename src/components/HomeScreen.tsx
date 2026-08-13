import { DEMO_CHART } from '../chart';

interface HomeScreenProps {
  onStart: () => void;
}

export function HomeScreen({ onStart }: HomeScreenProps) {
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
          <strong>{DEMO_CHART.title}</strong>
          <span>{DEMO_CHART.artist}</span>
          <div className="song-meta"><b>{DEMO_CHART.bpm}</b> BPM <i /> 00:42</div>
        </div>
      </section>

      <button className="primary-button" type="button" onClick={onStart}>
        <span className="play-icon">▶</span>
        开始航行
      </button>
      <p className="touch-tip"><span>↔</span> 单指左右滑动操控</p>
    </main>
  );
}
