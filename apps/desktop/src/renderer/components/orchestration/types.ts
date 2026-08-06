import type { ConversationAgentTaskStatus } from '@/shared/conversation';

export type AgentTaskRole = 'explorer' | 'worker' | 'auditor';
export type AgentTaskAccess = 'readOnly' | 'workspaceWrite';

export type AgentTaskAmendmentViewModel = Readonly<{
  id: string;
  markdown: string;
}>;

export type AgentTaskResultViewModel = Readonly<{
  id: string;
  summaryMarkdown: string;
  durationMs: number;
}>;

export type AgentTaskProgressViewModel = Readonly<{
  stage: 'waitingForModel' | 'streaming' | 'runningTool';
  summaryMarkdown: string;
  updatedAt: number;
}>;

export type AgentTaskViewModel = Readonly<{
  id: string;
  taskId: string;
  clientTaskKey: string;
  childThreadId: string;
  title: string;
  role: AgentTaskRole;
  access: AgentTaskAccess;
  dependsOn: readonly string[];
  taskMarkdown: string;
  status: ConversationAgentTaskStatus;
  amendments: readonly AgentTaskAmendmentViewModel[];
  progress?: AgentTaskProgressViewModel;
  result?: AgentTaskResultViewModel;
}>;

export type OrchestrationActivityViewModel = Readonly<{
  id: string;
  tasks: readonly AgentTaskViewModel[];
}>;
