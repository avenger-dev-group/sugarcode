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
} from '@/shared/conversation';

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
  state:
    | 'thinking'
    | 'waitingForApproval'
    | 'runningTool'
    | 'stopping'
    | 'uncertain';
  label: string;
  detail?: string;
}>;

export type ActiveTurnOperationProgress = Readonly<{
  state: 'waitingForApproval' | 'runningTool';
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
  pendingAgentOutputs?: readonly AgentMessageViewModel[];
  activities?: readonly TurnActivityViewModel[];
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
  workspaceIdentity: string | null;
  threadIdentity: string | null;
  turns: readonly TurnViewModel[];
  isEmpty: boolean;
  notice?: string;
}>;

export type ThreadNavigatorViewModel = Readonly<{
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  threadIds: readonly string[];
  threadTitles: Readonly<Record<string, string>>;
  runningThreadIds: readonly string[];
  unreadThreadStatuses: Readonly<
    Record<string, ConversationTerminalTurnStatus>
  >;
  selectedThreadId: string | null;
  pendingThreadId: string | null;
  pendingMutation: Readonly<{
    kind: 'rename' | 'fork' | 'archive' | 'unarchive' | 'delete';
    threadId: string;
  }> | null;
  archivedUndoThreadId: string | null;
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
  | 'approvalRequired';

export type ThreadStore = Readonly<{
  thread: ThreadViewModel;
  navigator: ThreadNavigatorViewModel;
  expandedProjectIds: readonly string[];
  draft: string;
  attachments: readonly DraftAttachmentViewModel[];
  canSend: boolean;
  canStop: boolean;
  startsChatOnSend: boolean;
  activeTurnProgress: ActiveTurnProgressViewModel | null;
  isSending: boolean;
  actionError: string | null;
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
  addAttachments: (files: readonly File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  toggleProjectExpanded: (projectId: string) => void;
  setSelectedModelProfileId: (profileId: string) => void;
  confirmModelSwitch: () => void;
  cancelModelSwitch: () => void;
  startNewThread: () => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  forkThread: (threadId: string) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  unarchiveThread: (threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  requestThreadRename: (threadId: string, title: string) => void;
  setRenameDraft: (title: string) => void;
  cancelThreadRename: () => void;
  confirmThreadRename: () => Promise<void>;
  send: () => Promise<void>;
  stop: () => Promise<void>;
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
  approvalThreadIds?: readonly string[];
}>;

export type TranscriptTurnProps = Readonly<{
  turn: TurnViewModel;
  turnNumber: number;
  boundary: 'none' | 'divider' | 'precedingTerminal';
  progress?: ActiveTurnProgressViewModel;
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
  transcriptContent: RefObject<HTMLDivElement | null>;
  transcriptEnd: RefObject<HTMLDivElement | null>;
  transcriptViewport: RefObject<HTMLDivElement | null>;
  recordScrollPosition: (event: UIEvent<HTMLDivElement>) => void;
  recordWheelScrollIntent: (event: WheelEvent<HTMLDivElement>) => void;
  recordKeyScrollIntent: (event: KeyboardEvent<HTMLDivElement>) => void;
  beginPointerScroll: (event: PointerEvent<HTMLDivElement>) => void;
  endPointerScroll: (event: PointerEvent<HTMLDivElement>) => void;
}>;
