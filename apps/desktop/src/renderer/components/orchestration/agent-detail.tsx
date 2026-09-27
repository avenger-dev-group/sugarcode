import {
  Activity,
  BellRing,
  Binoculars,
  Check,
  ChevronRight,
  Clock3,
  FilePenLine,
  GitBranch,
  History,
  LockKeyhole,
  PencilLine,
  Radio,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';
import { cn } from '@/renderer/utils/class-name';

import { formatAgentTaskDuration } from './presentation';
import type {
  AgentTaskProgressViewModel,
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

const PROGRESS_LABELS: Record<AgentTaskProgressViewModel['stage'], string> = {
  waitingForModel: 'Thinking',
  streaming: 'Writing response',
  runningTool: 'Using a tool',
};

type TraceEvent = Readonly<{
  id: string;
  icon: ReactNode;
  label: string;
  meta?: string;
  tone?: 'default' | 'success' | 'danger' | 'process';
  content?: ReactNode;
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
      return 'border-success/25 bg-success/8 text-success';
    case 'danger':
      return 'border-destructive/25 bg-destructive/8 text-destructive';
    case 'process':
      return 'border-process/25 bg-process/8 text-process';
    case 'default':
    case undefined:
      return 'border-border bg-background text-secondary';
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
  <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3">
    <div className="flex min-h-full flex-col items-center">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full border [&>svg]:size-3',
          traceTone(event.tone),
        )}
      >
        {event.icon}
      </span>
      {!last ? <span className="my-1 min-h-3 w-px flex-1 bg-border-subtle" /> : null}
    </div>
    <div className={last ? 'pb-0.5' : 'pb-4'}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium leading-5 text-primary">
          {event.label}
        </h3>
        {event.meta ? (
          <time className="shrink-0 font-mono text-[10px] text-tertiary">
            {event.meta}
          </time>
        ) : null}
      </div>
      {event.content ? (
        <div className="agent-task-markdown agent-task-markdown--compact mt-1 text-[12px] leading-[18px] text-secondary">
          {event.content}
        </div>
      ) : null}
    </div>
  </li>
);

const RecordDisclosure = ({
  children,
  icon,
  label,
  meta,
}: Readonly<{
  children: ReactNode;
  icon: ReactNode;
  label: string;
  meta: string;
}>) => (
  <details className="group rounded-xl border border-border-subtle bg-surface/45 open:bg-surface">
    <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 text-[13px] marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      <span className="text-tertiary [&>svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 font-medium text-secondary">{label}</span>
      <span className="text-[10px] text-tertiary">{meta}</span>
      <ChevronRight className="size-3.5 text-tertiary transition-transform group-open:rotate-90" aria-hidden="true" />
    </summary>
    <div className="agent-task-markdown border-t border-border-subtle px-3 py-3 text-[13px] leading-5">
      {children}
    </div>
  </details>
);

const CurrentOutput = ({ task }: Readonly<{ task: AgentTaskViewModel }>) => {
  if (task.result) {
    const danger = task.status === 'failed' || task.status === 'interrupted';
    return (
      <section
        className={cn(
          'overflow-hidden rounded-2xl border bg-surface-raised shadow-[var(--shadow-raised)]',
          danger ? 'border-destructive/30' : 'border-border',
        )}
        aria-labelledby="agent-result-heading"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('grid size-6 place-items-center rounded-full', danger ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success')}>
              {danger ? <TriangleAlert className="size-3.5" aria-hidden="true" /> : <Check className="size-3.5" aria-hidden="true" />}
            </span>
            <h2 id="agent-result-heading" className="text-[13px] font-semibold text-primary">
              {danger ? 'Partial result' : task.role === 'auditor' ? 'Audit result' : 'Result'}
            </h2>
          </div>
          <span className="font-mono text-[10px] text-tertiary">
            {formatAgentTaskDuration(task.result.durationMs)}
          </span>
        </div>
        <div className={cn('agent-task-markdown px-4 py-3.5 text-[14px] leading-[21px]', danger && 'text-destructive')}>
          <AgentMarkdown source={task.result.summaryMarkdown} isStreaming={false} />
        </div>
      </section>
    );
  }

  if (task.progress) {
    return (
      <section
        className="overflow-hidden rounded-2xl border border-process/25 bg-surface-raised shadow-[var(--shadow-raised)]"
        aria-labelledby="agent-live-output-heading"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-process/5 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="relative grid size-6 place-items-center rounded-full bg-process/10 text-process">
              <Radio className="size-3.5" aria-hidden="true" />
              <span className="absolute inset-0 animate-ping rounded-full border border-process/25 motion-reduce:animate-none" />
            </span>
            <div className="min-w-0">
              <h2 id="agent-live-output-heading" className="text-[13px] font-semibold text-primary">
                {PROGRESS_LABELS[task.progress.stage]}
              </h2>
              <p className="text-[10px] text-tertiary">Live output · updates in place</p>
            </div>
          </div>
          <time className="shrink-0 font-mono text-[10px] text-tertiary">
            {formatUpdateTime(task.progress.updatedAt)}
          </time>
        </div>
        <div className="agent-task-markdown max-h-64 overflow-y-auto px-4 py-3.5 text-[14px] leading-[21px]" aria-live="polite" aria-atomic="false">
          <AgentMarkdown
            source={task.progress.summaryMarkdown}
            isStreaming={task.progress.stage === 'streaming'}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-dashed border-border bg-surface/45 px-4 py-4">
      <div className="flex items-start gap-3">
        <Clock3 className="mt-0.5 size-4 shrink-0 text-tertiary" aria-hidden="true" />
        <div>
          <h2 className="text-[13px] font-medium text-primary">{STATUS_LABELS[task.status]}</h2>
          <p className="mt-1 text-[12px] leading-[18px] text-secondary">
            {task.status === 'queued'
              ? 'Waiting for dependencies or an execution slot.'
              : task.status === 'waitingApproval'
                ? 'A tool action needs approval before this Agent can continue.'
                : 'No live output has been recorded yet.'}
          </p>
        </div>
      </div>
    </section>
  );
};

export const AgentDetail = ({
  task,
}: Readonly<{ task: AgentTaskViewModel | null }>) => {
  if (!task) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
        <GitBranch className="size-5 text-tertiary" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">Select an Agent task</p>
        <p className="mt-1 text-[13px] leading-5 text-secondary">
          Review its current output, key activity, brief, and final result.
        </p>
      </div>
    );
  }

  const progressEvents = task.progressEvents ?? [];
  const events: TraceEvent[] = [
    {
      id: 'assigned',
      icon: <LockKeyhole aria-hidden="true" />,
      label: 'Task assigned',
      content: <p>The original brief was locked for this run.</p>,
    },
    ...progressEvents.map((progress, index): TraceEvent => ({
      id: `progress:${progress.updatedAt}:${index}`,
      icon: progress.stage === 'runningTool'
        ? <Sparkles aria-hidden="true" />
        : <Activity aria-hidden="true" />,
      label: PROGRESS_LABELS[progress.stage],
      meta: formatUpdateTime(progress.updatedAt),
      tone: progress.stage === 'runningTool' ? 'process' : 'default',
      content: <AgentMarkdown source={progress.summaryMarkdown} isStreaming={false} />,
    })),
    ...task.amendments.map((amendment, index): TraceEvent => ({
      id: amendment.id,
      icon: <PencilLine aria-hidden="true" />,
      label: `Scope revised · ${index + 1}`,
      content: <AgentMarkdown source={amendment.markdown} isStreaming={false} />,
    })),
  ];

  if (task.result) {
    const danger = task.status === 'failed' || task.status === 'interrupted';
    events.push({
      id: task.result.id,
      icon: danger ? <TriangleAlert aria-hidden="true" /> : <Check aria-hidden="true" />,
      label: task.status === 'failed'
        ? task.result.partial ? 'Failed · partial result saved' : 'Task failed'
        : task.status === 'interrupted' ? 'Task interrupted'
          : task.status === 'cancelled' ? 'Task cancelled'
            : 'Task completed',
      meta: [
        formatAgentTaskDuration(task.result.durationMs),
        task.result.attempts && task.result.attempts > 1 ? `${task.result.attempts} attempts` : undefined,
      ].filter(Boolean).join(' · '),
      tone: danger ? 'danger' : 'success',
    });
  }

  return (
    <div className="min-w-0 pb-6 text-sm">
      <header className="sticky top-0 z-10 border-b border-border-subtle bg-background/92 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-surface-raised [&>svg]:size-4', statusTone(task.status))}>
            <RoleIcon role={task.role} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-tertiary">{ROLE_LABELS[task.role]}</span>
              <span className="text-tertiary">·</span>
              <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium [&>svg]:size-3', statusTone(task.status))} data-agent-status={task.status}>
                <StatusIcon status={task.status} />
                {STATUS_LABELS[task.status]}
              </span>
            </div>
            <h1 className="mt-1 break-words text-[14px] font-semibold leading-5 text-primary">{task.title}</h1>
          </div>
        </div>
      </header>

      <main className="space-y-5 px-4 pt-4">
        <CurrentOutput task={task} />

        <section aria-labelledby="agent-activity-heading">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <History className="size-3.5 text-tertiary" aria-hidden="true" />
              <h2 id="agent-activity-heading" className="text-[12px] font-semibold text-secondary">Key activity</h2>
            </div>
            <span className="font-mono text-[10px] text-tertiary">{events.length} {events.length === 1 ? 'step' : 'steps'}</span>
          </div>
          <ol>
            {events.map((event, index) => (
              <TraceItem key={event.id} event={event} last={index === events.length - 1} />
            ))}
          </ol>
        </section>

        <section className="space-y-2" aria-labelledby="agent-records-heading">
          <h2 id="agent-records-heading" className="font-mono text-[10px] uppercase tracking-[0.14em] text-tertiary">Run records</h2>
          <RecordDisclosure icon={<LockKeyhole aria-hidden="true" />} label="Original brief" meta="Frozen">
            <AgentMarkdown source={task.taskMarkdown} isStreaming={false} />
          </RecordDisclosure>
          {task.amendments.map((amendment, index) => (
            <RecordDisclosure key={amendment.id} icon={<PencilLine aria-hidden="true" />} label={`Scope revision ${index + 1}`} meta="Recorded">
              <AgentMarkdown source={amendment.markdown} isStreaming={false} />
            </RecordDisclosure>
          ))}
        </section>

        <section className="grid grid-cols-2 gap-2 border-t border-border-subtle pt-4 text-[11px] sm:grid-cols-3" aria-label="Agent run metadata">
          <div className="rounded-lg bg-surface px-2.5 py-2">
            <p className="text-tertiary">Access</p>
            <p className="mt-0.5 truncate font-medium text-secondary">{task.access === 'readOnly' ? 'Read only' : 'Workspace write'}</p>
          </div>
          <div className="rounded-lg bg-surface px-2.5 py-2">
            <p className="text-tertiary">Dependencies</p>
            <p className="mt-0.5 truncate font-medium text-secondary">{task.dependsOn.length === 0 ? 'Independent' : `${task.dependsOn.length} tasks`}</p>
          </div>
          <div className="rounded-lg bg-surface px-2.5 py-2">
            <p className="text-tertiary">Activity</p>
            <p className="mt-0.5 truncate font-medium text-secondary">{progressEvents.length} milestones</p>
          </div>
        </section>

        {task.dependsOn.length > 0 ? (
          <ul className="space-y-1 text-[11px] text-tertiary" aria-label="Agent dependencies">
            {task.dependsOn.map((dependency) => (
              <li key={dependency} className="flex min-w-0 items-center gap-2">
                <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                <code className="truncate font-mono" title={dependency}>{dependency}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </div>
  );
};
