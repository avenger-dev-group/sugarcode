import type { ConversationActionResult } from '../../../shared/conversation.ts';

export const accepted = (
  result: Pick<ConversationActionResult, 'disposition' | 'queueItemId'> = {},
): ConversationActionResult => ({
  accepted: true,
  reason: 'accepted',
  ...result,
});
export const rejected = (
  reason: Exclude<ConversationActionResult['reason'], 'accepted'>,
  attachmentFailure?: ConversationActionResult['attachmentFailure'],
): ConversationActionResult => ({
  accepted: false,
  reason,
  ...(attachmentFailure ? { attachmentFailure } : {}),
});

export const attachmentImportFailure = (
  error: unknown,
): NonNullable<ConversationActionResult['attachmentFailure']> => {
  const message = error instanceof Error ? error.message : String(error);
  const tagged = /assetImport:(sourceUnavailable|unsupportedFormat|mediaTypeMismatch|tooLarge|storageUnavailable|unknown):/u.exec(
    message,
  )?.[1] as ConversationActionResult['attachmentFailure'] | undefined;
  if (tagged) {
    return tagged;
  }
  if (message.includes('does not support path-based video imports')) {
    return 'runtimeOutdated';
  }
  if (message.includes('unsupported content media type')) {
    return 'unsupportedFormat';
  }
  if (message.includes('declared media type does not match')) {
    return 'mediaTypeMismatch';
  }
  if (message.includes('exceeds the size limit')) {
    return 'tooLarge';
  }
  return 'unknown';
};
