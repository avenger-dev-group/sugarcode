import { memo, type ReactElement } from 'react';

import { AgentMarkdown } from './agent-markdown';
import type { AgentCommentaryProps } from './types';

const AgentCommentaryView = ({
  commentary,
}: AgentCommentaryProps): ReactElement => (
  <div
    className="w-full max-w-full break-words text-sm font-normal leading-[22px]"
    aria-label={
      commentary.state === 'running'
        ? 'Agent progress'
        : 'Agent progress update'
    }
  >
    <AgentMarkdown
      source={commentary.text}
      isStreaming={commentary.state === 'running'}
    />
  </div>
);

export const AgentCommentary = memo(AgentCommentaryView);
