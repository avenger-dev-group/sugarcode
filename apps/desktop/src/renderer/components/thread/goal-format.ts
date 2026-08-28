import type { GoalPauseReason, GoalStatus, GoalUsage } from '@/shared/conversation';

const integer = new Intl.NumberFormat('zh-CN');

export const formatGoalCount = (value: number): string => integer.format(value);

export const formatGoalDuration = (milliseconds: number): string => {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
};

export const formatGoalUsage = (usage: GoalUsage): string =>
  `${usage.turns} Turns · ${formatGoalCount(usage.tokens)} tokens · ${formatGoalDuration(usage.activeDurationMs)}`;

export const goalStatusLabel = (status: GoalStatus): string => {
  switch (status) {
    case 'active':
      return '进行中的目标';
    case 'paused':
      return '已暂停的目标';
    case 'completed':
      return '目标已完成';
  }
};

const PAUSE_REASON_LABELS: Record<GoalPauseReason, string> = {
  user: '由你暂停',
  blocked: '等待外部条件或你的输入',
  budget: '已达到本周期预算',
  failure: '执行失败，等待检查',
  restart: '应用重启后保持暂停',
  modelUnavailable: '固定模型当前不可用',
  queueBlocked: '会话队列未能继续',
  protocolViolation: 'Agent 未提交有效进度',
};

export const goalPauseReasonLabel = (
  reason: GoalPauseReason | undefined,
): string | undefined => reason ? PAUSE_REASON_LABELS[reason] : undefined;

