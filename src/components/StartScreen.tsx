import { BrandHeader } from './BrandHeader';
import { t } from '../i18n';

interface StartScreenProps {
  musicEnabled: boolean;
  onToggleMusic: () => void;
  onEnter: () => void;
}

export function StartScreen({ musicEnabled, onToggleMusic, onEnter }: StartScreenProps) {
  return (
    <main className="screen start-screen">
      <div className="space-backdrop" aria-hidden="true">
        <i className="start-scene-glow" />
      </div>

      <BrandHeader />

      <section className="start-title">
        <h1><span>{t('start.heroFirstLine')}</span><span>{t('start.heroSecondLine')}</span></h1>
        <p><i aria-hidden="true" />{t('start.tagline')}</p>
      </section>

      <section className="start-actions" aria-label={t('start.actionsLabel')}>
        <button className="shell-primary-button" type="button" onClick={onEnter}>
          {t('start.enter')}
        </button>
        <button
          className={`music-toggle ${musicEnabled ? 'is-enabled' : ''}`}
          type="button"
          aria-pressed={musicEnabled}
          onClick={onToggleMusic}
        >
          <span className="music-toggle-main">
            <span className="music-control-symbol" aria-hidden="true">♪</span>
            <strong>{musicEnabled ? t('start.musicEnabled') : t('start.openMusic')}</strong>
            <span className="music-equalizer" aria-hidden="true">
              <i /><i /><i /><i /><i /><i />
            </span>
          </span>
          <span className="music-headphone-note">
            <i aria-hidden="true" />
            {t('start.headphones')}
          </span>
        </button>
        <p className="visually-hidden" role="status">
          {musicEnabled
            ? t('start.readyHint')
            : t('start.musicHint')}
        </p>
      </section>
    </main>
  );
}
