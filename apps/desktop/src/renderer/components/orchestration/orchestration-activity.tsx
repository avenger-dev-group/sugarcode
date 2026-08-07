import {
  Binoculars,
  Check,
  Circle,
  Clock3,
  FilePenLine,
  GitBranch,
  ListChecks,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useEffect } from 'react';

import { cn } from '@/renderer/utils/class-name';

import type {
  AgentTaskRole,
  AgentTaskViewModel,
  OrchestrationActivityViewModel,
} from './types';
import { formatAgentTaskDuration } from './presentation';
import { useOrchestrationStore } from './use-store';

type TaskGroup = Readonly<{
  id: 'active' | 'queued' | 'finished';
  label: string;
  description: string;
  tasks: readonly AgentTaskViewModel[];
}>;

const STATUS_LABELS: Record<AgentTaskViewModel['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waitingApproval: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

const ROLE_LABELS: Record<AgentTaskRole, string> = {
  explorer: 'Explorer',
  worker: 'Worker',
  auditor: 'Auditor',
};

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
    case 'cancelled':
      return <TriangleAlert aria-hidden="true" />;
    case 'running':
    case 'waitingApproval':
      return <Sparkles aria-hidden="true" />;
    case 'queued':
      return <Circle aria-hidden="true" />;
  }
};

const statusTone = (status: AgentTaskViewModel['status']): string => {
  switch (status) {
    case 'running':
      return 'border-primary/25 bg-surface text-primary';
    case 'waitingApproval':
      return 'border-primary/25 bg-surface text-process';
    case 'completed':
      return 'border-border bg-surface text-success';
    case 'failed':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'interrupted':
    case 'cancelled':
      return 'border-border bg-surface text-secondary';
    case 'queued':
      return 'border-border bg-surface text-tertiary';
  }
};

const compactMarkdown = (value: string | undefined): string | undefined => {
  const compact = value
    ?.replace(/[#*`>|_~]/gu, '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/\s+/gu, ' ')
    .trim();
  return compact ? compact.slice(0, 220) : undefined;
};

const taskSummary = (task: AgentTaskViewModel): string | undefined => {
  if (task.status === 'failed' || task.status === 'interrupted') {
    return compactMarkdown(task.result?.summaryMarkdown);
  }
  if (!task.result) {
    return compactMarkdown(task.progress?.summaryMarkdown);
  }
  return undefined;
};

const AgentTaskRow = ({
  task,
  selected,
  onSelect,
}: Readonly<{
  task: AgentTaskViewModel;
  selected: boolean;
  onSelect: (task: AgentTaskViewModel) => void;
}>) => {
  const summary = taskSummary(task);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(task)}
        className={cn(
          'group/task flex w-full min-w-0 items-start gap-3 rounded-xl border bg-background px-3 py-3 text-left transition-[border-color,background-color,box-shadow] hover:border-primary/30 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          selected && 'border-primary/45 bg-surface shadow-sm',
          task.status === 'failed' && 'border-destructive/25',
        )}
        aria-label={`${ROLE_LABELS[task.role]} ${task.title}, ${STATUS_LABELS[task.status]}`}
        aria-pressed={selected}
        data-agent-status={task.status}
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-surface text-secondary [&>svg]:size-4">
          <RoleIcon role={task.role} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
              {ROLE_LABELS[task.role]}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] [&>svg]:size-2.5',
                statusTone(task.status),
              )}
            >
              <StatusIcon status={task.status} />
              {STATUS_LABELS[task.status]}
            </span>
            {task.result ? (
              <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-tertiary">
                <Clock3 className="size-3" aria-hidden="true" />
                {formatAgentTaskDuration(task.result.durationMs)}
              </span>
            ) : null}
          </span>
          <span className="mt-1 block break-words text-sm font-medium leading-5 text-primary">
            {task.title}
          </span>
          {summary ? (
            <span
              className={cn(
                'mt-1.5 line-clamp-2 block text-xs leading-5 text-secondary',
                task.status === 'failed' && 'text-destructive',
              )}
              aria-live={task.status === 'running' ? 'polite' : undefined}
            >
              {summary}
            </span>
          ) : null}
          <span className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-[0.08em] text-tertiary">
            <span className="inline-flex items-center gap-1">
              <LockKeyhole className="size-2.5" aria-hidden="true" />
              {task.access === 'readOnly' ? 'Read only' : 'Workspace write'}
            </span>
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
              {task.dependsOn.length === 0
                ? 'No dependencies'
                : `${task.dependsOn.length} ${
                    task.dependsOn.length === 1 ? 'dependency' : 'dependencies'
                  }`}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
};

const TaskGroupSection = ({
  group,
  selectedTaskId,
  onSelect,
}: Readonly<{
  group: TaskGroup;
  selectedTaskId: string | undefined;
  onSelect: (task: AgentTaskViewModel) => void;
}>) => {
  if (group.tasks.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={`agent-group-${group.id}`}>
      <div className="mb-2 flex items-baseline gap-2">
        <h3
          id={`agent-group-${group.id}`}
          className="text-xs font-medium text-secondary"
        >
          {group.label}
        </h3>
        <span className="font-mono text-[10px] text-tertiary">
          {group.tasks.length}
        </span>
        <span className="text-[11px] text-tertiary">{group.description}</span>
      </div>
      <ol className="space-y-2">
        {group.tasks.map((task) => (
          <AgentTaskRow
            key={task.taskId}
            task={task}
            selected={task.taskId === selectedTaskId}
            onSelect={onSelect}
          />
        ))}
      </ol>
    </section>
  );
};

export const OrchestrationActivity = ({
  activity,
}: Readonly<{ activity: OrchestrationActivityViewModel }>) => {
  const { selectTask, selectedTask, refreshTask } = useOrchestrationStore();
  const activeTasks = activity.tasks.filter(
    (task) => task.status === 'running' || task.status === 'waitingApproval',
  );
  const queuedTasks = activity.tasks.filter((task) => task.status === 'queued');
  const finishedTasks = activity.tasks.filter(
    (task) => !['queued', 'running', 'waitingApproval'].includes(task.status),
  );
  const completedTasks = activity.tasks.filter(
    (task) => task.status === 'completed',
  ).length;
  const failedTasks = activity.tasks.filter(
    (task) => task.status === 'failed',
  ).length;
  const settledTasks = finishedTasks.length;
  const progress =
    activity.tasks.length === 0
      ? 0
      : Math.round((settledTasks / activity.tasks.length) * 100);
  const groups: readonly TaskGroup[] = [
    {
      id: 'active',
      label: 'In progress',
      description: 'Live work and requests that need attention',
      tasks: activeTasks,
    },
    {
      id: 'queued',
      label: 'Up next',
      description: 'Waiting for a dependency or an execution slot',
      tasks: queuedTasks,
    },
    {
      id: 'finished',
      label: 'Finished',
      description: 'Completed work and recorded failures',
      tasks: finishedTasks,
    },
  ];

  useEffect(() => {
    const current = activity.tasks.find(
      (task) => task.taskId === selectedTask?.taskId,
    );
    if (current) {
      refreshTask(current);
    }
  }, [activity.tasks, refreshTask, selectedTask?.taskId]);

  return (
    <section
      className="overflow-hidden rounded-2xl border bg-background shadow-[0_12px_36px_var(--shadow-soft)]"
      aria-label="Agent task workbench"
    >
      <header className="border-b bg-surface px-4 py-3.5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm">
              <ListChecks className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">Agent task workbench</p>
              <p className="mt-0.5 text-xs text-secondary">
                {activeTasks.length > 0
                  ? `${activeTasks.length} working now · ${queuedTasks.length} queued`
                  : `${settledTasks} of ${activity.tasks.length} tasks settled`}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-1 text-secondary">
              <Check className="size-3 text-success" aria-hidden="true" />
              {completedTasks} done
            </span>
            {failedTasks > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
                <TriangleAlert className="size-3" aria-hidden="true" />
                {failedTasks} failed
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-label="Agent task progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="font-mono text-[10px] tabular-nums text-tertiary">
            {progress}%
          </span>
        </div>
      </header>
      <div className="space-y-5 p-3.5 sm:p-4">
        {groups.map((group) => (
          <TaskGroupSection
            key={group.id}
            group={group}
            selectedTaskId={selectedTask?.taskId}
            onSelect={selectTask}
          />
        ))}
      </div>
    </section>
  );
};
