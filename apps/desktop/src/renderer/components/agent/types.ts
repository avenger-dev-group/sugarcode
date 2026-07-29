export type AgentMessagePresentationState =
  | 'streaming'
  | 'stopping'
  | 'uncertain'
  | 'completed';

export type AgentMessageViewModel = Readonly<{
  id: string;
  text: string;
  state: AgentMessagePresentationState;
}>;

export type AgentMessageProps = Readonly<{
  message: AgentMessageViewModel;
}>;

export type WorkspaceReadPresentationState =
  | 'running'
  | 'stopping'
  | 'uncertain'
  | 'succeeded'
  | 'failed'
  | 'interrupted';

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
  | 'running'
  | 'stopping'
  | 'uncertain'
  | 'succeeded'
  | 'failed'
  | 'interrupted';

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
  | 'running'
  | 'stopping'
  | 'uncertain'
  | 'succeeded'
  | 'failed'
  | 'interrupted';

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

export type AgentMarkdownProps = Readonly<{
  source: string;
  isStreaming: boolean;
}>;
