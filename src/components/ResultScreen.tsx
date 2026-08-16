import type { GameResult, Level } from '../types';

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

  return (
    <main className={`screen result-screen ${completed ? 'is-complete' : 'is-crashed'}`}>
      <header className="result-shell-header">
        <strong>跃动地平线</strong>
        <span>{level.song.title}</span>
      </header>

      <section className="result-message">
        <p>{completed ? '航线完成' : '航线中断'}</p>
        <h1>{completed ? '节拍仍在向前' : '再一次，越过尖刺'}</h1>
        <span>{completed ? '你已经抵达这首歌的地平线。' : '保留这次节奏，下一次滑得更早一点。'}</span>
      </section>

      <div className="result-record" aria-hidden="true">
        <div className="result-record-label">
          <small>{completed ? 'RANK' : 'RUN'}</small>
          <strong>{completed ? rank : '×'}</strong>
        </div>
        {!completed && <i className="record-crack" />}
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
