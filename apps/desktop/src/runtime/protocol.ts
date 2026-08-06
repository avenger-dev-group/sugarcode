import {
  isModelConfigActionResult,
  isModelConfigInspection,
  isModelConfigSaveRequest,
  isModelDiscoveryResult,
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelConfigSaveRequest,
  type ModelDiscoveryResult,
  type ModelWireApi,
} from '../shared/model-config.ts';
import {
  isGitCommitResponse,
  isGitDiffResponse,
  isGitMutationResponse,
  isGitStatusResponse,
} from '../shared/git.ts';
import type {
  WorkspaceGitCommitResponse,
  WorkspaceGitDiffResponse,
  WorkspaceGitMutationResponse,
  WorkspaceGitStatusResponse,
} from '@sugarcode/app-server-protocol';

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

export type RuntimeAssetDescriptor = Readonly<{
  assetId: string;
  sha256: string;
  mediaType: string;
  originalName: string;
  sizeBytes: number;
  kind: 'image' | 'pdf' | 'text';
  pdfPages?: number;
}>;

export type RuntimeContentPart =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{
      type: 'asset';
      asset: RuntimeAssetDescriptor;
    }>;

export type RuntimeThreadRecord = Readonly<{
  id: string;
  workspaceId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  parentThreadId: string | null;
}>;

export type RuntimeTurnRecord = Readonly<{
  id: string;
  requestId: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  providerWireApi: ModelWireApi;
  model: string;
  errorJson: string | null;
  startedAt: number;
  completedAt: number | null;
}>;

export type RuntimeTurnItemRecord = Readonly<{
  id: string;
  turnId: string;
  sequence: number;
  kind: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type RuntimeThreadSnapshot = Readonly<{
  thread: RuntimeThreadRecord;
  turns: readonly RuntimeTurnRecord[];
  items: readonly RuntimeTurnItemRecord[];
}>;

export type RuntimeModelSelection = Readonly<{
  profileId: string;
  providerFamily: 'openai' | 'anthropic';
  wireApi: ModelWireApi;
  modelId: string;
  displayName: string;
  contextWindowTokens: number;
  effectiveCapabilities: Readonly<{
    toolCalls: boolean;
    strictTools: boolean;
    parallelTools: boolean;
    imageInput: boolean;
    pdfInput: boolean;
  }>;
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
      type: 'asset.import';
      requestId: string;
      fileName: string;
      mediaType?: string;
      data: string;
    }>
  | Readonly<{
      type: 'turn.start';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
      provider?: RuntimeProviderConfig;
      modelProfileId?: string;
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
      type: 'terminal.create';
      requestId: string;
      workspaceId: string;
      generation: number;
      sessionId: string;
      columns: number;
      rows: number;
    }>
  | Readonly<{
      type: 'terminal.input';
      requestId: string;
      workspaceId: string;
      generation: number;
      sessionId: string;
      data: string;
    }>
  | Readonly<{
      type: 'terminal.resize';
      requestId: string;
      workspaceId: string;
      generation: number;
      sessionId: string;
      columns: number;
      rows: number;
    }>
  | Readonly<{
      type: 'terminal.flow';
      requestId: string;
      workspaceId: string;
      generation: number;
      sessionId: string;
      paused: boolean;
    }>
  | Readonly<{
      type: 'terminal.terminate' | 'terminal.close';
      requestId: string;
      workspaceId: string;
      generation: number;
      sessionId: string;
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
  | Readonly<{
      type: 'thread.list';
      requestId: string;
      workspaceId: string;
      query?: string;
    }>
  | Readonly<{
      type: 'thread.load';
      requestId: string;
      workspaceId: string;
      threadId: string;
    }>
  | Readonly<{
      type: 'thread.create';
      requestId: string;
      workspaceId: string;
      title?: string;
    }>
  | Readonly<{
      type: 'thread.fork' | 'thread.archive' | 'thread.unarchive' | 'thread.delete';
      requestId: string;
      workspaceId: string;
      threadId: string;
    }>
  | Readonly<{
      type: 'git.status';
      requestId: string;
      workspaceId: string;
    }>
  | Readonly<{
      type: 'git.diff';
      requestId: string;
      workspaceId: string;
      expectedRevision: string;
      path: string;
      source: 'worktree' | 'index';
    }>
  | Readonly<{
      type: 'git.stage' | 'git.unstage';
      requestId: string;
      workspaceId: string;
      expectedRevision: string;
      paths: readonly string[];
    }>
  | Readonly<{
      type: 'git.commit';
      requestId: string;
      workspaceId: string;
      expectedRevision: string;
      message: string;
      authorName: string;
      authorEmail: string;
    }>
  | Readonly<{ type: 'model.inspect'; requestId: string }>
  | Readonly<{
      type: 'model.save';
      requestId: string;
      request: ModelConfigSaveRequest;
    }>
  | Readonly<{
      type: 'model.deleteApiKey';
      requestId: string;
      connectionId: string;
      expectedRevision: string;
    }>
  | Readonly<{
      type: 'model.discover';
      requestId: string;
      connectionId: string;
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
        type: 'asset.imported';
        asset: RuntimeAssetDescriptor;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.started';
        workspaceId: string;
        threadId: string;
        turnId: string;
        model: RuntimeModelSelection;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.userMessage';
        workspaceId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        content: readonly RuntimeContentPart[];
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
        fullAccess: boolean;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'approval.resolved';
        workspaceId: string;
        threadId: string;
        turnId: string;
        approvalId: string;
        operationId: string;
        decision: 'approved' | 'denied';
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'operation.started';
        workspaceId: string;
        threadId: string;
        turnId: string;
        operationId: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'operation.output';
        workspaceId: string;
        threadId: string;
        turnId: string;
        operationId: string;
        stream: 'stdout' | 'stderr';
        delta: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'operation.completed';
        workspaceId: string;
        threadId: string;
        turnId: string;
        operationId: string;
        succeeded: boolean;
        result: Readonly<Record<string, unknown>>;
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
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'terminal.started';
        workspaceId: string;
        generation: number;
        sessionId: string;
        shell: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'terminal.inputAccepted';
        workspaceId: string;
        generation: number;
        sessionId: string;
        inputBytes: number;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'terminal.output';
        workspaceId: string;
        generation: number;
        sessionId: string;
        outputSequence: number;
        data: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'terminal.error';
        workspaceId: string;
        generation: number;
        sessionId: string;
        error: 'spawnFailed' | 'protocolInvalid' | 'bridgeCrashed' | 'outputOverload';
        fatal: boolean;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'terminal.exited';
        workspaceId: string;
        generation: number;
        sessionId: string;
        exitCode: number;
        signal?: string;
        reason: 'natural' | 'requested' | 'ownerLost' | 'protocolError' | 'ioError';
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'model.configInspection';
        inspection: ModelConfigInspection;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'model.configAction';
        action: ModelConfigActionResult;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'model.discovery';
        discovery: ModelDiscoveryResult;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'thread.listResult';
        workspaceId: string;
        query: string;
        threads: readonly RuntimeThreadRecord[];
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'thread.loaded';
        workspaceId: string;
        snapshot: RuntimeThreadSnapshot;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'thread.mutated';
        workspaceId: string;
        operation: 'create' | 'fork' | 'archive' | 'unarchive' | 'delete';
        threadId: string;
        snapshot?: RuntimeThreadSnapshot;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'git.result';
        workspaceId: string;
        operation: 'status' | 'diff' | 'stage' | 'unstage' | 'commit';
        result:
          | WorkspaceGitStatusResponse
          | WorkspaceGitDiffResponse
          | WorkspaceGitMutationResponse
          | WorkspaceGitCommitResponse;
      }>);

type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequence'> : never;
export type RuntimeEventInput = WithoutSequence<RuntimeEvent>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value);

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

export const isRuntimeContentPart = (value: unknown): value is RuntimeContentPart => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'text') {
    return typeof value.text === 'string';
  }
  return (
    value.type === 'asset' &&
    isAssetDescriptor(value.asset)
  );
};

const isAssetDescriptor = (value: unknown): value is RuntimeAssetDescriptor =>
  isRecord(value) &&
  typeof value.assetId === 'string' &&
  /^ast_[0-9a-f]{64}$/u.test(value.assetId) &&
  typeof value.sha256 === 'string' &&
  /^[0-9a-f]{64}$/u.test(value.sha256) &&
  value.assetId === `ast_${value.sha256}` &&
  typeof value.mediaType === 'string' &&
  typeof value.originalName === 'string' &&
  typeof value.sizeBytes === 'number' &&
  Number.isSafeInteger(value.sizeBytes) &&
  value.sizeBytes > 0 &&
  ['image', 'pdf', 'text'].includes(String(value.kind)) &&
  (value.pdfPages === undefined ||
    (Number.isSafeInteger(value.pdfPages) && Number(value.pdfPages) > 0));

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
    case 'asset.import':
      return (
        typeof value.fileName === 'string' &&
        value.fileName.length > 0 &&
        value.fileName.length <= 255 &&
        (value.mediaType === undefined || typeof value.mediaType === 'string') &&
        typeof value.data === 'string' &&
        value.data.length > 0 &&
        value.data.length <= 27_962_032
      );
    case 'turn.start':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        ((value.provider !== undefined &&
          isProviderConfig(value.provider) &&
          value.modelProfileId === undefined) ||
          (value.provider === undefined &&
            (value.modelProfileId === undefined ||
              (typeof value.modelProfileId === 'string' &&
                /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId))))) &&
        Array.isArray(value.content) &&
        value.content.length > 0 &&
        value.content.every(isRuntimeContentPart)
      );
    case 'turn.cancel':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string'
      );
    case 'terminal.create':
    case 'terminal.resize':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        Number.isSafeInteger(value.columns) &&
        Number(value.columns) >= 2 &&
        Number(value.columns) <= 500 &&
        Number.isSafeInteger(value.rows) &&
        Number(value.rows) >= 2 &&
        Number(value.rows) <= 300
      );
    case 'terminal.input':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        typeof value.data === 'string' &&
        value.data.length > 0 &&
        utf8ByteLength(value.data) <= 65_536
      );
    case 'terminal.flow':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        typeof value.paused === 'boolean'
      );
    case 'terminal.terminate':
    case 'terminal.close':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId)
      );
    case 'approval.resolve':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        typeof value.approvalId === 'string' &&
        ['approved', 'denied'].includes(String(value.decision))
      );
    case 'thread.list':
      return (
        typeof value.workspaceId === 'string' &&
        (value.query === undefined || typeof value.query === 'string')
      );
    case 'thread.load':
    case 'thread.fork':
    case 'thread.archive':
    case 'thread.unarchive':
    case 'thread.delete':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string'
      );
    case 'thread.create':
      return (
        typeof value.workspaceId === 'string' &&
        (value.title === undefined || typeof value.title === 'string')
      );
    case 'git.status':
      return typeof value.workspaceId === 'string';
    case 'git.diff':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.expectedRevision === 'string' &&
        typeof value.path === 'string' &&
        ['worktree', 'index'].includes(String(value.source))
      );
    case 'git.stage':
    case 'git.unstage':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.expectedRevision === 'string' &&
        Array.isArray(value.paths) &&
        value.paths.every((path) => typeof path === 'string')
      );
    case 'git.commit':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.expectedRevision === 'string' &&
        typeof value.message === 'string' &&
        typeof value.authorName === 'string' &&
        typeof value.authorEmail === 'string'
      );
    case 'model.inspect':
      return true;
    case 'model.save':
      return isModelConfigSaveRequest(value.request);
    case 'model.deleteApiKey':
      return (
        typeof value.connectionId === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/u.test(value.connectionId) &&
        typeof value.expectedRevision === 'string' &&
        /^[0-9a-f]{64}$/u.test(value.expectedRevision)
      );
    case 'model.discover':
      return (
        typeof value.connectionId === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/u.test(value.connectionId)
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
    case 'asset.imported':
      return isAssetDescriptor(value.asset);
    case 'turn.started':
      return hasTurnCoordinates(value) && isRecord(value.model);
    case 'turn.userMessage':
      return (
        hasTurnCoordinates(value) &&
        typeof value.itemId === 'string' &&
        Array.isArray(value.content) &&
        value.content.every(isRuntimeContentPart)
      );
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
        typeof value.argumentsSummary === 'string' &&
        typeof value.fullAccess === 'boolean'
      );
    case 'approval.resolved':
      return (
        hasTurnCoordinates(value) &&
        typeof value.approvalId === 'string' &&
        typeof value.operationId === 'string' &&
        ['approved', 'denied'].includes(String(value.decision))
      );
    case 'operation.started':
      return hasTurnCoordinates(value) && typeof value.operationId === 'string';
    case 'operation.output':
      return (
        hasTurnCoordinates(value) &&
        typeof value.operationId === 'string' &&
        (value.stream === 'stdout' || value.stream === 'stderr') &&
        typeof value.delta === 'string' &&
        value.delta.length > 0 &&
        utf8ByteLength(value.delta) <= 32_768
      );
    case 'operation.completed':
      return (
        hasTurnCoordinates(value) &&
        typeof value.operationId === 'string' &&
        typeof value.succeeded === 'boolean' &&
        isRecord(value.result)
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
    case 'terminal.started':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        typeof value.shell === 'string'
      );
    case 'terminal.inputAccepted':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        Number.isSafeInteger(value.inputBytes) &&
        Number(value.inputBytes) > 0 &&
        Number(value.inputBytes) <= 65_536
      );
    case 'terminal.output':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        Number.isSafeInteger(value.outputSequence) &&
        Number(value.outputSequence) > 0 &&
        typeof value.data === 'string' &&
        utf8ByteLength(value.data) <= 32_768
      );
    case 'terminal.error':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        ['spawnFailed', 'protocolInvalid', 'bridgeCrashed', 'outputOverload'].includes(String(value.error)) &&
        typeof value.fatal === 'boolean'
      );
    case 'terminal.exited':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        Number.isSafeInteger(value.exitCode) &&
        (value.signal === undefined || typeof value.signal === 'string') &&
        ['natural', 'requested', 'ownerLost', 'protocolError', 'ioError'].includes(String(value.reason))
      );
    case 'model.configInspection':
      return isModelConfigInspection(value.inspection);
    case 'model.configAction':
      return isModelConfigActionResult(value.action);
    case 'model.discovery':
      return isModelDiscoveryResult(value.discovery);
    case 'thread.listResult':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.query === 'string' &&
        Array.isArray(value.threads) &&
        value.threads.every(isThreadRecord)
      );
    case 'thread.loaded':
      return (
        typeof value.workspaceId === 'string' &&
        isThreadSnapshot(value.snapshot)
      );
    case 'thread.mutated':
      return (
        typeof value.workspaceId === 'string' &&
        ['create', 'fork', 'archive', 'unarchive', 'delete'].includes(
          String(value.operation),
        ) &&
        typeof value.threadId === 'string' &&
        (value.snapshot === undefined || isThreadSnapshot(value.snapshot))
      );
    case 'git.result':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.operation === 'string' &&
        ((value.operation === 'status' && isGitStatusResponse(value.result)) ||
          (value.operation === 'diff' && isGitDiffResponse(value.result)) ||
          (['stage', 'unstage'].includes(value.operation) &&
            isGitMutationResponse(value.result)) ||
          (value.operation === 'commit' && isGitCommitResponse(value.result)))
      );
    default:
      return false;
  }
};

const isThreadRecord = (value: unknown): value is RuntimeThreadRecord =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.workspaceId === 'string' &&
  (value.title === null || typeof value.title === 'string') &&
  Number.isInteger(value.createdAt) &&
  Number.isInteger(value.updatedAt) &&
  (value.archivedAt === null || Number.isInteger(value.archivedAt)) &&
  (value.parentThreadId === null || typeof value.parentThreadId === 'string');

const isThreadSnapshot = (value: unknown): value is RuntimeThreadSnapshot =>
  isRecord(value) &&
  isThreadRecord(value.thread) &&
  Array.isArray(value.turns) &&
  Array.isArray(value.items) &&
  value.turns.every(
    (turn) =>
      isRecord(turn) &&
      typeof turn.id === 'string' &&
      typeof turn.requestId === 'string' &&
      ['running', 'completed', 'interrupted', 'failed'].includes(
        String(turn.status),
      ) &&
      typeof turn.providerWireApi === 'string' &&
      typeof turn.model === 'string',
  ) &&
  value.items.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.turnId === 'string' &&
      Number.isInteger(item.sequence) &&
      typeof item.kind === 'string' &&
      isRecord(item.payload),
  );
