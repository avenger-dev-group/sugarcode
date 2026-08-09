import type { ConversationCommandExecutionResultOutcome } from '@/shared/conversation';
import type { ReactNode } from 'react';

export type AgentMessagePresentationState =
  'streaming' | 'stopping' | 'uncertain' | 'completed';

export type AgentMessageViewModel = Readonly<{
  id: string;
  text: string;
  state: AgentMessagePresentationState;
  verifiedFilePaths: readonly string[];
}>;

export type AgentMessageProps = Readonly<{
  message: AgentMessageViewModel;
}>;

export type AgentCommentaryViewModel = Readonly<{
  id: string;
  text: string;
  state: 'running' | 'completed';
}>;

export type AgentCommentaryProps = Readonly<{
  commentary: AgentCommentaryViewModel;
}>;

export type WorkspaceReadPresentationState =
  'running' | 'stopping' | 'uncertain' | 'succeeded' | 'failed' | 'interrupted';

export type WorkspaceReadActivityViewModel = Readonly<{
  id: string;
  path: string;
  state: WorkspaceReadPresentationState;
  bytes?: number;
  errorKind?: string;
}>;

export type WorkspaceReadActivityProps = Readonly<{
  activity: WorkspaceReadActivityViewModel;
}>;

export type WorkspaceListPresentationState =
  'running' | 'stopping' | 'uncertain' | 'succeeded' | 'failed' | 'interrupted';

export type WorkspaceListActivityViewModel = Readonly<{
  id: string;
  path: string;
  state: WorkspaceListPresentationState;
  entries?: number;
  errorKind?: string;
}>;

export type WorkspaceListActivityProps = Readonly<{
  activity: WorkspaceListActivityViewModel;
}>;

export type WorkspaceSearchPresentationState =
  'running' | 'stopping' | 'uncertain' | 'succeeded' | 'failed' | 'interrupted';

export type WorkspaceSearchActivityViewModel = Readonly<{
  id: string;
  path: string;
  query: string;
  state: WorkspaceSearchPresentationState;
  matches?: number;
  truncated?: boolean;
  errorKind?: string;
}>;

export type WorkspaceSearchActivityProps = Readonly<{
  activity: WorkspaceSearchActivityViewModel;
}>;

export type CommandApprovalPresentationState =
  | 'awaiting'
  | 'stopping'
  | 'uncertain'
  | 'interrupted'
  | 'approved'
  | 'denied'
  | 'timedOut'
  | 'unsupported'
  | 'cancelled'
  | 'clientDisconnected';

export type CommandExecutionAttemptPresentationState =
  'observed' | 'stopping' | 'uncertain' | 'recorded';

export type CommandExecutionResultPresentationState =
  'observed' | 'stopping' | 'uncertain' | 'recorded';

export type CommandExecutionResultViewModel = Readonly<{
  id: string;
  state: CommandExecutionResultPresentationState;
  outcome: ConversationCommandExecutionResultOutcome;
}>;

export type CommandApprovalActivityViewModel = Readonly<{
  id: string;
  command: string;
  argumentCount: number;
  fullAccess?: boolean;
  approvalSource?: 'user' | 'policy' | 'system';
  liveOutput?: Readonly<{ stdout: string; stderr: string }>;
  state: CommandApprovalPresentationState;
  executionAttempt?: Readonly<{
    id: string;
    state: CommandExecutionAttemptPresentationState;
  }>;
  executionResult?: CommandExecutionResultViewModel;
}>;

export type CommandApprovalActivityProps = Readonly<{
  activity: CommandApprovalActivityViewModel;
}>;

export type AgentMarkdownProps = Readonly<{
  source: string;
  isStreaming: boolean;
  verifiedFilePaths?: readonly string[];
}>;

export type FileReferenceResolution =
  | Readonly<{
      status:
        | 'idle'
        | 'loading'
        | 'notFound'
        | 'ambiguous'
        | 'outsideWorkspace'
        | 'unavailable';
    }>
  | Readonly<{ status: 'resolved'; path: string }>;

export type FileReferenceLinkStore = Readonly<{
  locationLabel: string;
  open: () => Promise<void>;
  prepare: () => void;
}>;

export type FileReferenceLinkProps = Readonly<{
  children: ReactNode;
  exactPath?: boolean;
  openFile: (path: string) => void;
  path: string;
  variant: 'code' | 'link';
  workspaceGeneration: number;
  workspaceReady: boolean;
}>;
