import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@xyflow/react/dist/style.css';
import { App } from '@/renderer/app';
import { startWorkspaceProjection } from '@/renderer/services/workspace-projection';
import '@/renderer/styles/globals.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('SugarCode renderer root was not found.');
}

const stopWorkspaceProjection = startWorkspaceProjection();
if (import.meta.hot) {
  import.meta.hot.dispose(stopWorkspaceProjection);
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
