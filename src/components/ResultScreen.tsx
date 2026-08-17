import type { CSSProperties } from 'react';
import type { GameResult, Level } from '../types';
import { albumArtworkStyle } from '../assets/ui/albumArtwork';

export type ResultOutcome = 'complete' | 'crashed';

interface ResultScreenProps {
  result: GameResult;
  level: Level;
  outcome: ResultOutcome;
  onReplay: () => void;
  onHome: () => void;
}

const SPECTRUM_LINES = [22, 37, 54, 71, 43, 82, 61, 34, 68, 91, 49, 76, 57, 29, 64];

export function ResultScreen({ result, level, outcome, onReplay, onHome }: ResultScreenProps) {
  const accuracy = result.total ? Math.round((result.hits / result.total) * 100) : 0;
  const rank = accuracy >= 95 ? 'S' : accuracy >= 85 ? 'A' : accuracy >= 70 ? 'B' : 'C';
  const completed = outcome === 'complete';

  return (
    <main className={`screen result-screen ${completed ? 'is-complete' : 'is-crashed'}`}>
      <header className="result-shell-header">
        <strong>跃动地平线</strong>
      </header>

      <section className="result-track" style={albumArtworkStyle(level.id)}>
        <span className="result-track-art" aria-hidden="true"><i /></span>
        <div className="result-track-copy">
          <strong>{level.song.title}</strong>
          <span>{level.song.artist}</span>
          <small>{level.song.bpm} BPM</small>
        </div>
      </section>

      <section className="result-message">
        <span className="result-status">{completed ? 'RUN COMPLETE' : 'RUN TERMINATED'}</span>
        <h1>{completed ? '航线完成' : '航线中断'}</h1>
        <p>{completed ? '你已抵达这首歌的地平线' : '再一次，越过尖刺'}</p>
      </section>

      <section
        className="result-score-stage"
        aria-label={`本次得分 ${result.score.toLocaleString('zh-CN')}`}
      >
        <span className="result-spectrum result-spectrum-left" aria-hidden="true">
          {SPECTRUM_LINES.map((height, index) => (
            <i key={index} style={{ height: `${height}%`, '--spectrum-delay': `${index * 38}ms` } as CSSProperties} />
          ))}
        </span>
        <div className="result-score-ring">
          <div className="result-score-ring-copy">
            <span>本次得分</span>
            <strong>{result.score.toLocaleString('zh-CN')}</strong>
            <small>评级 {rank}</small>
          </div>
        </div>
        <span className="result-spectrum result-spectrum-right" aria-hidden="true">
          {SPECTRUM_LINES.map((height, index) => (
            <i key={index} style={{ height: `${height}%`, '--spectrum-delay': `${index * 38}ms` } as CSSProperties} />
          ))}
        </span>
      </section>

      <section className="result-metrics" aria-label="本局统计">
        <div><span>最大连击</span><strong>{result.maxCombo}<small>x</small></strong></div>
        <div><span>命中率</span><strong>{accuracy}<small>%</small></strong></div>
        <div><span>成功躲避</span><strong>{result.dodges}<small>/{result.totalDodges}</small></strong></div>
      </section>

      <div className="result-actions">
        <button className="shell-primary-button" type="button" onClick={onReplay}>
          {completed ? '再次起飞' : '重新起飞'}
        </button>
        <button className="shell-text-button" type="button" onClick={onHome}>返回选歌</button>
      </div>
    </main>
  );
}
