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
  ConversationTurnError,
  ConversationTurnStatus,
} from '@/shared/conversation';

import type {
  AgentMessageViewModel,
  AgentCommentaryViewModel,
  CommandApprovalActivityViewModel,
  WorkspaceListActivityViewModel,
  WorkspaceReadActivityViewModel,
  WorkspaceSearchActivityViewModel,
} from '../agent/types';
import type { ContextCompactionActivityViewModel } from '../agent/context-compaction-activity';
import type { FileChangeReviewViewModel } from '../workspace/types';
import type { McpActivityViewModel } from '../mcp/types';
import type { OrchestrationActivityViewModel } from '../orchestration/types';
import type { PanelResizeHandle } from '../foundation/types';

export type UserMessageViewModel = Readonly<{
  id: string;
  text: string;
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
  state: 'working' | 'waitingForModel' | 'stopping' | 'uncertain';
  label: string;
  elapsedLabel?: string;
  detail?: string;
}>;

export type TurnActivityViewModel =
  | Readonly<{
      type: 'commentary';
      activity: AgentCommentaryViewModel;
    }>
  | Readonly<{
      type: 'contextCompaction';
      activity: ContextCompactionActivityViewModel;
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
  | Readonly<{ type: 'fileChange'; activity: FileChangeReviewViewModel }>
  | Readonly<{
      type: 'commandApproval';
      activity: CommandApprovalActivityViewModel;
    }>
  | Readonly<{ type: 'mcp'; activity: McpActivityViewModel }>
  | Readonly<{
      type: 'orchestration';
      activity: OrchestrationActivityViewModel;
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

export type TurnViewModel = Readonly<{
  id: string;
  status: ConversationTurnStatus;
  model?: TurnModelViewModel;
  messages: readonly TranscriptMessageViewModel[];
  pendingAgentOutputs?: readonly AgentMessageViewModel[];
  activities?: readonly TurnActivityViewModel[];
  contextCompactions?: readonly ContextCompactionActivityViewModel[];
  workspaceRead?: WorkspaceReadActivityViewModel;
  workspaceList?: WorkspaceListActivityViewModel;
  workspaceSearch?: WorkspaceSearchActivityViewModel;
  fileChange?: FileChangeReviewViewModel;
  commandApproval?: CommandApprovalActivityViewModel;
  mcpActivities?: readonly McpActivityViewModel[];
  terminalLabel?: string;
  failure?: TurnFailureViewModel;
  isError: boolean;
}>;

export type ThreadViewModel = Readonly<{
  phase: ConversationPhase;
  threadIdentity: string | null;
  turns: readonly TurnViewModel[];
  isEmpty: boolean;
  statusLabel: string;
  notice?: string;
}>;

export type ThreadNavigatorViewModel = Readonly<{
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  threadIds: readonly string[];
  threadTitles: Readonly<Record<string, string>>;
  runningThreadIds: readonly string[];
  unreadThreadIds: readonly string[];
  selectedThreadId: string | null;
  pendingThreadId: string | null;
  pendingMutation: Readonly<{
    kind: 'fork' | 'archive' | 'unarchive' | 'delete';
    threadId: string;
  }> | null;
  archivedUndoThreadId: string | null;
  truncated: boolean;
  statusLabel: string;
  selectionNotice?: string;
  mutationNotice?: string;
}>;

export type ThreadStore = Readonly<{
  thread: ThreadViewModel;
  navigator: ThreadNavigatorViewModel;
  draft: string;
  attachments: readonly DraftAttachmentViewModel[];
  inputBytes: number;
  inputLimitBytes: number;
  inputHint: string;
  contextBudgetHint: string | null;
  canSend: boolean;
  canStop: boolean;
  activeTurnProgress: ActiveTurnProgressViewModel | null;
  isSending: boolean;
  actionError: string | null;
  modelOptions: readonly Readonly<{
    profileId: string;
    label: string;
    available: boolean;
  }>[];
  selectedModelProfileId: string;
  modelSelectionDisabled: boolean;
  modelSwitchConfirmation: Readonly<{
    sourceName: string;
    sourceWireApi: string;
    targetName: string;
    targetWireApi: string;
    protocolChanges: boolean;
  }> | null;
  setDraft: (value: string) => void;
  addAttachments: (files: readonly File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  setSelectedModelProfileId: (profileId: string) => void;
  confirmModelSwitch: () => void;
  cancelModelSwitch: () => void;
  startNewThread: () => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  forkThread: (threadId: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  unarchiveThread: (threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  send: () => Promise<void>;
  stop: () => Promise<void>;
}>;

export type ThreadWorkbenchViewProps = Readonly<{
  store: ThreadStore;
  navigatorResize?: PanelResizeHandle;
  contextRailResize?: PanelResizeHandle;
  navigationFooter?: ReactNode;
  contextRail?: ReactNode;
  permissionControl?: ReactNode;
}>;

export type TranscriptTurnProps = Readonly<{
  turn: TurnViewModel;
  progress?: ActiveTurnProgressViewModel;
  onStop: () => void;
}>;

export type ActivityDisclosureStore = Readonly<{
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}>;

export type ProcessActivityGroupProps = Readonly<{
  groupId: string;
  status: ConversationTurnStatus;
  requiresAttention: boolean;
  children: ReactNode;
}>;

export type TranscriptFollow = Readonly<{
  transcriptContent: RefObject<HTMLDivElement | null>;
  transcriptEnd: RefObject<HTMLDivElement | null>;
  transcriptViewport: RefObject<HTMLDivElement | null>;
  recordScrollPosition: (event: UIEvent<HTMLDivElement>) => void;
  recordWheelScrollIntent: (event: WheelEvent<HTMLDivElement>) => void;
  recordKeyScrollIntent: (event: KeyboardEvent<HTMLDivElement>) => void;
  beginPointerScroll: (event: PointerEvent<HTMLDivElement>) => void;
  endPointerScroll: (event: PointerEvent<HTMLDivElement>) => void;
}>;
