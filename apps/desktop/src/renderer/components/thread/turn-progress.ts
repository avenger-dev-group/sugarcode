import type { ConversationPhase } from '@/shared/conversation';

import type { ActiveTurnProgressViewModel } from './types';

export const MODEL_WAIT_NOTICE_SECONDS = 15;

export const formatWaitDuration = (seconds: number): string => {
  const bounded = Math.max(0, Math.floor(seconds));
  if (bounded < 60) {
    return `${bounded}s`;
  }
  const minutes = Math.floor(bounded / 60);
  const remainingSeconds = bounded % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
};

export const toActiveTurnProgress = (
  turnId: string,
  modelDisplayName: string | undefined,
  phase: ConversationPhase,
  quietSeconds: number,
): ActiveTurnProgressViewModel => {
  if (phase === 'stopping') {
    return {
      turnId,
      state: 'stopping',
      label: '正在安全停止…',
    };
  }
  if (phase === 'unavailable') {
    return {
      turnId,
      state: 'uncertain',
      label: 'Agent 状态暂时不可用',
      detail: '重新连接或重启后，SugarCode 会把未完成的任务恢复为已中断。',
    };
  }
  if (quietSeconds >= MODEL_WAIT_NOTICE_SECONDS) {
    return {
      turnId,
      state: 'waitingForModel',
      label: `${modelDisplayName ?? '所选模型'} 暂无可见响应`,
      elapsedLabel: `已等待 ${formatWaitDuration(quietSeconds)}`,
      detail:
        '任务仍在运行且不会被自动超时；你可以继续等待，或停止后切换模型。',
    };
  }
  return {
    turnId,
    state: 'working',
    label: 'Agent 正在处理…',
  };
};
