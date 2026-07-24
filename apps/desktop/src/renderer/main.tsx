import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/renderer/app';
import '@/renderer/styles/globals.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('SugarCode renderer root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
