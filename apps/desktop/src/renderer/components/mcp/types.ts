import type {
  McpApprovalStateSnapshot,
  McpApprovalViewModel,
  McpSessionStateSnapshot,
} from '@/shared/mcp';
import type {
  ConversationMcpResultReceipt,
  ConversationTurnStatus,
} from '@/shared/conversation';

export type McpStore = Readonly<{
  session: McpSessionStateSnapshot;
  approval: McpApprovalStateSnapshot;
  approvalRequest: McpApprovalViewModel | null;
  secondsRemaining: number;
  canApprove: boolean;
  sessionBusy: boolean;
  actionError: string | null;
  toggleServer: (serverId: string) => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  approve: () => Promise<void>;
  deny: () => Promise<void>;
}>;

export type McpSessionPanelProps = Readonly<{
  turnBusy: boolean;
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
