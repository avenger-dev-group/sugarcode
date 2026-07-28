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

export type AgentMarkdownProps = Readonly<{
  source: string;
  isStreaming: boolean;
}>;
