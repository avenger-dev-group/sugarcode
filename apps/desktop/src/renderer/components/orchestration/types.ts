import type { ConversationAgentTaskStatus } from '@/shared/conversation';

import type { FileChangeReviewFile } from '../workspace/types';

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

export type ContextRailResource =
  | Readonly<{
      kind: 'file';
      path: string;
    }>
  | Readonly<{
      kind: 'diff';
      path: string;
      changes: readonly FileChangeReviewFile[];
    }>
  | Readonly<{
      kind: 'drawio';
      path: string;
    }>
  | Readonly<{
      kind: 'skill';
      name: string;
      description?: string;
      content: string;
    }>;

export type ContextRailPlan = Readonly<{
  id: string;
  turnId: string;
  content: string;
}>;
