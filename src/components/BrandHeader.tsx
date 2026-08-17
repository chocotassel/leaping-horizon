import { t } from '../i18n';

export function BrandHeader() {
  return (
    <header className="brand-header">
      <strong>{t('app.title')}</strong>
    </header>
  );
}
