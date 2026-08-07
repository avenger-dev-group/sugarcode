import {
  BellRing,
  Binoculars,
  Check,
  Circle,
  Clock3,
  FilePenLine,
  GitBranch,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect } from 'react';

import { cn } from '@/renderer/utils/class-name';

import {
  agentTaskGroupForStatus,
  formatAgentTaskDuration,
} from './presentation';
import type {
  AgentTaskRole,
  AgentTaskViewModel,
  OrchestrationActivityViewModel,
} from './types';
import { useOrchestrationStore } from './use-store';

type TaskGroup = Readonly<{
  id: 'attention' | 'active' | 'queued' | 'finished';
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

const PROGRESS_LABELS: Record<
  NonNullable<AgentTaskViewModel['progress']>['stage'],
  string
> = {
  waitingForModel: 'Waiting for model',
  streaming: 'Streaming response',
  runningTool: 'Running tool',
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
      return <TriangleAlert aria-hidden="true" />;
    case 'cancelled':
      return <X aria-hidden="true" />;
    case 'running':
      return (
        <LoaderCircle
          className="animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      );
    case 'waitingApproval':
      return <BellRing aria-hidden="true" />;
    case 'queued':
      return <Circle aria-hidden="true" />;
  }
};

const statusTone = (status: AgentTaskViewModel['status']): string => {
  switch (status) {
    case 'running':
      return 'text-process';
    case 'waitingApproval':
      return 'text-primary';
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-destructive';
    case 'interrupted':
      return 'text-secondary';
    case 'cancelled':
    case 'queued':
      return 'text-tertiary';
  }
};

const compactMarkdown = (value: string | undefined): string | undefined => {
  const compact = value
    ?.replace(/[#*`>|_~]/gu, '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/\s+/gu, ' ')
    .trim();
  return compact ? compact.slice(0, 180) : undefined;
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

const formatUpdateTime = (updatedAt: number): string =>
  new Date(updatedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

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
  const attention =
    task.status === 'waitingApproval' ||
    task.status === 'failed' ||
    task.status === 'interrupted';
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(task)}
        className={cn(
          'group/task flex w-full min-w-0 items-start gap-3 rounded-lg border bg-background px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          selected && 'border-primary bg-surface shadow-sm',
          !selected && task.status === 'failed' && 'border-destructive',
        )}
        aria-label={`${ROLE_LABELS[task.role]} ${task.title}, ${STATUS_LABELS[task.status]}`}
        aria-pressed={selected}
        data-agent-status={task.status}
      >
        <span
          className={cn(
            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-surface [&>svg]:size-4',
            statusTone(task.status),
          )}
        >
          <RoleIcon role={task.role} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium leading-5 text-primary">
                {task.title}
              </span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-4 text-tertiary">
                <span>{ROLE_LABELS[task.role]}</span>
                <span aria-hidden="true">·</span>
                <span>{task.access === 'readOnly' ? 'Read only' : 'Workspace write'}</span>
                {task.dependsOn.length > 0 ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      <GitBranch className="size-3.5" aria-hidden="true" />
                      {task.dependsOn.length}
                    </span>
                  </>
                ) : null}
              </span>
            </span>
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 pt-0.5 text-xs font-medium [&>svg]:size-3.5',
                statusTone(task.status),
              )}
            >
              <StatusIcon status={task.status} />
              {STATUS_LABELS[task.status]}
            </span>
          </span>
          {summary ? (
            <span
              className={cn(
                'mt-1 line-clamp-1 block text-xs leading-5 text-secondary',
                task.status === 'failed' && 'text-destructive',
              )}
              aria-live={task.status === 'running' ? 'polite' : undefined}
            >
              {summary}
            </span>
          ) : null}
          <span className="mt-1.5 flex min-w-0 items-center gap-2 font-mono text-xs leading-4 text-tertiary">
            {task.progress && !task.result ? (
              <>
                <span className="truncate">
                  {PROGRESS_LABELS[task.progress.stage]}
                </span>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">
                  {formatUpdateTime(task.progress.updatedAt)}
                </span>
              </>
            ) : task.result ? (
              <>
                <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{formatAgentTaskDuration(task.result.durationMs)}</span>
                {attention ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Review recorded result</span>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />
                <span>Waiting for execution</span>
              </>
            )}
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
      <div className="mb-1.5 flex min-w-0 items-baseline gap-2 px-0.5">
        <h3
          id={`agent-group-${group.id}`}
          className="shrink-0 text-xs font-medium text-secondary"
        >
          {group.label}
        </h3>
        <span className="font-mono text-xs text-tertiary">
          {group.tasks.length}
        </span>
        <span className="truncate text-xs text-tertiary">
          {group.description}
        </span>
      </div>
      <ol className="space-y-1.5">
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
  const attentionTasks = activity.tasks.filter(
    (task) => agentTaskGroupForStatus(task.status) === 'attention',
  );
  const activeTasks = activity.tasks.filter(
    (task) => agentTaskGroupForStatus(task.status) === 'active',
  );
  const queuedTasks = activity.tasks.filter(
    (task) => agentTaskGroupForStatus(task.status) === 'queued',
  );
  const finishedTasks = activity.tasks.filter(
    (task) => agentTaskGroupForStatus(task.status) === 'finished',
  );
  const completedTasks = activity.tasks.filter(
    (task) => task.status === 'completed',
  ).length;
  const settledTasks = activity.tasks.filter((task) =>
    ['completed', 'failed', 'interrupted', 'cancelled'].includes(task.status),
  ).length;
  const progress =
    activity.tasks.length === 0
      ? 0
      : Math.round((settledTasks / activity.tasks.length) * 100);
  const groups: readonly TaskGroup[] = [
    {
      id: 'attention',
      label: 'Needs attention',
      description: 'Approval requests and results to review',
      tasks: attentionTasks,
    },
    {
      id: 'active',
      label: 'In progress',
      description: 'Agents working now',
      tasks: activeTasks,
    },
    {
      id: 'queued',
      label: 'Up next',
      description: 'Waiting for dependencies or capacity',
      tasks: queuedTasks,
    },
    {
      id: 'finished',
      label: 'Finished',
      description: 'Completed and cancelled work',
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
      className="overflow-hidden rounded-xl border bg-background shadow-[0_8px_28px_var(--shadow-soft)]"
      aria-label="Agent task workbench"
    >
      <header className="border-b bg-surface px-3.5 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
              <ListChecks className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">Agent tasks</p>
              <p className="mt-0.5 truncate text-xs text-secondary">
                {activeTasks.length > 0
                  ? `${activeTasks.length} active · ${queuedTasks.length} queued`
                  : `${settledTasks} of ${activity.tasks.length} tasks settled`}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            {attentionTasks.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-1 text-primary">
                <BellRing className="size-3.5" aria-hidden="true" />
                {attentionTasks.length} attention
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-1 text-secondary">
              <Check className="size-3.5 text-success" aria-hidden="true" />
              {completedTasks} done
            </span>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-2.5">
          <div
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border"
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
          <span className="font-mono text-[11px] tabular-nums text-tertiary">
            {progress}%
          </span>
        </div>
      </header>
      <div className="space-y-4 p-3">
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
