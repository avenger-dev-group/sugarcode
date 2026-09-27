import type { TurnViewModel } from './types';

export const TURN_NAVIGATOR_MINIMUM_COUNT = 4;

const PREVIEW_MAX_LENGTH = 240;

const toPlainTextPreview = (source: string): string => {
  const normalized = source
    .replace(/```[\s\S]*?```/gu, '代码片段')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_~>#-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  return normalized.length > PREVIEW_MAX_LENGTH
    ? `${normalized.slice(0, PREVIEW_MAX_LENGTH).trimEnd()}…`
    : normalized;
};

export const shouldShowTurnNavigator = (turnCount: number): boolean =>
  turnCount >= TURN_NAVIGATOR_MINIMUM_COUNT;

export type TurnNavigationPreview = Readonly<{
  question: string;
  answer?: string;
}>;

export const toTurnNavigationPreview = (
  turn: TurnViewModel,
  turnNumber: number,
): TurnNavigationPreview => {
  const userMessage = turn.messages.find((entry) => entry.role === 'user');
  const attachmentNames =
    userMessage?.role === 'user'
      ? userMessage.message.attachments.map(
          (attachment) => attachment.originalName,
        )
      : [];
  const questionText = toPlainTextPreview(userMessage?.message.text ?? '');
  const question =
    questionText ||
    (attachmentNames.length > 0
      ? `附件：${attachmentNames.join('、')}`
      : `第 ${turnNumber} 轮对话`);
  const agentMessage = turn.messages.findLast(
    (entry) => entry.role === 'agent' && entry.message.text.trim().length > 0,
  );
  const pendingAgentMessage = turn.pendingAgentOutputs?.findLast(
    (message) => message.text.trim().length > 0,
  );
  const answer = toPlainTextPreview(
    agentMessage?.role === 'agent'
      ? agentMessage.message.text
      : pendingAgentMessage?.text ?? turn.planProposal?.content ?? '',
  );

  return answer ? { question, answer } : { question };
};
