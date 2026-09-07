export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 48;
export const PROCESS_BOTTOM_THRESHOLD_PX = 24;
const SCROLL_EDGE_EPSILON_PX = 1;

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

export const shouldHandoffWheelScroll = ({
  deltaY,
  scrollTop,
  scrollHeight,
  clientHeight,
}: Readonly<{
  deltaY: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}>): boolean => {
  if (deltaY < 0) {
    return scrollTop <= SCROLL_EDGE_EPSILON_PX;
  }
  if (deltaY > 0) {
    return (
      scrollHeight - scrollTop - clientHeight <= SCROLL_EDGE_EPSILON_PX
    );
  }
  return false;
};

export const shouldFollowProcessAfterScroll = ({
  scrollTop,
  scrollHeight,
  clientHeight,
}: Readonly<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}>): boolean =>
  scrollHeight - scrollTop - clientHeight <= PROCESS_BOTTOM_THRESHOLD_PX;

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
