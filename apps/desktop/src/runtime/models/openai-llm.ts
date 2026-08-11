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
  ResponseOutputMessage,
  ResponseStreamEvent,
  Tool as OpenAiResponseTool,
} from 'openai/resources/responses/responses';

import { ProviderAdapterError, cancelledProviderError } from './errors.ts';
import { normalizeLlmRequest } from './normalize-request.ts';
import { createRequestDeadline } from './request-deadline.ts';
import { streamWithPreOutputRetry } from './retry.ts';
import { modelItemMetadata } from './step-outcome.ts';
import { normalizeToolArguments } from './tool-arguments.ts';
import type {
  ModelStepOutcome,
  ModelTextPhase,
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
  itemId: string;
  id: string;
  name: string;
  arguments: string;
};

type TextItemAccumulator = {
  id: string;
  phase: ModelTextPhase;
  text: string;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MAX_OUTPUT_TOKENS = 65_536;

const maxOutputTokens = (request: NormalizedLlmRequest): number =>
  Math.max(
    1,
    Math.min(
      request.config?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS,
    ),
  );

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
      const phase = message.role === 'assistant'
        ? message.parts.find(
            (
              part,
            ): part is Extract<typeof part, { type: 'text' }> =>
              part.type === 'text' && part.phase !== undefined,
          )?.phase
        : undefined;
      const inputMessage: EasyInputMessage = {
        type: 'message',
        role: message.role,
        content: [...content],
        ...(phase === 'commentary'
          ? { phase: 'commentary' as const }
          : phase === 'final'
            ? { phase: 'final_answer' as const }
            : {}),
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
  private readonly timeoutMs: number;

  constructor(options: OpenAiLlmOptions) {
    super({ model: options.model });
    this.wireApi = options.wireApi;
    this.parallelTools = options.parallelTools ?? false;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.client = new OpenAI({
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
    try {
      if (this.wireApi === 'openaiResponses') {
        yield* this.streamResponses(request, deadline.signal);
      } else {
        yield* this.streamChatCompletions(request, deadline.signal);
      }
    } catch (error) {
      if (deadline.didTimeout() && !abortSignal?.aborted) {
        throw new ProviderAdapterError({
          kind: 'timeout',
          retryable: true,
          message: `The model stream exceeded the ${this.timeoutMs} ms request deadline.`,
        });
      }
      throw mapOpenAiError(error, abortSignal);
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

  private async *streamResponses(
    request: NormalizedLlmRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const callIds = new Map<string, string>();
    const completedCalls: ToolCallAccumulator[] = [];
    const textItems = new Map<string, TextItemAccumulator>();
    const textItemIdsByOutputIndex = new Map<number, string>();
    const reconciledTextItemIds = new Set<string>();
    const canonicalTextItemId = (
      outputIndex: number,
      observedItemId: string,
    ): string => {
      const itemId = textItemIdsByOutputIndex.get(outputIndex) ?? observedItemId;
      textItemIdsByOutputIndex.set(outputIndex, itemId);
      return itemId;
    };
    const reconcileTextOutput = (
      outputIndex: number,
      output: ResponseOutputMessage,
      forcedPhase?: ModelTextPhase,
    ): void => {
      const authoritativeText = output.content
        .flatMap((content) =>
          content.type === 'output_text' ? [content.text] : [],
        )
        .join('');
      const indexedItemId = textItemIdsByOutputIndex.get(outputIndex);
      const exactCandidates = authoritativeText.length > 0
        ? [...textItems.values()].filter(
            (item) =>
              !reconciledTextItemIds.has(item.id) &&
              item.text === authoritativeText,
          )
        : [];
      const itemId = textItems.get(output.id)?.text === authoritativeText
        ? output.id
        : indexedItemId &&
            textItems.get(indexedItemId)?.text === authoritativeText
          ? indexedItemId
          : exactCandidates.length === 1
            ? exactCandidates[0]?.id ?? output.id
            : indexedItemId ?? output.id;
      textItemIdsByOutputIndex.set(outputIndex, itemId);
      reconciledTextItemIds.add(itemId);
      const existing = textItems.get(itemId) ?? textItems.get(output.id);
      textItems.set(itemId, {
        id: itemId,
        phase: forcedPhase ?? (output.phase === 'commentary'
          ? 'commentary'
          : output.phase === 'final_answer'
            ? 'final'
            : 'provisional'),
        text: authoritativeText || existing?.text || '',
      });
      if (itemId !== output.id) {
        textItems.delete(output.id);
      }
    };
    let internalReasoning = '';
    let internalReasoningItemId = '';
    let reasoningSummary = '';
    let reasoningSummaryItemId = '';
    let completed = false;
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
            max_output_tokens: maxOutputTokens(request),
            stream: true,
            store: false,
          },
          { signal: abortSignal },
        ),
    });
    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta': {
          const itemId = canonicalTextItemId(
            event.output_index,
            event.item_id,
          );
          const current = textItems.get(itemId) ?? {
            id: itemId,
            phase: 'provisional' as const,
            text: '',
          };
          current.text += event.delta;
          textItems.set(itemId, current);
          yield {
            content: {
              role: 'model',
              parts: [{
                text: event.delta,
                partMetadata: modelItemMetadata(current.id, {
                  phase: current.phase,
                }),
              }],
            },
            partial: true,
          };
          break;
        }
        case 'response.reasoning_summary_text.delta':
          reasoningSummaryItemId ||= event.item_id;
          reasoningSummary += event.delta;
          yield {
            content: {
              role: 'model',
              parts: [{
                text: event.delta,
                thought: true,
                partMetadata: modelItemMetadata(event.item_id, {
                  phase: 'commentary',
                  reasoningVisibility: 'summary',
                }),
              }],
            },
            partial: true,
          };
          break;
        case 'response.reasoning_text.delta':
          internalReasoningItemId ||= event.item_id;
          internalReasoning += event.delta;
          yield {
            content: {
              role: 'model',
              parts: [{
                text: event.delta,
                thought: true,
                partMetadata: modelItemMetadata(event.item_id, {
                  phase: 'commentary',
                  reasoningVisibility: 'internal',
                }),
              }],
            },
            partial: true,
          };
          break;
        case 'response.output_item.added':
          if (event.item.type === 'function_call') {
            callIds.set(event.item.id, event.item.call_id);
          } else if (event.item.type === 'message') {
            const item = event.item as ResponseOutputMessage;
            const itemId = canonicalTextItemId(event.output_index, item.id);
            const existing = textItems.get(itemId) ?? textItems.get(item.id);
            textItems.set(itemId, {
              id: itemId,
              phase: item.phase === 'commentary'
                ? 'commentary'
                : item.phase === 'final_answer'
                  ? 'final'
                  : 'provisional',
              text: existing?.text ?? '',
            });
            if (itemId !== item.id) {
              textItems.delete(item.id);
            }
          }
          break;
        case 'response.function_call_arguments.done': {
          completedCalls.push({
            itemId: event.item_id,
            id: callIds.get(event.item_id) ?? event.item_id,
            name: event.name,
            arguments: event.arguments,
          });
          break;
        }
        case 'response.completed': {
          completed = true;
          for (const [outputIndex, output] of (
            event.response.output ?? []
          ).entries()) {
            if (output.type !== 'message') {
              continue;
            }
            reconcileTextOutput(outputIndex, output);
          }
          const hasTools = completedCalls.length > 0;
          const resolvedTextItems = [...textItems.values()].map((item) => ({
            ...item,
            phase: item.phase === 'provisional'
              ? hasTools ? 'commentary' as const : 'final' as const
              : item.phase,
          }));
          const hasFinal = resolvedTextItems.some(
            (item) => item.phase === 'final' && item.text.trim().length > 0,
          );
          const refused = (event.response.output ?? []).some(
            (output) =>
              output.type === 'message' &&
              output.content.some((content) => content.type === 'refusal'),
          );
          const outcome: ModelStepOutcome = refused
            ? {
                kind: 'failed',
                errorKind: 'filtered',
                message: 'The provider refused the model response.',
              }
            : hasTools
            ? { kind: 'toolCalls' }
            : hasFinal
              ? { kind: 'final' }
              : { kind: 'continue', reason: 'commentaryOnly' };
          const parts: Part[] = [];
          if (internalReasoning) {
            parts.push({
              text: internalReasoning,
              thought: true,
              partMetadata: modelItemMetadata(
                internalReasoningItemId || `reasoning_${event.response.id}`,
                {
                  phase: 'commentary',
                  reasoningVisibility: 'internal',
                },
              ),
            });
          }
          if (reasoningSummary) {
            parts.push({
              text: reasoningSummary,
              thought: true,
              partMetadata: modelItemMetadata(
                reasoningSummaryItemId || `reasoning_summary_${event.response.id}`,
                {
                  phase: 'commentary',
                  reasoningVisibility: 'summary',
                },
              ),
            });
          }
          parts.push(...resolvedTextItems
            .filter((item) => item.text.length > 0)
            .map((item) => ({
              text: item.text,
              partMetadata: modelItemMetadata(item.id, {
                phase: item.phase,
                outcome,
              }),
            })));
          parts.push(
            ...completedCalls.map((call) => {
              const name =
                request.toolNameByProviderName.get(call.name) ?? call.name;
              const parsed = normalizeToolArguments(name, call.arguments);
              return {
              functionCall: {
                id: call.id,
                name: parsed.name,
                args: parsed.args,
              },
              partMetadata: modelItemMetadata(call.itemId, { outcome }),
              };
            }),
          );
          if (parts.length === 0) {
            parts.push({
              text: '',
              partMetadata: modelItemMetadata(`message_${event.response.id}`, {
                outcome,
              }),
            });
          }
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
        case 'response.incomplete': {
          completed = true;
          const outcome: ModelStepOutcome = {
            kind: 'continue',
            reason: 'maxOutputTokens',
          };
          for (const [outputIndex, output] of (
            event.response.output ?? []
          ).entries()) {
            if (output.type !== 'message') {
              continue;
            }
            reconcileTextOutput(outputIndex, output, 'commentary');
          }
          const parts: Part[] = [];
          if (internalReasoning) {
            parts.push({
              text: internalReasoning,
              thought: true,
              partMetadata: modelItemMetadata(
                internalReasoningItemId || `reasoning_${event.response.id}`,
                {
                  phase: 'commentary',
                  reasoningVisibility: 'internal',
                },
              ),
            });
          }
          if (reasoningSummary) {
            parts.push({
              text: reasoningSummary,
              thought: true,
              partMetadata: modelItemMetadata(
                reasoningSummaryItemId || `reasoning_summary_${event.response.id}`,
                {
                  phase: 'commentary',
                  reasoningVisibility: 'summary',
                },
              ),
            });
          }
          parts.push(
            ...[...textItems.values()]
              .filter((item) => item.text.length > 0)
              .map((item) => ({
                text: item.text,
                partMetadata: modelItemMetadata(item.id, {
                  phase: 'commentary',
                  outcome,
                }),
              })),
          );
          if (parts.length === 0) {
            parts.push({
              text: '',
              partMetadata: modelItemMetadata(
                `incomplete_${event.response.id}`,
                { outcome },
              ),
            });
          }
          yield {
            content: { role: 'model', parts },
            partial: false,
            turnComplete: true,
            finishReason: FinishReason.STOP,
            usageMetadata: openAiUsage(event.response.usage),
          };
          break;
        }
        case 'response.failed':
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
    if (abortSignal?.aborted) {
      throw cancelledProviderError();
    }
    if (!completed) {
      throw new ProviderAdapterError({
        kind: 'protocol',
        retryable: false,
        message: 'OpenAI Responses stream ended before response.completed.',
      });
    }
  }

  private async *streamChatCompletions(
    request: NormalizedLlmRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const calls = new Map<number, ToolCallAccumulator>();
    const textItemId = `message_${crypto.randomUUID()}`;
    const reasoningItemId = `reasoning_${crypto.randomUUID()}`;
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
            max_completion_tokens: maxOutputTokens(request),
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
              parts: [{
                text: reasoning,
                thought: true,
                partMetadata: modelItemMetadata(reasoningItemId, {
                  phase: 'commentary',
                  reasoningVisibility: 'internal',
                }),
              }],
            },
            partial: true,
          };
        }
        if (choice.delta.content) {
          text += choice.delta.content;
          yield {
            content: {
              role: 'model',
              parts: [{
                text: choice.delta.content,
                partMetadata: modelItemMetadata(textItemId, {
                  phase: 'provisional',
                }),
              }],
            },
            partial: true,
          };
        }
        for (const delta of choice.delta.tool_calls ?? []) {
          const current = calls.get(delta.index) ?? {
            itemId: delta.id ?? `tool_${crypto.randomUUID()}`,
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
    if (abortSignal?.aborted) {
      throw cancelledProviderError();
    }
    if (!terminalReason) {
      throw new ProviderAdapterError({
        kind: 'protocol',
        retryable: false,
        message: 'OpenAI Chat Completions stream ended without a finish reason.',
      });
    }
    const hasTools = calls.size > 0;
    const outcome: ModelStepOutcome = terminalReason === 'length' ||
        terminalReason === 'max_output_tokens'
      ? { kind: 'continue', reason: 'maxOutputTokens' }
      : terminalReason === 'content_filter'
        ? {
            kind: 'failed',
            errorKind: 'filtered',
            message: 'The provider filtered the model response.',
          }
        : hasTools
          ? { kind: 'toolCalls' }
          : text.trim().length > 0
            ? { kind: 'final' }
            : { kind: 'continue', reason: 'commentaryOnly' };
    const phase: ModelTextPhase = outcome.kind === 'final'
      ? 'final'
      : 'commentary';
    const parts: Part[] = [];
    if (thought) {
      parts.push({
        text: thought,
        thought: true,
        partMetadata: modelItemMetadata(reasoningItemId, {
          phase: 'commentary',
          reasoningVisibility: 'internal',
        }),
      });
    }
    if (text) {
      parts.push({
        text,
        partMetadata: modelItemMetadata(textItemId, { phase, outcome }),
      });
    }
    parts.push(
      ...[...calls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => {
          const name = request.toolNameByProviderName.get(call.name) ?? call.name;
          const parsed = normalizeToolArguments(name, call.arguments);
          return {
              functionCall: {
                id: call.id,
                name: parsed.name,
                args: parsed.args,
              },
              partMetadata: modelItemMetadata(call.itemId, { outcome }),
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
      finishReason: finishReason(terminalReason),
      usageMetadata: openAiUsage(usage),
      customMetadata: {
        provider: 'openai',
        wireApi: 'openaiChatCompletions',
      },
    };
  }
}
