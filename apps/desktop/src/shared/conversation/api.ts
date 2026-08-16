import type {
  ConversationAttachmentUpload,
  ConversationUserInputResponse,
} from './activities.ts';
import type {
  ConversationProjectionDiagnostic,
  ConversationStateListener,
  ConversationStateSnapshot,
  ConversationThreadDeltaListener,
  ConversationThreadProjectionListener,
  ConversationThreadProjectionSnapshot,
} from './projection.ts';

export type ConversationActionResult = Readonly<{
  accepted: boolean;
  reason:
    | 'accepted'
    | 'invalidInput'
    | 'invalidSearch'
    | 'notLatestTurn'
    | 'unknownThread'
    | 'turnActive'
    | 'queueFull'
    | 'queueItemNotFound'
    | 'queueRevisionMismatch'
    | 'turnMismatch'
    | 'notSteerable'
    | 'modelUnavailable'
    | 'unavailable'
    | 'noActiveTurn';
  disposition?: 'started' | 'queued';
  queueItemId?: string;
}>;
export type ConversationApi = Readonly<{
  getConversationState: () => Promise<ConversationStateSnapshot>;
  onConversationStateChanged: (
    listener: ConversationStateListener,
  ) => () => void;
  getConversationThreadProjection: (
    threadId: string,
  ) => Promise<ConversationThreadProjectionSnapshot>;
  onConversationThreadProjectionChanged: (
    listener: ConversationThreadProjectionListener,
    onDiagnostic?: (diagnostic: ConversationProjectionDiagnostic) => void,
  ) => () => void;
  onConversationThreadDelta: (
    listener: ConversationThreadDeltaListener,
    onDiagnostic?: (diagnostic: ConversationProjectionDiagnostic) => void,
  ) => () => void;
  sendConversationMessage: (
    request: ConversationSendRequest,
  ) => Promise<ConversationActionResult>;
  reviseConversationTurn: (
    request: ConversationReviseTurnRequest,
  ) => Promise<ConversationActionResult>;
  updateQueuedConversationMessage: (
    request: ConversationQueuedMessageUpdateRequest,
  ) => Promise<ConversationActionResult>;
  deleteQueuedConversationMessage: (
    request: ConversationQueuedMessageMutationRequest,
  ) => Promise<ConversationActionResult>;
  steerQueuedConversationMessage: (
    request: ConversationSteerQueuedMessageRequest,
  ) => Promise<ConversationActionResult>;
  resumeConversationQueue: (threadId: string) => Promise<ConversationActionResult>;
  stopConversationTurn: (threadId: string) => Promise<ConversationActionResult>;
  respondToConversationUserInput: (
    response: ConversationUserInputResponse,
  ) => Promise<ConversationActionResult>;
  searchConversationThreads: (
    query: string,
  ) => Promise<ConversationActionResult>;
  selectConversationThread: (
    threadId: string,
  ) => Promise<ConversationActionResult>;
  startNewConversationThread: () => Promise<ConversationActionResult>;
  deleteConversationThread: (
    threadId: string,
  ) => Promise<ConversationActionResult>;
}>;

export type ConversationSendRequest = Readonly<{
  input: string;
  attachments?: readonly ConversationAttachmentUpload[];
  modelProfileId?: string;
}>;

export type ConversationReviseTurnRequest = Readonly<{
  threadId: string;
  turnId: string;
  text: string;
  modelProfileId?: string;
}>;

export type ConversationQueuedMessageUpdateRequest = Readonly<{
  threadId: string;
  queueItemId: string;
  expectedRevision: number;
  input: string;
  modelProfileId?: string;
}>;

export type ConversationQueuedMessageMutationRequest = Readonly<{
  threadId: string;
  queueItemId: string;
  expectedRevision: number;
}>;

export type ConversationSteerQueuedMessageRequest =
  ConversationQueuedMessageMutationRequest & Readonly<{
    expectedTurnId: string;
  }>;
