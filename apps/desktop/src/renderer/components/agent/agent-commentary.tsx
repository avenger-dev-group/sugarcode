import { memo, type ReactElement } from 'react';

import type { AgentCommentaryProps } from './types';

const AgentCommentaryView = ({
  commentary,
}: AgentCommentaryProps): ReactElement => (
  <p
    className="whitespace-pre-wrap break-words text-sm font-normal leading-normal text-process"
    aria-label={
      commentary.state === 'running'
        ? 'Agent progress'
        : 'Agent progress update'
    }
  >
    {commentary.text}
  </p>
);

export const AgentCommentary = memo(AgentCommentaryView);
