import type { ConversationPhase } from '@/shared/conversation';

import type {
  ActiveTurnOperationProgress,
  ActiveTurnProgressViewModel,
  TurnViewModel,
} from './types';

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

export const activeTurnOperationProgress = (
  turn: TurnViewModel | undefined,
): ActiveTurnOperationProgress | undefined => {
  const activities = turn?.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const entry = activities[index];
    if (!entry) {
      continue;
    }
    if (entry.type === 'commandApproval') {
      if (entry.activity.state === 'awaiting') {
        return {
          state: 'waitingForApproval',
          label:
            entry.activity.operationKind === 'workspacePatch'
              ? '等待你确认文件修改'
              : '等待你确认命令执行',
          detail: entry.activity.command,
        };
      }
      if (entry.activity.executionAttempt && !entry.activity.executionResult) {
        return {
          state: 'runningTool',
          label:
            entry.activity.operationKind === 'workspacePatch'
              ? '正在原子应用文件修改'
              : '正在执行项目命令',
          detail: entry.activity.command,
        };
      }
      continue;
    }
    if (entry.type === 'workspaceRead' && entry.activity.state === 'running') {
      return {
        state: 'runningTool',
        label: '正在读取项目文件',
        detail: entry.activity.path,
      };
    }
    if (entry.type === 'workspaceList' && entry.activity.state === 'running') {
      return {
        state: 'runningTool',
        label: '正在查看项目目录',
        detail: entry.activity.path,
      };
    }
    if (entry.type === 'workspaceSearch' && entry.activity.state === 'running') {
      return {
        state: 'runningTool',
        label: '正在搜索项目代码',
        detail: `“${entry.activity.query}” · ${entry.activity.path}`,
      };
    }
    if (
      entry.type === 'fileChange' &&
      (entry.activity.state === 'preparing' ||
        entry.activity.state === 'applying')
    ) {
      return {
        state: 'runningTool',
        label: '正在处理文件修改',
        detail: entry.activity.path,
      };
    }
    if (entry.type === 'mcp') {
      if (entry.activity.state === 'awaiting') {
        return {
          state: 'waitingForApproval',
          label: '等待你确认外部工具调用',
          detail: entry.activity.name,
        };
      }
      if (
        entry.activity.state === 'approved' ||
        entry.activity.state === 'attempted'
      ) {
        return {
          state: 'runningTool',
          label: '正在调用外部工具',
          detail: entry.activity.name,
        };
      }
    }
  }
  return undefined;
};

export const toActiveTurnProgress = (
  turnId: string,
  modelDisplayName: string | undefined,
  phase: ConversationPhase,
  quietSeconds: number,
  operation?: ActiveTurnOperationProgress,
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
  if (operation) {
    return { turnId, ...operation };
  }
  if (quietSeconds >= MODEL_WAIT_NOTICE_SECONDS) {
    return {
      turnId,
      state: 'waitingForModel',
      label: `${modelDisplayName ?? '所选模型'} 暂无可见响应`,
      elapsedLabel: `已等待 ${formatWaitDuration(quietSeconds)}`,
      detail:
        '当前正在等待模型服务；单次请求最长约 5 分钟，超时会自动结束。你也可以立即停止后切换模型。',
    };
  }
  return {
    turnId,
    state: 'working',
    label: 'Agent 正在处理…',
  };
};
