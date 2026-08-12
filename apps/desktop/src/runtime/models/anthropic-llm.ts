import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaCompactionBlockParam,
  BetaContentBlockParam as ContentBlockParam,
  BetaMessageParam as MessageParam,
  BetaRawMessageStreamEvent as RawMessageStreamEvent,
  BetaStopReason as StopReason,
  BetaTool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  MessageParam as RegularMessageParam,
  RawMessageStreamEvent as RegularRawMessageStreamEvent,
  Tool as RegularAnthropicTool,
} from '@anthropic-ai/sdk/resources/messages';
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason, type Part } from '@google/genai';

import {
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
} from '../../shared/model-metadata.ts';
import { ProviderAdapterError, cancelledProviderError } from './errors.ts';
import { normalizeLlmRequest } from './normalize-request.ts';
import { createRequestDeadline } from './request-deadline.ts';
import { streamWithPreOutputRetry } from './retry.ts';
import { modelItemMetadata } from './step-outcome.ts';
import { normalizeToolArguments } from './tool-arguments.ts';
import type {
  ModelStepOutcome,
  NormalizedLlmRequest,
  NormalizedMediaPart,
  NormalizedMessage,
  NormalizedTool,
  ProviderAdapterOptions,
} from './types.ts';

type AnthropicBlockAccumulator =
  | {
      type: 'tool';
      id: string;
      name: string;
      arguments: string;
    }
  | { type: 'thinking'; signature: string; text: string }
  | { type: 'compaction'; content: string | null; encryptedContent: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateBaseUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderAdapterError({
      kind: 'invalidRequest',
      retryable: false,
      message: 'The Anthropic Base URL is invalid.',
    });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ProviderAdapterError({
      kind: 'invalidRequest',
      retryable: false,
      message: 'The Anthropic Base URL must be HTTP(S) without credentials, query, or fragment.',
    });
  }
  const withoutTrailingSlash = value.replace(/\/+$/u, '');
  return withoutTrailingSlash.endsWith('/v1')
    ? withoutTrailingSlash.slice(0, -3)
    : withoutTrailingSlash;
};

const mediaSource = (
  part: NormalizedMediaPart,
): ContentBlockParam | null => {
  if (part.mimeType.startsWith('image/')) {
    if (part.uri) {
      return { type: 'image', source: { type: 'url', url: part.uri } };
    }
    if (
      part.data &&
      ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
        part.mimeType,
      )
    ) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType as
            | 'image/jpeg'
            | 'image/png'
            | 'image/gif'
            | 'image/webp',
          data: part.data,
        },
      };
    }
  }
  if (part.mimeType === 'application/pdf') {
    if (part.uri) {
      return {
        type: 'document',
        source: { type: 'url', url: part.uri },
        title: part.name ?? null,
      };
    }
    if (part.data) {
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: part.data,
        },
        title: part.name ?? null,
      };
    }
  }
  return null;
};

const providerNameByAdkName = (
  request: NormalizedLlmRequest,
): ReadonlyMap<string, string> =>
  new Map(request.tools.map((tool) => [tool.adkName, tool.providerName]));

const messageContent = (
  message: NormalizedMessage,
  names: ReadonlyMap<string, string>,
): readonly ContentBlockParam[] => {
  const content: ContentBlockParam[] = [];
  let pendingThinking = '';
  let thinkingSignature = '';
  const flushThinking = (): void => {
    if (pendingThinking && thinkingSignature) {
      content.push({
        type: 'thinking',
        thinking: pendingThinking,
        signature: thinkingSignature,
      });
    }
    pendingThinking = '';
    thinkingSignature = '';
  };
  for (const part of message.parts) {
    if (part.type === 'text' && part.thought) {
      pendingThinking += part.text;
      const signature = part.metadata?.anthropicSignature;
      if (typeof signature === 'string') {
        thinkingSignature = signature;
      }
      const redacted = part.metadata?.anthropicRedactedThinking;
      if (typeof redacted === 'string') {
        flushThinking();
        content.push({ type: 'redacted_thinking', data: redacted });
      }
      continue;
    }
    flushThinking();
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'media') {
      const media = mediaSource(part);
      if (media) {
        content.push(media);
      }
    } else if (part.type === 'toolCall') {
      content.push({
        type: 'tool_use',
        id: part.id,
        name: names.get(part.name) ?? part.name,
        input: part.args,
      });
    } else if (part.type === 'toolResult') {
      content.push({
        type: 'tool_result',
        tool_use_id: part.id,
        content: JSON.stringify(part.result),
      });
    }
  }
  flushThinking();
  return content;
};

const anthropicMessages = (
  request: NormalizedLlmRequest,
  compatibilityKey: string,
): readonly MessageParam[] => {
  const names = providerNameByAdkName(request);
  let startIndex = 0;
  let checkpoint: BetaCompactionBlockParam | undefined;
  for (const [index, message] of request.messages.entries()) {
    for (const part of message.parts) {
      const value = part.type === 'text' && isRecord(part.metadata?.anthropicCompaction)
        ? part.metadata.anthropicCompaction
        : undefined;
      if (
        isRecord(value) &&
        value.type === 'compaction' &&
        value.model === request.model &&
        value.compatibilityKey === compatibilityKey
      ) {
        checkpoint = {
          type: 'compaction',
          ...(typeof value.content === 'string' ? { content: value.content } : {}),
          ...(typeof value.encrypted_content === 'string'
            ? { encrypted_content: value.encrypted_content }
            : {}),
        };
        startIndex = index + 1;
      }
    }
  }
  const messages = request.messages.slice(startIndex).flatMap((message): readonly MessageParam[] => {
    const content = messageContent(message, names);
    return content.length === 0
      ? []
      : [{ role: message.role, content: [...content] }];
  });
  return checkpoint
    ? [{ role: 'assistant', content: [checkpoint] }, ...messages]
    : messages;
};

const anthropicTools = (
  tools: readonly NormalizedTool[],
): readonly AnthropicTool[] =>
  tools.map(
    (tool): AnthropicTool => ({
      name: tool.providerName,
      description: tool.description,
      input_schema: {
        type: 'object',
        ...tool.parameters,
      },
    }),
  );

const anthropicFinishReason = (
  value: StopReason | null | undefined,
): FinishReason => {
  switch (value) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return FinishReason.MAX_TOKENS;
    case 'refusal':
      return FinishReason.SAFETY;
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
    case 'pause_turn':
    case 'compaction':
      return FinishReason.STOP;
    default:
      return FinishReason.OTHER;
  }
};

const anthropicUsage = (options: {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}): LlmResponse['usageMetadata'] => {
  const cached =
    (options.cacheCreationTokens ?? 0) + (options.cacheReadTokens ?? 0);
  const input = options.inputTokens;
  const output = options.outputTokens;
  return {
    ...(input === undefined ? {} : { promptTokenCount: input }),
    ...(output === undefined ? {} : { candidatesTokenCount: output }),
    ...(input === undefined || output === undefined
      ? {}
      : { totalTokenCount: input + cached + output }),
    ...(cached > 0 ? { cachedContentTokenCount: cached } : {}),
  };
};

const retryableStatus = (status: number | undefined): boolean =>
  status === 408 ||
  status === 409 ||
  status === 429 ||
  (status !== undefined && status >= 500);

const mapAnthropicError = (
  error: unknown,
  signal?: AbortSignal,
): ProviderAdapterError => {
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) {
    return cancelledProviderError();
  }
  if (error instanceof ProviderAdapterError) {
    return error;
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const contextWindowExceeded =
      /context (?:length|window)|maximum context|too many tokens|prompt is too long/iu.test(
        error.message,
      );
    return new ProviderAdapterError({
      kind:
        contextWindowExceeded
          ? 'contextWindowExceeded'
          : status === 401 || status === 403
          ? 'authentication'
          : status === 429
            ? 'rateLimit'
            : status !== undefined && status >= 500
              ? 'server'
              : 'invalidRequest',
      retryable: contextWindowExceeded ? false : retryableStatus(status),
      message: error.message,
      ...(status === undefined ? {} : { status }),
      ...(typeof error.requestID === 'string'
        ? { requestId: error.requestID }
        : {}),
    });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderAdapterError({
      kind: 'timeout',
      retryable: true,
      message: error.message,
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderAdapterError({
      kind: 'connection',
      retryable: true,
      message: error.message,
    });
  }
  return new ProviderAdapterError({
    kind: 'unknown',
    retryable: false,
    message:
      error instanceof Error ? error.message : 'Anthropic request failed.',
  });
};

export class AnthropicLlm extends BaseLlm {
  static readonly supportedModels = [/^anthropic:/u];

  private readonly client: Anthropic;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private nativeCompaction: boolean;
  private readonly compactThresholdTokens?: number;
  private readonly compatibilityKey: string;

  constructor(options: ProviderAdapterOptions) {
    super({ model: options.model });
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
    this.nativeCompaction = options.nativeCompaction === true;
    this.compactThresholdTokens = options.compactThresholdTokens;
    this.compatibilityKey = `anthropicMessages:${validateBaseUrl(options.baseUrl)}`;
    this.client = new Anthropic({
      apiKey: options.apiKey || 'sugarcode-no-key',
      baseURL: validateBaseUrl(options.baseUrl),
      defaultHeaders: options.headers,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    void _stream;
    const request = normalizeLlmRequest(llmRequest, this.model);
    const deadline = createRequestDeadline(abortSignal, this.timeoutMs);
    const blocks = new Map<number, AnthropicBlockAccumulator>();
    const completedToolCalls: Array<{
      id: string;
      name: string;
      arguments: string;
    }> = [];
    const redactedThinking: string[] = [];
    let fullText = '';
    let fullThinking = '';
    let thinkingSignature = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheCreationTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let completedCompaction: Extract<AnthropicBlockAccumulator, { type: 'compaction' }> | undefined;
    let contextInputTokens: number | undefined;
    let stopReason: StopReason | null | undefined;
    let completed = false;
    const textItemId = `message_${crypto.randomUUID()}`;
    const thinkingItemId = `reasoning_${crypto.randomUUID()}`;
    try {
      const stream = streamWithPreOutputRetry<RawMessageStreamEvent>({
        signal: deadline.signal,
        maxRetries: this.maxRetries,
        shouldRetry: (error) =>
          mapAnthropicError(error, deadline.signal).details.retryable,
        create: async () => {
          const maxTokens = Math.max(
            1,
            Math.min(
              request.config?.maxOutputTokens ?? DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
              65_536,
            ),
          );
          if (!this.nativeCompaction) {
            const stream = await this.client.messages.create(
              {
                model: request.model,
                max_tokens: maxTokens,
                messages: [...anthropicMessages(request, this.compatibilityKey)] as RegularMessageParam[],
                system: request.system || undefined,
                tools: [...anthropicTools(request.tools)] as RegularAnthropicTool[],
                stream: true,
              },
              { signal: deadline.signal },
            );
            return stream as AsyncIterable<RegularRawMessageStreamEvent> as
              AsyncIterable<RawMessageStreamEvent>;
          }
          return this.client.beta.messages.create(
            {
              model: request.model,
              max_tokens: maxTokens,
              messages: [...anthropicMessages(request, this.compatibilityKey)],
              system: request.system || undefined,
              tools: [...anthropicTools(request.tools)],
              betas: ['context-management-2025-06-27'],
              context_management: {
                edits: [{
                  type: 'compact_20260112',
                  pause_after_compaction: true,
                  ...(this.compactThresholdTokens === undefined
                    ? {}
                    : {
                        trigger: {
                          type: 'input_tokens',
                          value: this.compactThresholdTokens,
                        },
                      }),
                }],
              },
              stream: true,
            },
            { signal: deadline.signal },
          );
        },
      });
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens;
            outputTokens = event.message.usage.output_tokens;
            cacheCreationTokens = event.message.usage.cache_creation_input_tokens;
            cacheReadTokens = event.message.usage.cache_read_input_tokens;
            break;
          case 'content_block_start':
            if (event.content_block.type === 'text' && event.content_block.text) {
              fullText += event.content_block.text;
              yield {
                content: {
                  role: 'model',
                  parts: [{
                    text: event.content_block.text,
                    partMetadata: modelItemMetadata(textItemId, {
                      phase: 'provisional',
                    }),
                  }],
                },
                partial: true,
              };
            } else if (event.content_block.type === 'thinking') {
              blocks.set(event.index, {
                type: 'thinking',
                signature: event.content_block.signature,
                text: event.content_block.thinking,
              });
              if (event.content_block.thinking) {
                fullThinking += event.content_block.thinking;
                yield {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        text: event.content_block.thinking,
                        thought: true,
                        partMetadata: modelItemMetadata(thinkingItemId, {
                          phase: 'commentary',
                          reasoningVisibility: 'internal',
                        }),
                      },
                    ],
                  },
                  partial: true,
                };
              }
            } else if (event.content_block.type === 'redacted_thinking') {
              redactedThinking.push(event.content_block.data);
            } else if (event.content_block.type === 'compaction') {
              blocks.set(event.index, {
                type: 'compaction',
                content: event.content_block.content,
                encryptedContent: event.content_block.encrypted_content,
              });
            } else if (event.content_block.type === 'tool_use') {
              blocks.set(event.index, {
                type: 'tool',
                id: event.content_block.id,
                name: event.content_block.name,
                arguments:
                  isRecord(event.content_block.input) &&
                  Object.keys(event.content_block.input).length > 0
                    ? JSON.stringify(event.content_block.input)
                    : '',
              });
            }
            break;
          case 'content_block_delta': {
            const block = blocks.get(event.index);
            if (event.delta.type === 'text_delta') {
              fullText += event.delta.text;
              yield {
                content: {
                  role: 'model',
                  parts: [{
                    text: event.delta.text,
                    partMetadata: modelItemMetadata(textItemId, {
                      phase: 'provisional',
                    }),
                  }],
                },
                partial: true,
              };
            } else if (event.delta.type === 'thinking_delta') {
              fullThinking += event.delta.thinking;
              if (block?.type === 'thinking') {
                block.text += event.delta.thinking;
              }
              yield {
                content: {
                  role: 'model',
                  parts: [{
                    text: event.delta.thinking,
                    thought: true,
                    partMetadata: modelItemMetadata(thinkingItemId, {
                      phase: 'commentary',
                      reasoningVisibility: 'internal',
                    }),
                  }],
                },
                partial: true,
              };
            } else if (
              event.delta.type === 'signature_delta' &&
              block?.type === 'thinking'
            ) {
              block.signature += event.delta.signature;
            } else if (
              event.delta.type === 'input_json_delta' &&
              block?.type === 'tool'
            ) {
              block.arguments += event.delta.partial_json;
            } else if (
              event.delta.type === 'compaction_delta' &&
              block?.type === 'compaction'
            ) {
              block.content = event.delta.content;
              block.encryptedContent = event.delta.encrypted_content;
            }
            break;
          }
          case 'content_block_stop': {
            const block = blocks.get(event.index);
            if (block?.type === 'tool') {
              completedToolCalls.push(block);
            } else if (block?.type === 'thinking' && block.signature) {
              thinkingSignature = block.signature;
            } else if (block?.type === 'compaction') {
              completedCompaction = block;
            }
            blocks.delete(event.index);
            break;
          }
          case 'message_delta':
            stopReason = event.delta.stop_reason;
            outputTokens = event.usage.output_tokens;
            if (typeof event.usage.input_tokens === 'number') {
              inputTokens = event.usage.input_tokens;
            }
            if (typeof event.usage.cache_creation_input_tokens === 'number') {
              cacheCreationTokens = event.usage.cache_creation_input_tokens;
            }
            if (typeof event.usage.cache_read_input_tokens === 'number') {
              cacheReadTokens = event.usage.cache_read_input_tokens;
            }
            {
              const finalMessageIteration = event.usage.iterations
                ?.filter((iteration) => iteration.type === 'message')
                .at(-1);
              if (finalMessageIteration) {
                contextInputTokens =
                  finalMessageIteration.input_tokens +
                  finalMessageIteration.cache_creation_input_tokens +
                  finalMessageIteration.cache_read_input_tokens;
              }
            }
            break;
          case 'message_stop': {
            completed = true;
            const hasTools = completedToolCalls.length > 0;
            const outcome: ModelStepOutcome =
              stopReason === 'pause_turn' || stopReason === 'compaction'
              ? { kind: 'continue', reason: 'pauseTurn' }
              : stopReason === 'max_tokens' ||
                  stopReason === 'model_context_window_exceeded'
                ? { kind: 'continue', reason: 'maxOutputTokens' }
                : stopReason === 'refusal'
                  ? {
                      kind: 'failed',
                      errorKind: 'filtered',
                      message: 'The provider refused the model response.',
                    }
                  : hasTools
                    ? { kind: 'toolCalls' }
                    : fullText.trim().length > 0
                      ? { kind: 'final' }
                      : { kind: 'continue', reason: 'commentaryOnly' };
            const parts: Part[] = [];
            if (fullThinking || thinkingSignature) {
              parts.push({
                text: fullThinking,
                thought: true,
                partMetadata: {
                  ...modelItemMetadata(thinkingItemId, {
                    phase: 'commentary',
                    reasoningVisibility: 'internal',
                  }),
                  ...(thinkingSignature
                    ? { anthropicSignature: thinkingSignature }
                    : {}),
                },
              });
            }
            parts.push(
              ...redactedThinking.map((data) => ({
                text: '',
                thought: true,
                partMetadata: { anthropicRedactedThinking: data },
              })),
            );
            if (completedCompaction) {
              parts.push({
                text: '',
                thought: true,
                partMetadata: {
                  anthropicCompaction: {
                      type: 'compaction',
                      model: request.model,
                      compatibilityKey: this.compatibilityKey,
                      content: completedCompaction.content,
                    encrypted_content: completedCompaction.encryptedContent,
                  },
                },
              });
            }
            if (fullText) {
              parts.push({
                text: fullText,
                partMetadata: modelItemMetadata(textItemId, {
                  phase: outcome.kind === 'final' ? 'final' : 'commentary',
                  outcome,
                }),
              });
            }
            parts.push(
              ...completedToolCalls.map((call) => {
                const name =
                  request.toolNameByProviderName.get(call.name) ?? call.name;
                const parsed = normalizeToolArguments(name, call.arguments);
                return {
                functionCall: {
                  id: call.id,
                  name: parsed.name,
                  args: parsed.args,
                },
                partMetadata: modelItemMetadata(call.id, { outcome }),
                };
              }),
            );
            if (parts.length === 0) {
              parts.push({
                text: '',
                partMetadata: modelItemMetadata(textItemId, { outcome }),
              });
            }
            yield {
              content: { role: 'model', parts },
              partial: false,
              turnComplete: true,
              finishReason: anthropicFinishReason(stopReason),
              usageMetadata: anthropicUsage({
                inputTokens,
                outputTokens,
                cacheCreationTokens,
                cacheReadTokens,
              }),
              customMetadata: {
                provider: 'anthropic',
                wireApi: 'anthropicMessages',
                ...(contextInputTokens === undefined && inputTokens === undefined
                  ? {}
                  : {
                      contextInputTokens:
                        contextInputTokens ??
                        ((inputTokens ?? 0) +
                          (cacheCreationTokens ?? 0) +
                          (cacheReadTokens ?? 0)),
                    }),
              },
            };
            break;
          }
        }
      }
      if (!completed) {
        throw new ProviderAdapterError({
          kind: 'protocol',
          retryable: false,
          message: 'Anthropic stream ended before message_stop.',
        });
      }
    } catch (error) {
      if (deadline.didTimeout() && !abortSignal?.aborted) {
        throw new ProviderAdapterError({
          kind: 'timeout',
          retryable: true,
          message: `The model stream exceeded the ${this.timeoutMs} ms request deadline.`,
        });
      }
      if (
        this.nativeCompaction &&
        error instanceof Anthropic.APIError &&
        /context_management|compact_20260112|compaction/iu.test(error.message) &&
        /unsupported|unknown|unrecognized|invalid/iu.test(error.message)
      ) {
        this.nativeCompaction = false;
        throw new ProviderAdapterError({
          kind: 'contextWindowExceeded',
          retryable: false,
          message:
            'The endpoint does not support provider-native compaction; SugarCode will retry with application compaction.',
          ...(error.status === undefined ? {} : { status: error.status }),
        });
      }
      throw mapAnthropicError(error, abortSignal);
    } finally {
      deadline.dispose();
    }
  }

  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    void _llmRequest;
    return Promise.reject(
      new ProviderAdapterError({
        kind: 'invalidRequest',
        retryable: false,
        message: 'SugarCode does not enable the ADK Live API.',
      }),
    );
  }
}
