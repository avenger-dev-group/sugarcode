import type {
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  RefObject,
  UIEvent,
  WheelEvent,
} from 'react';

import type {
  ConversationAttachment,
  ConversationPhase,
  ConversationTerminalTurnStatus,
  ConversationTurnError,
  ConversationTurnStatus,
  ConversationThreadQueue,
  ConversationQueuedMessage,
} from '@/shared/conversation';
import type { ComposerReference } from '@/shared/composer';

import type { EditableMessageTarget } from './message-edit';

import type {
  AgentMessageViewModel,
  AgentCommentaryViewModel,
  CommandApprovalActivityViewModel,
  WorkspaceListActivityViewModel,
  WorkspaceReadActivityViewModel,
  WorkspaceSearchActivityViewModel,
} from '../agent/types';
import type { FileChangeReviewViewModel } from '../workspace/types';
import type { McpActivityViewModel } from '../mcp/types';
import type { OrchestrationActivityViewModel } from '../orchestration/types';
import type { PanelResizeHandle } from '../foundation/types';
import type {
  UserInputActivityViewModel,
  UserInputRequestViewModel,
  UserInputSubmission,
} from '../user-input/types';

export type UserMessageViewModel = Readonly<{
  id: string;
  text: string;
  references: readonly ComposerReference[];
  attachments: readonly ConversationAttachment[];
}>;

export type DraftAttachmentViewModel = Readonly<{
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  data: string;
  previewUrl?: string;
}>;

export type TranscriptMessageViewModel =
  | Readonly<{
      role: 'user';
      message: UserMessageViewModel;
    }>
  | Readonly<{
      role: 'agent';
      message: AgentMessageViewModel;
    }>;

export type TurnFailureViewModel = Readonly<{
  kind: ConversationTurnError['kind'];
  summary: string;
  guidance: string;
  retryable: boolean;
  protocol?: Readonly<{
    stage: string;
    code: string;
    eventType?: string;
    fingerprint: string;
  }>;
}>;

export type TurnModelViewModel = Readonly<{
  displayName: string;
  wireApi:
    | 'openaiResponses'
    | 'openaiChatCompletions'
    | 'anthropicMessages';
}>;

export type ActiveTurnProgressViewModel = Readonly<{
  turnId: string;
  state:
    | 'thinking'
    | 'waitingForApproval'
    | 'waitingForInput'
    | 'runningTool'
    | 'stopping'
    | 'uncertain';
  label: string;
  detail?: string;
}>;

export type ActiveTurnOperationProgress = Readonly<{
  state: 'waitingForApproval' | 'waitingForInput' | 'runningTool';
  label: string;
  detail?: string;
}>;

export type SkillActivityPresentationState =
  | 'running'
  | 'stopping'
  | 'uncertain'
  | 'succeeded'
  | 'failed'
  | 'interrupted';

export type SkillActivityViewModel = Readonly<{
  id: string;
  name: string;
  state: SkillActivityPresentationState;
  purpose?: string;
  description?: string;
  content?: string;
  errorKind?: string;
}>;

export type SkillActivityProps = Readonly<{
  activity: SkillActivityViewModel;
  language: ProcessLanguage;
}>;

export type ContextCompactionActivityViewModel = Readonly<{
  id: string;
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  trigger: 'auto' | 'manual' | 'recovery';
  strategy: 'applicationSummary' | 'openaiNative' | 'anthropicNative';
  beforeContextTokens?: number;
  afterContextTokens?: number;
  durationMs?: number;
  readableSummary?: string;
  opaqueCheckpoint?: boolean;
  message?: string;
}>;

export type TurnActivityViewModel =
  | Readonly<{
      type: 'commentary';
      activity: AgentCommentaryViewModel;
    }>
  | Readonly<{
      type: 'workspaceRead';
      activity: WorkspaceReadActivityViewModel;
    }>
  | Readonly<{
      type: 'workspaceList';
      activity: WorkspaceListActivityViewModel;
    }>
  | Readonly<{
      type: 'workspaceSearch';
      activity: WorkspaceSearchActivityViewModel;
    }>
  | Readonly<{ type: 'skill'; activity: SkillActivityViewModel }>
  | Readonly<{ type: 'fileChange'; activity: FileChangeReviewViewModel }>
  | Readonly<{
      type: 'commandApproval';
      activity: CommandApprovalActivityViewModel;
    }>
  | Readonly<{ type: 'mcp'; activity: McpActivityViewModel }>
  | Readonly<{
      type: 'orchestration';
      activity: OrchestrationActivityViewModel;
    }>
  | Readonly<{
      type: 'contextCompaction';
      activity: ContextCompactionActivityViewModel;
    }>
  | Readonly<{
      type: 'userInput';
      activity: UserInputActivityViewModel;
    }>;

export type CompactToolActivity = Extract<
  TurnActivityViewModel,
  {
    type:
      | 'workspaceRead'
      | 'workspaceList'
      | 'workspaceSearch'
      | 'fileChange'
      | 'commandApproval'
      | 'mcp';
  }
>;

export type ProcessLanguage = 'en' | 'zh';

export type TurnViewModel = Readonly<{
  id: string;
  status: ConversationTurnStatus;
  verifiedFilePaths: readonly string[];
  processLanguage: ProcessLanguage;
  durationLabel?: string;
  model?: TurnModelViewModel;
  messages: readonly TranscriptMessageViewModel[];
  planProposal?: Readonly<{ id: string; content: string }>;
  pendingAgentOutputs?: readonly AgentMessageViewModel[];
  activities?: readonly TurnActivityViewModel[];
  workspaceRead?: WorkspaceReadActivityViewModel;
  workspaceList?: WorkspaceListActivityViewModel;
  workspaceSearch?: WorkspaceSearchActivityViewModel;
  fileChange?: FileChangeReviewViewModel;
  commandApproval?: CommandApprovalActivityViewModel;
  mcpActivities?: readonly McpActivityViewModel[];
  userInputRequest?: UserInputRequestViewModel;
  terminalLabel?: string;
  failure?: TurnFailureViewModel;
  isError: boolean;
}>;

export type ThreadViewModel = Readonly<{
  phase: ConversationPhase;
  workspaceIdentity: string | null;
  threadIdentity: string | null;
  turns: readonly TurnViewModel[];
  queue: ConversationThreadQueue;
  isEmpty: boolean;
  notice?: string;
}>;

export type ThreadNavigatorViewModel = Readonly<{
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  threadIds: readonly string[];
  threadTitles: Readonly<Record<string, string>>;
  runningThreadIds: readonly string[];
  inputRequiredThreadIds: readonly string[];
  unreadThreadStatuses: Readonly<
    Record<string, ConversationTerminalTurnStatus>
  >;
  selectedThreadId: string | null;
  pendingThreadId: string | null;
  pendingMutation: Readonly<{
    kind: 'rename' | 'delete';
    threadId: string;
  }> | null;
  truncated: boolean;
  statusLabel: string;
  selectionNotice?: string;
  mutationNotice?: string;
}>;

export type ThreadNavigationStatus =
  | 'idle'
  | 'opening'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'inputRequired'
  | 'approvalRequired';

export type ThreadStore = Readonly<{
  thread: ThreadViewModel;
  navigator: ThreadNavigatorViewModel;
  expandedProjectIds: readonly string[];
  workspaceGeneration: number;
  workspaceReady: boolean;
  draft: string;
  attachments: readonly DraftAttachmentViewModel[];
  canSend: boolean;
  canStop: boolean;
  showStopControl: boolean;
  startsChatOnSend: boolean;
  activeTurnProgress: ActiveTurnProgressViewModel | null;
  isSending: boolean;
  actionError: string | null;
  queueEditor: Readonly<{
    itemId: string | null;
    draft: string;
    modelProfileId: string;
    pendingIds: readonly string[];
  }>;
  editableMessageTarget: EditableMessageTarget | null;
  messageEditor: Readonly<{
    turnId: string | null;
    messageId: string | null;
    draft: string;
    pending: boolean;
    error: string | null;
  }>;
  rename: Readonly<{
    request: Readonly<{ threadId: string; title: string }> | null;
    draft: string;
    pending: boolean;
    error: string | null;
    canSave: boolean;
  }>;
  modelOptions: readonly Readonly<{
    profileId: string;
    label: string;
    available: boolean;
  }>[];
  selectedModelProfileId: string;
  modelSelectionDisabled: boolean;
  modelSwitchConfirmation: Readonly<{
    sourceName: string;
    targetName: string;
  }> | null;
  setDraft: (value: string) => void;
  beginMessageEdit: (turnId: string, messageId: string, text: string) => void;
  setMessageEditDraft: (value: string) => void;
  cancelMessageEdit: () => void;
  submitMessageEdit: () => Promise<void>;
  addAttachments: (files: readonly File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  toggleProjectExpanded: (projectId: string) => void;
  setSelectedModelProfileId: (profileId: string) => void;
  confirmModelSwitch: () => void;
  cancelModelSwitch: () => void;
  startNewThread: () => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  requestThreadRename: (threadId: string, title: string) => void;
  setRenameDraft: (title: string) => void;
  cancelThreadRename: () => void;
  confirmThreadRename: () => Promise<void>;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  beginQueueEdit: (message: ConversationQueuedMessage) => void;
  setQueueEditDraft: (value: string) => void;
  setQueueEditModel: (profileId: string) => void;
  cancelQueueEdit: () => void;
  saveQueueEdit: () => Promise<void>;
  deleteQueueMessage: (message: ConversationQueuedMessage) => Promise<void>;
  steerQueueMessage: (message: ConversationQueuedMessage) => Promise<void>;
  resumeQueue: () => Promise<void>;
  respondToUserInput: (
    turnId: string,
    inputRequestId: string,
    submission: UserInputSubmission,
  ) => Promise<boolean>;
  implementPlan: (turnId: string) => Promise<void>;
  refinePlan: (turnId: string) => void;
}>;

export type ThreadWorkbenchViewProps = Readonly<{
  store: ThreadStore;
  navigatorOpen?: boolean;
  navigatorResize?: PanelResizeHandle;
  contextRailOpen?: boolean;
  contextRailResize?: PanelResizeHandle;
  onToggleNavigator?: () => void;
  onToggleContextRail?: () => void;
  navigationFooter?: ReactNode;
  contextRail?: ReactNode;
  permissionControl?: ReactNode;
  approvalSurface?: ReactNode;
  approvalThreadIds?: readonly string[];
}>;

export type TranscriptTurnProps = Readonly<{
  turn: TurnViewModel;
  turnNumber: number;
  boundary: 'none' | 'divider' | 'precedingTerminal';
  progress?: ActiveTurnProgressViewModel;
  editableMessageId: string | null;
  messageEditor: ThreadStore['messageEditor'];
  onBeginMessageEdit: ThreadStore['beginMessageEdit'];
  onSetMessageEditDraft: ThreadStore['setMessageEditDraft'];
  onCancelMessageEdit: ThreadStore['cancelMessageEdit'];
  onSubmitMessageEdit: ThreadStore['submitMessageEdit'];
  planActionable: boolean;
  onImplementPlan: ThreadStore['implementPlan'];
  onRefinePlan: ThreadStore['refinePlan'];
}>;

export type ActivityDisclosureStore = Readonly<{
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}>;

export type ProcessActivityGroupProps = Readonly<{
  groupId: string;
  status: ConversationTurnStatus;
  requiresAttention: boolean;
  language: ProcessLanguage;
  activeLabel?: string;
  animateActive?: boolean;
  durationLabel?: string;
  children: ReactNode;
}>;

export type TurnChangeSummaryProps = Readonly<{
  turnId: string;
  activities: readonly TurnActivityViewModel[];
  language: ProcessLanguage;
}>;

export type TranscriptFollow = Readonly<{
  settlingThreadSelection: boolean;
  transcriptContent: RefObject<HTMLDivElement | null>;
  transcriptEnd: RefObject<HTMLDivElement | null>;
  transcriptViewport: RefObject<HTMLDivElement | null>;
  recordScrollPosition: (event: UIEvent<HTMLDivElement>) => void;
  recordWheelScrollIntent: (event: WheelEvent<HTMLDivElement>) => void;
  recordKeyScrollIntent: (event: KeyboardEvent<HTMLDivElement>) => void;
  beginPointerScroll: (event: PointerEvent<HTMLDivElement>) => void;
  endPointerScroll: (event: PointerEvent<HTMLDivElement>) => void;
}>;
