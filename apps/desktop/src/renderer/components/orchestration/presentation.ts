import type { ConversationAgentTaskStatus } from '@/shared/conversation';

export type AgentTaskGroupId = 'attention' | 'active' | 'queued' | 'finished';

export const agentTaskGroupForStatus = (
  status: ConversationAgentTaskStatus,
): AgentTaskGroupId => {
  switch (status) {
    case 'waitingApproval':
    case 'failed':
    case 'interrupted':
      return 'attention';
    case 'running':
      return 'active';
    case 'queued':
      return 'queued';
    case 'completed':
    case 'cancelled':
      return 'finished';
  }
};

export const formatAgentTaskDuration = (durationMs: number): string => {
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};
