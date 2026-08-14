import type { ConversationTurnStatus } from '@/shared/conversation';

import type { ProcessLanguage } from './types';

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const processLanguageFromText = (text: string): ProcessLanguage =>
  /\p{Script=Han}/u.test(text) ? 'zh' : 'en';

export const uuidV7TimestampMs = (id: string): number | null => {
  if (!UUID_V7_PATTERN.test(id)) {
    return null;
  }
  const timestamp = Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
};

export const formatProcessDuration = (
  durationMs: number,
  language: ProcessLanguage = 'en',
): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (language === 'zh') {
    if (hours > 0) {
      return `${hours}小时${minutes}分${seconds}秒`;
    }
    if (minutes > 0) {
      return `${minutes}分${seconds}秒`;
    }
    return `${seconds}秒`;
  }
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
  language: ProcessLanguage = 'en',
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
  return formatProcessDuration(completedAtMs - startedAtMs, language);
};

export const shouldAutoExpandActivityGroup = (
  status: ConversationTurnStatus,
  requiresAttention: boolean,
): boolean => status === 'inProgress' || requiresAttention;

export const processActivityLabel = (
  status: ConversationTurnStatus,
  requiresAttention: boolean,
  language: ProcessLanguage = 'en',
): string => {
  if (requiresAttention) {
    return language === 'zh' ? '需要操作' : 'Action required';
  }
  switch (status) {
    case 'inProgress':
      return language === 'zh' ? '正在处理' : 'Working';
    case 'interrupted':
      return language === 'zh' ? '处理已停止' : 'Process stopped';
    case 'failed':
      return language === 'zh' ? '处理失败' : 'Process failed';
    case 'completed':
      return language === 'zh' ? '已处理' : 'Processed';
  }
};
