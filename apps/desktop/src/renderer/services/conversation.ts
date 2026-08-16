import type {
  ConversationActionResult,
  ConversationStateListener,
  ConversationStateSnapshot,
  ConversationSendRequest,
  ConversationReviseTurnRequest,
  ConversationQueuedMessageMutationRequest,
  ConversationQueuedMessageUpdateRequest,
  ConversationSteerQueuedMessageRequest,
  ConversationProjectionDiagnostic,
  ConversationThreadDeltaListener,
  ConversationThreadProjectionListener,
  ConversationThreadProjectionSnapshot,
  ConversationUserInputResponse,
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

export const reviseConversationTurn = (
  request: ConversationReviseTurnRequest,
): Promise<ConversationActionResult> =>
  desktopApi().reviseConversationTurn(request);

export const updateQueuedConversationMessage = (
  request: ConversationQueuedMessageUpdateRequest,
): Promise<ConversationActionResult> =>
  desktopApi().updateQueuedConversationMessage(request);

export const deleteQueuedConversationMessage = (
  request: ConversationQueuedMessageMutationRequest,
): Promise<ConversationActionResult> =>
  desktopApi().deleteQueuedConversationMessage(request);

export const steerQueuedConversationMessage = (
  request: ConversationSteerQueuedMessageRequest,
): Promise<ConversationActionResult> =>
  desktopApi().steerQueuedConversationMessage(request);

export const resumeConversationQueue = (
  threadId: string,
): Promise<ConversationActionResult> =>
  desktopApi().resumeConversationQueue(threadId);

export const stopConversationTurn =
  (threadId: string): Promise<ConversationActionResult> =>
    desktopApi().stopConversationTurn(threadId);

export const respondToConversationUserInput = (
  response: ConversationUserInputResponse,
): Promise<ConversationActionResult> =>
  desktopApi().respondToConversationUserInput(response);

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

export const deleteConversationThread = (
  threadId: string,
): Promise<ConversationActionResult> =>
  desktopApi().deleteConversationThread(threadId);
