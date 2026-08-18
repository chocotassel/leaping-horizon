import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './editor.css';

const root = document.getElementById('root')!;
void import('./LevelEditor').then(({ LevelEditor }) => {
  createRoot(root).render(
    <StrictMode>
      <LevelEditor />
    </StrictMode>,
  );
}).catch((error: unknown) => {
  root.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
});
