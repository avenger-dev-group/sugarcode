import type { ConversationPhase } from '@/shared/conversation';

import type {
  ActiveTurnOperationProgress,
  ActiveTurnProgressViewModel,
  TurnViewModel,
} from './types';

export const activeTurnOperationProgress = (
  turn: TurnViewModel | undefined,
): ActiveTurnOperationProgress | undefined => {
  if (turn?.userInputRequest) {
    return {
      state: 'waitingForInput',
      label: '等待你的回答',
      detail:
        turn.userInputRequest.questions.length > 1
          ? `共 ${turn.userInputRequest.questions.length} 个问题`
          : turn.userInputRequest.questions[0]?.header,
    };
  }
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
    if (entry.type === 'skill' && entry.activity.state === 'running') {
      return {
        state: 'runningTool',
        label: '正在应用 Skill',
        detail: entry.activity.name,
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
  phase: ConversationPhase,
  operation?: ActiveTurnOperationProgress,
  quietState: 'thinking' | 'continuing' | 'composing' = 'thinking',
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
  if (quietState === 'composing') {
    return {
      turnId,
      state: 'thinking',
      label: '正在整理回复',
    };
  }
  if (quietState === 'continuing') {
    return {
      turnId,
      state: 'thinking',
      label: '正在继续思考',
    };
  }
  return {
    turnId,
    state: 'thinking',
    label: '思考中',
  };
};
