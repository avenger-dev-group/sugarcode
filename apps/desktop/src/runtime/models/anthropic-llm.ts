import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  RawMessageStreamEvent,
  StopReason,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages';
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason, type Part } from '@google/genai';

import { ProviderAdapterError, cancelledProviderError } from './errors.ts';
import { normalizeLlmRequest } from './normalize-request.ts';
import { createRequestDeadline } from './request-deadline.ts';
import { streamWithPreOutputRetry } from './retry.ts';
import type {
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
  | { type: 'thinking'; signature: string; text: string };

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

const parseArguments = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // ADK validates the final arguments and publishes a bounded tool error.
  }
  return { _sugarcodeInvalidArguments: value };
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
): readonly MessageParam[] => {
  const names = providerNameByAdkName(request);
  return request.messages.flatMap((message): readonly MessageParam[] => {
    const content = messageContent(message, names);
    return content.length === 0
      ? []
      : [{ role: message.role, content: [...content] }];
  });
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
      : { totalTokenCount: input + output }),
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
    return new ProviderAdapterError({
      kind:
        status === 401 || status === 403
          ? 'authentication'
          : status === 429
            ? 'rateLimit'
            : status !== undefined && status >= 500
              ? 'server'
              : 'invalidRequest',
      retryable: retryableStatus(status),
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

  constructor(options: ProviderAdapterOptions) {
    super({ model: options.model });
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 120_000;
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
    let stopReason: StopReason | null | undefined;
    let completed = false;
    try {
      const stream = streamWithPreOutputRetry<RawMessageStreamEvent>({
        signal: deadline.signal,
        maxRetries: this.maxRetries,
        shouldRetry: (error) =>
          mapAnthropicError(error, deadline.signal).details.retryable,
        create: async () =>
          this.client.messages.create(
            {
              model: request.model,
              max_tokens: Math.max(
                1,
                Math.min(request.config?.maxOutputTokens ?? 8_192, 65_536),
              ),
              messages: [...anthropicMessages(request)],
              system: request.system || undefined,
              tools: [...anthropicTools(request.tools)],
              stream: true,
            },
            { signal: deadline.signal },
          ),
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
                  parts: [{ text: event.content_block.text }],
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
                      { text: event.content_block.thinking, thought: true },
                    ],
                  },
                  partial: true,
                };
              }
            } else if (event.content_block.type === 'redacted_thinking') {
              redactedThinking.push(event.content_block.data);
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
                  parts: [{ text: event.delta.text }],
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
                  parts: [{ text: event.delta.thinking, thought: true }],
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
            }
            break;
          }
          case 'content_block_stop': {
            const block = blocks.get(event.index);
            if (block?.type === 'tool') {
              completedToolCalls.push(block);
            } else if (block?.type === 'thinking' && block.signature) {
              thinkingSignature = block.signature;
            }
            blocks.delete(event.index);
            break;
          }
          case 'message_delta':
            stopReason = event.delta.stop_reason;
            outputTokens = event.usage.output_tokens;
            break;
          case 'message_stop': {
            completed = true;
            const parts: Part[] = [];
            if (fullThinking || thinkingSignature) {
              parts.push({
                text: fullThinking,
                thought: true,
                ...(thinkingSignature
                  ? {
                      partMetadata: {
                        anthropicSignature: thinkingSignature,
                      },
                    }
                  : {}),
              });
            }
            parts.push(
              ...redactedThinking.map((data) => ({
                text: '',
                thought: true,
                partMetadata: { anthropicRedactedThinking: data },
              })),
            );
            if (fullText) {
              parts.push({ text: fullText });
            }
            parts.push(
              ...completedToolCalls.map((call) => ({
                functionCall: {
                  id: call.id,
                  name:
                    request.toolNameByProviderName.get(call.name) ?? call.name,
                  args: parseArguments(call.arguments),
                },
              })),
            );
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
