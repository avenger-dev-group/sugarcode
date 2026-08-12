import { LoaderCircle } from 'lucide-react';
import { memo, type ReactElement } from 'react';

import { MessageCopyButton } from '@/renderer/components/message-actions/message-copy-button';

import { AgentMarkdown } from './agent-markdown';
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

const AgentMessageView = ({
  message,
}: AgentMessageProps): ReactElement | null => {
  const isStreaming = message.state === 'streaming';
  if (!isStreaming && message.text.length === 0) {
    return null;
  }
  const stateLabel = STATE_LABELS[message.state];

  return (
    <article
      className="min-w-0"
      aria-label={ARIA_LABELS[message.state]}
    >
      {isStreaming || stateLabel ? (
        <div className="mb-1.5 flex items-center gap-2">
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
      ) : null}
      {message.state === 'completed' ||
      (message.state === 'streaming' && message.text.length > 0) ? (
        <AgentMarkdown
          source={message.text}
          isStreaming={isStreaming}
          verifiedFilePaths={message.verifiedFilePaths}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm font-normal leading-[22px] text-foreground">
          {message.text || (
            <span>Thinking through the turn…</span>
          )}
        </p>
      )}
      {message.state === 'completed' ? (
        <div className="mt-2 flex h-6 items-center">
          <MessageCopyButton
            text={message.text}
            className="text-tertiary hover:text-foreground"
          />
        </div>
      ) : null}
    </article>
  );
};

export const AgentMessage = memo(AgentMessageView);
