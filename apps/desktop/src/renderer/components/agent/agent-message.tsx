import { LoaderCircle } from 'lucide-react';
import type { ReactElement } from 'react';

import type { AgentMessageProps } from './types';

const ARIA_LABELS: Record<AgentMessageProps['message']['state'], string> = {
  streaming: 'Agent is responding',
  stopping: 'Agent response is stopping',
  uncertain: 'Agent response status is unavailable',
  completed: 'Agent response',
};

const STATE_LABELS: Partial<
  Record<AgentMessageProps['message']['state'], string>
> = {
  stopping: 'Stopping',
  uncertain: 'Final status unavailable',
};

export const AgentMessage = ({
  message,
}: AgentMessageProps): ReactElement | null => {
  const isStreaming = message.state === 'streaming';
  if (!isStreaming && message.text.length === 0) {
    return null;
  }
  const stateLabel = STATE_LABELS[message.state];

  return (
    <article
      className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3"
      aria-label={ARIA_LABELS[message.state]}
    >
      <div
        className="mt-0.5 flex size-7 items-center justify-center rounded-full border bg-background font-mono text-[10px] text-secondary"
        aria-hidden="true"
      >
        SC
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-[0.12em] text-tertiary">
            SugarCode
          </span>
          {isStreaming ? (
            <LoaderCircle
              className="size-3 animate-spin text-process"
              aria-hidden="true"
            />
          ) : null}
          {stateLabel ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-tertiary">
              {stateLabel}
            </span>
          ) : null}
        </div>
        <p
          className={`whitespace-pre-wrap break-words text-sm font-normal leading-[22px] ${
            message.state === 'completed'
              ? 'text-foreground'
              : 'text-process'
          }`}
        >
          {message.text || (
            <span className="text-process">Thinking through the turn…</span>
          )}
        </p>
      </div>
    </article>
  );
};
