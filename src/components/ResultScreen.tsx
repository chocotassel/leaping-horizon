import { useEffect, useState, type CSSProperties } from 'react';
import type { GameResult, Level } from '../types';
import { albumArtworkStyle } from '../assets/ui/albumArtwork';
import { getAccuracyPercent } from '../game/stars';
import { formatNumber, t } from '../i18n';
import { BrandHeader } from './BrandHeader';
import { StarRating } from './StarRating';

export type ResultOutcome = 'complete' | 'crashed';

export type ResultTone = 'success' | 'danger';

export interface ResultPresentation {
  tone: ResultTone;
  status: string;
  title: string;
  subtitle: string;
  replayLabel: string;
}

export interface ResultScreenProps {
  result: GameResult;
  stars: number;
  level: Level;
  presentation: ResultPresentation;
  onReplay: () => void;
  onHome: () => void;
}

export function getResultPresentation(outcome: ResultOutcome): ResultPresentation {
  return outcome === 'complete'
    ? {
        tone: 'success',
        status: t('result.statusComplete'),
        title: t('result.titleComplete'),
        subtitle: t('result.subtitleComplete'),
        replayLabel: t('result.replayComplete'),
      }
    : {
        tone: 'danger',
        status: t('result.statusCrashed'),
        title: t('result.titleCrashed'),
        subtitle: t('result.subtitleCrashed'),
        replayLabel: t('result.replayCrashed'),
      };
}

const SPECTRUM_LINES = [
  18, 22, 30, 42, 58, 74, 63, 48, 34, 22, 16, 24, 39,
  61, 86, 72, 54, 38, 27, 19, 28, 44, 65, 52, 31,
];
function spectrumStyle(height: number, index: number): CSSProperties {
  const peak = (0.38 + height / 100 * 0.55) * 0.5;
  return {
    '--spectrum-rest': peak * 0.42,
    '--spectrum-peak': peak,
    '--spectrum-delay': `${-((index * 7) % SPECTRUM_LINES.length) / SPECTRUM_LINES.length * 1400}ms`,
  } as CSSProperties;
}

export function ResultScreen({ result, stars, level, presentation, onReplay, onHome }: ResultScreenProps) {
  const [spectrumStopped, setSpectrumStopped] = useState(false);
  const accuracy = getAccuracyPercent(result);

  useEffect(() => {
    setSpectrumStopped(false);
    const timeoutId = window.setTimeout(() => setSpectrumStopped(true), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [result]);

  return (
    <main className={`screen result-screen is-${presentation.tone}`}>
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
        <span className="result-status">{presentation.status}</span>
        <h1>{presentation.title}</h1>
        <p>{presentation.subtitle}</p>
      </section>

      <section
        className={`result-score-stage${spectrumStopped ? ' is-spectrum-stopped' : ''}`}
        aria-label={t('result.summaryLabel', { score: formatNumber(result.score), stars })}
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
            <StarRating
              className="result-stars"
              label={t('result.starsLabel', { stars })}
              value={stars}
            />
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
          {presentation.replayLabel}
        </button>
        <button className="shell-text-button" type="button" onClick={onHome}>{t('result.backToSongs')}</button>
      </div>
    </main>
  );
}
