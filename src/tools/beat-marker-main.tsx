import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BeatMarkerApp } from './BeatMarkerApp';
import './beat-marker.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BeatMarkerApp />
  </StrictMode>,
);
