import {
  Activity,
  BellRing,
  Binoculars,
  Check,
  Clock3,
  FilePenLine,
  GitBranch,
  History,
  LockKeyhole,
  PencilLine,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';
import { cn } from '@/renderer/utils/class-name';

import { formatAgentTaskDuration } from './presentation';
import type {
  AgentTaskRole,
  AgentTaskViewModel,
} from './types';

const ROLE_LABELS: Record<AgentTaskRole, string> = {
  explorer: 'Explorer',
  worker: 'Worker',
  auditor: 'Auditor',
};

const STATUS_LABELS: Record<AgentTaskViewModel['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waitingApproval: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

const PROGRESS_LABELS: Record<
  NonNullable<AgentTaskViewModel['progress']>['stage'],
  string
> = {
  waitingForModel: 'Waiting for model',
  streaming: 'Streaming response',
  runningTool: 'Running tool',
};

type TraceEvent = Readonly<{
  id: string;
  icon: ReactNode;
  label: string;
  meta?: string;
  tone?: 'default' | 'success' | 'danger' | 'process';
  content: ReactNode;
}>;

const RoleIcon = ({ role }: Readonly<{ role: AgentTaskRole }>) => {
  switch (role) {
    case 'explorer':
      return <Binoculars aria-hidden="true" />;
    case 'worker':
      return <FilePenLine aria-hidden="true" />;
    case 'auditor':
      return <ShieldCheck aria-hidden="true" />;
  }
};

const StatusIcon = ({
  status,
}: Readonly<{ status: AgentTaskViewModel['status'] }>) => {
  switch (status) {
    case 'completed':
      return <Check aria-hidden="true" />;
    case 'failed':
    case 'interrupted':
      return <TriangleAlert aria-hidden="true" />;
    case 'cancelled':
      return <X aria-hidden="true" />;
    case 'waitingApproval':
      return <BellRing aria-hidden="true" />;
    case 'running':
      return <Activity aria-hidden="true" />;
    case 'queued':
      return <Clock3 aria-hidden="true" />;
  }
};

const statusTone = (status: AgentTaskViewModel['status']): string => {
  switch (status) {
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-destructive';
    case 'running':
      return 'text-process';
    case 'waitingApproval':
      return 'text-primary';
    case 'interrupted':
      return 'text-secondary';
    case 'queued':
    case 'cancelled':
      return 'text-tertiary';
  }
};

const traceTone = (tone: TraceEvent['tone']): string => {
  switch (tone) {
    case 'success':
      return 'text-success';
    case 'danger':
      return 'text-destructive';
    case 'process':
      return 'text-process';
    case 'default':
    case undefined:
      return 'text-secondary';
  }
};

const formatUpdateTime = (updatedAt: number): string =>
  new Date(updatedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const TraceItem = ({
  event,
  last,
}: Readonly<{
  event: TraceEvent;
  last: boolean;
}>) => (
  <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2.5">
    <div className="flex min-h-full flex-col items-center">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full border bg-background [&>svg]:size-4',
          traceTone(event.tone),
        )}
      >
        {event.icon}
      </span>
      {!last ? <span className="my-1 min-h-4 w-px flex-1 bg-border" /> : null}
    </div>
    <div className={last ? 'pb-1' : 'pb-4'}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-primary">{event.label}</h3>
        {event.meta ? (
          <span className="shrink-0 font-mono text-xs text-tertiary">
            {event.meta}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 text-[14px] font-normal leading-[21px]">
        {event.content}
      </div>
    </div>
  </li>
);

export const AgentDetail = ({
  task,
}: Readonly<{ task: AgentTaskViewModel | null }>) => {
  if (!task) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
        <GitBranch className="size-5 text-tertiary" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">Select an Agent task</p>
        <p className="mt-1 text-[13px] leading-5 text-secondary">
          Its brief, live progress, revisions, and recorded result will appear
          as one execution trace.
        </p>
      </div>
    );
  }

  const events: TraceEvent[] = [
    {
      id: 'brief',
      icon: <LockKeyhole aria-hidden="true" />,
      label: 'Task assigned',
      meta: 'Frozen brief',
      content: <AgentMarkdown source={task.taskMarkdown} isStreaming={false} />,
    },
    ...task.amendments.map(
      (amendment, index): TraceEvent => ({
        id: amendment.id,
        icon: <PencilLine aria-hidden="true" />,
        label: `Scope revised · ${index + 1}`,
        meta: 'Recorded update',
        content: (
          <AgentMarkdown source={amendment.markdown} isStreaming={false} />
        ),
      }),
    ),
  ];

  if (task.progress && !task.result) {
    events.push({
      id: 'progress',
      icon: <Activity aria-hidden="true" />,
      label: PROGRESS_LABELS[task.progress.stage],
      meta: formatUpdateTime(task.progress.updatedAt),
      tone: 'process',
      content: (
        <div aria-live="polite">
          <AgentMarkdown
            source={task.progress.summaryMarkdown}
            isStreaming={task.progress.stage === 'streaming'}
          />
        </div>
      ),
    });
  }

  if (task.result) {
    const danger = task.status === 'failed' || task.status === 'interrupted';
    events.push({
      id: task.result.id,
      icon: danger ? (
        <TriangleAlert aria-hidden="true" />
      ) : (
        <Check aria-hidden="true" />
      ),
      label:
        task.status === 'failed'
          ? 'Task failed'
          : task.status === 'interrupted'
            ? 'Task interrupted'
            : task.status === 'cancelled'
              ? 'Task cancelled'
              : task.role === 'auditor'
                ? 'Audit recorded'
                : 'Task completed',
      meta: formatAgentTaskDuration(task.result.durationMs),
      tone: danger ? 'danger' : 'success',
      content: (
        <div className={danger ? 'text-destructive' : undefined}>
          <AgentMarkdown
            source={task.result.summaryMarkdown}
            isStreaming={false}
          />
        </div>
      ),
    });
  } else if (!task.progress) {
    events.push({
      id: 'state',
      icon: <StatusIcon status={task.status} />,
      label: STATUS_LABELS[task.status],
      tone:
        task.status === 'waitingApproval'
          ? 'default'
          : task.status === 'failed'
            ? 'danger'
            : 'process',
      content: (
        <p className="text-[13px] leading-5 text-secondary">
          {task.status === 'queued'
            ? 'Waiting for dependencies or an execution slot.'
            : task.status === 'waitingApproval'
              ? 'A tool action needs approval before this Agent can continue.'
              : 'No additional public activity was recorded.'}
        </p>
      ),
    });
  }

  return (
    <div className="min-w-0 text-sm">
      <header className="border-b bg-surface px-4 py-3.5">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background [&>svg]:size-4',
              statusTone(task.status),
            )}
          >
            <RoleIcon role={task.role} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-tertiary">
              {ROLE_LABELS[task.role]}
            </p>
            <h2 className="mt-1 break-words text-sm font-medium leading-5 text-primary">
              {task.title}
            </h2>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3">
          <span
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 font-medium [&>svg]:size-3.5',
              statusTone(task.status),
            )}
            data-agent-status={task.status}
          >
            <StatusIcon status={task.status} />
            <span className="truncate">{STATUS_LABELS[task.status]}</span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-secondary">
            <LockKeyhole className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
            <span className="truncate">
              {task.access === 'readOnly' ? 'Read only' : 'Workspace write'}
            </span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-secondary">
            <GitBranch className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
            <span className="truncate">
              {task.dependsOn.length === 0
                ? 'Independent'
                : `${task.dependsOn.length} dependencies`}
            </span>
          </span>
        </div>
      </header>

      <section className="px-4 py-4" aria-labelledby="agent-execution-trace">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="size-3.5 text-tertiary" aria-hidden="true" />
            <h2
              id="agent-execution-trace"
              className="text-xs font-medium text-secondary"
            >
              Execution trace
            </h2>
          </div>
          <span className="font-mono text-[11px] text-tertiary">
            {events.length} {events.length === 1 ? 'event' : 'events'}
          </span>
        </div>
        <ol>
          {events.map((event, index) => (
            <TraceItem
              key={event.id}
              event={event}
              last={index === events.length - 1}
            />
          ))}
        </ol>
      </section>

      {task.dependsOn.length > 0 ? (
        <section className="border-t px-4 py-4" aria-labelledby="agent-dependencies">
          <h2
            id="agent-dependencies"
            className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-tertiary"
          >
            Dependencies
          </h2>
          <ul className="space-y-1.5 text-[12px] text-secondary">
            {task.dependsOn.map((dependency) => (
              <li key={dependency} className="flex min-w-0 items-center gap-2">
                <GitBranch className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
                <code className="truncate font-mono text-xs" title={dependency}>
                  {dependency}
                </code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
};
