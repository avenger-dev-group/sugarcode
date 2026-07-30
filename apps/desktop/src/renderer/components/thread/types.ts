import type { RefObject, UIEvent } from 'react';

import type {
  ConversationPhase,
  ConversationTurnError,
  ConversationTurnStatus,
} from '@/shared/conversation';

import type {
  AgentMessageViewModel,
  CommandApprovalActivityViewModel,
  WorkspaceListActivityViewModel,
  WorkspaceReadActivityViewModel,
  WorkspaceSearchActivityViewModel,
} from '../agent/types';
import type { ContextCompactionActivityViewModel } from '../agent/context-compaction-activity';
import type { FileChangeReviewViewModel } from '../workspace/types';
import type { McpActivityViewModel } from '../mcp/types';

export type UserMessageViewModel = Readonly<{
  id: string;
  text: string;
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
}>;

export type TurnActivityViewModel =
  | Readonly<{
      type: 'contextCompaction';
      activity: ContextCompactionActivityViewModel;
    }>
  | Readonly<{ type: 'workspaceRead'; activity: WorkspaceReadActivityViewModel }>
  | Readonly<{ type: 'workspaceList'; activity: WorkspaceListActivityViewModel }>
  | Readonly<{
      type: 'workspaceSearch';
      activity: WorkspaceSearchActivityViewModel;
    }>
  | Readonly<{ type: 'fileChange'; activity: FileChangeReviewViewModel }>
  | Readonly<{
      type: 'commandApproval';
      activity: CommandApprovalActivityViewModel;
    }>
  | Readonly<{ type: 'mcp'; activity: McpActivityViewModel }>;

export type TurnViewModel = Readonly<{
  id: string;
  status: ConversationTurnStatus;
  messages: readonly TranscriptMessageViewModel[];
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
  query: string;
  searchStatus: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  threadIds: readonly string[];
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
  navigatorOpen: boolean;
  draft: string;
  inputBytes: number;
  inputLimitBytes: number;
  inputHint: string;
  canSend: boolean;
  canStop: boolean;
  isSending: boolean;
  actionError: string | null;
  setDraft: (value: string) => void;
  setNavigatorOpen: (open: boolean) => void;
  searchThreads: (query: string) => Promise<void>;
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
}>;

export type TranscriptTurnProps = Readonly<{
  turn: TurnViewModel;
}>;

export type TranscriptFollow = Readonly<{
  transcriptEnd: RefObject<HTMLDivElement | null>;
  recordScrollPosition: (event: UIEvent<HTMLDivElement>) => void;
}>;
