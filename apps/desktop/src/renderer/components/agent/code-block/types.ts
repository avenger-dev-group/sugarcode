export type CodeBlockCopyState = 'idle' | 'copied' | 'failed';

export type AgentCodeBlockProps = Readonly<{
  code: string;
  language?: string;
}>;

export type CodeBlockStore = Readonly<{
  copyState: CodeBlockCopyState;
  copy: () => Promise<void>;
}>;
