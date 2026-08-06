import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason, type Part } from '@google/genai';
import OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  EasyInputMessage,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputContent,
  ResponseStreamEvent,
  Tool as OpenAiResponseTool,
} from 'openai/resources/responses/responses';

import { ProviderAdapterError, cancelledProviderError } from './errors.ts';
import { normalizeLlmRequest } from './normalize-request.ts';
import { streamWithPreOutputRetry } from './retry.ts';
import type {
  NormalizedLlmRequest,
  NormalizedMediaPart,
  NormalizedMessage,
  NormalizedTool,
  ProviderAdapterOptions,
} from './types.ts';

export type OpenAiWireApi =
  | 'openaiResponses'
  | 'openaiChatCompletions';

export type OpenAiLlmOptions = ProviderAdapterOptions &
  Readonly<{ wireApi: OpenAiWireApi }>;

type ToolCallAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

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
      message: 'The model Base URL is invalid.',
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
      message: 'The model Base URL must be an HTTP(S) origin without credentials, query, or fragment.',
    });
  }
  return value.replace(/\/+$/u, '');
};

const jsonText = (value: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(value);

const parseToolArguments = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // ADK performs the user-visible schema validation after this response.
  }
  return { _sugarcodeInvalidArguments: value };
};

const finishReason = (value: string | null | undefined): FinishReason => {
  switch (value) {
    case 'length':
    case 'max_output_tokens':
      return FinishReason.MAX_TOKENS;
    case 'content_filter':
      return FinishReason.SAFETY;
    case 'stop':
    case 'tool_calls':
    case 'function_call':
    case 'completed':
      return FinishReason.STOP;
    default:
      return FinishReason.OTHER;
  }
};

const mediaUrl = (part: NormalizedMediaPart): string | undefined =>
  part.uri ??
  (part.data ? `data:${part.mimeType};base64,${part.data}` : undefined);

const providerNameByAdkName = (
  request: NormalizedLlmRequest,
): ReadonlyMap<string, string> =>
  new Map(request.tools.map((tool) => [tool.adkName, tool.providerName]));

const responseTools = (
  tools: readonly NormalizedTool[],
): readonly OpenAiResponseTool[] =>
  tools.map(
    (tool): OpenAiResponseTool => ({
      type: 'function',
      name: tool.providerName,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }),
  );

const chatTools = (
  tools: readonly NormalizedTool[],
): readonly ChatCompletionTool[] =>
  tools.map(
    (tool): ChatCompletionTool => ({
      type: 'function',
      function: {
        name: tool.providerName,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      },
    }),
  );

const responseMessageContent = (
  message: NormalizedMessage,
): readonly ResponseInputContent[] =>
  message.parts.flatMap((part): readonly ResponseInputContent[] => {
    if (part.type === 'text' && !part.thought) {
      return [{ type: 'input_text', text: part.text }];
    }
    if (part.type !== 'media') {
      return [];
    }
    const url = mediaUrl(part);
    if (!url) {
      return [];
    }
    if (part.mimeType.startsWith('image/')) {
      return [{ type: 'input_image', image_url: url, detail: 'auto' }];
    }
    if (part.mimeType === 'application/pdf') {
      return [
        {
          type: 'input_file',
          ...(part.uri ? { file_url: part.uri } : { file_data: url }),
          filename: part.name ?? 'document.pdf',
        },
      ];
    }
    return [];
  });

const responseInput = (request: NormalizedLlmRequest): ResponseInput => {
  const result: ResponseInput = [];
  const names = providerNameByAdkName(request);
  for (const message of request.messages) {
    const content = responseMessageContent(message);
    if (content.length > 0) {
      const inputMessage: EasyInputMessage = {
        type: 'message',
        role: message.role,
        content: [...content],
      };
      result.push(inputMessage);
    }
    for (const part of message.parts) {
      if (part.type === 'toolCall') {
        const item: ResponseFunctionToolCall = {
          type: 'function_call',
          call_id: part.id,
          name: names.get(part.name) ?? part.name,
          arguments: jsonText(part.args),
        };
        result.push(item);
      } else if (part.type === 'toolResult') {
        const item = {
          type: 'function_call_output',
          call_id: part.id,
          output: jsonText(part.result),
        } as const;
        result.push(item);
      }
    }
  }
  return result;
};

const chatUserContent = (
  message: NormalizedMessage,
): string | ChatCompletionContentPart[] => {
  const content: ChatCompletionContentPart[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && !part.thought) {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'media' && part.mimeType.startsWith('image/')) {
      const url = mediaUrl(part);
      if (url) {
        content.push({ type: 'image_url', image_url: { url } });
      }
    }
  }
  return content.length === 1 && content[0]?.type === 'text'
    ? content[0].text
    : content;
};

const chatMessages = (
  request: NormalizedLlmRequest,
): readonly ChatCompletionMessageParam[] => {
  const messages: ChatCompletionMessageParam[] = [];
  const names = providerNameByAdkName(request);
  if (request.system) {
    messages.push({ role: 'developer', content: request.system });
  }
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const text = message.parts
        .flatMap((part) =>
          part.type === 'text' && part.thought === false
            ? [part.text]
            : [],
        )
        .join('');
      const toolCalls = message.parts.flatMap((part) =>
        part.type === 'toolCall'
          ? [
              {
                id: part.id,
                type: 'function' as const,
                function: {
                  name: names.get(part.name) ?? part.name,
                  arguments: jsonText(part.args),
                },
              },
            ]
          : [],
      );
      if (text || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }
    const userContent = chatUserContent(message);
    if (
      (typeof userContent === 'string' && userContent.length > 0) ||
      (Array.isArray(userContent) && userContent.length > 0)
    ) {
      messages.push({ role: 'user', content: userContent });
    }
    for (const part of message.parts) {
      if (part.type === 'toolResult') {
        messages.push({
          role: 'tool',
          tool_call_id: part.id,
          content: jsonText(part.result),
        });
      }
    }
  }
  return messages;
};

const openAiUsage = (usage: unknown): LlmResponse['usageMetadata'] => {
  if (!isRecord(usage)) {
    return undefined;
  }
  const input =
    typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : typeof usage.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : undefined;
  const output =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : undefined;
  const total =
    typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : input !== undefined && output !== undefined
        ? input + output
        : undefined;
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : isRecord(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : undefined;
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : undefined;
  return {
    ...(input === undefined ? {} : { promptTokenCount: input }),
    ...(output === undefined ? {} : { candidatesTokenCount: output }),
    ...(total === undefined ? {} : { totalTokenCount: total }),
    ...(typeof outputDetails?.reasoning_tokens === 'number'
      ? { thoughtsTokenCount: outputDetails.reasoning_tokens }
      : {}),
    ...(typeof inputDetails?.cached_tokens === 'number'
      ? { cachedContentTokenCount: inputDetails.cached_tokens }
      : {}),
  };
};

const isRetryableStatus = (status: number | undefined): boolean =>
  status === 408 ||
  status === 409 ||
  status === 429 ||
  (status !== undefined && status >= 500);

const mapOpenAiError = (
  error: unknown,
  signal?: AbortSignal,
): ProviderAdapterError => {
  if (signal?.aborted || error instanceof OpenAI.APIUserAbortError) {
    return cancelledProviderError();
  }
  if (error instanceof ProviderAdapterError) {
    return error;
  }
  if (error instanceof OpenAI.APIError) {
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
      retryable: isRetryableStatus(status),
      message: error.message,
      ...(status === undefined ? {} : { status }),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(typeof error.requestID === 'string'
        ? { requestId: error.requestID }
        : {}),
    });
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderAdapterError({
      kind: 'timeout',
      retryable: true,
      message: error.message,
    });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderAdapterError({
      kind: 'connection',
      retryable: true,
      message: error.message,
    });
  }
  return new ProviderAdapterError({
    kind: 'unknown',
    retryable: false,
    message: error instanceof Error ? error.message : 'OpenAI request failed.',
  });
};

const compatibleReasoningDelta = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.reasoning_content === 'string'
    ? value.reasoning_content
    : typeof value.reasoning === 'string'
      ? value.reasoning
      : undefined;
};

export class OpenAiLlm extends BaseLlm {
  static readonly supportedModels = [/^openai:/u];

  private readonly client: OpenAI;
  private readonly wireApi: OpenAiWireApi;
  private readonly parallelTools: boolean;
  private readonly maxRetries: number;

  constructor(options: OpenAiLlmOptions) {
    super({ model: options.model });
    this.wireApi = options.wireApi;
    this.parallelTools = options.parallelTools ?? false;
    this.maxRetries = options.maxRetries ?? 2;
    this.client = new OpenAI({
      apiKey: options.apiKey || 'sugarcode-no-key',
      baseURL: validateBaseUrl(options.baseUrl),
      defaultHeaders: options.headers,
      timeout: options.timeoutMs ?? 120_000,
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
    try {
      if (this.wireApi === 'openaiResponses') {
        yield* this.streamResponses(request, abortSignal);
      } else {
        yield* this.streamChatCompletions(request, abortSignal);
      }
    } catch (error) {
      throw mapOpenAiError(error, abortSignal);
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

  private async *streamResponses(
    request: NormalizedLlmRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const callIds = new Map<string, string>();
    const completedCalls: ToolCallAccumulator[] = [];
    let text = '';
    let thought = '';
    const stream = streamWithPreOutputRetry<ResponseStreamEvent>({
      signal: abortSignal,
      maxRetries: this.maxRetries,
      shouldRetry: (error) => mapOpenAiError(error, abortSignal).details.retryable,
      create: async () =>
        this.client.responses.create(
          {
            model: request.model,
            input: responseInput(request),
            instructions: request.system || undefined,
            tools: [...responseTools(request.tools)],
            parallel_tool_calls: this.parallelTools,
            stream: true,
            store: false,
          },
          { signal: abortSignal },
        ),
    });
    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          text += event.delta;
          yield {
            content: { role: 'model', parts: [{ text: event.delta }] },
            partial: true,
          };
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          thought += event.delta;
          yield {
            content: {
              role: 'model',
              parts: [{ text: event.delta, thought: true }],
            },
            partial: true,
          };
          break;
        case 'response.output_item.added':
          if (event.item.type === 'function_call') {
            callIds.set(event.item.id, event.item.call_id);
          }
          break;
        case 'response.function_call_arguments.done': {
          completedCalls.push({
            id: callIds.get(event.item_id) ?? event.item_id,
            name: event.name,
            arguments: event.arguments,
          });
          break;
        }
        case 'response.completed': {
          const parts: Part[] = [];
          if (thought) {
            parts.push({ text: thought, thought: true });
          }
          if (text) {
            parts.push({ text });
          }
          parts.push(
            ...completedCalls.map((call) => ({
              functionCall: {
                id: call.id,
                name:
                  request.toolNameByProviderName.get(call.name) ?? call.name,
                args: parseToolArguments(call.arguments),
              },
            })),
          );
          yield {
            content: { role: 'model', parts },
            partial: false,
            turnComplete: true,
            finishReason: finishReason(event.response.status),
            usageMetadata: openAiUsage(event.response.usage),
            customMetadata: {
              provider: 'openai',
              wireApi: 'openaiResponses',
              responseId: event.response.id,
            },
          };
          break;
        }
        case 'response.failed':
        case 'response.incomplete':
          throw new ProviderAdapterError({
            kind: 'protocol',
            retryable: false,
            message: `OpenAI Responses ended with status ${event.response.status}.`,
          });
        case 'error':
          throw new ProviderAdapterError({
            kind: 'protocol',
            retryable: false,
            message: event.message,
            code: event.code,
          });
        default:
          break;
      }
    }
  }

  private async *streamChatCompletions(
    request: NormalizedLlmRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const calls = new Map<number, ToolCallAccumulator>();
    let text = '';
    let thought = '';
    let terminalReason: string | null | undefined;
    let usage: unknown;
    const stream = streamWithPreOutputRetry({
      signal: abortSignal,
      maxRetries: this.maxRetries,
      shouldRetry: (error) => mapOpenAiError(error, abortSignal).details.retryable,
      create: async () =>
        this.client.chat.completions.create(
          {
            model: request.model,
            messages: [...chatMessages(request)],
            tools: [...chatTools(request.tools)],
            parallel_tool_calls: this.parallelTools,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: abortSignal },
        ),
    });
    for await (const chunk of stream) {
      usage = chunk.usage ?? usage;
      for (const choice of chunk.choices) {
        terminalReason = choice.finish_reason ?? terminalReason;
        const reasoning = compatibleReasoningDelta(choice.delta);
        if (reasoning) {
          thought += reasoning;
          yield {
            content: {
              role: 'model',
              parts: [{ text: reasoning, thought: true }],
            },
            partial: true,
          };
        }
        if (choice.delta.content) {
          text += choice.delta.content;
          yield {
            content: {
              role: 'model',
              parts: [{ text: choice.delta.content }],
            },
            partial: true,
          };
        }
        for (const delta of choice.delta.tool_calls ?? []) {
          const current = calls.get(delta.index) ?? {
            id: delta.id ?? `call_${crypto.randomUUID()}`,
            name: '',
            arguments: '',
          };
          current.id = delta.id ?? current.id;
          current.name += delta.function?.name ?? '';
          current.arguments += delta.function?.arguments ?? '';
          calls.set(delta.index, current);
        }
      }
    }
    const parts: Part[] = [];
    if (thought) {
      parts.push({ text: thought, thought: true });
    }
    if (text) {
      parts.push({ text });
    }
    parts.push(
      ...[...calls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({
              functionCall: {
                id: call.id,
                name:
                  request.toolNameByProviderName.get(call.name) ?? call.name,
                args: parseToolArguments(call.arguments),
              },
        })),
    );
    yield {
      content: { role: 'model', parts },
      partial: false,
      turnComplete: true,
      finishReason: finishReason(terminalReason),
      usageMetadata: openAiUsage(usage),
      customMetadata: {
        provider: 'openai',
        wireApi: 'openaiChatCompletions',
      },
    };
  }
}
