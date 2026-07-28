import { LoaderCircle } from 'lucide-react';

import type { AgentMessageProps } from './types';

export const AgentMessage = ({ message }: AgentMessageProps) => (
  <article
    className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3"
    aria-label={message.isStreaming ? 'Agent is responding' : 'Agent response'}
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
        {message.isStreaming ? (
          <LoaderCircle
            className="size-3 animate-spin text-process"
            aria-hidden="true"
          />
        ) : null}
      </div>
      <p
        className={`whitespace-pre-wrap break-words text-sm font-normal leading-[22px] ${
          message.isStreaming ? 'text-process' : 'text-foreground'
        }`}
      >
        {message.text || (
          <span className="text-process">Thinking through the turn…</span>
        )}
      </p>
    </div>
  </article>
);
