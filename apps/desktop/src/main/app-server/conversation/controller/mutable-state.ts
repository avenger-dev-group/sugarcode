import type {
  ConversationAgentTaskStatus,
  ConversationCommandApprovalDecision,
  ConversationCommandExecutionResultOutcome,
  ConversationCommentaryActivity,
  ConversationContextCompactionActivity,
  ConversationFileChangeProposal,
  ConversationFileChangeResultOutcome,
  ConversationMessage,
  ConversationMcpResultReceipt,
  ConversationModelSelection,
  ConversationTurn,
  ConversationTurnError,
  ConversationTurnStatus,
  ConversationWorkspaceListActivity,
  ConversationWorkspaceListOutcome,
  ConversationWorkspaceReadActivity,
  ConversationWorkspaceReadOutcome,
  ConversationWorkspaceSearchActivity,
  ConversationWorkspaceSearchOutcome,
} from '@/shared/conversation';

import type { MutableAgentOutput } from '../agent-output-lifecycle';
import type { AgentOutputRef } from '../protocol';

export type MutableMessage = {
  id: string;
  role: ConversationMessage['role'];
  text: string;
  attachments?: ConversationMessage['attachments'];
  status: ConversationMessage['status'];
  agentOutput?: AgentOutputRef;
};

export type MutableContextCompactionActivity = {
  -readonly [
    Key in keyof ConversationContextCompactionActivity
  ]: ConversationContextCompactionActivity[Key];
};

export type MutableCommentaryActivity = {
  -readonly [
    Key in keyof ConversationCommentaryActivity
  ]: ConversationCommentaryActivity[Key];
};

export type MutableConversationActivity =
  | { type: 'commentary'; activity: MutableCommentaryActivity }
  | { type: 'contextCompaction'; activity: MutableContextCompactionActivity }
  | { type: 'workspaceRead'; activity: MutableWorkspaceReadActivity }
  | { type: 'workspaceList'; activity: MutableWorkspaceListActivity }
  | { type: 'workspaceSearch'; activity: MutableWorkspaceSearchActivity }
  | { type: 'fileChange'; activity: MutableFileChangeActivity }
  | { type: 'commandApproval'; activity: MutableCommandApprovalActivity }
  | { type: 'mcp'; activity: MutableMcpActivity }
  | { type: 'orchestration'; activity: MutableOrchestrationActivity };

export type MutableAgentTask = {
  id: string;
  taskId: string;
  clientTaskKey: string;
  childThreadId: string;
  title: string;
  role: 'explorer' | 'worker' | 'auditor';
  access: 'readOnly' | 'workspaceWrite';
  dependsOn: readonly string[];
  taskMarkdown: string;
  status: ConversationAgentTaskStatus;
  amendments: Array<{ id: string; markdown: string }>;
  result?: { id: string; summaryMarkdown: string; durationMs: number };
};

export type MutableOrchestrationActivity = {
  id: string;
  tasks: MutableAgentTask[];
};

export type MutableWorkspaceReadActivity = {
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationWorkspaceReadActivity['callStatus'];
  result?: {
    id: string;
    status: ConversationWorkspaceReadActivity['callStatus'];
    outcome: ConversationWorkspaceReadOutcome;
  };
};

export type MutableWorkspaceListActivity = {
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationWorkspaceListActivity['callStatus'];
  result?: {
    id: string;
    status: ConversationWorkspaceListActivity['callStatus'];
    outcome: ConversationWorkspaceListOutcome;
  };
};

export type MutableWorkspaceSearchActivity = {
  id: string;
  callId: string;
  path: string;
  query: string;
  callStatus: ConversationWorkspaceSearchActivity['callStatus'];
  result?: {
    id: string;
    status: ConversationWorkspaceSearchActivity['callStatus'];
    outcome: ConversationWorkspaceSearchOutcome;
  };
};

export type MutableFileChangeActivity = {
  id: string;
  callId: string;
  path: string;
  paths: readonly string[];
  callStatus: ConversationMessage['status'];
  change?: ConversationFileChangeProposal;
  changes: ConversationFileChangeProposal[];
  result?: {
    id: string;
    status: ConversationMessage['status'];
    outcome: ConversationFileChangeResultOutcome;
  };
};

export type MutableCommandCall = {
  id: string;
  callId: string;
  command: string;
  arguments: readonly string[];
  status: ConversationMessage['status'];
};

export type MutableCommandApprovalActivity = {
  callItemId: string;
  id: string;
  callId: string;
  approvalId: string;
  command: string;
  argumentCount: number;
  fullAccess?: boolean;
  requestStatus: ConversationMessage['status'];
  decision?: {
    id: string;
    status: ConversationMessage['status'];
    value: ConversationCommandApprovalDecision;
  };
  executionAttempt?: {
    id: string;
    status: ConversationMessage['status'];
  };
  executionResult?: {
    id: string;
    status: ConversationMessage['status'];
    outcome: ConversationCommandExecutionResultOutcome;
  };
  argumentSignature: string;
  liveOutput?: { stdout: string; stderr: string };
};

export type MutableMcpCall = {
  id: string;
  callId: string;
  name: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  argumentSignature: string;
  status: ConversationMessage['status'];
};

export type MutableMcpActivity = {
  callItemId: string;
  id: string;
  callId: string;
  approvalId: string;
  serverId: string;
  name: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  argumentSignature: string;
  callStatus: ConversationMessage['status'];
  requestStatus: ConversationMessage['status'];
  decision?: {
    id: string;
    status: ConversationMessage['status'];
    value: ConversationCommandApprovalDecision;
  };
  executionAttempt?: {
    id: string;
    status: ConversationMessage['status'];
  };
  result?: {
    id: string;
    status: ConversationMessage['status'];
    receipt: ConversationMcpResultReceipt;
  };
};

export type MutableTurn = {
  id: string;
  status: ConversationTurnStatus;
  model?: ConversationModelSelection;
  messages: MutableMessage[];
  pendingAgentOutputs: MutableAgentOutput[];
  activities: MutableConversationActivity[];
  contextCompactions?: MutableContextCompactionActivity[];
  workspaceRead?: MutableWorkspaceReadActivity;
  workspaceList?: MutableWorkspaceListActivity;
  workspaceSearch?: MutableWorkspaceSearchActivity;
  fileChange?: MutableFileChangeActivity;
  pendingCommandCalls?: MutableCommandCall[];
  commandApproval?: MutableCommandApprovalActivity;
  pendingMcpCall?: MutableMcpCall;
  mcpActivities?: MutableMcpActivity[];
  orchestration?: MutableOrchestrationActivity;
  error?: ConversationTurnError;
  usage?: ConversationTurn['usage'];
};
