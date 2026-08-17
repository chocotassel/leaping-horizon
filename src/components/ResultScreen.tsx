import type { CSSProperties } from 'react';
import type { GameResult, Level } from '../types';
import { albumArtworkStyle } from '../assets/ui/albumArtwork';
import { formatNumber, t } from '../i18n';
import { BrandHeader } from './BrandHeader';

export type ResultOutcome = 'complete' | 'crashed';

interface ResultScreenProps {
  result: GameResult;
  level: Level;
  outcome: ResultOutcome;
  onReplay: () => void;
  onHome: () => void;
}

const SPECTRUM_LINES = [
  18, 22, 30, 42, 58, 74, 63, 48, 34, 22, 16, 24, 39,
  61, 86, 72, 54, 38, 27, 19, 28, 44, 65, 52, 31,
];
const SPECTRUM_PHASES = [0, -288, -864, -576, -1152];

function spectrumStyle(height: number, index: number): CSSProperties {
  const scale = height / 100;
  return {
    '--spectrum-rest': scale * 0.34,
    '--spectrum-low': scale * 0.56,
    '--spectrum-high': scale * 0.78,
    '--spectrum-peak': scale,
    '--spectrum-delay': `${SPECTRUM_PHASES[index % SPECTRUM_PHASES.length]}ms`,
  } as CSSProperties;
}

export function ResultScreen({ result, level, outcome, onReplay, onHome }: ResultScreenProps) {
  const accuracy = result.total ? Math.round((result.hits / result.total) * 100) : 0;
  const rank = accuracy >= 95 ? 'S' : accuracy >= 85 ? 'A' : accuracy >= 70 ? 'B' : 'C';
  const completed = outcome === 'complete';

  return (
    <main className={`screen result-screen ${completed ? 'is-complete' : 'is-crashed'}`}>
      <BrandHeader />

      <section className="result-track" style={albumArtworkStyle(level.id)}>
        <span className="result-track-art" aria-hidden="true"><i /></span>
        <div className="result-track-copy">
          <strong>{level.song.title}</strong>
          <span>{level.song.artist}</span>
          <small>{t('common.bpm', { value: level.song.bpm })}</small>
        </div>
      </section>

      <section className="result-message">
        <span className="result-status">{completed ? t('result.statusComplete') : t('result.statusCrashed')}</span>
        <h1>{completed ? t('result.titleComplete') : t('result.titleCrashed')}</h1>
        <p>{completed ? t('result.subtitleComplete') : t('result.subtitleCrashed')}</p>
      </section>

      <section
        className="result-score-stage"
        aria-label={t('result.scoreLabel', { score: formatNumber(result.score) })}
      >
        <span className="result-spectrum result-spectrum-left" aria-hidden="true">
          {SPECTRUM_LINES.map((height, index) => (
            <i key={index} style={spectrumStyle(height, index)} />
          ))}
        </span>
        <div className="result-score-ring">
          <div className="result-score-ring-copy">
            <span>{t('result.score')}</span>
            <strong>{formatNumber(result.score)}</strong>
            <small>{t('result.rank', { rank })}</small>
          </div>
        </div>
        <span className="result-spectrum result-spectrum-right" aria-hidden="true">
          {SPECTRUM_LINES.map((height, index) => (
            <i key={index} style={spectrumStyle(height, index)} />
          ))}
        </span>
      </section>

      <section className="result-metrics" aria-label={t('result.metricsLabel')}>
        <div><span>{t('result.maxCombo')}</span><strong>{result.maxCombo}<small>{t('result.comboSuffix')}</small></strong></div>
        <div><span>{t('result.accuracy')}</span><strong>{accuracy}<small>{t('result.percentSuffix')}</small></strong></div>
        <div><span>{t('result.dodges')}</span><strong>{result.dodges}<small>{t('result.totalSuffix', { total: result.totalDodges })}</small></strong></div>
      </section>

      <div className="result-actions">
        <button className="shell-primary-button" type="button" onClick={onReplay}>
          {completed ? t('result.replayComplete') : t('result.replayCrashed')}
        </button>
        <button className="shell-text-button" type="button" onClick={onHome}>{t('result.backToSongs')}</button>
      </div>
    </main>
  );
}
