import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PatternLabApp } from './PatternLabApp';
import './pattern-lab.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PatternLabApp />
  </StrictMode>,
);
