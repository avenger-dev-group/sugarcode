export type AgentMessageViewModel = Readonly<{
  id: string;
  text: string;
  isStreaming: boolean;
}>;

export type AgentMessageProps = Readonly<{
  message: AgentMessageViewModel;
}>;
