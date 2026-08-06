import {
  InMemorySessionService,
  LlmAgent,
  Runner,
  type BaseLlm,
  type Event,
} from '@google/adk';
import type { Content, Part } from '@google/genai';

import { SUGARCODE_BASE_AGENT_PROMPT_V1 } from './agent-instructions.ts';
import { ProviderAdapterError } from './models/errors.ts';
import { AnthropicLlm } from './models/anthropic-llm.ts';
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
  RuntimeUsage,
} from './protocol.ts';
import { RUNTIME_PROTOCOL_VERSION } from './protocol.ts';
import { createWorkspaceTools } from './tools/workspace.ts';

const APPLICATION_NAME = 'sugarcode-desktop-v3';

type RuntimeHostOptions = Readonly<{
  postEvent: (event: RuntimeEvent) => void;
  createModel?: (provider: RuntimeProviderConfig) => BaseLlm;
  loadNative?: typeof loadNativeRuntime;
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
        break;
      case 'approval.resolve':
        this.emit({
          type: 'runtime.log',
          requestId: command.requestId,
          level: 'warn',
          message: `Approval ${command.approvalId} has no pending runtime tool.`,
        });
        break;
      case 'shutdown':
        this.shuttingDown = true;
        for (const controller of this.activeTurns.values()) {
          controller.abort();
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
      this.nativeRuntime?.ensureThread(
        command.threadId,
        command.workspaceId,
      );
      this.nativeRuntime?.startTurn(
        command.turnId,
        command.threadId,
        command.requestId,
        command.provider.wireApi,
        command.provider.model,
      );
      this.emit({
        type: 'turn.started',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
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
        model: this.createModel(command.provider),
        tools: this.nativeRuntime
          ? [...createWorkspaceTools(this.nativeRuntime, command.workspaceId)]
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
      normalized.type !== 'turn.started' &&
      normalized.type !== 'turn.completed'
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
        `${normalized.type}:${itemId}`,
        normalized.turnId,
        normalized.sequence,
        normalized.type,
        JSON.stringify(normalized),
      );
    }
    this.postEvent(normalized);
  };
}
