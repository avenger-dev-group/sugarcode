import {
  BellRing,
  Binoculars,
  Check,
  ChevronDown,
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

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/renderer/components/ui/popover';
import { cn } from '@/renderer/utils/class-name';

import {
  activeAgentTaskDockTasks,
  agentTaskWaves,
  formatAgentTaskDuration,
  queuedAgentTaskReason,
} from './presentation';
import type {
  AgentTaskRole,
  AgentTaskViewModel,
  OrchestrationActivityViewModel,
} from './types';
import {
  useOrchestrationActions,
  useOrchestrationTaskState,
} from './use-store';

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
  waitingForModel: 'Thinking',
  streaming: 'Responding',
  runningTool: 'Using tools',
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

const taskSummary = (task: AgentTaskViewModel): string | undefined =>
  compactMarkdown(
    task.result?.summaryMarkdown ??
      task.progress?.summaryMarkdown ??
      task.taskMarkdown,
  );

const formatUpdateTime = (updatedAt: number): string =>
  new Date(updatedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

const taskMeta = (
  task: AgentTaskViewModel,
  tasks: readonly AgentTaskViewModel[],
): string => {
  if (task.status === 'queued') {
    return queuedAgentTaskReason(task, tasks);
  }
  if (task.progress && !task.result) {
    return `${PROGRESS_LABELS[task.progress.stage]} · ${formatUpdateTime(
      task.progress.updatedAt,
    )}`;
  }
  if (task.result) {
    return [
      formatAgentTaskDuration(task.result.durationMs),
      task.result.attempts && task.result.attempts > 1
        ? `${task.result.attempts} attempts`
        : undefined,
      task.result.partial ? 'partial result saved' : undefined,
    ].filter(Boolean).join(' · ');
  }
  return task.access === 'readOnly' ? 'Read only' : 'Workspace write';
};

const AgentTaskCard = ({
  task,
  tasks,
  selected,
  onSelect,
}: Readonly<{
  task: AgentTaskViewModel;
  tasks: readonly AgentTaskViewModel[];
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
          'group/task flex min-h-24 w-full min-w-0 flex-col rounded-lg border bg-background p-2.5 text-left transition-[border-color,background-color,box-shadow] hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          selected && 'border-brand/40 bg-brand/10 shadow-sm',
          !selected && task.status === 'failed' && 'border-destructive',
        )}
        aria-label={`${ROLE_LABELS[task.role]} ${task.title}, ${STATUS_LABELS[task.status]}`}
        aria-pressed={selected}
        data-agent-status={task.status}
      >
        <span className="flex min-w-0 items-start gap-2.5">
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-md border bg-surface [&>svg]:size-3.5',
              statusTone(task.status),
            )}
          >
            <RoleIcon role={task.role} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-5 text-primary">
              {task.title}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-tertiary">
              <span>{ROLE_LABELS[task.role]}</span>
              {task.dependsOn.length > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                  <span>{task.dependsOn.length}</span>
                </>
              ) : null}
            </span>
          </span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 pt-0.5 text-[11px] font-medium [&>svg]:size-3.5',
              statusTone(task.status),
              task.status === 'running' && 'agent-status-shimmer',
            )}
          >
            <StatusIcon status={task.status} />
            {STATUS_LABELS[task.status]}
          </span>
        </span>
        {summary ? (
          <span
            className={cn(
              'mt-2 block max-h-9 overflow-hidden text-xs font-normal leading-[18px] text-primary',
              task.status === 'failed' && 'text-destructive',
            )}
            aria-live={task.status === 'running' ? 'polite' : undefined}
          >
            {summary}
          </span>
        ) : null}
        <span className="mt-auto flex min-w-0 items-center gap-1.5 pt-2 font-mono text-[11px] leading-4 text-tertiary">
          {task.result ? (
            <Clock3 className="size-3 shrink-0" aria-hidden="true" />
          ) : task.status === 'queued' ? (
            <LockKeyhole className="size-3 shrink-0" aria-hidden="true" />
          ) : null}
          <span className="truncate">{taskMeta(task, tasks)}</span>
        </span>
      </button>
    </li>
  );
};

const AgentTaskWaveGrid = ({
  activity,
  selectedTaskId,
  onSelect,
}: Readonly<{
  activity: OrchestrationActivityViewModel;
  selectedTaskId?: string;
  onSelect: (task: AgentTaskViewModel) => void;
}>) => {
  const waves = agentTaskWaves(activity.tasks);

  return (
    <div className="space-y-3">
      {waves.map((wave) => (
        <section
          key={wave.index}
          aria-labelledby={`agent-wave-${activity.id}-${wave.index}`}
        >
          <div className="mb-2 flex min-w-0 items-center gap-2 px-0.5">
            <h3
              id={`agent-wave-${activity.id}-${wave.index}`}
              className="shrink-0 text-xs font-medium text-secondary"
            >
              Wave {wave.index + 1}
            </h3>
            <span
              className="h-px min-w-4 flex-1 bg-border"
              aria-hidden="true"
            />
            <span className="shrink-0 text-[11px] text-tertiary">
              {wave.tasks.length === 1
                ? '1 task'
                : wave.tasks.every((task) => task.access === 'readOnly')
                  ? `${wave.tasks.length} parallel-capable`
                  : `${wave.tasks.length} share workspace access`}
            </span>
          </div>
          <ol className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-2">
            {wave.tasks.map((task) => (
              <AgentTaskCard
                key={task.taskId}
                task={task}
                tasks={activity.tasks}
                selected={task.taskId === selectedTaskId}
                onSelect={onSelect}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
};

const settledTaskCount = (tasks: readonly AgentTaskViewModel[]): number =>
  tasks.filter((task) =>
    ['completed', 'failed', 'interrupted', 'cancelled'].includes(task.status),
  ).length;

const AgentTaskDockRow = ({
  task,
  onSelect,
}: Readonly<{
  task: AgentTaskViewModel;
  onSelect: (task: AgentTaskViewModel) => void;
}>) => {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(task)}
        className="group flex w-full min-w-0 items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`${task.title}, ${STATUS_LABELS[task.status]}. Open details.`}
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full bg-surface [&>svg]:size-3',
            statusTone(task.status),
          )}
        >
          <StatusIcon status={task.status} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-primary">
          {task.title}
        </span>
        <span
          className={cn(
            'shrink-0 text-[11px] font-medium',
            statusTone(task.status),
            task.status === 'running' && 'agent-status-shimmer',
          )}
        >
          {STATUS_LABELS[task.status]}
        </span>
      </button>
    </li>
  );
};

export const AgentTaskDock = ({
  activity,
}: Readonly<{ activity: OrchestrationActivityViewModel }>) => {
  const { refreshTask, selectTask } = useOrchestrationActions();
  const { selectedTask, setTaskDockOpen, taskDockOpen } =
    useOrchestrationTaskState();
  const dockTasks = activeAgentTaskDockTasks(activity.tasks);
  const primaryTask = dockTasks[0];
  const activeCount = activity.tasks.filter(
    (task) => task.status === 'running',
  ).length;
  const queuedCount = activity.tasks.filter(
    (task) => task.status === 'queued',
  ).length;
  const attentionCount = activity.tasks.filter((task) =>
    ['waitingApproval', 'failed', 'interrupted'].includes(task.status),
  ).length;
  const settledCount = settledTaskCount(activity.tasks);
  const progress = Math.round((settledCount / activity.tasks.length) * 100);
  const triggerStatus =
    attentionCount > 0
      ? attentionCount === 1
        ? '1 needs attention'
        : `${attentionCount} need attention`
      : activeCount > 0
        ? `${activeCount} active`
        : queuedCount > 0
          ? `${queuedCount} waiting`
          : `${settledCount} of ${activity.tasks.length} settled`;

  useEffect(() => {
    if (dockTasks.length === 0) {
      setTaskDockOpen(false);
    }
  }, [dockTasks.length, setTaskDockOpen]);

  useEffect(() => {
    const current = activity.tasks.find(
      (task) => task.taskId === selectedTask?.taskId,
    );
    if (current) {
      refreshTask(current);
    }
  }, [activity.tasks, refreshTask, selectedTask?.taskId]);

  useEffect(() => {
    return () => {
      setTaskDockOpen(false);
    };
  }, [setTaskDockOpen]);

  if (dockTasks.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 px-1">
      <Popover open={taskDockOpen} onOpenChange={setTaskDockOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="group relative flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-xl border bg-background px-3 py-2 text-left transition-[border-color,background-color] hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label={`Agent tasks, ${triggerStatus}. Show current task details.`}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-surface">
              <ListChecks
                className="size-4 text-secondary"
                aria-hidden="true"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-xs font-medium text-primary">
                  Agent tasks
                </span>
                <span className="text-tertiary" aria-hidden="true">
                  ·
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-secondary">
                  {primaryTask?.title}
                </span>
              </span>
              <span
                className={cn(
                  'mt-0.5 block truncate text-[11px] leading-4',
                  attentionCount > 0
                    ? 'text-primary'
                    : activeCount > 0
                      ? 'text-process agent-status-shimmer'
                      : 'text-tertiary',
                )}
              >
                {triggerStatus}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-tertiary">
              {settledCount}/{activity.tasks.length}
            </span>
            <ChevronDown
              className="size-3.5 shrink-0 text-tertiary transition-transform group-aria-expanded:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
            <span
              className="absolute inset-x-0 bottom-0 h-px bg-border"
              aria-hidden="true"
            >
              <span
                className="block h-full bg-brand transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${progress}%` }}
              />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="flex max-h-[min(24rem,calc(100vh-10rem))] w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden p-0"
          aria-label="Current Agent tasks"
        >
          <header className="border-b px-4 py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-surface">
                <ListChecks
                  className="size-4 text-secondary"
                  aria-hidden="true"
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-primary">Agent tasks</p>
                <p className="mt-0.5 text-[11px] text-tertiary">
                  {attentionCount > 0
                    ? `${attentionCount} attention`
                    : 'No blockers'}
                  {' · '}
                  {activeCount} working{' · '}
                  {queuedCount} waiting
                </p>
              </div>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-tertiary">
                {settledCount} / {activity.tasks.length}
              </span>
            </div>
            <div
              className="mt-3 h-1 overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-label="Agent task progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${progress}%` }}
              />
            </div>
          </header>
          <div className="min-h-0 overflow-y-auto">
            <ol className="divide-y divide-border">
              {dockTasks.map((task) => (
                <AgentTaskDockRow
                  key={task.taskId}
                  task={task}
                  onSelect={selectTask}
                />
              ))}
            </ol>
          </div>
          {settledCount > 0 ? (
            <footer className="border-t bg-surface px-4 py-2.5 text-[11px] text-tertiary">
              Completed task details appear in the conversation history.
            </footer>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
};

export const OrchestrationActivity = ({
  activity,
}: Readonly<{ activity: OrchestrationActivityViewModel }>) => {
  const { refreshTask, selectTask } = useOrchestrationActions();
  const { selectedTask } = useOrchestrationTaskState();
  const activeTasks = activity.tasks.filter(
    (task) => task.status === 'running',
  );
  const queuedTasks = activity.tasks.filter((task) => task.status === 'queued');
  const attentionTasks = activity.tasks.filter((task) =>
    ['waitingApproval', 'failed', 'interrupted'].includes(task.status),
  );
  const settledTasks = settledTaskCount(activity.tasks);
  const progress =
    activity.tasks.length === 0
      ? 0
      : Math.round((settledTasks / activity.tasks.length) * 100);

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
      className="overflow-hidden rounded-xl border bg-background"
      aria-label="Agent task dependency waves"
    >
      <header className="px-3.5 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-surface">
              <ListChecks className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">Agent tasks</p>
              <p className="mt-0.5 truncate text-xs text-secondary">
                Independent read-only work runs together; dependencies advance
                by wave.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            {attentionTasks.length > 0 ? (
              <span
                className="inline-flex items-center gap-1 rounded-md border bg-surface px-1.5 py-1 text-primary"
                aria-label={`${attentionTasks.length} Agent tasks need attention`}
              >
                <BellRing className="size-3.5" aria-hidden="true" />
                {attentionTasks.length}
              </span>
            ) : null}
            {activeTasks.length > 0 ? (
              <span
                className="inline-flex items-center gap-1 rounded-md border bg-surface px-1.5 py-1 text-process"
                aria-label={`${activeTasks.length} Agent tasks active`}
              >
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {activeTasks.length} active
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <div className="border-t bg-surface p-3">
        <AgentTaskWaveGrid
          activity={activity}
          selectedTaskId={selectedTask?.taskId}
          onSelect={selectTask}
        />
      </div>

      <footer className="flex min-w-0 items-center gap-2.5 border-t px-3.5 py-2.5">
        <div
          className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border"
          role="progressbar"
          aria-label="Agent task progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-tertiary">
          {settledTasks} / {activity.tasks.length} settled
          {queuedTasks.length > 0 ? ` · ${queuedTasks.length} queued` : ''}
        </span>
      </footer>
    </section>
  );
};
