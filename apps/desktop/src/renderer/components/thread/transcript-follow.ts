export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 48;

export const isTranscriptScrollUpKey = (
  key: string,
  shiftKey: boolean,
): boolean =>
  key === 'ArrowUp' ||
  key === 'PageUp' ||
  key === 'Home' ||
  (key === ' ' && shiftKey);

export const shouldFollowTranscriptAfterScroll = ({
  wasFollowing,
  previousScrollTop,
  scrollTop,
  scrollHeight,
  clientHeight,
  pointerScrollActive,
}: Readonly<{
  wasFollowing: boolean;
  previousScrollTop: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  pointerScrollActive: boolean;
}>): boolean => {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  if (distanceFromBottom <= TRANSCRIPT_BOTTOM_THRESHOLD_PX) {
    return true;
  }
  if (pointerScrollActive && scrollTop < previousScrollTop) {
    return false;
  }
  return wasFollowing;
};

export const shouldResetTranscriptFollow = ({
  previousThreadId,
  threadId,
  previousPendingThreadId,
  pendingThreadId,
  userMessageAdded,
}: Readonly<{
  previousThreadId: string | null;
  threadId: string | null;
  previousPendingThreadId: string | null;
  pendingThreadId: string | null;
  userMessageAdded: boolean;
}>): boolean =>
  previousThreadId !== threadId ||
  userMessageAdded ||
  (previousPendingThreadId !== null &&
    pendingThreadId === null &&
    threadId === previousPendingThreadId);
