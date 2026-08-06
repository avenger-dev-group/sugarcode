import {
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
import type {
  RuntimeCommand,
  RuntimeEvent,
  RuntimeEventInput,
  RuntimeProviderConfig,
  RuntimeProviderError,
  RuntimeModelSelection,
  RuntimeThreadRecord,
  RuntimeThreadSnapshot,
  RuntimeUsage,
} from './protocol.ts';
import { RUNTIME_PROTOCOL_VERSION } from './protocol.ts';
import { createWorkspaceTools } from './tools/workspace.ts';

const APPLICATION_NAME = 'sugarcode-desktop-v3';
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

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

const userContent = (command: Extract<RuntimeCommand, { type: 'turn.start' }>): Content => {
  const parts: Part[] = command.content.flatMap((part): readonly Part[] => {
    if (part.type === 'text') {
      return [{ text: part.text }];
    }
    return [
      {
        text: `[Attached asset ${part.name} (${part.mediaType}, ${part.assetId}) is not loaded yet.]`,
      },
    ];
  });
  return { role: 'user', parts };
};

export class RuntimeHost {
  private readonly postEvent: RuntimeHostOptions['postEvent'];
  private readonly createModel: NonNullable<RuntimeHostOptions['createModel']>;
  private readonly loadNative: NonNullable<RuntimeHostOptions['loadNative']>;
  private readonly sessions = new InMemorySessionService();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
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
      case 'turn.start':
        this.requireReady(command.requestId);
        void this.startTurn(command);
        break;
      case 'turn.cancel':
        this.activeTurns.get(command.turnId)?.abort();
        this.cancelTurnApprovals(command.turnId);
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
      const session = await this.sessions.getSession({
        appName: APPLICATION_NAME,
        userId: command.workspaceId,
        sessionId: command.threadId,
      });
      if (!session) {
        await this.sessions.createSession({
          appName: APPLICATION_NAME,
          userId: command.workspaceId,
          sessionId: command.threadId,
        });
      }
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
        newMessage: userContent(command),
        abortSignal: controller.signal,
      })) {
        this.publishAgentEvent(command, event);
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
    execute: () => Promise<unknown>,
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
        argumentsSummary: `${toolName} (${Buffer.byteLength(argumentsJson, 'utf8')} bytes)`,
      });
    });
    if (decision === 'denied') {
      return { ok: false, error: 'userDenied' };
    }
    try {
      const result = await execute();
      this.requireNative().completeOperation(
        operationId,
        JSON.stringify(result),
        true,
      );
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : 'privilegedToolFailed',
      };
      this.requireNative().completeOperation(
        operationId,
        JSON.stringify(result),
        false,
      );
      return result;
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
