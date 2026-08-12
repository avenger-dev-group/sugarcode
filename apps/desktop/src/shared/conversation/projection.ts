import type {
  ConversationActivity,
  ConversationAgentOutput,
  ConversationCommandApprovalActivity,
  ConversationFileChangeActivity,
  ConversationMcpActivity,
  ConversationMessage,
  ConversationModelSelection,
  ConversationPhase,
  ConversationTokenUsage,
  ConversationTurnError,
  ConversationTurnStatus,
  ConversationTerminalTurnStatus,
  ConversationUserInputRequest,
  ConversationWorkspaceListActivity,
  ConversationWorkspaceReadActivity,
  ConversationWorkspaceSearchActivity,
} from './activities.ts';

export type ConversationTurn = Readonly<{
  id: string;
  status: ConversationTurnStatus;
  model?: ConversationModelSelection;
  messages: readonly ConversationMessage[];
  pendingAgentOutputs?: readonly ConversationAgentOutput[];
  activities?: readonly ConversationActivity[];
  workspaceRead?: ConversationWorkspaceReadActivity;
  workspaceList?: ConversationWorkspaceListActivity;
  workspaceSearch?: ConversationWorkspaceSearchActivity;
  fileChange?: ConversationFileChangeActivity;
  commandApproval?: ConversationCommandApprovalActivity;
  mcpActivities?: readonly ConversationMcpActivity[];
  userInputRequest?: ConversationUserInputRequest;
  error?: ConversationTurnError;
  usage?: ConversationTokenUsage;
}>;

export type ConversationNotice = Readonly<{
  kind: 'requestFailed' | 'connectionLost' | 'warning';
  summary: string;
}>;

export type ConversationThreadNavigatorSnapshot = Readonly<{
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  activeThreadIds: readonly string[];
  activeThreadTitles: Readonly<Record<string, string>>;
  activeTruncated: boolean;
  runningThreadIds?: readonly string[];
  unreadThreadStatuses?: Readonly<
    Record<string, ConversationTerminalTurnStatus>
  >;
  search: Readonly<{
    query: string;
    status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
    threadIds: readonly string[];
    threadTitles: Readonly<Record<string, string>>;
    truncated: boolean;
    summary?: string;
  }>;
  pendingThreadId?: string;
  pendingMutation?: Readonly<{
    kind: 'rename' | 'delete';
    threadId: string;
  }>;
  selectionNotice?: string;
  mutationNotice?: string;
}>;

export type ConversationStateSnapshot = Readonly<{
  revision: number;
  workspaceId?: string;
  phase: ConversationPhase;
  threadId?: string;
  activeTurnId?: string;
  turns: readonly ConversationTurn[];
  navigator: ConversationThreadNavigatorSnapshot;
  notice?: ConversationNotice;
}>;

export type ConversationThreadProjectionSnapshot = Readonly<{
  revision: number;
  workspaceId: string;
  threadId: string;
  phase: Exclude<ConversationPhase, 'idle' | 'unavailable'>;
  activeTurnId?: string;
  turns: readonly ConversationTurn[];
}>;

export type ConversationThreadProjectionDelta = Readonly<{
  revision: number;
  workspaceId: string;
  threadId: string;
  phase: Exclude<ConversationPhase, 'idle' | 'unavailable'>;
  activeTurnId?: string;
  turn: ConversationTurn;
}>;

export type ConversationStateListener = (
  snapshot: ConversationStateSnapshot,
) => void;

export type ConversationThreadProjectionListener = (
  snapshot: ConversationThreadProjectionSnapshot,
) => void;

export type ConversationThreadDeltaListener = (
  delta: ConversationThreadProjectionDelta,
) => void;

export type ConversationProjectionDiagnostic = Readonly<{
  kind: 'shapeInvalid';
  projection: 'snapshot' | 'delta';
  threadId?: string;
  revision?: number;
}>;
