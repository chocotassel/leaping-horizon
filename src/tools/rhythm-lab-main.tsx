import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RhythmLabApp } from './RhythmLabApp';
import './rhythm-lab.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RhythmLabApp />
  </StrictMode>,
);
