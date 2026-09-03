const TOOL_PROGRESS_SEGMENT = ':progress:';
const MODEL_PROGRESS_SEGMENT = ':model-progress:';
const REASONING_SUMMARY_SEGMENT = ':reasoning-summary:';

export const toolProgressCommentaryId = (
  turnId: string,
  callId: string,
): string => `${turnId}${TOOL_PROGRESS_SEGMENT}${callId}`;

export const modelProgressCommentaryId = (
  turnId: string,
  itemId: string,
): string => `${turnId}${MODEL_PROGRESS_SEGMENT}${itemId}`;

export const reasoningSummaryCommentaryId = (
  turnId: string,
  itemId: string,
): string => `${turnId}${REASONING_SUMMARY_SEGMENT}${itemId}`;

export const isReasoningSummaryCommentaryId = (
  turnId: string,
  itemId: string,
): boolean => itemId.startsWith(`${turnId}${REASONING_SUMMARY_SEGMENT}`);

export const isTrustedCommentaryId = (
  turnId: string,
  itemId: string,
): boolean =>
  itemId.startsWith(`${turnId}${TOOL_PROGRESS_SEGMENT}`) ||
  itemId.startsWith(`${turnId}${MODEL_PROGRESS_SEGMENT}`) ||
  isReasoningSummaryCommentaryId(turnId, itemId);
