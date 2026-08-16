import type { GameResult, Level } from '../types';
import type { CSSProperties } from 'react';
import handsOnDeckArt from '../assets/ui/album-hands-on-deck.png';
import sliceAtTwoArt from '../assets/ui/album-slice-at-two.png';
import brokenOrbitArt from '../assets/ui/broken-orbit.png';

export type ResultOutcome = 'complete' | 'crashed';

interface ResultScreenProps {
  result: GameResult;
  level: Level;
  outcome: ResultOutcome;
  onReplay: () => void;
  onHome: () => void;
}

export function ResultScreen({ result, level, outcome, onReplay, onHome }: ResultScreenProps) {
  const accuracy = result.total ? Math.round((result.hits / result.total) * 100) : 0;
  const rank = accuracy >= 95 ? 'S' : accuracy >= 85 ? 'A' : accuracy >= 70 ? 'B' : 'C';
  const completed = outcome === 'complete';
  const trackArt = level.song.title === 'Slice at Two' ? sliceAtTwoArt : handsOnDeckArt;

  return (
    <main className={`screen result-screen ${completed ? 'is-complete' : 'is-crashed'}`}>
      <header className="result-shell-header">
        <strong>跃动地平线</strong>
      </header>

      <section className="result-track" style={{ '--album-art': `url(${trackArt})` } as CSSProperties}>
        <span className="result-track-art" aria-hidden="true"><i /></span>
        <div>
          <strong>{level.song.title}</strong>
          <span className="result-track-wave" aria-hidden="true"><i /></span>
        </div>
      </section>

      <section className="result-message">
        <h1>{completed ? '航线完成' : '航线中断'}</h1>
        <p>{completed ? '你已抵达这首歌的地平线' : '再一次，越过尖刺'}</p>
      </section>

      <div
        className={`result-orbit ${completed ? 'is-complete' : 'is-broken'}`}
        style={{ '--broken-orbit-art': `url(${brokenOrbitArt})` } as CSSProperties}
        aria-hidden="true"
      >
        <span className="result-wave result-wave-left" />
        <span className="result-wave result-wave-right" />
        <div className="result-orbit-ring">
          <strong>{completed ? rank : '×'}</strong>
        </div>
        {!completed && <span className="orbit-shards"><i /><i /><i /><i /><i /></span>}
      </div>

      <section className="result-score-block">
        <span>本次得分</span>
        <strong>{result.score.toLocaleString('zh-CN')}</strong>
      </section>

      <section className="result-metrics" aria-label="本局统计">
        <div><span>最大连击</span><strong>{result.maxCombo}<small>x</small></strong></div>
        <div><span>命中率</span><strong>{accuracy}<small>%</small></strong></div>
        <div><span>成功躲避</span><strong>{result.dodges}<small>/{result.totalDodges}</small></strong></div>
      </section>

      <div className="result-actions">
        <button className="shell-primary-button" type="button" onClick={onReplay}>
          {completed ? '再次挑战' : '重新开始'}
        </button>
        <button className="shell-text-button" type="button" onClick={onHome}>返回选歌</button>
      </div>
    </main>
  );
}
