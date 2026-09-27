import {
  BellRing,
  Binoculars,
  Check,
  ChevronDown,
  ChevronRight,
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

const statusSurface = (status: AgentTaskViewModel['status']): string => {
  switch (status) {
    case 'running':
      return 'border-process/30 bg-process/5';
    case 'waitingApproval':
      return 'border-primary/35 bg-primary/5';
    case 'completed':
      return 'border-success/25 bg-success/5';
    case 'failed':
      return 'border-destructive/35 bg-destructive/5';
    case 'interrupted':
      return 'border-secondary/30 bg-surface';
    case 'cancelled':
    case 'queued':
      return 'border-border bg-background';
  }
};

const statusRail = (status: AgentTaskViewModel['status']): string => {
  switch (status) {
    case 'running':
      return 'bg-process';
    case 'waitingApproval':
      return 'bg-primary';
    case 'completed':
      return 'bg-success';
    case 'failed':
      return 'bg-destructive';
    case 'interrupted':
      return 'bg-secondary';
    case 'cancelled':
    case 'queued':
      return 'bg-border';
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
  task.result
    ? compactMarkdown(task.result.summaryMarkdown)
    : task.progress?.stage === 'runningTool'
      ? compactMarkdown(task.progress.summaryMarkdown)
      : task.progress?.stage === 'streaming'
        ? 'Response is streaming. Open details to follow the live output.'
        : compactMarkdown(task.taskMarkdown);

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
          'group/task relative flex min-h-32 w-full min-w-0 flex-col overflow-hidden rounded-xl border p-3 text-left shadow-sm transition-[transform,border-color,background-color,box-shadow] duration-150 hover:-translate-y-px hover:shadow-[0_8px_24px_var(--shadow-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transform-none motion-reduce:transition-none',
          statusSurface(task.status),
          selected && 'border-brand/50 bg-brand/10 ring-1 ring-brand/15',
        )}
        aria-label={`${ROLE_LABELS[task.role]} ${task.title}, ${STATUS_LABELS[task.status]}`}
        aria-pressed={selected}
        data-agent-status={task.status}
      >
        <span
          className={cn(
            'absolute inset-y-3 left-0 w-0.5 rounded-r-full',
            statusRail(task.status),
          )}
          aria-hidden="true"
        />
        <span className="flex min-w-0 items-start gap-2.5">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-background/80 shadow-sm [&>svg]:size-3.5',
              statusTone(task.status),
            )}
          >
            <RoleIcon role={task.role} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-tertiary">
              <span className="truncate">{ROLE_LABELS[task.role]}</span>
              {task.dependsOn.length > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                  <span>{task.dependsOn.length}</span>
                </>
              ) : null}
            </span>
            <span className="mt-1 block line-clamp-2 text-sm font-semibold leading-5 text-primary">
              {task.title}
            </span>
          </span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full border border-current/15 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium [&>svg]:size-3',
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
              'mt-2.5 block line-clamp-2 text-[12px] font-normal leading-[18px] text-secondary',
              task.status === 'failed' && 'text-destructive',
            )}
          >
            {summary}
          </span>
        ) : null}
        <span className="mt-auto flex min-w-0 items-center gap-2 pt-3 text-[10px] leading-4 text-tertiary">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono">
            {task.result ? (
              <Clock3 className="size-3 shrink-0" aria-hidden="true" />
            ) : task.status === 'queued' ? (
              <LockKeyhole className="size-3 shrink-0" aria-hidden="true" />
            ) : (
              <span className="agent-activity-beacon" data-active={task.status === 'running'} aria-hidden="true" />
            )}
            <span className="truncate">{taskMeta(task, tasks)}</span>
          </span>
          {(task.progressEvents?.length ?? 0) > 0 ? (
            <span className="shrink-0 tabular-nums">{task.progressEvents?.length} steps</span>
          ) : null}
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-hover/task:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
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
    <div className="relative space-y-4">
      {waves.map((wave) => (
        <section
          key={wave.index}
          className="relative"
          aria-labelledby={`agent-wave-${activity.id}-${wave.index}`}
        >
          <div className="mb-2.5 flex min-w-0 items-center gap-2">
            <span className="grid size-5 shrink-0 place-items-center rounded-full border border-border bg-background font-mono text-[9px] tabular-nums text-tertiary shadow-sm">
              {String(wave.index + 1).padStart(2, '0')}
            </span>
            <h3
              id={`agent-wave-${activity.id}-${wave.index}`}
              className="shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-secondary"
            >
              Execution wave
            </h3>
            <span
              className="h-px min-w-4 flex-1 bg-border-subtle"
              aria-hidden="true"
            />
            <span className="shrink-0 text-[10px] text-tertiary">
              {wave.tasks.length === 1
                ? '1 task'
                : wave.tasks.every((task) => task.access === 'readOnly')
                  ? `${wave.tasks.length} parallel`
                  : `${wave.tasks.length} coordinated`}
            </span>
          </div>
          <ol className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2.5 pl-7">
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
  tasks,
  onSelect,
}: Readonly<{
  task: AgentTaskViewModel;
  tasks: readonly AgentTaskViewModel[];
  onSelect: (task: AgentTaskViewModel) => void;
}>) => {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(task)}
        className="group flex w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`${task.title}, ${STATUS_LABELS[task.status]}. Open details.`}
      >
        <span
          className={cn(
            'relative flex size-7 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-background [&>svg]:size-3.5',
            statusTone(task.status),
          )}
        >
          <RoleIcon role={task.role} />
          <span className={cn('absolute -right-0.5 -bottom-0.5 grid size-3 place-items-center rounded-full border border-background bg-surface [&>svg]:size-2', statusTone(task.status))}>
            <StatusIcon status={task.status} />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-5 text-primary">{task.title}</span>
          <span className="mt-0.5 block truncate text-[10px] text-tertiary">{ROLE_LABELS[task.role]} · {taskMeta(task, tasks)}</span>
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
        <ChevronRight className="size-3.5 shrink-0 text-tertiary transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
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
            className={cn(
              'group relative flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-xl border bg-background px-3 py-2.5 text-left shadow-sm transition-[border-color,background-color,box-shadow] hover:bg-surface hover:shadow-[0_8px_24px_var(--shadow-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              attentionCount > 0 && 'border-primary/35',
              attentionCount === 0 && activeCount > 0 && 'border-process/30',
            )}
            aria-label={`Agent tasks, ${triggerStatus}. Show current task details.`}
          >
            <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border bg-surface">
              <ListChecks
                className="size-4 text-secondary"
                aria-hidden="true"
              />
              {activeCount > 0 ? (
                <span className="agent-activity-beacon absolute -right-0.5 -top-0.5 ring-2 ring-background" data-active="true" aria-hidden="true" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-xs font-medium text-primary">
                  Agent run
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
                  tasks={activity.tasks}
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
      className="overflow-hidden rounded-2xl border border-border bg-background shadow-[0_12px_36px_var(--shadow-soft)]"
      aria-label="Agent task dependency waves"
    >
      <header className="relative overflow-hidden px-4 py-3.5">
        <div className="pointer-events-none absolute -right-12 -top-16 size-40 rounded-full bg-process/5 blur-3xl" aria-hidden="true" />
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl border bg-surface shadow-sm">
              <ListChecks className="size-4 text-secondary" aria-hidden="true" />
              {activeTasks.length > 0 ? (
                <span className="agent-activity-beacon absolute -right-0.5 -top-0.5 ring-2 ring-background" data-active="true" aria-hidden="true" />
              ) : null}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-primary">Agent run</p>
                <span className="rounded-full bg-surface px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-tertiary">
                  {activity.tasks.length} tasks
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-secondary">
                {settledTasks === activity.tasks.length
                  ? 'All delegated work has settled.'
                  : activeTasks.length > 0
                    ? `${activeTasks.length} working now · ${queuedTasks.length} waiting`
                    : `${queuedTasks.length} tasks ready for their execution wave`}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            {attentionTasks.length > 0 ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2 py-1 text-[10px] font-medium text-primary"
                aria-label={`${attentionTasks.length} Agent tasks need attention`}
              >
                <BellRing className="size-3.5" aria-hidden="true" />
                {attentionTasks.length}
              </span>
            ) : null}
            {activeTasks.length > 0 ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-process/25 bg-process/5 px-2 py-1 text-[10px] font-medium text-process"
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

      <div className="relative overflow-hidden border-t bg-surface/70 p-3.5">
        <div className="workbench-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
        <div className="relative">
          <AgentTaskWaveGrid
            activity={activity}
            selectedTaskId={selectedTask?.taskId}
            onSelect={selectTask}
          />
        </div>
      </div>

      <footer className="flex min-w-0 items-center gap-3 border-t px-4 py-3">
        <div
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border"
          role="progressbar"
          aria-label="Agent task progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="h-full rounded-full bg-brand shadow-sm transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-tertiary">
          {settledTasks}/{activity.tasks.length} settled
          {queuedTasks.length > 0 ? ` · ${queuedTasks.length} queued` : ''}
        </span>
      </footer>
    </section>
  );
};
