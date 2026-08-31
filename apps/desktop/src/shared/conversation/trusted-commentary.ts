const TOOL_PROGRESS_SEGMENT = ':progress:';

export const toolProgressCommentaryId = (
  turnId: string,
  callId: string,
): string => `${turnId}${TOOL_PROGRESS_SEGMENT}${callId}`;

export const isTrustedCommentaryId = (
  turnId: string,
  itemId: string,
): boolean => itemId.startsWith(`${turnId}${TOOL_PROGRESS_SEGMENT}`);
