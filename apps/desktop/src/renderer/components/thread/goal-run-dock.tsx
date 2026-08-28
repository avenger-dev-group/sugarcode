import {
  CheckCircle2,
  CircleAlert,
  Pause,
  Pencil,
  Play,
  Target,
  Trash2,
} from 'lucide-react';

import { useOrchestrationActions } from '@/renderer/components/orchestration/use-store';
import { Button } from '@/renderer/components/ui/button';
import type { ConversationGoalMutation, GoalSnapshot } from '@/shared/conversation';

import { formatGoalDuration, goalPauseReasonLabel, goalStatusLabel } from './goal-format';
import type { ActiveTurnProgressViewModel } from './types';

type GoalRunDockProps = Readonly<{
  goal: GoalSnapshot;
  busy: boolean;
  progress?: ActiveTurnProgressViewModel;
  onMutate: (mutation: ConversationGoalMutation) => Promise<boolean>;
  onStop: () => Promise<void>;
}>;

const GoalStateIcon = ({ goal }: Readonly<{ goal: GoalSnapshot }>) => {
  if (goal.status === 'completed') return <CheckCircle2 className="size-4 text-success" aria-hidden="true" />;
  if (goal.status === 'paused') return <CircleAlert className="size-4 text-warning" aria-hidden="true" />;
  return <Target className="size-4 text-process" aria-hidden="true" />;
};

export const GoalRunDock = ({ goal, busy, progress, onMutate, onStop }: GoalRunDockProps) => {
  const { openGoal } = useOrchestrationActions();
  const identity = {
    threadId: goal.threadId,
    goalId: goal.id,
    expectedRevision: goal.revision,
  } as const;
  const ownsActiveTurn =
    goal.status === 'active' &&
    goal.activeTurnId !== undefined;
  const liveLabel = ownsActiveTurn
    ? progress?.label ?? '正在继续目标'
    : goal.status === 'active'
      ? '正在准备下一步'
      : goalPauseReasonLabel(goal.pauseReason);
  const checkpoint = goal.progress?.summary;

  return (
    <section
      id="conversation-goal"
      className="mb-2 overflow-hidden rounded-xl border border-border-subtle bg-background shadow-[0_8px_32px_var(--shadow-soft)]"
      aria-label={goalStatusLabel(goal.status)}
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg border bg-surface">
          <GoalStateIcon goal={goal} />
        </span>
        <button type="button" className="min-w-0 flex-1 text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring" onClick={openGoal}>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-xs font-medium text-secondary">{goalStatusLabel(goal.status)}</span>
            <span className="truncate text-sm text-primary" title={goal.objective}>{goal.objective}</span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-tertiary">
            {goal.status === 'active' ? <span className="agent-activity-beacon" data-active={ownsActiveTurn ? 'true' : 'false'} aria-hidden="true" /> : null}
            <span className={ownsActiveTurn ? 'agent-status-shimmer truncate' : 'truncate'}>{liveLabel ?? checkpoint ?? `已运行 ${formatGoalDuration(goal.lifetimeUsage.activeDurationMs)}`}</span>
            {checkpoint && checkpoint !== liveLabel ? <><span aria-hidden="true">·</span><span className="hidden min-w-0 truncate sm:inline" title={checkpoint}>最近进度：{checkpoint}</span></> : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {goal.status !== 'completed' ? (
            <Button type="button" size="icon" variant="ghost" className="size-8" onClick={openGoal} aria-label="编辑目标" title="编辑目标">
              <Pencil className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {goal.status === 'active' ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="暂停目标"
              title="暂停目标"
              onClick={() => ownsActiveTurn ? void onStop() : void onMutate({ action: 'pause', ...identity })}
            >
              <Pause className="size-3.5" aria-hidden="true" />
            </Button>
          ) : goal.status === 'paused' ? (
            <Button type="button" size="icon" variant="ghost" className="size-8" disabled={busy} aria-label="恢复目标" title="恢复目标" onClick={() => void onMutate({ action: 'resume', ...identity })}>
              <Play className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {goal.status !== 'active' || !busy ? (
            <Button type="button" size="icon" variant="ghost" className="size-8" disabled={busy} aria-label="清除目标" title="清除目标" onClick={() => void onMutate({ action: 'clear', ...identity })}>
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {goal.progress?.nextStep || goal.progress?.blocker ? (
        <div className="border-t border-border-subtle bg-surface/45 px-3 py-1.5 text-[11px] leading-5 text-secondary sm:pl-12">
          {goal.progress.blocker ? `阻塞：${goal.progress.blocker}` : `下一步：${goal.progress?.nextStep}`}
        </div>
      ) : null}
    </section>
  );
};
