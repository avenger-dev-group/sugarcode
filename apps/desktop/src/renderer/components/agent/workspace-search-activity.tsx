import {
  Check,
  CircleHelp,
  FolderSearch,
  LoaderCircle,
  Search,
  Square,
  X,
} from 'lucide-react';

import type {
  WorkspaceSearchActivityProps,
  WorkspaceSearchPresentationState,
} from './types';

const STATE_COPY: Record<
  WorkspaceSearchPresentationState,
  Readonly<{ label: string; detail: string }>
> = {
  running: {
    label: 'Searching workspace',
    detail: 'Waiting for a durable result',
  },
  stopping: {
    label: 'Stopping workspace search',
    detail: 'Waiting for Core to record the final state',
  },
  uncertain: {
    label: 'Workspace search status unavailable',
    detail: 'The connection closed before a result was observed',
  },
  succeeded: {
    label: 'Workspace search complete',
    detail: 'Durable result recorded',
  },
  failed: {
    label: 'Workspace search failed',
    detail: 'Durable error recorded',
  },
  interrupted: {
    label: 'Workspace search stopped',
    detail: 'No result was recorded',
  },
};

const ActivityIcon = ({
  state,
}: Readonly<{ state: WorkspaceSearchPresentationState }>) => {
  const className = 'size-3.5';
  switch (state) {
    case 'running':
    case 'stopping':
      return (
        <LoaderCircle
          className={`${className} animate-spin motion-reduce:animate-none`}
          aria-hidden="true"
        />
      );
    case 'succeeded':
      return <Check className={className} aria-hidden="true" />;
    case 'failed':
      return <X className={className} aria-hidden="true" />;
    case 'interrupted':
      return <Square className={className} aria-hidden="true" />;
    case 'uncertain':
      return <CircleHelp className={className} aria-hidden="true" />;
  }
};

const stateColor = (state: WorkspaceSearchPresentationState): string => {
  switch (state) {
    case 'running':
    case 'stopping':
      return 'text-process';
    case 'failed':
      return 'text-destructive';
    case 'uncertain':
      return 'text-tertiary';
    case 'interrupted':
      return 'text-secondary';
    case 'succeeded':
      return 'text-primary';
  }
};

export const WorkspaceSearchActivity = ({
  activity,
}: WorkspaceSearchActivityProps) => {
  const copy = STATE_COPY[activity.state];
  const resultDetail =
    activity.state === 'succeeded' && activity.matches !== undefined
      ? activity.truncated
        ? `More than ${activity.matches.toLocaleString('en-US')} matches found`
        : `${activity.matches.toLocaleString('en-US')} ${
            activity.matches === 1 ? 'match' : 'matches'
          } found`
      : activity.state === 'failed' && activity.errorKind
        ? `Failure kind ${activity.errorKind}`
        : copy.detail;

  return (
    <section
      className="ml-10 flex min-w-0 gap-3 rounded-xl border bg-surface px-3.5 py-3"
      role={activity.state === 'failed' ? 'alert' : 'status'}
      aria-label={`${copy.label}: ${activity.path}`}
      data-state={activity.state}
    >
      <div
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background ${stateColor(
          activity.state,
        )}`}
      >
        <ActivityIcon state={activity.state} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-medium leading-normal">{copy.label}</p>
          <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-tertiary">
            <Search className="size-3" aria-hidden="true" />
            workspace/search
          </span>
        </div>
        <dl className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-tertiary">
            Root
          </dt>
          <dd className="min-w-0">
            <code className="block break-all font-mono text-xs font-normal leading-normal text-secondary">
              {activity.path}
            </code>
          </dd>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-tertiary">
            Query
          </dt>
          <dd className="min-w-0">
            <code className="block break-all font-mono text-xs font-normal leading-normal text-secondary">
              {activity.query}
            </code>
          </dd>
        </dl>
        <p
          className={`mt-1.5 flex min-w-0 items-center gap-1 break-words font-mono text-[10px] tracking-[0.08em] ${stateColor(
            activity.state,
          )}`}
        >
          <FolderSearch className="size-3 shrink-0" aria-hidden="true" />
          <span>{resultDetail}</span>
        </p>
      </div>
    </section>
  );
};
