import { Brain, ChevronDown, MessageSquareText } from 'lucide-react';

import { AgentCommentary } from '@/renderer/components/agent/agent-commentary';
import type { AgentCommentaryViewModel } from '@/renderer/components/agent/types';

import type { ProcessLanguage } from './types';
import { useActivityDisclosureStore } from './use-store';

export const NarrativeActivity = ({
  activity,
  kind,
  language,
}: Readonly<{
  activity: AgentCommentaryViewModel;
  kind: 'commentary' | 'reasoning' | 'reasoningSummary';
  language: ProcessLanguage;
}>) => {
  const running = activity.state === 'running';
  const reasoning = kind !== 'commentary';
  const store = useActivityDisclosureStore(activity.id, !reasoning && running);
  const label = reasoning
    ? language === 'zh'
      ? kind === 'reasoningSummary' ? '思考摘要' : '思考过程'
      : kind === 'reasoningSummary' ? 'Reasoning summary' : 'Reasoning'
    : language === 'zh'
      ? '进度说明'
      : 'Progress update';
  const Icon = reasoning ? Brain : MessageSquareText;

  return (
    <details
      open={store.expanded}
      onToggle={(event) => store.setExpanded(event.currentTarget.open)}
      className="group/narrative min-w-0"
      data-kind={kind}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md py-1 pr-1 text-sm text-secondary outline-none transition-colors hover:bg-surface hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <Icon
          className={`size-3.5 shrink-0 ${running ? 'text-process' : 'text-tertiary'}`}
          aria-hidden="true"
        />
        <span className={running ? 'agent-status-shimmer' : undefined}>
          {label}
        </span>
        {running ? (
          <span className="text-[11px] text-tertiary">
            {language === 'zh' ? '生成中' : 'Streaming'}
          </span>
        ) : null}
        <ChevronDown
          className="ml-auto size-3.5 shrink-0 text-tertiary transition-transform motion-reduce:transition-none group-open/narrative:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div
        className="ml-[7px] mt-1 max-h-56 min-w-0 overflow-y-auto overscroll-y-auto border-l border-border/70 py-1 pl-[18px] pr-2 text-tertiary [scrollbar-gutter:stable]"
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        <AgentCommentary commentary={activity} />
      </div>
    </details>
  );
};
