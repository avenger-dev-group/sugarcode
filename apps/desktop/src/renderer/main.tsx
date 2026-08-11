import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/renderer/app';
import { TooltipProvider } from '@/renderer/components/ui/tooltip';
import { startConversationProjection } from '@/renderer/services/conversation-projection';
import { startWorkspaceProjection } from '@/renderer/services/workspace-projection';
import '@/renderer/styles/globals.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('SugarCode renderer root was not found.');
}

document.documentElement.dataset.platform = /Windows/u.test(
  navigator.userAgent,
)
  ? 'windows'
  : /Macintosh|Mac OS X/u.test(navigator.userAgent)
    ? 'macos'
    : 'linux';

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
    <TooltipProvider delayDuration={450} skipDelayDuration={100}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
