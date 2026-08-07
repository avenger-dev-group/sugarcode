import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/renderer/app';
import { startConversationProjection } from '@/renderer/services/conversation-projection';
import { startWorkspaceProjection } from '@/renderer/services/workspace-projection';
import '@/renderer/styles/globals.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('SugarCode renderer root was not found.');
}

const stopWorkspaceProjection = startWorkspaceProjection();
const stopConversationProjection = startConversationProjection();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopConversationProjection();
    stopWorkspaceProjection();
  });
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
