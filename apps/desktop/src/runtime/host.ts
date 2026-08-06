import {
  createEvent,
  InMemorySessionService,
  LlmAgent,
  Runner,
  type BaseLlm,
  type Event,
} from '@google/adk';
import type { Content, Part } from '@google/genai';
import { createHash, randomUUID } from 'node:crypto';

import { SUGARCODE_BASE_AGENT_PROMPT_V1 } from './agent-instructions.ts';
import { ProviderAdapterError } from './models/errors.ts';
import { AnthropicLlm } from './models/anthropic-llm.ts';
import { discoverModels } from './models/discovery.ts';
import { OpenAiLlm } from './models/openai-llm.ts';
import {
  loadNativeRuntime,
  type NativeRuntimeBinding,
} from './native.ts';
import {
  isRuntimeContentPart,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeAssetDescriptor,
  type RuntimeCommand,
  type RuntimeContentPart,
  type RuntimeEvent,
  type RuntimeEventInput,
  type RuntimeModelSelection,
  type RuntimeProviderConfig,
  type RuntimeProviderError,
  type RuntimeThreadRecord,
  type RuntimeThreadSnapshot,
  type RuntimeUsage,
} from './protocol.ts';
import { createWorkspaceTools } from './tools/workspace.ts';

const APPLICATION_NAME = 'sugarcode-desktop-v3';
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const MAX_TURN_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type RuntimeHostOptions = Readonly<{
  postEvent: (event: RuntimeEvent) => void;
  createModel?: (provider: RuntimeProviderConfig) => BaseLlm;
  loadNative?: typeof loadNativeRuntime;
}>;

type PendingApproval = Readonly<{
  workspaceId: string;
  threadId: string;
  turnId: string;
  operationId: string;
  resolve: (decision: 'approved' | 'denied') => void;
}>;

const defaultCreateModel = (provider: RuntimeProviderConfig): BaseLlm => {
  const common = {
    model: provider.model,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    headers: provider.headers,
    timeoutMs: provider.timeoutMs,
    parallelTools: provider.parallelTools,
  };
  return provider.wireApi === 'anthropicMessages'
    ? new AnthropicLlm(common)
    : new OpenAiLlm({ ...common, wireApi: provider.wireApi });
};

type ResolvedProfile = Readonly<{
  provider: RuntimeProviderConfig;
  selection: RuntimeModelSelection;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const capabilityEnabled = (value: unknown): boolean => value !== 'disabled';

const providerError = (error: unknown): RuntimeProviderError => {
  if (error instanceof ProviderAdapterError) {
    return error.details;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      kind: 'cancelled',
      retryable: false,
      message: 'The Turn was cancelled.',
    };
  }
  return {
    kind: 'unknown',
    retryable: false,
    message: error instanceof Error ? error.message : 'The Turn failed.',
  };
};

const usageFromEvent = (event: Event): RuntimeUsage | undefined => {
  const usage = event.usageMetadata;
  if (!usage) {
    return undefined;
  }
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  return {
    inputTokens,
    outputTokens,
    ...(usage.thoughtsTokenCount === undefined
      ? {}
      : { reasoningTokens: usage.thoughtsTokenCount }),
    ...(usage.cachedContentTokenCount === undefined
      ? {}
      : { cachedInputTokens: usage.cachedContentTokenCount }),
    totalTokens: usage.totalTokenCount ?? inputTokens + outputTokens,
  };
};

type StoredAssetContent = Readonly<{
  asset: RuntimeAssetDescriptor;
  data: string;
}>;

type StoredHistoryPart =
  | Readonly<{
      type: 'text';
      text: string;
      reasoning: boolean;
      metadata?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      type: 'media';
      mediaType: string;
      data: string;
      name?: string;
    }>
  | Readonly<{
      type: 'toolCall';
      id: string;
      name: string;
      arguments: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      type: 'toolResult';
      id: string;
      name: string;
      result: Readonly<Record<string, unknown>>;
    }>;

type StoredModelHistory = Readonly<{
  role: 'assistant' | 'user';
  parts: readonly StoredHistoryPart[];
}>;

export class RuntimeHost {
  private readonly postEvent: RuntimeHostOptions['postEvent'];
  private readonly createModel: NonNullable<RuntimeHostOptions['createModel']>;
  private readonly loadNative: NonNullable<RuntimeHostOptions['loadNative']>;
  private readonly sessions = new InMemorySessionService();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly activeOperations = new Map<string, Set<string>>();
  private sequence = 0;
  private initialized = false;
  private shuttingDown = false;
  private nativeRuntime: NativeRuntimeBinding | null = null;

  constructor(options: RuntimeHostOptions) {
    this.postEvent = options.postEvent;
    this.createModel = options.createModel ?? defaultCreateModel;
    this.loadNative = options.loadNative ?? loadNativeRuntime;
  }

  handle = (command: RuntimeCommand): void => {
    switch (command.type) {
      case 'initialize':
        if (command.nativeModulePath) {
          this.nativeRuntime = this.loadNative(
            command.nativeModulePath,
            command.dataDirectory,
          );
        }
        this.initialized = true;
        this.emit({
          type: 'runtime.ready',
          requestId: command.requestId,
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
        });
        break;
      case 'workspace.open':
        this.requireReady(command.requestId);
        this.nativeRuntime?.ensureWorkspace(
          command.workspaceId,
          command.canonicalRoot,
        );
        break;
      case 'asset.import':
        this.requireReady(command.requestId);
        this.emit({
          type: 'asset.imported',
          requestId: command.requestId,
          asset: this.parseNativeJson<RuntimeAssetDescriptor>(
            this.requireNative().importAssetJson(
              command.fileName,
              command.mediaType,
              command.data,
            ),
          ),
        });
        break;
      case 'turn.start':
        this.requireReady(command.requestId);
        void this.startTurn(command);
        break;
      case 'turn.cancel':
        this.activeTurns.get(command.turnId)?.abort();
        this.cancelTurnApprovals(command.turnId);
        this.cancelTurnOperations(command.turnId);
        break;
      case 'approval.resolve': {
        const pending = this.pendingApprovals.get(command.approvalId);
        if (
          !pending ||
          pending.workspaceId !== command.workspaceId ||
          pending.threadId !== command.threadId ||
          pending.turnId !== command.turnId
        ) {
          this.emit({
            type: 'runtime.log',
            requestId: command.requestId,
            level: 'warn',
            message: `Approval ${command.approvalId} has no matching pending runtime tool.`,
          });
          break;
        }
        this.requireNative().resolveApproval(command.approvalId, command.decision);
        this.pendingApprovals.delete(command.approvalId);
        this.emit({
          type: 'approval.resolved',
          requestId: command.requestId,
          workspaceId: pending.workspaceId,
          threadId: pending.threadId,
          turnId: pending.turnId,
          approvalId: command.approvalId,
          operationId: pending.operationId,
          decision: command.decision,
        });
        pending.resolve(command.decision);
        break;
      }
      case 'thread.list':
        this.requireReady(command.requestId);
        this.emit({
          type: 'thread.listResult',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          query: command.query ?? '',
          threads: this.parseNativeJson<RuntimeThreadRecord[]>(
            this.requireNative().listThreadsJson(
              command.workspaceId,
              command.query,
            ),
          ),
        });
        break;
      case 'thread.load':
        this.requireReady(command.requestId);
        this.emit({
          type: 'thread.loaded',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          snapshot: this.parseNativeJson<RuntimeThreadSnapshot>(
            this.requireNative().loadThreadJson(command.threadId),
          ),
        });
        break;
      case 'thread.create': {
        this.requireReady(command.requestId);
        const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
          this.requireNative().createThreadJson(
            command.workspaceId,
            command.title,
          ),
        );
        this.emit({
          type: 'thread.mutated',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'create',
          threadId: snapshot.thread.id,
          snapshot,
        });
        break;
      }
      case 'thread.fork': {
        this.requireReady(command.requestId);
        const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
          this.requireNative().forkThreadJson(
            command.threadId,
            command.workspaceId,
          ),
        );
        this.emit({
          type: 'thread.mutated',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'fork',
          threadId: snapshot.thread.id,
          snapshot,
        });
        break;
      }
      case 'thread.archive':
      case 'thread.unarchive': {
        this.requireReady(command.requestId);
        const operation = command.type === 'thread.archive' ? 'archive' : 'unarchive';
        const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
          this.requireNative().setThreadArchivedJson(
            command.threadId,
            command.workspaceId,
            operation === 'archive',
          ),
        );
        this.emit({
          type: 'thread.mutated',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation,
          threadId: command.threadId,
          snapshot,
        });
        break;
      }
      case 'thread.delete':
        this.requireReady(command.requestId);
        if (!this.requireNative().deleteThread(command.threadId, command.workspaceId)) {
          throw new Error(`Thread ${command.threadId} does not exist in this workspace.`);
        }
        this.emit({
          type: 'thread.mutated',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'delete',
          threadId: command.threadId,
        });
        break;
      case 'git.status':
        this.emit({
          type: 'git.result',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'status',
          result: this.parseNativeJson(
            this.requireNative().gitStatusJson(command.workspaceId),
          ),
        });
        break;
      case 'git.diff':
        this.emit({
          type: 'git.result',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'diff',
          result: this.parseNativeJson(
            this.requireNative().gitDiffJson(
              command.workspaceId,
              command.expectedRevision,
              command.path,
              command.source,
            ),
          ),
        });
        break;
      case 'git.stage':
      case 'git.unstage': {
        const operation = command.type === 'git.stage' ? 'stage' : 'unstage';
        this.emit({
          type: 'git.result',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation,
          result: this.parseNativeJson(
            this.requireNative().gitMutateJson(
              command.workspaceId,
              command.expectedRevision,
              command.paths,
              operation === 'stage',
            ),
          ),
        });
        break;
      }
      case 'git.commit':
        this.emit({
          type: 'git.result',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'commit',
          result: this.parseNativeJson(
            this.requireNative().gitCommitJson(
              command.workspaceId,
              command.expectedRevision,
              command.message,
              command.authorName,
              command.authorEmail,
            ),
          ),
        });
        break;
      case 'model.inspect':
        this.requireReady(command.requestId);
        this.emit({
          type: 'model.configInspection',
          requestId: command.requestId,
          inspection: this.parseNativeJson(
            this.requireNative().inspectModelConfigJson(),
          ),
        });
        break;
      case 'model.save':
        this.requireReady(command.requestId);
        this.emit({
          type: 'model.configAction',
          requestId: command.requestId,
          action: this.parseNativeJson(
            this.requireNative().saveModelConfigJson(
              command.request.expectedRevision,
              JSON.stringify(command.request.config),
              JSON.stringify(command.request.credentialUpdates),
            ),
          ),
        });
        break;
      case 'model.deleteApiKey':
        this.requireReady(command.requestId);
        this.emit({
          type: 'model.configAction',
          requestId: command.requestId,
          action: this.parseNativeJson(
            this.requireNative().deleteModelApiKeyJson(
              command.connectionId,
              command.expectedRevision,
            ),
          ),
        });
        break;
      case 'model.discover':
        this.requireReady(command.requestId);
        void this.discover(command.requestId, command.connectionId);
        break;
      case 'shutdown':
        this.shuttingDown = true;
        for (const controller of this.activeTurns.values()) {
          controller.abort();
        }
        for (const turnId of this.activeTurns.keys()) {
          this.cancelTurnApprovals(turnId);
          this.cancelTurnOperations(turnId);
        }
        this.activeTurns.clear();
        break;
    }
  };

  private requireReady = (requestId: string): void => {
    if (!this.initialized || this.shuttingDown) {
      throw new Error(`Runtime is not ready for request ${requestId}.`);
    }
  };

  private requireNative = (): NativeRuntimeBinding => {
    if (!this.nativeRuntime) {
      throw new Error('The SugarCode native runtime is unavailable.');
    }
    return this.nativeRuntime;
  };

  private parseNativeJson = <T>(value: string): T => JSON.parse(value) as T;

  private ensureSession = async (
    command: Extract<RuntimeCommand, { type: 'turn.start' }>,
    selection: RuntimeModelSelection,
  ): Promise<void> => {
    const key = {
      appName: APPLICATION_NAME,
      userId: command.workspaceId,
      sessionId: command.threadId,
    };
    if (await this.sessions.getSession(key)) {
      return;
    }
    const session = await this.sessions.createSession(key);
    try {
      if (!this.nativeRuntime) {
        return;
      }
      const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
        this.nativeRuntime.loadThreadJson(command.threadId),
      );
      for (const turn of snapshot.turns) {
        if (turn.status !== 'completed') {
          continue;
        }
        const items = snapshot.items
          .filter((item) => item.turnId === turn.id)
          .sort((left, right) => left.sequence - right.sequence);
        const user = items.find((item) => item.kind === 'turn.userMessage');
        const content = user?.payload.content;
        if (Array.isArray(content)) {
          if (!content.every(isRuntimeContentPart)) {
            throw new Error('Stored user content is invalid.');
          }
          await this.sessions.appendEvent({
            session,
            event: createEvent({
              id: `${turn.id}:restored-user`,
              invocationId: `restore:${turn.id}`,
              author: 'user',
              content: this.contentFromParts(content, selection),
            }),
          });
        }
        for (const item of items.filter(
          (candidate) => candidate.kind === 'turn.modelHistory',
        )) {
          const restored = this.parseStoredModelHistory(item.payload.history);
          await this.sessions.appendEvent({
            session,
            event: createEvent({
              id: item.id,
              invocationId: `restore:${turn.id}`,
              author: 'sugarcode_agent',
              content: this.contentFromHistory(restored),
            }),
          });
        }
      }
    } catch (error) {
      await this.sessions.deleteSession(key);
      throw error;
    }
  };

  private contentFromParts = (
    content: readonly RuntimeContentPart[],
    selection: RuntimeModelSelection,
  ): Content => {
    const attachmentBytes = content.reduce(
      (total, part) => total + (part.type === 'asset' ? part.asset.sizeBytes : 0),
      0,
    );
    if (attachmentBytes > MAX_TURN_ATTACHMENT_BYTES) {
      throw new Error('Turn attachments exceed the 20 MiB limit.');
    }
    const parts: Part[] = content.flatMap((part): readonly Part[] => {
      if (part.type === 'text') {
        return [{ text: part.text }];
      }
      const stored = this.parseNativeJson<StoredAssetContent>(
        this.requireNative().readAssetJson(part.asset.assetId),
      );
      if (!this.sameAsset(stored.asset, part.asset)) {
        throw new Error('Stored content asset metadata does not match the Turn.');
      }
      if (
        (part.asset.kind === 'image' &&
          !selection.effectiveCapabilities.imageInput) ||
        (part.asset.kind === 'pdf' &&
          !selection.effectiveCapabilities.pdfInput)
      ) {
        throw new Error(`The selected model does not accept ${part.asset.kind} input.`);
      }
      if (part.asset.kind === 'text') {
        return [{
          text: `Attachment ${part.asset.originalName}:\n${Buffer.from(stored.data, 'base64').toString('utf8')}`,
        }];
      }
      return [{
        inlineData: {
          mimeType: part.asset.mediaType,
          data: stored.data,
          displayName: part.asset.originalName,
        },
      }];
    });
    return { role: 'user', parts };
  };

  private sameAsset = (
    left: RuntimeAssetDescriptor,
    right: RuntimeAssetDescriptor,
  ): boolean =>
    left.assetId === right.assetId &&
    left.sha256 === right.sha256 &&
    left.mediaType === right.mediaType &&
    left.originalName === right.originalName &&
    left.sizeBytes === right.sizeBytes &&
    left.kind === right.kind &&
    left.pdfPages === right.pdfPages;

  private persistModelHistory = (
    command: Extract<RuntimeCommand, { type: 'turn.start' }>,
    event: Event,
  ): void => {
    if (!this.nativeRuntime || !event.content) {
      return;
    }
    const history = this.storedModelHistory(event.content);
    if (history.parts.length === 0) {
      return;
    }
    this.sequence += 1;
    this.nativeRuntime.appendItem(
      `history:${command.turnId}:${event.id}`,
      command.turnId,
      this.sequence,
      'turn.modelHistory',
      JSON.stringify({ history }),
    );
  };

  private storedModelHistory = (content: Content): StoredModelHistory => ({
    role: content.role === 'model' ? 'assistant' : 'user',
    parts: (content.parts ?? []).map((part): StoredHistoryPart => {
      if (typeof part.text === 'string') {
        return {
          type: 'text',
          text: part.text,
          reasoning: part.thought === true,
          ...(isRecord(part.partMetadata)
            ? { metadata: part.partMetadata }
            : {}),
        };
      }
      if (part.inlineData?.mimeType && part.inlineData.data) {
        return {
          type: 'media',
          mediaType: part.inlineData.mimeType,
          data: part.inlineData.data,
          ...(part.inlineData.displayName
            ? { name: part.inlineData.displayName }
            : {}),
        };
      }
      if (part.functionCall?.id && part.functionCall.name) {
        return {
          type: 'toolCall',
          id: part.functionCall.id,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        };
      }
      if (part.functionResponse?.id && part.functionResponse.name) {
        return {
          type: 'toolResult',
          id: part.functionResponse.id,
          name: part.functionResponse.name,
          result: part.functionResponse.response ?? {},
        };
      }
      throw new Error('Model history contains an unsupported content part.');
    }),
  });

  private parseStoredModelHistory = (value: unknown): StoredModelHistory => {
    if (
      !isRecord(value) ||
      (value.role !== 'assistant' && value.role !== 'user') ||
      !Array.isArray(value.parts)
    ) {
      throw new Error('Stored model history is invalid.');
    }
    const parts = value.parts.map((part): StoredHistoryPart => {
      if (!isRecord(part) || typeof part.type !== 'string') {
        throw new Error('Stored model history is invalid.');
      }
      if (
        part.type === 'text' &&
        typeof part.text === 'string' &&
        typeof part.reasoning === 'boolean'
      ) {
        const metadata = part.metadata;
        if (metadata === undefined) {
          return {
            type: 'text',
            text: part.text,
            reasoning: part.reasoning,
          };
        }
        if (!isRecord(metadata)) {
          throw new Error('Stored model history is invalid.');
        }
        return {
          type: 'text',
          text: part.text,
          reasoning: part.reasoning,
          metadata,
        };
      }
      if (
        part.type === 'media' &&
        typeof part.mediaType === 'string' &&
        typeof part.data === 'string'
      ) {
        const name = part.name;
        if (name === undefined) {
          return {
            type: 'media',
            mediaType: part.mediaType,
            data: part.data,
          };
        }
        if (typeof name !== 'string') {
          throw new Error('Stored model history is invalid.');
        }
        return {
          type: 'media',
          mediaType: part.mediaType,
          data: part.data,
          name,
        };
      }
      if (
        part.type === 'toolCall' &&
        typeof part.id === 'string' &&
        typeof part.name === 'string' &&
        isRecord(part.arguments)
      ) {
        return {
          type: 'toolCall',
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        };
      }
      if (
        part.type === 'toolResult' &&
        typeof part.id === 'string' &&
        typeof part.name === 'string' &&
        isRecord(part.result)
      ) {
        return {
          type: 'toolResult',
          id: part.id,
          name: part.name,
          result: part.result,
        };
      }
      throw new Error('Stored model history is invalid.');
    });
    return { role: value.role, parts };
  };

  private contentFromHistory = (history: StoredModelHistory): Content => ({
    role: history.role === 'assistant' ? 'model' : 'user',
    parts: history.parts.map((part): Part => {
      switch (part.type) {
        case 'text':
          return {
            text: part.text,
            thought: part.reasoning,
            ...(part.metadata ? { partMetadata: part.metadata } : {}),
          };
        case 'media':
          return {
            inlineData: {
              mimeType: part.mediaType,
              data: part.data,
              ...(part.name ? { displayName: part.name } : {}),
            },
          };
        case 'toolCall':
          return {
            functionCall: {
              id: part.id,
              name: part.name,
              args: part.arguments,
            },
          };
        case 'toolResult':
          return {
            functionResponse: {
              id: part.id,
              name: part.name,
              response: part.result,
            },
          };
      }
    }),
  });

  private resolveProfile = (
    command: Extract<RuntimeCommand, { type: 'turn.start' }>,
  ): ResolvedProfile => {
    if (command.provider) {
      const providerFamily = command.provider.wireApi === 'anthropicMessages'
        ? 'anthropic'
        : 'openai';
      return {
        provider: command.provider,
        selection: {
          profileId: 'runtime-direct',
          providerFamily,
          wireApi: command.provider.wireApi,
          modelId: command.provider.model,
          displayName: command.provider.model,
          contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
          effectiveCapabilities: {
            toolCalls: true,
            strictTools: false,
            parallelTools: command.provider.parallelTools,
            imageInput: true,
            pdfInput: providerFamily === 'anthropic',
          },
        },
      };
    }
    const resolved = this.parseNativeJson<unknown>(
      this.requireNative().modelProfileJson(command.modelProfileId),
    );
    if (
      !isRecord(resolved) ||
      !isRecord(resolved.profile) ||
      !isRecord(resolved.connection)
    ) {
      throw new Error('The selected model profile is invalid.');
    }
    const profile = resolved.profile;
    const connection = resolved.connection;
    const wireApi = connection.wireApi;
    const providerFamily = connection.providerFamily;
    if (
      typeof profile.id !== 'string' ||
      typeof profile.modelId !== 'string' ||
      typeof profile.displayName !== 'string' ||
      !['openai', 'anthropic'].includes(String(providerFamily)) ||
      !['openaiResponses', 'openaiChatCompletions', 'anthropicMessages'].includes(
        String(wireApi),
      ) ||
      typeof connection.baseUrl !== 'string'
    ) {
      throw new Error('The selected model profile is incomplete.');
    }
    const selection: RuntimeModelSelection = {
      profileId: profile.id,
      providerFamily: providerFamily as RuntimeModelSelection['providerFamily'],
      wireApi: wireApi as RuntimeModelSelection['wireApi'],
      modelId: profile.modelId,
      displayName: profile.displayName,
      contextWindowTokens:
        typeof profile.contextWindowTokens === 'number'
          ? profile.contextWindowTokens
          : DEFAULT_CONTEXT_WINDOW_TOKENS,
      effectiveCapabilities: {
        toolCalls: capabilityEnabled(profile.toolCalls),
        strictTools: profile.strictTools === 'enabled',
        parallelTools: capabilityEnabled(profile.parallelTools),
        imageInput: capabilityEnabled(profile.imageInput),
        pdfInput: capabilityEnabled(profile.pdfInput),
      },
    };
    return {
      provider: {
        wireApi: selection.wireApi,
        model: selection.modelId,
        baseUrl: connection.baseUrl,
        ...(typeof resolved.apiKey === 'string'
          ? { apiKey: resolved.apiKey }
          : {}),
        timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
        parallelTools: selection.effectiveCapabilities.parallelTools,
      },
      selection,
    };
  };

  private discover = async (
    requestId: string,
    connectionId: string,
  ): Promise<void> => {
    try {
      const discovery = await discoverModels(
        this.requireNative().modelConnectionJson(connectionId),
      );
      this.emit({ type: 'model.discovery', requestId, discovery });
    } catch (error) {
      this.emit({
        type: 'runtime.log',
        requestId,
        level: 'error',
        message: error instanceof Error ? error.message : 'Model discovery failed.',
      });
    }
  };

  private startTurn = async (
    command: Extract<RuntimeCommand, { type: 'turn.start' }>,
  ): Promise<void> => {
    if (this.activeTurns.has(command.turnId)) {
      this.emitCompleted(command, 'failed', {
        kind: 'invalidRequest',
        retryable: false,
        message: 'The Turn is already active.',
      });
      return;
    }
    const controller = new AbortController();
    this.activeTurns.set(command.turnId, controller);
    try {
      const resolved = this.resolveProfile(command);
      this.nativeRuntime?.ensureThread(
        command.threadId,
        command.workspaceId,
      );
      await this.ensureSession(command, resolved.selection);
      this.nativeRuntime?.startTurn(
        command.turnId,
        command.threadId,
        command.requestId,
        resolved.provider.wireApi,
        resolved.provider.model,
      );
      this.emit({
        type: 'turn.started',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        model: resolved.selection,
      });
      this.emit({
        type: 'turn.userMessage',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        itemId: `${command.turnId}:user`,
        content: command.content,
      });
      const agent = new LlmAgent({
        name: 'sugarcode_agent',
        description: 'SugarCode local coding agent',
        instruction: SUGARCODE_BASE_AGENT_PROMPT_V1,
        model: this.createModel(resolved.provider),
        tools: this.nativeRuntime
          ? [
              ...createWorkspaceTools(
                this.nativeRuntime,
                command.workspaceId,
                (toolName, argumentsValue, execute) =>
                  this.runPrivilegedTool(
                    command,
                    toolName,
                    argumentsValue,
                    execute,
                  ),
              ),
            ]
          : [],
      });
      const runner = new Runner({
        appName: APPLICATION_NAME,
        agent,
        sessionService: this.sessions,
      });
      for await (const event of runner.runAsync({
        userId: command.workspaceId,
        sessionId: command.threadId,
        newMessage: this.contentFromParts(command.content, resolved.selection),
        abortSignal: controller.signal,
      })) {
        this.publishAgentEvent(command, event);
        if (!event.partial) {
          this.persistModelHistory(command, event);
        }
      }
      this.emitCompleted(
        command,
        controller.signal.aborted ? 'interrupted' : 'completed',
      );
    } catch (error) {
      const details = providerError(error);
      this.emitCompleted(
        command,
        details.kind === 'cancelled' ? 'interrupted' : 'failed',
        details,
      );
    } finally {
      this.activeTurns.delete(command.turnId);
    }
  };

  private publishAgentEvent = (
    command: Extract<RuntimeCommand, { type: 'turn.start' }>,
    event: Event,
  ): void => {
    for (const [index, part] of (event.content?.parts ?? []).entries()) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        if (event.partial === false) {
          continue;
        }
        this.emit({
          type: 'turn.textDelta',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          itemId: `${event.id}:${index}`,
          phase: part.thought ? 'commentary' : 'final',
          delta: part.text,
        });
      }
      if (part.functionCall?.name) {
        this.emit({
          type: 'turn.toolCall',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          itemId: `${event.id}:${index}`,
          callId: part.functionCall.id ?? `${event.id}:${index}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
      if (part.functionResponse?.name) {
        this.emit({
          type: 'turn.toolResult',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          itemId: `${event.id}:${index}`,
          callId: part.functionResponse.id ?? `${event.id}:${index}`,
          result: part.functionResponse.response ?? {},
        });
      }
    }
    const usage = usageFromEvent(event);
    if (usage) {
      this.emit({
        type: 'turn.usage',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        usage,
      });
    }
  };

  private runPrivilegedTool = async (
    command: Extract<RuntimeCommand, { type: 'turn.start' }>,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    execute: (operationId: string) => Promise<unknown>,
  ): Promise<unknown> => {
    const operationId = randomUUID();
    const approvalId = randomUUID();
    const argumentsJson = JSON.stringify(argumentsValue);
    const requestHash = createHash('sha256').update(argumentsJson).digest('hex');
    this.requireNative().proposeOperation(
      operationId,
      approvalId,
      command.turnId,
      toolName,
      requestHash,
      argumentsJson,
    );
    const decision = await new Promise<'approved' | 'denied'>((resolve) => {
      this.pendingApprovals.set(approvalId, {
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
        resolve,
      });
      this.emit({
        type: 'approval.requested',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        approvalId,
        operationId,
        toolName,
        argumentsSummary: this.approvalArgumentsSummary(
          toolName,
          argumentsValue,
          argumentsJson,
        ),
        fullAccess:
          toolName === 'shell_exec' && argumentsValue.mode === 'fullAccess',
      });
    });
    if (decision === 'denied') {
      return { ok: false, error: 'userDenied' };
    }
    const operations = this.activeOperations.get(command.turnId) ?? new Set<string>();
    operations.add(operationId);
    this.activeOperations.set(command.turnId, operations);
    let began = false;
    try {
      began = this.requireNative().beginOperation(operationId);
      if (!began) {
        return { ok: false, error: 'operationAlreadyExecuting' };
      }
      const result = await execute(operationId);
      const succeeded = !(
        isRecord(result) &&
        (result.ok === false ||
          result.status === 'error' ||
          result.status === 'cancelled')
      );
      this.requireNative().completeOperation(
        operationId,
        JSON.stringify(result),
        succeeded,
      );
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : 'privilegedToolFailed',
      };
      if (began) {
        this.requireNative().completeOperation(
          operationId,
          JSON.stringify(result),
          false,
        );
      }
      return result;
    } finally {
      const active = this.activeOperations.get(command.turnId);
      active?.delete(operationId);
      if (active?.size === 0) {
        this.activeOperations.delete(command.turnId);
      }
    }
  };

  private cancelTurnApprovals = (turnId: string): void => {
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.turnId !== turnId) {
        continue;
      }
      try {
        this.nativeRuntime?.resolveApproval(approvalId, 'denied');
      } catch {
        // Recovery keeps unresolved approvals visible if persistence is unavailable.
      }
      this.pendingApprovals.delete(approvalId);
      pending.resolve('denied');
    }
  };

  private cancelTurnOperations = (turnId: string): void => {
    const operations = this.activeOperations.get(turnId);
    if (!operations) {
      return;
    }
    for (const operationId of operations) {
      try {
        this.nativeRuntime?.cancelOperation(operationId);
      } catch {
        // Native operation recovery marks unfinished execution retryable on restart.
      }
    }
  };

  private approvalArgumentsSummary = (
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    argumentsJson: string,
  ): string => {
    if (toolName !== 'shell_exec' || typeof argumentsValue.command !== 'string') {
      return `${toolName} (${Buffer.byteLength(argumentsJson, 'utf8')} bytes)`;
    }
    const commandArguments = Array.isArray(argumentsValue.arguments) &&
      argumentsValue.arguments.every((argument) => typeof argument === 'string')
      ? argumentsValue.arguments.map((argument) => JSON.stringify(argument)).join(' ')
      : '';
    const rendered = [argumentsValue.command, commandArguments]
      .filter((part) => part.length > 0)
      .join(' ');
    const prefix = argumentsValue.mode === 'fullAccess'
      ? 'Full Access'
      : 'Sandboxed';
    const summary = `${prefix}: ${rendered}`;
    return summary.length <= 4_096
      ? summary
      : `${summary.slice(0, 4_093)}...`;
  };

  private emitCompleted = (
    command: Extract<RuntimeCommand, { type: 'turn.start' }>,
    status: 'completed' | 'interrupted' | 'failed',
    error?: RuntimeProviderError,
  ): void => {
    try {
      this.nativeRuntime?.finishTurn(
        command.turnId,
        status,
        error ? JSON.stringify(error) : undefined,
      );
    } catch (persistenceError) {
      this.emit({
        type: 'runtime.log',
        requestId: command.requestId,
        level: 'error',
        message:
          persistenceError instanceof Error
            ? persistenceError.message
            : 'Failed to persist the terminal Turn state.',
      });
    }
    this.emit({
      type: 'turn.completed',
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      turnId: command.turnId,
      status,
      ...(error ? { error } : {}),
    });
  };

  private emit = (
    event: RuntimeEventInput,
  ): void => {
    this.sequence += 1;
    const normalized = { ...event, sequence: this.sequence } as RuntimeEvent;
    if (
      this.nativeRuntime &&
      normalized.type !== 'runtime.ready' &&
      normalized.type !== 'runtime.log' &&
      normalized.type !== 'turn.completed' &&
      'turnId' in normalized
    ) {
      const itemId =
        'itemId' in normalized
          ? normalized.itemId
          : 'taskId' in normalized
            ? normalized.taskId
            : 'approvalId' in normalized
              ? normalized.approvalId
              : String(normalized.sequence);
      this.nativeRuntime.appendItem(
        `${normalized.type}:${itemId}:${normalized.sequence}`,
        normalized.turnId,
        normalized.sequence,
        normalized.type,
        JSON.stringify(normalized),
      );
    }
    this.postEvent(normalized);
  };
}
