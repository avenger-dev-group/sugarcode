import type {
  McpApprovalStateSnapshot,
  McpApprovalViewModel,
  McpSessionStateSnapshot,
} from '@/shared/mcp';
import type {
  ConversationMcpResultReceipt,
  ConversationTurnStatus,
} from '@/shared/conversation';
import type { CommandApprovalStore } from '@/renderer/components/command-approval/types';

export type McpStore = Readonly<{
  session: McpSessionStateSnapshot;
  approval: McpApprovalStateSnapshot;
  approvalRequest: McpApprovalViewModel | null;
  approvalRequests: readonly McpApprovalViewModel[];
  secondsRemaining: (request: McpApprovalViewModel) => number;
  canApprove: (request: McpApprovalViewModel) => boolean;
  sessionBusy: boolean;
  actionError: string | null;
  toggleServer: (serverId: string) => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  approve: (request: McpApprovalViewModel) => Promise<void>;
  deny: (request: McpApprovalViewModel) => Promise<void>;
}>;

export type McpSessionPanelProps = Readonly<{
  turnBusy: boolean;
  embedded?: boolean;
}>;

export type McpApprovalSurfaceProps = Readonly<{
  store: McpStore;
  permissionStore: CommandApprovalStore;
  activeThreadId: string | null;
  activeWorkspaceId: string | null;
}>;

export type McpActivityState =
  | 'awaiting'
  | 'denied'
  | 'approved'
  | 'attempted'
  | 'succeeded'
  | 'toolError'
  | 'failed'
  | 'stopped'
  | 'uncertain';

export type McpActivityViewModel = Readonly<{
  id: string;
  serverId: string;
  name: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  state: McpActivityState;
  decision?: string;
  attemptId?: string;
  resultId?: string;
  receipt?: ConversationMcpResultReceipt;
}>;

export type McpActivityTimelineProps = Readonly<{
  activities: readonly McpActivityViewModel[];
  turnStatus: ConversationTurnStatus;
}>;
