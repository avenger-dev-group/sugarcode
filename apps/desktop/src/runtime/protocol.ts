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
import {
  isKnowledgeActionResult,
  isKnowledgeBaseDetail,
  isKnowledgeEditableDocument,
  isKnowledgeInspection,
  isKnowledgeSearchResult,
  type KnowledgeActionResult,
  type KnowledgeBaseDetail,
  type KnowledgeEditableDocument,
  type KnowledgeInspection,
  type KnowledgeSearchResult,
} from '../shared/knowledge.ts';
import {
  isCommandEnvironmentActionResult,
  isCommandEnvironmentStatus,
  isTaskWorkspaceActionResult,
  isTaskWorkspaceStatus,
  type CommandEnvironmentActionResult,
  type CommandEnvironmentStatus,
  type TaskWorkspaceActionResult,
  type TaskWorkspaceStatus,
} from '../shared/command-environment.ts';
import {
  MAX_CONVERSATION_ATTACHMENT_BASE64_LENGTH,
  MAX_CONVERSATION_ATTACHMENT_PREVIEW_URL_LENGTH,
} from '../shared/conversation/limits.ts';

export const RUNTIME_PROTOCOL_VERSION = 6 as const;

export const MAX_RUNTIME_USER_INPUT_QUESTIONS = 3;
export const MAX_RUNTIME_USER_INPUT_OPTIONS = 3;
export const MAX_RUNTIME_USER_INPUT_ANSWER_BYTES = 2 * 1024;
export const MAX_RUNTIME_PLAN_BYTES = 64 * 1024;

export type RuntimeUserInputOption = Readonly<{
  label: string;
  description: string;
}>;

export type RuntimeUserInputQuestion = Readonly<{
  id: string;
  header: string;
  question: string;
  options: readonly RuntimeUserInputOption[];
}>;

export type RuntimeUserInputDecision =
  | Readonly<{
      questionId: string;
      kind: 'answered';
      source: 'option' | 'custom';
      answer: string;
    }>
  | Readonly<{
      questionId: string;
      kind: 'skipped';
    }>;

export type RuntimeUserInputSubmission =
  | Readonly<{
      kind: 'submitted';
      decisions: readonly RuntimeUserInputDecision[];
    }>
  | Readonly<{
      kind: 'cancelled';
      decisions: readonly RuntimeUserInputDecision[];
    }>;

export type RuntimeProviderConfig = Readonly<{
  wireApi: ModelWireApi;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  parallelTools: boolean;
  compactThresholdTokens?: number;
  nativeCompaction?: boolean;
  mediaTransport?: 'auto' | 'inline' | 'dashscopeTemporaryUrl';
}>;

export type RuntimeApprovalDecisionSource = 'user' | 'policy' | 'system';

export type RuntimeAssetDescriptor = Readonly<{
  assetId: string;
  sha256: string;
  mediaType: string;
  originalName: string;
  sizeBytes: number;
  kind: 'image' | 'video' | 'pdf' | 'text';
  pdfPages?: number;
}>;

export type RuntimeContentPart =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{
      type: 'knowledgeReferences';
      references: readonly Readonly<{
        knowledgeBaseId: string;
        name: string;
      }>[];
    }>
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
  queue: RuntimeThreadQueue;
}>;

export type RuntimeQueuedMessage = Readonly<{
  id: string;
  threadId: string;
  position: number;
  revision: number;
  content: readonly RuntimeContentPart[];
  modelProfileId?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type RuntimeThreadQueue = Readonly<{
  paused: boolean;
  messages: readonly RuntimeQueuedMessage[];
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
  autoCompaction?: 'auto' | 'enabled' | 'disabled';
  compactThresholdTokens?: number;
  nativeCompaction?: 'auto' | 'enabled' | 'disabled';
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
      ffmpegPath?: string;
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
      type: 'environment.inspect';
      requestId: string;
      workspaceId: string;
      threadId?: string;
    }>
  | Readonly<{
      type: 'environment.refresh';
      requestId: string;
      workspaceId: string;
      threadId: string;
    }>
  | Readonly<{
      type: 'environment.profileLoadingSet';
      requestId: string;
      enabled: boolean;
    }>
  | Readonly<{
      type: 'taskWorkspace.inspect';
      requestId: string;
      workspaceId: string;
      threadId: string;
    }>
  | Readonly<{
      type: 'taskWorkspace.set';
      requestId: string;
      workspaceId: string;
      threadId: string;
      mode: 'local' | 'worktree';
    }>
  | Readonly<{
      type: 'asset.import';
      requestId: string;
      fileName: string;
      mediaType?: string;
    } & (
      | Readonly<{ data: string; localPath?: never }>
      | Readonly<{ localPath: string; data?: never }>
    )>
  | Readonly<{
      type: 'asset.preview';
      requestId: string;
      assetId: string;
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
      type: 'queue.messageCreate';
      requestId: string;
      workspaceId: string;
      threadId: string;
      queueItemId: string;
      content: readonly RuntimeContentPart[];
      modelProfileId?: string;
    }>
  | Readonly<{
      type: 'queue.messageUpdate';
      requestId: string;
      workspaceId: string;
      threadId: string;
      queueItemId: string;
      expectedRevision: number;
      content: readonly RuntimeContentPart[];
      modelProfileId?: string;
    }>
  | Readonly<{
      type: 'queue.messageDelete';
      requestId: string;
      workspaceId: string;
      threadId: string;
      queueItemId: string;
      expectedRevision: number;
    }>
  | Readonly<{
      type: 'queue.pause' | 'queue.resume';
      requestId: string;
      workspaceId: string;
      threadId: string;
    }>
  | Readonly<{
      type: 'turn.startQueued';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
      queueItemId: string;
      expectedRevision: number;
      modelProfileId?: string;
      content: readonly RuntimeContentPart[];
    }>
  | Readonly<{
      type: 'turn.steerQueued';
      requestId: string;
      workspaceId: string;
      threadId: string;
      expectedTurnId: string;
      queueItemId: string;
      expectedRevision: number;
    }>
  | Readonly<{
      type: 'turn.revise';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
      replacedTurnId: string;
      provider?: RuntimeProviderConfig;
      modelProfileId?: string;
      generateTitle?: false;
      content: readonly RuntimeContentPart[];
    }>
  | Readonly<{
      type: 'turn.cancel';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
      source: 'stopButton';
    }>
  | Readonly<{
      type: 'context.compact';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
      modelProfileId?: string;
      focus?: string;
    }>
  | Readonly<{
      type: 'turn.userInputResponse';
      requestId: string;
      workspaceId: string;
      threadId: string;
      turnId: string;
      inputRequestId: string;
      submission: RuntimeUserInputSubmission;
    }>
  | Readonly<{
      type: 'terminal.create';
      requestId: string;
      workspaceId: string;
      threadId?: string;
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
      threadId?: string;
    }>
  | Readonly<{
      type: 'git.diff';
      requestId: string;
      workspaceId: string;
      threadId?: string;
      expectedRevision: string;
      path: string;
      source: 'worktree' | 'index';
    }>
  | Readonly<{
      type: 'git.stage' | 'git.unstage';
      requestId: string;
      workspaceId: string;
      threadId?: string;
      expectedRevision: string;
      paths: readonly string[];
    }>
  | Readonly<{
      type: 'git.commit';
      requestId: string;
      workspaceId: string;
      threadId?: string;
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
    }>
  | Readonly<{
      type: 'skills.export';
      requestId: string;
      workspaceId?: string;
      skillId: string;
      destinationPath: string;
    }>
  | Readonly<{
      type: 'skills.importZip';
      requestId: string;
      workspaceId?: string;
      archivePath: string;
    }>
  | Readonly<{
      type: 'skills.exportZip';
      requestId: string;
      workspaceId?: string;
      skillId: string;
      destinationPath: string;
    }>
  | Readonly<{
      type: 'knowledge.inspect';
      requestId: string;
      workspaceId?: string;
    }>
  | Readonly<{
      type: 'knowledge.create';
      requestId: string;
      name: string;
      description: string;
      workspaceIds: readonly string[];
    }>
  | Readonly<{
      type: 'knowledge.update';
      requestId: string;
      knowledgeBaseId: string;
      name: string;
      description: string;
      workspaceIds: readonly string[];
      ignoreRules: readonly string[];
      semanticEnabled?: boolean;
    }>
  | Readonly<{
      type: 'knowledge.delete';
      requestId: string;
      knowledgeBaseId: string;
    }>
  | Readonly<{
      type: 'knowledge.addFiles';
      requestId: string;
      knowledgeBaseId: string;
      paths: readonly string[];
    }>
  | Readonly<{
      type: 'knowledge.addFolder';
      requestId: string;
      knowledgeBaseId: string;
      path: string;
    }>
  | Readonly<{
      type: 'knowledge.text.create';
      requestId: string;
      knowledgeBaseId: string;
      fileName: string;
      content: string;
    }>
  | Readonly<{
      type: 'knowledge.text.read';
      requestId: string;
      sourceId: string;
    }>
  | Readonly<{
      type: 'knowledge.text.update';
      requestId: string;
      sourceId: string;
      expectedSha256: string;
      content: string;
    }>
  | Readonly<{
      type: 'knowledge.source.delete';
      requestId: string;
      sourceId: string;
    }>
  | Readonly<{
      type: 'knowledge.source.rescan';
      requestId: string;
      sourceId: string;
      rebuild?: boolean;
    }>
  | Readonly<{
      type: 'knowledge.index.cancel';
      requestId: string;
      jobId: string;
    }>
  | Readonly<{
      type: 'knowledge.detail';
      requestId: string;
      knowledgeBaseId: string;
    }>
  | Readonly<{
      type: 'knowledge.search';
      requestId: string;
      workspaceId?: string;
      knowledgeBaseIds: readonly string[];
      query: string;
    }>
  | Readonly<{
      type: 'knowledge.model.install';
      requestId: string;
    }>
  | Readonly<{
      type: 'knowledge.model.cancel';
      requestId: string;
    }>
  | Readonly<{
      type: 'knowledge.model.remove';
      requestId: string;
    }>
  | Readonly<{
      type: 'knowledge.retrieval.select';
      requestId: string;
      planId: string;
    }>
  | Readonly<{
      type: 'knowledge.semanticIndex.pause';
      requestId: string;
      paused: boolean;
    }>
  | Readonly<{ type: 'shutdown'; requestId: string }>;

export type RuntimeUsage = Readonly<{
  inputTokens: number;
  contextInputTokens?: number;
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
    'contextInputTokens',
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
    (!Object.hasOwn(value, 'contextInputTokens') ||
      isTokenCount(value.contextInputTokens)) &&
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
    | 'contextWindowExceeded'
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
        type: 'asset.preview';
        preview:
          | Readonly<{
              available: true;
              asset: RuntimeAssetDescriptor;
              data: string;
            }>
          | Readonly<{
              available: false;
              reason: 'unsupported' | 'tooLarge';
            }>;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'environment.inspection';
        status: CommandEnvironmentStatus;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'environment.action';
        action: CommandEnvironmentActionResult;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'taskWorkspace.inspection';
        workspace: TaskWorkspaceStatus;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'taskWorkspace.action';
        action: TaskWorkspaceActionResult;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.revised';
        workspaceId: string;
        threadId: string;
        turnId: string;
        replacedTurnId: string;
        model: RuntimeModelSelection;
        content: readonly RuntimeContentPart[];
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
        type: 'turn.planProposed';
        workspaceId: string;
        threadId: string;
        turnId: string;
        planId: string;
        content: string;
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
        type: 'turn.contextCompactionStarted';
        workspaceId: string;
        threadId: string;
        turnId: string;
        compactionId: string;
        trigger: 'auto' | 'manual' | 'recovery';
        strategy: 'applicationSummary' | 'openaiNative' | 'anthropicNative';
        beforeContextTokens?: number;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.contextCompactionFinished';
        workspaceId: string;
        threadId: string;
        turnId: string;
        compactionId: string;
        trigger: 'auto' | 'manual' | 'recovery';
        strategy: 'applicationSummary' | 'openaiNative' | 'anthropicNative';
        outcome: 'completed' | 'failed' | 'interrupted';
        beforeContextTokens?: number;
        afterContextTokens?: number;
        durationMs: number;
        readableSummary?: string;
        opaqueCheckpoint?: boolean;
        message?: string;
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
        type: 'turn.userInputRequested';
        workspaceId: string;
        threadId: string;
        turnId: string;
        inputRequestId: string;
        questions: readonly RuntimeUserInputQuestion[];
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.userInputResolved';
        workspaceId: string;
        threadId: string;
        turnId: string;
        inputRequestId: string;
        submission: RuntimeUserInputSubmission;
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
        projectEnvironmentTrust?: true;
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
        error:
          | 'spawnFailed'
          | 'protocolInvalid'
          | 'terminalCrashed'
          | 'outputOverload';
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
        reason:
          'natural' | 'requested' | 'ownerLost' | 'protocolError' | 'ioError';
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
        type: 'knowledge.inspection';
        inspection: KnowledgeInspection;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'knowledge.action';
        action: KnowledgeActionResult;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'knowledge.detail';
        detail: KnowledgeBaseDetail;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'knowledge.textDocument';
        document: KnowledgeEditableDocument;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'knowledge.searchResult';
        result: KnowledgeSearchResult;
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
        type: 'queue.changed';
        workspaceId: string;
        threadId: string;
        queue: RuntimeThreadQueue;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'turn.steered';
        workspaceId: string;
        threadId: string;
        turnId: string;
        itemId: string;
        content: readonly RuntimeContentPart[];
        queue: RuntimeThreadQueue;
      }>)
  | (RuntimeEventBase &
      Readonly<{
        type: 'thread.mutated';
        workspaceId: string;
        operation: 'create' | 'rename' | 'generateTitle' | 'delete';
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

const hasBoundedRuntimeText = (
  value: unknown,
  maxBytes: number,
): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  utf8ByteLength(value) <= maxBytes &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));

const hasBoundedRuntimeMarkdown = (
  value: unknown,
  maxBytes: number,
): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  utf8ByteLength(value) <= maxBytes &&
  !Array.from(value).some(
    (character) =>
      /\p{Cc}/u.test(character) && !['\n', '\r', '\t'].includes(character),
  );

const isRuntimeUserInputQuestion = (
  value: unknown,
): value is RuntimeUserInputQuestion =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  /^[a-z][a-z0-9_]{0,63}$/u.test(value.id) &&
  hasBoundedRuntimeText(value.header, 48) &&
  Array.from(value.header as string).length <= 12 &&
  hasBoundedRuntimeText(value.question, 512) &&
  Array.isArray(value.options) &&
  value.options.length >= 2 &&
  value.options.length <= MAX_RUNTIME_USER_INPUT_OPTIONS &&
  value.options.every(
    (option) =>
      isRecord(option) &&
      hasBoundedRuntimeText(option.label, 96) &&
      hasBoundedRuntimeText(option.description, 384),
  ) &&
  new Set(
    value.options.map((option) =>
      isRecord(option) ? option.label : undefined,
    ),
  ).size === value.options.length;

const isRuntimeUserInputDecision = (
  value: unknown,
): value is RuntimeUserInputDecision =>
  isRecord(value) &&
  typeof value.questionId === 'string' &&
  /^[a-z][a-z0-9_]{0,63}$/u.test(value.questionId) &&
  (value.kind === 'skipped'
    ? Object.keys(value).every((key) => ['questionId', 'kind'].includes(key))
    : value.kind === 'answered' &&
      (value.source === 'option' || value.source === 'custom') &&
      hasBoundedRuntimeText(
        value.answer,
        MAX_RUNTIME_USER_INPUT_ANSWER_BYTES,
      ) &&
      Object.keys(value).every((key) =>
        ['questionId', 'kind', 'source', 'answer'].includes(key),
      ));

const isRuntimeUserInputSubmission = (
  value: unknown,
): value is RuntimeUserInputSubmission =>
  isRecord(value) &&
  (value.kind === 'submitted' || value.kind === 'cancelled') &&
  Object.keys(value).every((key) => ['kind', 'decisions'].includes(key)) &&
  Array.isArray(value.decisions) &&
  value.decisions.length <= MAX_RUNTIME_USER_INPUT_QUESTIONS &&
  (value.kind === 'cancelled' || value.decisions.length >= 1) &&
  value.decisions.every(isRuntimeUserInputDecision) &&
  new Set(value.decisions.map((decision) => decision.questionId)).size ===
    value.decisions.length;

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
    (content.match(/\n/gu)?.length ?? 0) + (content.endsWith('\n') ? 0 : 1),
  );

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value);

const isStringRecord = (
  value: unknown,
): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === 'string');

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
  typeof value.parallelTools === 'boolean' &&
  (value.compactThresholdTokens === undefined ||
    (Number.isInteger(value.compactThresholdTokens) &&
      Number(value.compactThresholdTokens) >= 4_096)) &&
  (value.nativeCompaction === undefined ||
    typeof value.nativeCompaction === 'boolean');

export const isRuntimeContentPart = (
  value: unknown,
): value is RuntimeContentPart => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'text') {
    return typeof value.text === 'string';
  }
  if (value.type === 'knowledgeReferences') {
    return (
      Array.isArray(value.references) &&
      value.references.length > 0 &&
      value.references.length <= 4 &&
      value.references.every(
        (reference) =>
          isRecord(reference) &&
          typeof reference.knowledgeBaseId === 'string' &&
          /^kb_[0-9a-f]{32}$/u.test(reference.knowledgeBaseId) &&
          typeof reference.name === 'string' &&
          reference.name.length > 0 &&
          reference.name.length <= 80,
      )
    );
  }
  return value.type === 'asset' && isAssetDescriptor(value.asset);
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
  ['image', 'video', 'pdf', 'text'].includes(String(value.kind)) &&
  (value.pdfPages === undefined ||
    (Number.isSafeInteger(value.pdfPages) && Number(value.pdfPages) > 0));

const hasRequestId = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & { requestId: string } =>
  typeof value.requestId === 'string' && value.requestId.length > 0;

export const isRuntimeCommand = (value: unknown): value is RuntimeCommand => {
  if (
    !isRecord(value) ||
    !hasRequestId(value) ||
    typeof value.type !== 'string'
  ) {
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
            value.nativeModulePath.length > 0)) &&
        (value.ffmpegPath === undefined ||
          (typeof value.ffmpegPath === 'string' &&
            value.ffmpegPath.length > 0 &&
            value.ffmpegPath.length <= 32_768))
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
    case 'environment.inspect':
      return (
        typeof value.workspaceId === 'string' &&
        (value.threadId === undefined || typeof value.threadId === 'string')
      );
    case 'environment.refresh':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string'
      );
    case 'environment.profileLoadingSet':
      return typeof value.enabled === 'boolean';
    case 'taskWorkspace.inspect':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string'
      );
    case 'taskWorkspace.set':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        (value.mode === 'local' || value.mode === 'worktree')
      );
    case 'asset.import':
      return (
        typeof value.fileName === 'string' &&
        value.fileName.length > 0 &&
        value.fileName.length <= 255 &&
        (value.mediaType === undefined ||
          typeof value.mediaType === 'string') &&
        ((typeof value.data === 'string' &&
          value.data.length > 0 &&
          value.data.length <= MAX_CONVERSATION_ATTACHMENT_BASE64_LENGTH &&
          value.localPath === undefined) ||
          (typeof value.localPath === 'string' &&
            value.localPath.length > 0 &&
            value.localPath.length <= 32_768 &&
            value.data === undefined))
      );
    case 'asset.preview':
      return (
        typeof value.assetId === 'string' &&
        /^ast_[0-9a-f]{64}$/u.test(value.assetId)
      );
    case 'turn.start':
    case 'turn.revise':
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
        (value.type !== 'turn.revise' ||
          (typeof value.replacedTurnId === 'string' &&
            value.replacedTurnId.length > 0 &&
            value.generateTitle !== true)) &&
        Array.isArray(value.content) &&
        value.content.length > 0 &&
        value.content.every(isRuntimeContentPart)
      );
    case 'queue.messageCreate':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.queueItemId === 'string' &&
        (value.modelProfileId === undefined ||
          (typeof value.modelProfileId === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId))) &&
        Array.isArray(value.content) &&
        value.content.length > 0 &&
        value.content.every(isRuntimeContentPart)
      );
    case 'queue.messageUpdate':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.queueItemId === 'string' &&
        Number.isSafeInteger(value.expectedRevision) &&
        Number(value.expectedRevision) >= 1 &&
        (value.modelProfileId === undefined ||
          (typeof value.modelProfileId === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId))) &&
        Array.isArray(value.content) &&
        value.content.length > 0 &&
        value.content.every(isRuntimeContentPart)
      );
    case 'queue.messageDelete':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.queueItemId === 'string' &&
        Number.isSafeInteger(value.expectedRevision) &&
        Number(value.expectedRevision) >= 1
      );
    case 'queue.pause':
    case 'queue.resume':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string'
      );
    case 'turn.startQueued':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        typeof value.queueItemId === 'string' &&
        Number.isSafeInteger(value.expectedRevision) &&
        Number(value.expectedRevision) >= 1 &&
        (value.modelProfileId === undefined ||
          (typeof value.modelProfileId === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId))) &&
        Array.isArray(value.content) &&
        value.content.length > 0 &&
        value.content.every(isRuntimeContentPart)
      );
    case 'turn.steerQueued':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.expectedTurnId === 'string' &&
        typeof value.queueItemId === 'string' &&
        Number.isSafeInteger(value.expectedRevision) &&
        Number(value.expectedRevision) >= 1
      );
    case 'turn.cancel':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        value.source === 'stopButton'
      );
    case 'context.compact':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        (value.modelProfileId === undefined ||
          (typeof value.modelProfileId === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId))) &&
        (value.focus === undefined ||
          (typeof value.focus === 'string' &&
            utf8ByteLength(value.focus) <= 4_096))
      );
    case 'turn.userInputResponse':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        typeof value.inputRequestId === 'string' &&
        value.inputRequestId.length > 0 &&
        isRuntimeUserInputSubmission(value.submission)
      );
    case 'terminal.create':
    case 'terminal.resize':
      return (
        typeof value.workspaceId === 'string' &&
        (value.threadId === undefined || typeof value.threadId === 'string') &&
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
          (id) =>
            typeof id === 'string' &&
            /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id),
        ) &&
        new Set(value.serverIds).size === value.serverIds.length
      );
    case 'skills.inspect':
      return (
        value.workspaceId === undefined || typeof value.workspaceId === 'string'
      );
    case 'skills.content':
      return (
        (value.workspaceId === undefined ||
          typeof value.workspaceId === 'string') &&
        isSkillId(value.skillId) &&
        typeof value.expectedSha256 === 'string' &&
        /^[0-9a-f]{64}$/u.test(value.expectedSha256)
      );
    case 'skills.setEnabled':
      return (
        (value.workspaceId === undefined ||
          typeof value.workspaceId === 'string') &&
        isSkillId(value.skillId) &&
        typeof value.enabled === 'boolean'
      );
    case 'skills.import':
      return (
        (value.workspaceId === undefined ||
          typeof value.workspaceId === 'string') &&
        typeof value.sourcePath === 'string' &&
        value.sourcePath.length > 0 &&
        value.sourcePath.length <= 4_096
      );
    case 'skills.export':
      return (
        (value.workspaceId === undefined ||
          typeof value.workspaceId === 'string') &&
        isSkillId(value.skillId) &&
        typeof value.destinationPath === 'string' &&
        value.destinationPath.length > 0 &&
        value.destinationPath.length <= 4_096
      );
    case 'skills.importZip':
      return (
        (value.workspaceId === undefined ||
          typeof value.workspaceId === 'string') &&
        typeof value.archivePath === 'string' &&
        value.archivePath.length > 0 &&
        value.archivePath.length <= 4_096
      );
    case 'skills.exportZip':
      return (
        (value.workspaceId === undefined ||
          typeof value.workspaceId === 'string') &&
        isSkillId(value.skillId) &&
        typeof value.destinationPath === 'string' &&
        value.destinationPath.length > 0 &&
        value.destinationPath.length <= 4_096
      );
    case 'knowledge.inspect':
      return (
        value.workspaceId === undefined || typeof value.workspaceId === 'string'
      );
    case 'knowledge.model.install':
    case 'knowledge.model.cancel':
    case 'knowledge.model.remove':
      return true;
    case 'knowledge.retrieval.select':
      return (
        typeof value.planId === 'string' &&
        value.planId.length > 0 &&
        value.planId.length <= 128
      );
    case 'knowledge.semanticIndex.pause':
      return typeof value.paused === 'boolean';
    case 'knowledge.create':
      return (
        typeof value.name === 'string' &&
        value.name.trim().length > 0 &&
        value.name.length <= 256 &&
        typeof value.description === 'string' &&
        value.description.length <= 4_096 &&
        Array.isArray(value.workspaceIds) &&
        value.workspaceIds.length <= 64 &&
        value.workspaceIds.every((id) => typeof id === 'string')
      );
    case 'knowledge.update':
      return (
        typeof value.knowledgeBaseId === 'string' &&
        /^kb_[0-9a-f]{32}$/u.test(value.knowledgeBaseId) &&
        typeof value.name === 'string' &&
        value.name.trim().length > 0 &&
        value.name.length <= 256 &&
        typeof value.description === 'string' &&
        value.description.length <= 4_096 &&
        Array.isArray(value.workspaceIds) &&
        value.workspaceIds.length <= 64 &&
        value.workspaceIds.every((id) => typeof id === 'string') &&
        Array.isArray(value.ignoreRules) &&
        value.ignoreRules.length <= 256 &&
        value.ignoreRules.every(
          (rule) =>
            typeof rule === 'string' && rule.length > 0 && rule.length <= 1_024,
        ) &&
        (value.semanticEnabled === undefined ||
          typeof value.semanticEnabled === 'boolean')
      );
    case 'knowledge.delete':
    case 'knowledge.detail':
      return (
        typeof value.knowledgeBaseId === 'string' &&
        /^kb_[0-9a-f]{32}$/u.test(value.knowledgeBaseId)
      );
    case 'knowledge.addFiles':
      return (
        typeof value.knowledgeBaseId === 'string' &&
        /^kb_[0-9a-f]{32}$/u.test(value.knowledgeBaseId) &&
        Array.isArray(value.paths) &&
        value.paths.length > 0 &&
        value.paths.length <= 256 &&
        value.paths.every(
          (path) =>
            typeof path === 'string' &&
            path.length > 0 &&
            path.length <= 16_384,
        )
      );
    case 'knowledge.addFolder':
      return (
        typeof value.knowledgeBaseId === 'string' &&
        /^kb_[0-9a-f]{32}$/u.test(value.knowledgeBaseId) &&
        typeof value.path === 'string' &&
        value.path.length > 0 &&
        value.path.length <= 16_384
      );
    case 'knowledge.text.create':
      return (
        typeof value.knowledgeBaseId === 'string' &&
        /^kb_[0-9a-f]{32}$/u.test(value.knowledgeBaseId) &&
        typeof value.fileName === 'string' &&
        value.fileName.length > 0 &&
        value.fileName.length <= 255 &&
        !value.fileName.includes('/') &&
        !value.fileName.includes('\\') &&
        ![...value.fileName].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }) &&
        /\.(?:txt|md)$/iu.test(value.fileName) &&
        typeof value.content === 'string' &&
        value.content.trim().length > 0 &&
        utf8ByteLength(value.content) <= 2 * 1_024 * 1_024
      );
    case 'knowledge.text.read':
      return (
        typeof value.sourceId === 'string' &&
        /^ks_[0-9a-f]{32}$/u.test(value.sourceId)
      );
    case 'knowledge.text.update':
      return (
        typeof value.sourceId === 'string' &&
        /^ks_[0-9a-f]{32}$/u.test(value.sourceId) &&
        typeof value.expectedSha256 === 'string' &&
        /^[0-9a-f]{64}$/u.test(value.expectedSha256) &&
        typeof value.content === 'string' &&
        value.content.trim().length > 0 &&
        utf8ByteLength(value.content) <= 2 * 1_024 * 1_024
      );
    case 'knowledge.source.delete':
    case 'knowledge.source.rescan':
      return (
        typeof value.sourceId === 'string' &&
        /^ks_[0-9a-f]{32}$/u.test(value.sourceId) &&
        (value.rebuild === undefined || typeof value.rebuild === 'boolean')
      );
    case 'knowledge.index.cancel':
      return (
        typeof value.jobId === 'string' &&
        /^kj_[0-9a-f]{32}$/u.test(value.jobId)
      );
    case 'knowledge.search':
      return (
        (value.workspaceId === undefined ||
          typeof value.workspaceId === 'string') &&
        Array.isArray(value.knowledgeBaseIds) &&
        value.knowledgeBaseIds.length > 0 &&
        value.knowledgeBaseIds.length <= 4 &&
        value.knowledgeBaseIds.every(
          (id) => typeof id === 'string' && /^kb_[0-9a-f]{32}$/u.test(id),
        ) &&
        typeof value.query === 'string' &&
        value.query.trim().length > 0 &&
        value.query.length <= 4_000
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
  if (
    !isRecord(value) ||
    !hasEventBase(value) ||
    typeof value.type !== 'string'
  ) {
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
          value.document.lines ===
            workspaceDocumentLineCount(value.document.content) &&
          typeof value.document.hasUtf8Bom === 'boolean') ||
          (value.document.status === 'truncated' &&
            typeof value.document.content === 'string' &&
            Number.isSafeInteger(value.document.bytes) &&
            Number.isSafeInteger(value.document.returnedBytes) &&
            value.document.returnedBytes ===
              utf8ByteLength(value.document.content) &&
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
    case 'asset.preview':
      return (
        isRecord(value.preview) &&
        typeof value.preview.available === 'boolean' &&
        (value.preview.available
          ? isAssetDescriptor(value.preview.asset) &&
            value.preview.asset.kind === 'image' &&
            typeof value.preview.data === 'string' &&
            value.preview.data.length > 0 &&
            value.preview.data.length + 128 <=
              MAX_CONVERSATION_ATTACHMENT_PREVIEW_URL_LENGTH
          : ['unsupported', 'tooLarge'].includes(String(value.preview.reason)))
      );
    case 'turn.revised':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        typeof value.turnId === 'string' &&
        typeof value.replacedTurnId === 'string' &&
        isRecord(value.model) &&
        Array.isArray(value.content) &&
        value.content.length > 0 &&
        value.content.every(isRuntimeContentPart)
      );
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
    case 'turn.planProposed':
      return (
        hasTurnCoordinates(value) &&
        typeof value.planId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/u.test(value.planId) &&
        hasBoundedRuntimeMarkdown(value.content, MAX_RUNTIME_PLAN_BYTES)
      );
    case 'turn.usage':
      return hasTurnCoordinates(value) && isRuntimeUsage(value.usage);
    case 'turn.contextCompactionStarted':
      return (
        hasTurnCoordinates(value) &&
        typeof value.compactionId === 'string' &&
        ['auto', 'manual', 'recovery'].includes(String(value.trigger)) &&
        ['applicationSummary', 'openaiNative', 'anthropicNative'].includes(
          String(value.strategy),
        ) &&
        (value.beforeContextTokens === undefined ||
          (Number.isSafeInteger(value.beforeContextTokens) &&
            Number(value.beforeContextTokens) >= 0))
      );
    case 'turn.contextCompactionFinished':
      return (
        hasTurnCoordinates(value) &&
        typeof value.compactionId === 'string' &&
        ['auto', 'manual', 'recovery'].includes(String(value.trigger)) &&
        ['applicationSummary', 'openaiNative', 'anthropicNative'].includes(
          String(value.strategy),
        ) &&
        ['completed', 'failed', 'interrupted'].includes(
          String(value.outcome),
        ) &&
        Number.isSafeInteger(value.durationMs) &&
        Number(value.durationMs) >= 0 &&
        (value.beforeContextTokens === undefined ||
          (Number.isSafeInteger(value.beforeContextTokens) &&
            Number(value.beforeContextTokens) >= 0)) &&
        (value.afterContextTokens === undefined ||
          (Number.isSafeInteger(value.afterContextTokens) &&
            Number(value.afterContextTokens) >= 0)) &&
        (value.readableSummary === undefined ||
          typeof value.readableSummary === 'string') &&
        (value.opaqueCheckpoint === undefined ||
          typeof value.opaqueCheckpoint === 'boolean') &&
        (value.message === undefined || typeof value.message === 'string')
      );
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
    case 'turn.userInputRequested':
      return (
        hasTurnCoordinates(value) &&
        typeof value.inputRequestId === 'string' &&
        value.inputRequestId.length > 0 &&
        Array.isArray(value.questions) &&
        value.questions.length >= 1 &&
        value.questions.length <= MAX_RUNTIME_USER_INPUT_QUESTIONS &&
        value.questions.every(isRuntimeUserInputQuestion) &&
        new Set(value.questions.map((question) => question.id)).size ===
          value.questions.length
      );
    case 'turn.userInputResolved':
      return (
        hasTurnCoordinates(value) &&
        typeof value.inputRequestId === 'string' &&
        value.inputRequestId.length > 0 &&
        isRuntimeUserInputSubmission(value.submission)
      );
    case 'approval.requested':
      return (
        hasTurnCoordinates(value) &&
        typeof value.approvalId === 'string' &&
        typeof value.operationId === 'string' &&
        typeof value.toolName === 'string' &&
        typeof value.argumentsSummary === 'string' &&
        typeof value.fullAccess === 'boolean' &&
        (value.projectEnvironmentTrust === undefined ||
          value.projectEnvironmentTrust === true) &&
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
        [
          'spawnFailed',
          'protocolInvalid',
          'terminalCrashed',
          'outputOverload',
        ].includes(String(value.error)) &&
        typeof value.fatal === 'boolean'
      );
    case 'terminal.exited':
      return (
        typeof value.workspaceId === 'string' &&
        Number.isSafeInteger(value.generation) &&
        isSessionId(value.sessionId) &&
        Number.isSafeInteger(value.exitCode) &&
        (value.signal === undefined || typeof value.signal === 'string') &&
        [
          'natural',
          'requested',
          'ownerLost',
          'protocolError',
          'ioError',
        ].includes(String(value.reason))
      );
    case 'environment.inspection':
      return isCommandEnvironmentStatus(value.status);
    case 'environment.action':
      return isCommandEnvironmentActionResult(value.action);
    case 'taskWorkspace.inspection':
      return isTaskWorkspaceStatus(value.workspace);
    case 'taskWorkspace.action':
      return isTaskWorkspaceActionResult(value.action);
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
    case 'knowledge.inspection':
      return isKnowledgeInspection(value.inspection);
    case 'knowledge.action':
      return isKnowledgeActionResult(value.action);
    case 'knowledge.detail':
      return isKnowledgeBaseDetail(value.detail);
    case 'knowledge.textDocument':
      return isKnowledgeEditableDocument(value.document);
    case 'knowledge.searchResult':
      return isKnowledgeSearchResult(value.result);
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
    case 'queue.changed':
      return (
        typeof value.workspaceId === 'string' &&
        typeof value.threadId === 'string' &&
        isRuntimeThreadQueue(value.queue)
      );
    case 'turn.steered':
      return (
        hasTurnCoordinates(value) &&
        typeof value.itemId === 'string' &&
        Array.isArray(value.content) &&
        value.content.length > 0 &&
        value.content.every(isRuntimeContentPart) &&
        isRuntimeThreadQueue(value.queue)
      );
    case 'thread.mutated':
      return (
        typeof value.workspaceId === 'string' &&
        ['create', 'rename', 'generateTitle', 'delete'].includes(
          String(value.operation),
        ) &&
        typeof value.threadId === 'string' &&
        (value.deleted === undefined ||
          (value.operation === 'delete' &&
            typeof value.deleted === 'boolean')) &&
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
  isRuntimeThreadQueue(value.queue) &&
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

const isRuntimeThreadQueue = (value: unknown): value is RuntimeThreadQueue =>
  isRecord(value) &&
  typeof value.paused === 'boolean' &&
  Array.isArray(value.messages) &&
  value.messages.length <= 10 &&
  value.messages.every(
    (message) =>
      isRecord(message) &&
      typeof message.id === 'string' &&
      typeof message.threadId === 'string' &&
      Number.isSafeInteger(message.position) &&
      Number(message.position) >= 1 &&
      Number.isSafeInteger(message.revision) &&
      Number(message.revision) >= 1 &&
      Array.isArray(message.content) &&
      message.content.length > 0 &&
      message.content.every(isRuntimeContentPart) &&
      (message.modelProfileId === undefined ||
        (typeof message.modelProfileId === 'string' &&
          /^[A-Za-z0-9_-]{1,64}$/u.test(message.modelProfileId))) &&
      Number.isInteger(message.createdAt) &&
      Number.isInteger(message.updatedAt),
  );
