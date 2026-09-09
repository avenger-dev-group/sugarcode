export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 48;

export const isTranscriptScrollUpKey = (
  key: string,
  shiftKey: boolean,
): boolean =>
  key === 'ArrowUp' ||
  key === 'PageUp' ||
  key === 'Home' ||
  (key === ' ' && shiftKey);

export const shouldTrackTranscriptPointerScroll = ({
  pointerType,
  targetIsScrollbar,
}: Readonly<{
  pointerType: string;
  targetIsScrollbar: boolean;
}>): boolean => pointerType !== 'mouse' || targetIsScrollbar;

export const shouldFollowTranscriptAfterScroll = ({
  wasFollowing,
  previousScrollTop,
  previousScrollHeight,
  scrollTop,
  scrollHeight,
  clientHeight,
  pointerScrollActive,
}: Readonly<{
  wasFollowing: boolean;
  previousScrollTop: number;
  previousScrollHeight: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  pointerScrollActive: boolean;
}>): boolean => {
  if (
    scrollTop < previousScrollTop &&
    (pointerScrollActive || scrollHeight >= previousScrollHeight)
  ) {
    return false;
  }
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  if (distanceFromBottom <= TRANSCRIPT_BOTTOM_THRESHOLD_PX) {
    return true;
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

export const shouldHoldTranscriptPlaceholder = ({
  deferredThreadId,
  pendingThreadId,
  previousPendingThreadId,
  threadId,
}: Readonly<{
  deferredThreadId: string | null;
  pendingThreadId: string | null;
  previousPendingThreadId: string | null;
  threadId: string | null;
}>): boolean =>
  pendingThreadId === null &&
  previousPendingThreadId !== null &&
  threadId === previousPendingThreadId &&
  deferredThreadId !== threadId;
