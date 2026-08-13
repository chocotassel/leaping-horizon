import type { GameResult } from '../types';

interface ResultScreenProps {
  result: GameResult;
  onReplay: () => void;
  onHome: () => void;
}

export function ResultScreen({ result, onReplay, onHome }: ResultScreenProps) {
  const accuracy = result.total ? Math.round((result.hits / result.total) * 100) : 0;
  const rank = accuracy >= 95 ? 'S' : accuracy >= 85 ? 'A' : accuracy >= 70 ? 'B' : 'C';

  return (
    <main className="screen result-screen">
      <div className="result-rays" />
      <header className="result-head">
        <p>航行完成</p>
        <h1>MISSION COMPLETE</h1>
      </header>

      <div className="rank-medal">
        <div className="rank-ring"><span>{rank}</span></div>
        <p>{accuracy >= 85 ? '节拍同步优秀' : '继续追逐节拍'}</p>
      </div>

      <section className="result-score">
        <span>总分</span>
        <strong>{result.score.toLocaleString('zh-CN')}</strong>
      </section>

      <section className="result-stats">
        <div><span>最大连击</span><strong>{result.maxCombo}<small>x</small></strong></div>
        <i />
        <div><span>命中率</span><strong>{accuracy}<small>%</small></strong></div>
      </section>

      <section className="hit-summary">
        <span>节拍命中</span>
        <b>{result.hits} / {result.total}</b>
        <div><i style={{ width: `${accuracy}%` }} /></div>
      </section>

      <div className="result-actions">
        <button className="primary-button" type="button" onClick={onReplay}><span>↻</span>再次航行</button>
        <button className="text-button" type="button" onClick={onHome}>返回主界面</button>
      </div>
    </main>
  );
}
