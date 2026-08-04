import { ChevronDown, LoaderCircle } from 'lucide-react';

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
  durationLabel,
  children,
}: ProcessActivityGroupProps) => {
  const store = useActivityDisclosureStore(
    groupId,
    shouldAutoExpandActivityGroup(status, requiresAttention),
  );
  const label = processActivityLabel(status, requiresAttention);
  const active = status === 'inProgress' && !requiresAttention;
  const visibleDuration =
    status === 'completed' && !requiresAttention ? durationLabel : undefined;

  return (
    <details
      open={store.expanded}
      onToggle={(event) => store.setExpanded(event.currentTarget.open)}
      className="group/process-analysis min-w-0"
      aria-label={`${label}${visibleDuration ? ` in ${visibleDuration}` : ''} activity`}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 pr-1 text-sm text-secondary outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        {active ? (
          <LoaderCircle
            className="size-3.5 animate-spin text-process motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : null}
        <span className={requiresAttention ? 'text-process' : undefined}>
          {label}
        </span>
        {visibleDuration ? (
          <span className="tabular-nums text-tertiary">{visibleDuration}</span>
        ) : null}
        <ChevronDown
          className="size-3.5 shrink-0 text-tertiary transition-transform motion-reduce:transition-none group-open/process-analysis:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-1.5 space-y-2.5">{children}</div>
    </details>
  );
};
