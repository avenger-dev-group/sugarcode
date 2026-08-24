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
import type { ModelRequestOptions } from '../model-config.ts';

export type ConversationAttachmentFailure =
  | 'sourceUnavailable'
  | 'unsupportedFormat'
  | 'mediaTypeMismatch'
  | 'tooLarge'
  | 'runtimeOutdated'
  | 'storageUnavailable'
  | 'unknown';

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
    | 'attachmentUnavailable'
    | 'unavailable'
    | 'noActiveTurn';
  disposition?: 'started' | 'queued';
  queueItemId?: string;
  attachmentFailure?: ConversationAttachmentFailure;
}>;
export type ConversationApi = Readonly<{
  getLocalFilePath: (file: File) => string;
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
  getConversationAttachmentPreview: (
    request: ConversationAttachmentPreviewRequest,
  ) => Promise<ConversationAttachmentPreviewResult>;
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
  resumeConversationQueue: (
    threadId: string,
  ) => Promise<ConversationActionResult>;
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

export type ConversationAttachmentPreviewRequest = Readonly<{
  threadId: string;
  assetId: string;
}>;

export type ConversationAttachmentPreviewResult =
  | Readonly<{
      available: true;
      assetId: string;
      previewUrl: string;
    }>
  | Readonly<{
      available: false;
      reason:
        'invalid' | 'notFound' | 'unsupported' | 'tooLarge' | 'unavailable';
    }>;

export type ConversationSendRequest = Readonly<{
  input: string;
  attachments?: readonly ConversationAttachmentUpload[];
  modelProfileId?: string;
  modelRequest?: ModelRequestOptions;
}>;

export type ConversationReviseTurnRequest = Readonly<{
  threadId: string;
  turnId: string;
  text: string;
  modelProfileId?: string;
  modelRequest?: ModelRequestOptions;
}>;

export type ConversationQueuedMessageUpdateRequest = Readonly<{
  threadId: string;
  queueItemId: string;
  expectedRevision: number;
  input: string;
  modelProfileId?: string;
  modelRequest?: ModelRequestOptions;
}>;

export type ConversationQueuedMessageMutationRequest = Readonly<{
  threadId: string;
  queueItemId: string;
  expectedRevision: number;
}>;

export type ConversationSteerQueuedMessageRequest =
  ConversationQueuedMessageMutationRequest &
    Readonly<{
      expectedTurnId: string;
    }>;
