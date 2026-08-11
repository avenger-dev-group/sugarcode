import type {
  CompactToolActivity,
  ProcessLanguage,
  TurnActivityViewModel,
} from './types';

type CommandActivity = Extract<
  CompactToolActivity,
  { type: 'commandApproval' }
>;

export const commandActivityFailed = (entry: CommandActivity): boolean => {
  const result = entry.activity.executionResult;
  if (
    entry.activity.state === 'denied' ||
    entry.activity.state === 'timedOut' ||
    entry.activity.state === 'unsupported'
  ) {
    return true;
  }
  if (!result || result.outcome.type === 'workspacePatch') {
    return false;
  }
  return (
    result.outcome.type === 'error' ||
    result.outcome.outcome.type !== 'exitCode' ||
    result.outcome.outcome.code !== 0
  );
};

export const commandActivityAction = (
  entry: CommandActivity,
  failed: boolean,
  active: boolean,
  language: ProcessLanguage,
): string => {
  const workspacePatch = entry.activity.operationKind === 'workspacePatch';
  if (language === 'zh') {
    switch (entry.activity.state) {
      case 'denied':
        return '已拒绝';
      case 'timedOut':
        return '审批超时';
      case 'unsupported':
        return '不支持审批';
      default:
        if (failed) {
          return workspacePatch ? '修改失败' : '命令失败';
        }
        if (active) {
          return workspacePatch ? '正在修改' : '正在运行';
        }
        if (entry.activity.executionResult) {
          return workspacePatch ? '已编辑' : '已运行';
        }
        return entry.activity.state === 'approved' ? '已批准' : '命令已停止';
    }
  }
  switch (entry.activity.state) {
    case 'denied':
      return 'Denied';
    case 'timedOut':
      return 'Approval timed out';
    case 'unsupported':
      return 'Approval unsupported';
    default:
      if (failed) {
        return workspacePatch ? 'Edit failed' : 'Command failed';
      }
      if (active) {
        return workspacePatch ? 'Editing' : 'Running';
      }
      if (entry.activity.executionResult) {
        return workspacePatch ? 'Edited' : 'Ran';
      }
      return entry.activity.state === 'approved'
        ? 'Approved'
        : 'Command stopped';
  }
};

export const isCompactToolActivity = (
  entry: TurnActivityViewModel | undefined,
): entry is CompactToolActivity => {
  if (!entry) {
    return false;
  }
  if (
    entry.type === 'workspaceRead' ||
    entry.type === 'workspaceList' ||
    entry.type === 'workspaceSearch' ||
    entry.type === 'fileChange'
  ) {
    return true;
  }
  if (entry.type === 'commandApproval') {
    return (
      entry.activity.state !== 'awaiting' && entry.activity.state !== 'stopping'
    );
  }
  if (entry.type === 'mcp') {
    return entry.activity.state !== 'awaiting';
  }
  return false;
};
