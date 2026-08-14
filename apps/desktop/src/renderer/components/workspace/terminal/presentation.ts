import type { TerminalStateSnapshot } from '@/shared/terminal';

export const terminalStatusLabel = (
  state: TerminalStateSnapshot,
): string => {
  switch (state.status) {
    case 'starting':
      return '正在启动';
    case 'running':
      return '运行中';
    case 'paused':
      return '输入已暂停';
    case 'exited':
      return `已退出 ${state.exitCode}`;
    case 'failed':
      return '启动失败';
    case 'closed':
      return '未启动';
  }
};

export const shouldAutoStartTerminal = ({
  attemptedGeneration,
  busy,
  open,
  status,
  workspaceGeneration,
  workspaceReady,
}: Readonly<{
  attemptedGeneration: number | null;
  busy: boolean;
  open: boolean;
  status: TerminalStateSnapshot['status'];
  workspaceGeneration: number;
  workspaceReady: boolean;
}>): boolean =>
  open &&
  workspaceReady &&
  status === 'closed' &&
  !busy &&
  attemptedGeneration !== workspaceGeneration;

export const shouldPullTerminalSnapshot = ({
  currentStatus,
  open,
  sessionChanged,
  signalStatus,
}: Readonly<{
  currentStatus: TerminalStateSnapshot['status'];
  open: boolean;
  sessionChanged: boolean;
  signalStatus: TerminalStateSnapshot['status'];
}>): boolean => open || sessionChanged || signalStatus !== currentStatus;
