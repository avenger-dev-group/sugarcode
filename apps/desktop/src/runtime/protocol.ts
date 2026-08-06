import type { ModelWireApi } from '../shared/model-config.ts';

export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export type RuntimeProviderConfig = Readonly<{
  wireApi: ModelWireApi;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  parallelTools: boolean;
}>;

export type RuntimeContentPart =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{
      type: 'asset';
      assetId: string;
      mediaType: string;
      name: string;
    }>;

export type RuntimeCommand =
  | Readonly<{
      type: 'initialize';
      requestId: string;
      protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
      dataDirectory: string;
      nativeModulePath?: string;
    }>
  | Readonly<{
      type: 'workspace.open';
      requestId: string;
      workspaceId: string;
      canonicalRoot: string;
    }>
  | Readonly<{
      type: 'turn.start';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
      provider: RuntimeProviderConfig;
      content: readonly RuntimeContentPart[];
    }>
  | Readonly<{
      type: 'turn.cancel';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
    }>
  | Readonly<{
      type: 'approval.resolve';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
      approvalId: string;
      decision: 'approved' | 'denied';
    }>
  | Readonly<{ type: 'shutdown'; requestId: string }>;

export type RuntimeUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens: number;
}>;

export type RuntimeProviderError = Readonly<{
  kind:
    | 'authentication'
    | 'rateLimit'
    | 'invalidRequest'
    | 'timeout'
    | 'connection'
    | 'protocol'
    | 'server'
    | 'cancelled'
    | 'unknown';
  retryable: boolean;
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  retryAfterMs?: number;
}>;

type RuntimeEventBase = Readonly<{
  sequence: number;
  requestId: string;
}>;

export type RuntimeEvent =
  | (RuntimeEventBase &
      Readonly<{
        type: 'runtime.ready';
        protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'runtime.log';
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.started';
        workspaceId: string;
        threadId: string;
        turnId: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.textDelta';
        workspaceId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        phase: 'commentary' | 'final';
        delta: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.usage';
        workspaceId: string;
        threadId: string;
        turnId: string;
        usage: RuntimeUsage;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.toolCall';
        workspaceId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        callId: string;
        name: string;
        arguments: Readonly<Record<string, unknown>>;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.toolResult';
        workspaceId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        callId: string;
        result: Readonly<Record<string, unknown>>;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'approval.requested';
        workspaceId: string;
        threadId: string;
        turnId: string;
        approvalId: string;
        operationId: string;
        toolName: string;
        argumentsSummary: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'agent.task';
        workspaceId: string;
        threadId: string;
        turnId: string;
        taskId: string;
        parentTaskId?: string;
        status:
          | 'pending'
          | 'running'
          | 'waiting'
          | 'completed'
          | 'failed'
          | 'interrupted';
        title: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.completed';
        workspaceId: string;
        threadId: string;
        turnId: string;
        status: 'completed' | 'interrupted' | 'failed';
        error?: RuntimeProviderError;
      }>);

type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequence'> : never;
export type RuntimeEventInput = WithoutSequence<RuntimeEvent>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringRecord = (
  value: unknown,
): value is Readonly<Record<string, string>> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');

const isProviderConfig = (value: unknown): value is RuntimeProviderConfig =>
  isRecord(value) &&
  ['openaiResponses', 'openaiChatCompletions', 'anthropicMessages'].includes(
    String(value.wireApi),
  ) &&
  typeof value.model === 'string' &&
  value.model.length > 0 &&
  typeof value.baseUrl === 'string' &&
  value.baseUrl.length > 0 &&
  (value.apiKey === undefined || typeof value.apiKey === 'string') &&
  (value.headers === undefined || isStringRecord(value.headers)) &&
  typeof value.timeoutMs === 'number' &&
  Number.isInteger(value.timeoutMs) &&
  value.timeoutMs >= 1_000 &&
  value.timeoutMs <= 600_000 &&
  typeof value.parallelTools === 'boolean';

const isContentPart = (value: unknown): value is RuntimeContentPart => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'text') {
    return typeof value.text === 'string';
  }
  return (
    value.type === 'asset' &&
    typeof value.assetId === 'string' &&
    typeof value.mediaType === 'string' &&
    typeof value.name === 'string'
  );
};

const hasRequestId = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & { requestId: string } =>
  typeof value.requestId === 'string' && value.requestId.length > 0;

export const isRuntimeCommand = (value: unknown): value is RuntimeCommand => {
  if (!isRecord(value) || !hasRequestId(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'initialize':
      return (
        value.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
        typeof value.dataDirectory === 'string' &&
        value.dataDirectory.length > 0 &&
        (value.nativeModulePath === undefined ||
          (typeof value.nativeModulePath === 'string' &&
            value.nativeModulePath.length > 0))
      );
    case 'workspace.open':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.canonicalRoot === 'string' &&
        value.canonicalRoot.length > 0
      );
    case 'turn.start':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        isProviderConfig(value.provider) &&
        Array.isArray(value.content) &&
        value.content.length > 0 &&
        value.content.every(isContentPart)
      );
    case 'turn.cancel':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string'
      );
    case 'approval.resolve':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        typeof value.approvalId === 'string' &&
        ['approved', 'denied'].includes(String(value.decision))
      );
    case 'shutdown':
      return true;
    default:
      return false;
  }
};

const hasEventBase = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  sequence: number;
  requestId: string;
} =>
  Number.isInteger(value.sequence) &&
  Number(value.sequence) >= 0 &&
  hasRequestId(value);

const hasTurnCoordinates = (value: Record<string, unknown>): boolean =>
  typeof value.workspaceId === 'string' &&
  typeof value.threadId === 'string' &&
  typeof value.turnId === 'string';

export const isRuntimeEvent = (value: unknown): value is RuntimeEvent => {
  if (!isRecord(value) || !hasEventBase(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'runtime.ready':
      return value.protocolVersion === RUNTIME_PROTOCOL_VERSION;
    case 'runtime.log':
      return (
        ['debug', 'info', 'warn', 'error'].includes(String(value.level)) &&
        typeof value.message === 'string'
      );
    case 'turn.started':
      return hasTurnCoordinates(value);
    case 'turn.textDelta':
      return (
        hasTurnCoordinates(value) &&
        typeof value.itemId === 'string' &&
        ['commentary', 'final'].includes(String(value.phase)) &&
        typeof value.delta === 'string'
      );
    case 'turn.usage':
      return hasTurnCoordinates(value) && isRecord(value.usage);
    case 'turn.toolCall':
      return (
        hasTurnCoordinates(value) &&
        typeof value.itemId === 'string' &&
        typeof value.callId === 'string' &&
        typeof value.name === 'string' &&
        isRecord(value.arguments)
      );
    case 'turn.toolResult':
      return (
        hasTurnCoordinates(value) &&
        typeof value.itemId === 'string' &&
        typeof value.callId === 'string' &&
        isRecord(value.result)
      );
    case 'approval.requested':
      return (
        hasTurnCoordinates(value) &&
        typeof value.approvalId === 'string' &&
        typeof value.operationId === 'string' &&
        typeof value.toolName === 'string' &&
        typeof value.argumentsSummary === 'string'
      );
    case 'agent.task':
      return (
        hasTurnCoordinates(value) &&
        typeof value.taskId === 'string' &&
        (value.parentTaskId === undefined ||
          typeof value.parentTaskId === 'string') &&
        [
          'pending',
          'running',
          'waiting',
          'completed',
          'failed',
          'interrupted',
        ].includes(String(value.status)) &&
        typeof value.title === 'string'
      );
    case 'turn.completed':
      return (
        hasTurnCoordinates(value) &&
        ['completed', 'interrupted', 'failed'].includes(String(value.status)) &&
        (value.error === undefined || isRecord(value.error))
      );
    default:
      return false;
  }
};
