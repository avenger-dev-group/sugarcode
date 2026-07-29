import {
  Ban,
  Check,
  CircleHelp,
  Clock3,
  LoaderCircle,
  ShieldCheck,
  Square,
  Unplug,
  X,
} from 'lucide-react';

import type {
  CommandApprovalActivityProps,
  CommandApprovalPresentationState,
} from './types';

const STATE_COPY: Record<
  CommandApprovalPresentationState,
  Readonly<{ label: string; detail: string }>
> = {
  awaiting: {
    label: 'Command approval pending',
    detail: 'Waiting for a durable approval decision',
  },
  stopping: {
    label: 'Stopping command approval',
    detail: 'Waiting for Core to record the final decision',
  },
  uncertain: {
    label: 'Command approval status unavailable',
    detail: 'The connection closed before a decision was observed',
  },
  interrupted: {
    label: 'Command approval interrupted',
    detail: 'No durable decision was recorded',
  },
  approved: {
    label: 'Command approved',
    detail: 'Approval recorded; execution is not shown',
  },
  denied: {
    label: 'Command denied',
    detail: 'Denial recorded; the command was not approved',
  },
  timedOut: {
    label: 'Command approval timed out',
    detail: 'The approval window expired',
  },
  unsupported: {
    label: 'Command approval unsupported',
    detail: 'This client did not support the approval request',
  },
  cancelled: {
    label: 'Command approval cancelled',
    detail: 'The approval request was cancelled',
  },
  clientDisconnected: {
    label: 'Command approval disconnected',
    detail: 'The client disconnected before approval',
  },
};

const StateIcon = ({
  state,
}: Readonly<{ state: CommandApprovalPresentationState }>) => {
  const className = 'size-3.5';
  switch (state) {
    case 'awaiting':
    case 'stopping':
      return (
        <LoaderCircle
          className={`${className} animate-spin motion-reduce:animate-none`}
          aria-hidden="true"
        />
      );
    case 'approved':
      return <Check className={className} aria-hidden="true" />;
    case 'denied':
      return <X className={className} aria-hidden="true" />;
    case 'timedOut':
      return <Clock3 className={className} aria-hidden="true" />;
    case 'unsupported':
      return <Ban className={className} aria-hidden="true" />;
    case 'cancelled':
    case 'interrupted':
      return <Square className={className} aria-hidden="true" />;
    case 'clientDisconnected':
      return <Unplug className={className} aria-hidden="true" />;
    case 'uncertain':
      return <CircleHelp className={className} aria-hidden="true" />;
  }
};

const stateColor = (state: CommandApprovalPresentationState): string => {
  switch (state) {
    case 'awaiting':
    case 'stopping':
      return 'text-process';
    case 'denied':
    case 'timedOut':
    case 'unsupported':
      return 'text-destructive';
    case 'uncertain':
    case 'clientDisconnected':
      return 'text-tertiary';
    case 'cancelled':
    case 'interrupted':
      return 'text-secondary';
    case 'approved':
      return 'text-primary';
  }
};

export const CommandApprovalActivity = ({
  activity,
}: CommandApprovalActivityProps) => {
  const copy = STATE_COPY[activity.state];
  return (
    <section
      className="ml-10 flex min-w-0 gap-3 rounded-xl border bg-surface px-3.5 py-3"
      role={
        activity.state === 'denied' ||
        activity.state === 'timedOut' ||
        activity.state === 'unsupported'
          ? 'alert'
          : 'status'
      }
      aria-label={`${copy.label}: ${activity.command}`}
      data-state={activity.state}
    >
      <div
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background ${stateColor(
          activity.state,
        )}`}
      >
        <StateIcon state={activity.state} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-medium leading-normal">{copy.label}</p>
          <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-tertiary">
            <ShieldCheck className="size-3" aria-hidden="true" />
            shell/exec
          </span>
        </div>
        <code className="mt-1 block min-w-0 break-all font-mono text-xs font-normal leading-normal text-secondary">
          {activity.command}
        </code>
        <p className="mt-1 font-mono text-[10px] tracking-[0.08em] text-tertiary">
          {activity.argumentCount.toLocaleString('en-US')}{' '}
          {activity.argumentCount === 1 ? 'argument' : 'arguments'}
        </p>
        <p
          className={`mt-1.5 flex min-w-0 items-center gap-1 break-words font-mono text-[10px] tracking-[0.08em] ${stateColor(
            activity.state,
          )}`}
        >
          <StateIcon state={activity.state} />
          <span>{copy.detail}</span>
        </p>
      </div>
    </section>
  );
};
