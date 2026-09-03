import { ChevronDown } from 'lucide-react';

import type { ProcessActivityGroupProps } from './types';
import {
  processActivityLabel,
  shouldAutoExpandActivityGroup,
} from './activity-disclosure';
import { useActivityDisclosureStore } from './use-store';

export const ProcessActivityGroup = ({
  groupId,
  status,
  requiresAttention,
  language,
  activeLabel,
  animateActive = true,
  durationLabel,
  activitySummary,
  children,
}: ProcessActivityGroupProps) => {
  const store = useActivityDisclosureStore(
    groupId,
    shouldAutoExpandActivityGroup(status, requiresAttention),
  );
  const active = status === 'inProgress' && !requiresAttention;
  const label =
    active && activeLabel
      ? activeLabel
      : processActivityLabel(status, requiresAttention, language);
  const visibleDuration =
    status === 'completed' && !requiresAttention ? durationLabel : undefined;

  return (
    <>
      {active && activeLabel ? (
        <span className="sr-only" role="status" aria-live="polite">
          {activeLabel}
        </span>
      ) : null}
      <details
        open={store.expanded}
        onToggle={(event) => store.setExpanded(event.currentTarget.open)}
        className="group/process-analysis block w-full min-w-0"
        aria-label={
          language === 'zh'
            ? `${label}${visibleDuration ? `，用时 ${visibleDuration}` : ''}`
            : `${label}${visibleDuration ? ` in ${visibleDuration}` : ''} activity`
        }
      >
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 pr-1 text-sm text-secondary outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <span
            className={
              active && animateActive
                ? 'agent-status-shimmer'
                : active || requiresAttention
                  ? 'text-process'
                  : undefined
            }
          >
            {label}
          </span>
          {visibleDuration ? (
            <span className="tabular-nums text-tertiary">
              · {visibleDuration}
            </span>
          ) : null}
          {activitySummary ? (
            <span className="min-w-0 truncate text-xs text-tertiary">
              · {activitySummary}
            </span>
          ) : null}
          <ChevronDown
            className="size-3.5 shrink-0 text-tertiary transition-transform motion-reduce:transition-none group-open/process-analysis:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div
          className="mt-1.5 max-h-[min(55vh,36rem)] w-full min-w-0 space-y-1.5 overflow-y-auto overscroll-y-auto border-b border-border/60 pb-2.5 pr-2 [scrollbar-gutter:stable]"
          tabIndex={0}
          role="region"
          aria-label={language === 'zh' ? '处理过程' : 'Process activity'}
        >
          {children}
        </div>
      </details>
    </>
  );
};
