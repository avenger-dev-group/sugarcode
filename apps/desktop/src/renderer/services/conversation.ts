import type {
  ConversationActionResult,
  ConversationStateListener,
  ConversationStateSnapshot,
  ConversationSendRequest,
  ConversationProjectionDiagnostic,
  ConversationThreadDeltaListener,
  ConversationThreadProjectionListener,
  ConversationThreadProjectionSnapshot,
} from '@/shared/conversation';

const desktopApi = (): Window['sugarcode'] => window.sugarcode;

export const getConversationState =
  (): Promise<ConversationStateSnapshot> =>
    desktopApi().getConversationState();

export const onConversationStateChanged = (
  listener: ConversationStateListener,
): (() => void) => desktopApi().onConversationStateChanged(listener);

export const getConversationThreadProjection = (
  threadId: string,
): Promise<ConversationThreadProjectionSnapshot> =>
  desktopApi().getConversationThreadProjection(threadId);

export const onConversationThreadProjectionChanged = (
  listener: ConversationThreadProjectionListener,
  onDiagnostic?: (diagnostic: ConversationProjectionDiagnostic) => void,
): (() => void) =>
  desktopApi().onConversationThreadProjectionChanged(listener, onDiagnostic);

export const onConversationThreadDelta = (
  listener: ConversationThreadDeltaListener,
  onDiagnostic?: (diagnostic: ConversationProjectionDiagnostic) => void,
): (() => void) =>
  desktopApi().onConversationThreadDelta(listener, onDiagnostic);

export const sendConversationMessage = (
  request: ConversationSendRequest,
): Promise<ConversationActionResult> =>
  desktopApi().sendConversationMessage(request);

export const stopConversationTurn =
  (threadId: string): Promise<ConversationActionResult> =>
    desktopApi().stopConversationTurn(threadId);

export const searchConversationThreads = (
  query: string,
): Promise<ConversationActionResult> =>
  desktopApi().searchConversationThreads(query);

export const selectConversationThread = (
  threadId: string,
): Promise<ConversationActionResult> =>
  desktopApi().selectConversationThread(threadId);

export const startNewConversationThread =
  (): Promise<ConversationActionResult> =>
    desktopApi().startNewConversationThread();

export const forkConversationThread = (
  threadId: string,
): Promise<ConversationActionResult> =>
  desktopApi().forkConversationThread(threadId);

export const archiveConversationThread = (
  threadId: string,
): Promise<ConversationActionResult> =>
  desktopApi().archiveConversationThread(threadId);

export const unarchiveConversationThread = (
  threadId: string,
): Promise<ConversationActionResult> =>
  desktopApi().unarchiveConversationThread(threadId);

export const deleteConversationThread = (
  threadId: string,
): Promise<ConversationActionResult> =>
  desktopApi().deleteConversationThread(threadId);
