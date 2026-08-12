import type {
  FunctionDeclaration,
  GenerateContentConfig,
} from '@google/genai';

export type ProviderAdapterOptions = Readonly<{
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  parallelTools?: boolean;
  maxRetries?: number;
  compactThresholdTokens?: number;
  nativeCompaction?: boolean;
}>;

export const INVALID_TOOL_ARGUMENTS_TOOL_NAME =
  'sugarcode_invalid_tool_arguments';

export type ModelTextPhase = 'commentary' | 'final' | 'provisional';

export type ModelStepOutcome =
  | Readonly<{ kind: 'toolCalls' }>
  | Readonly<{ kind: 'final' }>
  | Readonly<{
      kind: 'continue';
      reason: 'commentaryOnly' | 'pauseTurn' | 'maxOutputTokens';
    }>
  | Readonly<{
      kind: 'failed';
      errorKind:
        | 'protocol'
        | 'filtered'
        | 'unsupportedToolArguments';
      message: string;
    }>;

export type ModelItemMetadata = Readonly<{
  itemId: string;
  phase?: ModelTextPhase;
  outcome?: ModelStepOutcome;
  reasoningVisibility?: 'internal' | 'summary';
}>;

export type NormalizedMediaPart = Readonly<{
  type: 'media';
  mimeType: string;
  data?: string;
  uri?: string;
  name?: string;
}>;

export type NormalizedToolCallPart = Readonly<{
  type: 'toolCall';
  id: string;
  name: string;
  args: Readonly<Record<string, unknown>>;
}>;

export type NormalizedToolResultPart = Readonly<{
  type: 'toolResult';
  id: string;
  name: string;
  result: Readonly<Record<string, unknown>>;
}>;

export type NormalizedMessagePart =
  | Readonly<{
      type: 'text';
      text: string;
      thought: boolean;
      phase?: ModelTextPhase;
      metadata?: Readonly<Record<string, unknown>>;
    }>
  | NormalizedMediaPart
  | NormalizedToolCallPart
  | NormalizedToolResultPart;

export type NormalizedMessage = Readonly<{
  role: 'user' | 'assistant';
  parts: readonly NormalizedMessagePart[];
}>;

export type NormalizedTool = Readonly<{
  providerName: string;
  adkName: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export type NormalizedLlmRequest = Readonly<{
  model: string;
  system: string;
  messages: readonly NormalizedMessage[];
  tools: readonly NormalizedTool[];
  toolNameByProviderName: ReadonlyMap<string, string>;
  config?: GenerateContentConfig;
}>;

export type ToolDeclarationWithNames = Readonly<{
  declaration: FunctionDeclaration;
  adkName: string;
  providerName: string;
}>;
