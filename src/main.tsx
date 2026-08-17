import { createRoot } from 'react-dom/client';
import App from './App';
import { locale, t } from './i18n';
import './styles.css';
import './ui-shell.css';

document.documentElement.lang = locale;
document.title = t('app.title');

createRoot(document.getElementById('root')!).render(
  <App />,
);
