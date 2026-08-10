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
  type WorkspaceGitCommitResponse,
  type WorkspaceGitDiffResponse,
  type WorkspaceGitMutationResponse,
  type WorkspaceGitStatusResponse,
} from '../shared/git.ts';
import {
  isMcpConfigActionResult,
  isMcpConfigInspection,
  isMcpConfigSaveRequest,
  isMcpSessionActionResult,
  type McpConfigActionResult,
  type McpConfigInspection,
  type McpConfigSaveRequest,
  type McpSessionActionResult,
} from '../shared/mcp.ts';
import {
  isSkillContent,
  isSkillId,
  isSkillsActionResult,
  isSkillsInspection,
  type SkillContent,
  type SkillsActionResult,
  type SkillsInspection,
} from '../shared/skills.ts';

export const RUNTIME_PROTOCOL_VERSION = 2 as const;

export type RuntimeProviderConfig = Readonly<{
  wireApi: ModelWireApi;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  parallelTools: boolean;
}>;

export type RuntimeApprovalDecisionSource = 'user' | 'policy' | 'system';

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
  agentTasks: readonly RuntimeAgentTaskRecord[];
}>;

export type RuntimeAgentTaskStatus =
  | 'queued'
  | 'running'
  | 'waitingApproval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type RuntimeAgentTaskProgress = Readonly<{
  stage: 'waitingForModel' | 'streaming' | 'runningTool';
  summaryMarkdown: string;
  updatedAt: number;
}>;

export type RuntimeAgentTask = Readonly<{
  orchestrationId: string;
  taskId: string;
  clientTaskKey: string;
  childThreadId: string;
  title: string;
  role: 'explorer' | 'worker' | 'auditor';
  access: 'readOnly' | 'workspaceWrite';
  dependsOn: readonly string[];
  taskMarkdown: string;
  status: RuntimeAgentTaskStatus;
  amendments: readonly Readonly<{ id: string; markdown: string }>[];
  progress?: RuntimeAgentTaskProgress;
  result?: Readonly<{
    id: string;
    summaryMarkdown: string;
    durationMs: number;
  }>;
}>;

export type RuntimeAgentTaskRecord = Readonly<{
  id: string;
  turnId: string;
  parentTaskId: string | null;
  title: string;
  status: RuntimeAgentTaskStatus;
  payload: RuntimeAgentTask;
  createdAt: number;
  updatedAt: number;
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

export type RuntimeWorkspaceEntry = Readonly<{
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'link' | 'other';
}>;

export type RuntimeWorkspaceDocument =
  | Readonly<{
      status: 'complete';
      path: string;
      content: string;
      bytes: number;
      lines: number;
      hasUtf8Bom: boolean;
    }>
  | Readonly<{
      status: 'truncated';
      path: string;
      content: string;
      bytes: number;
      returnedBytes: number;
      lines: number;
      hasUtf8Bom: boolean;
    }>
  | Readonly<{
      status: 'error';
      path: string;
      kind:
        | 'invalidPath'
        | 'notFound'
        | 'accessDenied'
        | 'pathNotAllowed'
        | 'notRegularFile'
        | 'oversized'
        | 'binary'
        | 'invalidEncoding'
        | 'longLine'
        | 'changed'
        | 'unavailable';
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
      type: 'workspace.list';
      requestId: string;
      workspaceId: string;
      path: string;
    }>
  | Readonly<{
      type: 'workspace.pathSearch';
      requestId: string;
      workspaceId: string;
      query: string;
    }>
  | Readonly<{
      type: 'workspace.inspect';
      requestId: string;
      workspaceId: string;
      path: string;
    }>
  | Readonly<{
      type: 'workspace.resolve';
      requestId: string;
      workspaceId: string;
      name: string;
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
      generateTitle?: boolean;
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
      source: RuntimeApprovalDecisionSource;
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
      type: 'thread.rename';
      requestId: string;
      workspaceId: string;
      threadId: string;
      title: string;
    }>
  | Readonly<{
      type: 'thread.delete';
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
  | Readonly<{ type: 'mcp.configInspect'; requestId: string }>
  | Readonly<{
      type: 'mcp.configSave';
      requestId: string;
      request: McpConfigSaveRequest;
    }>
  | Readonly<{
      type: 'mcp.sessionSet';
      requestId: string;
      serverIds: readonly string[];
    }>
  | Readonly<{
      type: 'skills.inspect';
      requestId: string;
      workspaceId?: string;
    }>
  | Readonly<{
      type: 'skills.content';
      requestId: string;
      workspaceId?: string;
      skillId: string;
      expectedSha256: string;
    }>
  | Readonly<{
      type: 'skills.setEnabled';
      requestId: string;
      workspaceId?: string;
      skillId: string;
      enabled: boolean;
    }>
  | Readonly<{
      type: 'skills.import';
      requestId: string;
      workspaceId?: string;
      sourcePath: string;
      scope: 'user' | 'project';
    }>
  | Readonly<{
      type: 'skills.export';
      requestId: string;
      workspaceId?: string;
      skillId: string;
      destinationPath: string;
    }>
  | Readonly<{ type: 'shutdown'; requestId: string }>;

export type RuntimeUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens: number;
}>;

const isRuntimeUsage = (value: unknown): value is RuntimeUsage => {
  if (!isRecord(value)) {
    return false;
  }
  const allowedFields = new Set([
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cachedInputTokens',
    'totalTokens',
  ]);
  const isTokenCount = (token: unknown): boolean =>
    Number.isSafeInteger(token) && Number(token) >= 0;
  return (
    Object.keys(value).every((field) => allowedFields.has(field)) &&
    isTokenCount(value.inputTokens) &&
    isTokenCount(value.outputTokens) &&
    isTokenCount(value.totalTokens) &&
    (!Object.hasOwn(value, 'reasoningTokens') ||
      isTokenCount(value.reasoningTokens)) &&
    (!Object.hasOwn(value, 'cachedInputTokens') ||
      isTokenCount(value.cachedInputTokens))
  );
};

export type RuntimeProviderError = Readonly<{
  kind:
    | 'authentication'
    | 'rateLimit'
    | 'invalidRequest'
    | 'timeout'
    | 'connection'
    | 'protocol'
    | 'filtered'
    | 'unsupportedToolArguments'
    | 'outputTooLarge'
    | 'server'
    | 'cancelled'
    | 'stateUnavailable'
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
        type: 'workspace.opened';
        workspaceId: string;
        canonicalRoot: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'workspace.listResult';
        workspaceId: string;
        path: string;
        entries: readonly RuntimeWorkspaceEntry[];
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'workspace.pathSearchResult';
        workspaceId: string;
        query: string;
        paths: readonly string[];
        truncated: boolean;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'workspace.inspected';
        workspaceId: string;
        document: RuntimeWorkspaceDocument;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'workspace.resolved';
        workspaceId: string;
        name: string;
        status: 'resolved' | 'notFound' | 'ambiguous' | 'unavailable';
        path?: string;
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
        type: 'turn.textStarted';
        workspaceId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        phase: 'commentary' | 'final' | 'provisional';
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.textDelta';
        workspaceId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        phase: 'commentary' | 'final' | 'provisional';
        delta: string;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.textCompleted';
        workspaceId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        phase: 'commentary' | 'final';
        text: string;
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
        recovered?: true;
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
        source?: RuntimeApprovalDecisionSource;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'mcp.approvalRequested';
        workspaceId: string;
        threadId: string;
        turnId: string;
        approvalId: string;
        operationId: string;
        serverId: string;
        name: string;
        argumentsJson: string;
        argumentsBytes: number;
        argumentsSha256: string;
        inventorySha256: string;
        recovered?: true;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'mcp.approvalResolved';
        workspaceId: string;
        threadId: string;
        turnId: string;
        approvalId: string;
        operationId: string;
        decision: 'approved' | 'denied';
        source?: RuntimeApprovalDecisionSource;
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
        task: RuntimeAgentTask;
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
        error: 'spawnFailed' | 'protocolInvalid' | 'terminalCrashed' | 'outputOverload';
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
        type: 'mcp.configInspection';
        inspection: McpConfigInspection;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'mcp.configAction';
        action: McpConfigActionResult;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'mcp.sessionAction';
        action: McpSessionActionResult;
        activeServerIds: readonly string[];
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'skills.inspection';
        inspection: SkillsInspection;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'skills.content';
        content: SkillContent;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'skills.action';
        action: SkillsActionResult;
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
        operation:
          | 'create'
          | 'rename'
          | 'generateTitle'
          | 'delete';
        threadId: string;
        snapshot?: RuntimeThreadSnapshot;
        deleted?: boolean;
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

const isSafeWorkspacePath = (
  value: unknown,
  allowRoot: boolean,
): value is string =>
  typeof value === 'string' &&
  utf8ByteLength(value) <= 1_024 &&
  (allowRoot || value.length > 0) &&
  (value.length === 0 ||
    (!value.startsWith('/') &&
      !value.startsWith('\\') &&
      value.split(/[\\/]/u).length <= 64 &&
      !value
        .split(/[\\/]/u)
        .some((part) => part.length === 0 || part === '.' || part === '..') &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })));

const workspaceDocumentLineCount = (content: string): number =>
  Math.max(
    1,
    (content.match(/\n/gu)?.length ?? 0) +
      (content.endsWith('\n') ? 0 : 1),
  );

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
    case 'workspace.list':
      return (
        typeof value.workspaceId === 'string' &&
        isSafeWorkspacePath(value.path, true)
      );
    case 'workspace.pathSearch':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.query === 'string' &&
        value.query.trim().length > 0 &&
        utf8ByteLength(value.query) <= 512 &&
        !/[\r\n]/u.test(value.query)
      );
    case 'workspace.inspect':
      return (
        typeof value.workspaceId === 'string' &&
        isSafeWorkspacePath(value.path, false)
      );
    case 'workspace.resolve':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.name === 'string' &&
        value.name.length > 0 &&
        utf8ByteLength(value.name) <= 255 &&
        !value.name.includes('/') &&
        !value.name.includes('\\')
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
        (value.generateTitle === undefined ||
          typeof value.generateTitle === 'boolean') &&
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
        ['approved', 'denied'].includes(String(value.decision)) &&
        ['user', 'policy', 'system'].includes(String(value.source))
      );
    case 'thread.list':
      return (
        typeof value.workspaceId === 'string' &&
        (value.query === undefined || typeof value.query === 'string')
      );
    case 'thread.load':
    case 'thread.delete':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string'
      );
    case 'thread.rename':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        isThreadTitle(value.title)
      );
    case 'thread.create':
      return (
        typeof value.workspaceId === 'string' &&
        (value.title === undefined || isThreadTitle(value.title))
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
    case 'mcp.configInspect':
      return true;
    case 'mcp.configSave':
      return isMcpConfigSaveRequest(value.request);
    case 'mcp.sessionSet':
      return (
        Array.isArray(value.serverIds) &&
        value.serverIds.length <= 2 &&
        value.serverIds.every(
          (id) => typeof id === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id),
        ) &&
        new Set(value.serverIds).size === value.serverIds.length
      );
    case 'skills.inspect':
      return value.workspaceId === undefined || typeof value.workspaceId === 'string';
    case 'skills.content':
      return (
        (value.workspaceId === undefined || typeof value.workspaceId === 'string') &&
        isSkillId(value.skillId) &&
        typeof value.expectedSha256 === 'string' &&
        /^[0-9a-f]{64}$/u.test(value.expectedSha256)
      );
    case 'skills.setEnabled':
      return (
        (value.workspaceId === undefined || typeof value.workspaceId === 'string') &&
        isSkillId(value.skillId) &&
        typeof value.enabled === 'boolean'
      );
    case 'skills.import':
      return (
        (value.workspaceId === undefined || typeof value.workspaceId === 'string') &&
        typeof value.sourcePath === 'string' &&
        value.sourcePath.length > 0 &&
        value.sourcePath.length <= 4_096 &&
        (value.scope === 'user' || value.scope === 'project')
      );
    case 'skills.export':
      return (
        (value.workspaceId === undefined || typeof value.workspaceId === 'string') &&
        isSkillId(value.skillId) &&
        typeof value.destinationPath === 'string' &&
        value.destinationPath.length > 0 &&
        value.destinationPath.length <= 4_096
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

const AGENT_TASK_STATUSES: readonly RuntimeAgentTaskStatus[] = [
  'queued',
  'running',
  'waitingApproval',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
];

export const isRuntimeAgentTask = (value: unknown): value is RuntimeAgentTask =>
  isRecord(value) &&
  typeof value.orchestrationId === 'string' &&
  typeof value.taskId === 'string' &&
  typeof value.clientTaskKey === 'string' &&
  typeof value.childThreadId === 'string' &&
  typeof value.title === 'string' &&
  ['explorer', 'worker', 'auditor'].includes(String(value.role)) &&
  ['readOnly', 'workspaceWrite'].includes(String(value.access)) &&
  Array.isArray(value.dependsOn) &&
  value.dependsOn.every((dependency) => typeof dependency === 'string') &&
  typeof value.taskMarkdown === 'string' &&
  AGENT_TASK_STATUSES.includes(value.status as RuntimeAgentTaskStatus) &&
  Array.isArray(value.amendments) &&
  value.amendments.every(
    (amendment) =>
      isRecord(amendment) &&
      typeof amendment.id === 'string' &&
      typeof amendment.markdown === 'string',
  ) &&
  (value.progress === undefined ||
    (isRecord(value.progress) &&
      ['waitingForModel', 'streaming', 'runningTool'].includes(
        String(value.progress.stage),
      ) &&
      typeof value.progress.summaryMarkdown === 'string' &&
      value.progress.summaryMarkdown.length > 0 &&
      Number.isSafeInteger(value.progress.updatedAt) &&
      Number(value.progress.updatedAt) >= 0)) &&
  (value.result === undefined ||
    (isRecord(value.result) &&
      typeof value.result.id === 'string' &&
      typeof value.result.summaryMarkdown === 'string' &&
      Number.isSafeInteger(value.result.durationMs) &&
      Number(value.result.durationMs) >= 0));

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
    case 'workspace.opened':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.canonicalRoot === 'string' &&
        value.canonicalRoot.length > 0
      );
    case 'workspace.listResult':
      return (
        typeof value.workspaceId === 'string' &&
        isSafeWorkspacePath(value.path, true) &&
        Array.isArray(value.entries) &&
        value.entries.length <= 1_000 &&
        value.entries.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.name === 'string' &&
            utf8ByteLength(entry.name) <= 1_024 &&
            isSafeWorkspacePath(entry.path, false) &&
            ['file', 'directory', 'link', 'other'].includes(String(entry.kind)),
        )
      );
    case 'workspace.pathSearchResult':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.query === 'string' &&
        value.query.trim().length > 0 &&
        utf8ByteLength(value.query) <= 512 &&
        Array.isArray(value.paths) &&
        value.paths.length <= 64 &&
        value.paths.every((path) => isSafeWorkspacePath(path, false)) &&
        typeof value.truncated === 'boolean'
      );
    case 'workspace.inspected':
      return (
        typeof value.workspaceId === 'string' &&
        isRecord(value.document) &&
        isSafeWorkspacePath(value.document.path, false) &&
        ((value.document.status === 'complete' &&
          typeof value.document.content === 'string' &&
          Number.isSafeInteger(value.document.bytes) &&
          value.document.bytes ===
            utf8ByteLength(value.document.content) +
              (value.document.hasUtf8Bom === true ? 3 : 0) &&
          Number.isSafeInteger(value.document.lines) &&
          value.document.lines === workspaceDocumentLineCount(value.document.content) &&
          typeof value.document.hasUtf8Bom === 'boolean') ||
          (value.document.status === 'truncated' &&
            typeof value.document.content === 'string' &&
            Number.isSafeInteger(value.document.bytes) &&
            Number.isSafeInteger(value.document.returnedBytes) &&
            value.document.returnedBytes === utf8ByteLength(value.document.content) &&
            Number.isSafeInteger(value.document.lines) &&
            typeof value.document.hasUtf8Bom === 'boolean') ||
          (value.document.status === 'error' &&
            [
              'invalidPath',
              'notFound',
              'accessDenied',
              'pathNotAllowed',
              'notRegularFile',
              'oversized',
              'binary',
              'invalidEncoding',
              'longLine',
              'changed',
              'unavailable',
            ].includes(String(value.document.kind))))
      );
    case 'workspace.resolved':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.name === 'string' &&
        value.name.length > 0 &&
        utf8ByteLength(value.name) <= 255 &&
        !value.name.includes('/') &&
        !value.name.includes('\\') &&
        ['resolved', 'notFound', 'ambiguous', 'unavailable'].includes(
          String(value.status),
        ) &&
        (value.status === 'resolved'
          ? isSafeWorkspacePath(value.path, false)
          : value.path === undefined)
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
    case 'turn.textStarted':
      return (
        hasTurnCoordinates(value) &&
        typeof value.itemId === 'string' &&
        ['commentary', 'final', 'provisional'].includes(String(value.phase))
      );
    case 'turn.textDelta':
      return (
        hasTurnCoordinates(value) &&
        typeof value.itemId === 'string' &&
        ['commentary', 'final', 'provisional'].includes(String(value.phase)) &&
        typeof value.delta === 'string'
      );
    case 'turn.textCompleted':
      return (
        hasTurnCoordinates(value) &&
        typeof value.itemId === 'string' &&
        ['commentary', 'final'].includes(String(value.phase)) &&
        typeof value.text === 'string'
      );
    case 'turn.usage':
      return hasTurnCoordinates(value) && isRuntimeUsage(value.usage);
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
        typeof value.fullAccess === 'boolean' &&
        (value.recovered === undefined || value.recovered === true)
      );
    case 'approval.resolved':
      return (
        hasTurnCoordinates(value) &&
        typeof value.approvalId === 'string' &&
        typeof value.operationId === 'string' &&
        ['approved', 'denied'].includes(String(value.decision)) &&
        (value.source === undefined ||
          ['user', 'policy', 'system'].includes(String(value.source)))
      );
    case 'mcp.approvalRequested':
      return (
        hasTurnCoordinates(value) &&
        typeof value.approvalId === 'string' &&
        typeof value.operationId === 'string' &&
        typeof value.serverId === 'string' &&
        typeof value.name === 'string' &&
        value.name.startsWith(`mcp__${value.serverId}__`) &&
        typeof value.argumentsJson === 'string' &&
        Number.isSafeInteger(value.argumentsBytes) &&
        Number(value.argumentsBytes) >= 2 &&
        Number(value.argumentsBytes) <= 32 * 1024 &&
        utf8ByteLength(value.argumentsJson) === value.argumentsBytes &&
        typeof value.argumentsSha256 === 'string' &&
        /^[0-9a-f]{64}$/u.test(value.argumentsSha256) &&
        typeof value.inventorySha256 === 'string' &&
        /^[0-9a-f]{64}$/u.test(value.inventorySha256) &&
        (value.recovered === undefined || value.recovered === true)
      );
    case 'mcp.approvalResolved':
      return (
        hasTurnCoordinates(value) &&
        typeof value.approvalId === 'string' &&
        typeof value.operationId === 'string' &&
        ['approved', 'denied'].includes(String(value.decision)) &&
        (value.source === undefined ||
          ['user', 'policy', 'system'].includes(String(value.source)))
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
      return hasTurnCoordinates(value) && isRuntimeAgentTask(value.task);
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
        ['spawnFailed', 'protocolInvalid', 'terminalCrashed', 'outputOverload'].includes(String(value.error)) &&
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
    case 'mcp.configInspection':
      return isMcpConfigInspection(value.inspection);
    case 'mcp.configAction':
      return isMcpConfigActionResult(value.action);
    case 'mcp.sessionAction':
      return (
        isMcpSessionActionResult(value.action) &&
        Array.isArray(value.activeServerIds) &&
        value.activeServerIds.every((id) => typeof id === 'string')
      );
    case 'skills.inspection':
      return isSkillsInspection(value.inspection);
    case 'skills.content':
      return isSkillContent(value.content);
    case 'skills.action':
      return isSkillsActionResult(value.action);
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
        [
          'create',
          'rename',
          'generateTitle',
          'delete',
        ].includes(String(value.operation)) &&
        typeof value.threadId === 'string' &&
        (value.deleted === undefined ||
          (value.operation === 'delete' && typeof value.deleted === 'boolean')) &&
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
  (value.title === null || isThreadTitle(value.title)) &&
  Number.isInteger(value.createdAt) &&
  Number.isInteger(value.updatedAt) &&
  (value.archivedAt === null || Number.isInteger(value.archivedAt)) &&
  (value.parentThreadId === null || typeof value.parentThreadId === 'string');

const isThreadTitle = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  utf8ByteLength(value) <= 256 &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));

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
