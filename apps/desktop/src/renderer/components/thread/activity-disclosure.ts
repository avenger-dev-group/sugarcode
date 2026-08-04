import type { ConversationTurnStatus } from '@/shared/conversation';

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const uuidV7TimestampMs = (id: string): number | null => {
  if (!UUID_V7_PATTERN.test(id)) {
    return null;
  }
  const timestamp = Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
};

export const formatProcessDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
};

export const completedProcessDurationLabel = (
  turnId: string,
  completedAgentMessageId: string | undefined,
): string | undefined => {
  if (!completedAgentMessageId) {
    return undefined;
  }
  const startedAtMs = uuidV7TimestampMs(turnId);
  const completedAtMs = uuidV7TimestampMs(completedAgentMessageId);
  if (
    startedAtMs === null ||
    completedAtMs === null ||
    completedAtMs < startedAtMs
  ) {
    return undefined;
  }
  return formatProcessDuration(completedAtMs - startedAtMs);
};

export const shouldAutoExpandActivityGroup = (
  status: ConversationTurnStatus,
  requiresAttention: boolean,
): boolean => status === 'inProgress' || requiresAttention;

export const processActivityLabel = (
  status: ConversationTurnStatus,
  requiresAttention: boolean,
): string => {
  if (requiresAttention) {
    return 'Action required';
  }
  switch (status) {
    case 'inProgress':
      return 'Working';
    case 'interrupted':
      return 'Process stopped';
    case 'failed':
      return 'Process failed';
    case 'completed':
      return 'Processed';
  }
};
