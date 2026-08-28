import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason, type Part } from '@google/genai';
import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  EasyInputMessage,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseCompactionItemParam,
  ResponseInputAudio,
  ResponseInputContent,
  ResponseStreamEvent,
  Tool as OpenAiResponseTool,
} from 'openai/resources/responses/responses';

import {
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
} from '../../shared/model-metadata.ts';
import {
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  MODEL_REQUEST_ATTEMPT_TIMEOUT_MS,
} from '../../shared/model-request-limits.ts';
import {
  RuntimeProtocolError,
  protocolProviderError,
  protocolShapeSha256,
} from '../protocol-error.ts';
import { ProviderAdapterError, cancelledProviderError } from './errors.ts';
import { normalizeLlmRequest } from './normalize-request.ts';
import {
  OpenAiResponsesReconciler,
  type ReconciledResponsesBlock,
} from './openai-responses-reconciler.ts';
import {
  openAiResponsesCompatibilityKey,
  openAiResponsesPartReplay,
  readOpenAiResponsesPartReplay,
} from './openai-responses-replay.ts';
import { createRequestDeadline } from './request-deadline.ts';
import { streamWithPreOutputRetry } from './retry.ts';
import { modelItemMetadata } from './step-outcome.ts';
import { normalizeToolArguments } from './tool-arguments.ts';
import { classifyTransportError } from './transport-error.ts';
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

const DEFAULT_MAX_OUTPUT_TOKENS = DEFAULT_AGENT_MAX_OUTPUT_TOKENS;
const MAX_OUTPUT_TOKENS = 65_536;

const maxOutputTokens = (request: NormalizedLlmRequest): number =>
  Math.max(
    1,
    Math.min(
      request.config?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS,
    ),
  );

const chatCompletionChunkCountsAsOutput = (
  chunk: ChatCompletionChunk,
): boolean =>
  (chunk.usage !== null && chunk.usage !== undefined) ||
  chunk.choices.some((choice) => {
    const reasoning = compatibleReasoningDelta(choice.delta);
    return (
      choice.finish_reason !== null ||
      (typeof choice.delta.content === 'string' &&
        choice.delta.content.length > 0) ||
      (reasoning?.length ?? 0) > 0 ||
      (choice.delta.tool_calls?.length ?? 0) > 0 ||
      (typeof choice.delta.refusal === 'string' &&
        choice.delta.refusal.length > 0)
    );
  });

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

const audioFormat = (
  mimeType: string,
): 'mp3' | 'wav' | undefined =>
  mimeType === 'audio/mpeg' || mimeType === 'audio/mp3'
    ? 'mp3'
    : mimeType === 'audio/wav' || mimeType === 'audio/x-wav'
      ? 'wav'
      : undefined;

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
    if (part.mimeType.startsWith('video/')) {
      return [
        {
          type: 'input_file',
          ...(part.uri ? { file_url: part.uri } : { file_data: url }),
          filename: part.name ?? 'video.mp4',
        },
      ];
    }
    return [];
  });

const responseInput = (
  request: NormalizedLlmRequest,
  compatibilityKey: string,
): ResponseInput => {
  const result: Array<ResponseInputItem | ResponseInputAudio> = [];
  const names = providerNameByAdkName(request);
  let startIndex = 0;
  let checkpoint: ResponseCompactionItemParam | undefined;
  for (const [index, message] of request.messages.entries()) {
    for (const part of message.parts) {
      const value = part.type === 'text' && isRecord(part.metadata?.openaiCompaction)
        ? part.metadata.openaiCompaction
        : undefined;
      if (
        isRecord(value) &&
        value.type === 'compaction' &&
        value.model === request.model &&
        value.compatibilityKey === compatibilityKey &&
        typeof value.encrypted_content === 'string'
      ) {
        checkpoint = {
          type: 'compaction',
          encrypted_content: value.encrypted_content,
          ...(typeof value.id === 'string' ? { id: value.id } : {}),
        };
        startIndex = index + 1;
      }
    }
  }
  if (checkpoint) {
    result.push(checkpoint);
  }
  for (const message of request.messages.slice(startIndex)) {
    const replayItems: ResponseInputItem[] = [];
    const replayReasoningIds = new Set<string>();
    let replayable = message.role === 'assistant';
    let sawReplay = false;
    for (const part of message.parts) {
      if (part.type !== 'text' && part.type !== 'toolCall') {
        replayable = false;
        continue;
      }
      const replay = readOpenAiResponsesPartReplay(part.metadata);
      if (!replay) {
        replayable = false;
        continue;
      }
      sawReplay = true;
      if (replay.compatibilityKey !== compatibilityKey) {
        replayable = false;
        continue;
      }
      if (part.type === 'text' && replay.block.type === 'reasoning') {
        if (!replayReasoningIds.has(replay.block.item.id)) {
          replayReasoningIds.add(replay.block.item.id);
          replayItems.push(replay.block.item);
        }
      } else if (part.type === 'text' && replay.block.type === 'text') {
        replayItems.push({
          type: 'message',
          id: replay.block.itemId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: part.text, annotations: [] }],
          ...(replay.block.phase === 'commentary'
            ? { phase: 'commentary' as const }
            : replay.block.phase === 'final'
              ? { phase: 'final_answer' as const }
              : {}),
        });
      } else if (part.type === 'toolCall' && replay.block.type === 'toolCall') {
        if (replay.block.callId !== part.id) {
          throw new ProviderAdapterError(protocolProviderError(
            'Stored Responses replay metadata does not match its tool call.',
            {
              stage: 'outputNormalization',
              code: 'continuationOutputMismatch',
              eventType: 'history.replay',
              value: { part, replay: replay.block },
            },
          ));
        }
        replayItems.push({
          type: 'function_call',
          ...(replay.block.itemId ? { id: replay.block.itemId } : {}),
          call_id: replay.block.callId,
          name: names.get(part.name) ?? part.name,
          arguments: jsonText(part.args),
          status: 'completed',
        });
      } else {
        replayable = false;
      }
    }
    if (sawReplay && replayable && replayItems.length > 0) {
      result.push(...replayItems);
      continue;
    }
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
      if (part.type !== 'media' || !part.data) {
        continue;
      }
      const format = audioFormat(part.mimeType);
      if (!format) {
        continue;
      }
      const audio: ResponseInputAudio = {
        type: 'input_audio',
        input_audio: { data: part.data, format },
      };
      result.push(audio);
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
  try {
    const normalized: Array<ResponseInputItem | ResponseInputAudio> = [];
    for (const item of result) {
      if (item.type === 'input_audio') {
        normalized.push(item);
      } else {
        normalized.push(...toResponseInputItems([item]));
      }
    }
    return normalized as ResponseInput;
  } catch (error) {
    throw new ProviderAdapterError(protocolProviderError(
      error instanceof Error
        ? `Stored Responses history could not be normalized: ${error.message}`
        : 'Stored Responses history could not be normalized.',
      {
        stage: 'outputNormalization',
        code: 'continuationOutputMismatch',
        eventType: 'history.replay',
        value: result,
      },
    ));
  }
};

const chatUserContent = (
  message: NormalizedMessage,
): string | Array<
  | ChatCompletionContentPart
  | Readonly<{
      type: 'video_url';
      video_url: Readonly<{ url: string; fps?: number }>;
    }>
> => {
  const content: Array<
    | ChatCompletionContentPart
    | Readonly<{
        type: 'video_url';
        video_url: Readonly<{ url: string; fps?: number }>;
      }>
  > = [];
  for (const part of message.parts) {
    if (part.type === 'text' && !part.thought) {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'media' && part.mimeType.startsWith('image/')) {
      const url = mediaUrl(part);
      if (url) {
        content.push({ type: 'image_url', image_url: { url } });
      }
    } else if (part.type === 'media' && part.mimeType.startsWith('video/')) {
      const url = mediaUrl(part);
      if (url) {
        content.push({
          type: 'video_url',
          video_url: { url, ...(part.fps === undefined ? {} : { fps: part.fps }) },
        });
      }
    } else if (part.type === 'media' && part.data) {
      const format = audioFormat(part.mimeType);
      if (format) {
        content.push({
          type: 'input_audio',
          input_audio: { data: part.data, format },
        });
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
    messages.push({ role: 'system', content: request.system });
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
      messages.push({
        role: 'user',
        content: userContent,
      } as ChatCompletionMessageParam);
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

const assertValidChatToolHistory = (
  messages: readonly ChatCompletionMessageParam[],
): void => {
  let pending = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (pending.size > 0) {
      if (message.role !== 'tool' || !pending.delete(message.tool_call_id)) {
        throw new ProviderAdapterError(protocolProviderError(
          'SugarCode blocked an incomplete tool-call history before sending it to the model.',
          {
            stage: 'outputNormalization',
            code: 'continuationOutputMismatch',
            eventType: 'history.chatCompletions',
            value: {
              index,
              role: message.role,
              pendingCallIds: [...pending].sort(),
              ...(message.role === 'tool'
                ? { receivedCallId: message.tool_call_id }
                : {}),
            },
          },
        ));
      }
      continue;
    }
    if (message.role === 'tool') {
      throw new ProviderAdapterError(protocolProviderError(
        'SugarCode blocked an orphaned tool result before sending it to the model.',
        {
          stage: 'outputNormalization',
          code: 'continuationOutputMismatch',
          eventType: 'history.chatCompletions',
          value: { index, receivedCallId: message.tool_call_id },
        },
      ));
    }
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      continue;
    }
    const callIds = message.tool_calls.map((call) => call.id);
    pending = new Set(callIds);
    if (pending.size !== callIds.length || callIds.some((id) => !id)) {
      throw new ProviderAdapterError(protocolProviderError(
        'SugarCode blocked duplicate or empty tool-call identifiers before sending them to the model.',
        {
          stage: 'outputNormalization',
          code: 'malformedToolCall',
          eventType: 'history.chatCompletions',
          value: { index, callIds },
        },
      ));
    }
  }
  if (pending.size > 0) {
    throw new ProviderAdapterError(protocolProviderError(
      'SugarCode blocked an incomplete tool-call history before sending it to the model.',
      {
        stage: 'outputNormalization',
        code: 'continuationOutputMismatch',
        eventType: 'history.chatCompletions',
        value: { pendingCallIds: [...pending].sort() },
      },
    ));
  }
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
  if (error instanceof RuntimeProtocolError) {
    return new ProviderAdapterError(error.details);
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
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const contextWindowExceeded =
      error.code === 'context_length_exceeded' ||
      /context (?:length|window)|maximum context|too many tokens/iu.test(
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
      retryable: contextWindowExceeded ? false : isRetryableStatus(status),
      message: error.message,
      ...(status === undefined ? {} : { status }),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(typeof error.requestID === 'string'
        ? { requestId: error.requestID }
        : {}),
    });
  }
  const transport = classifyTransportError(error);
  if (transport) {
    return new ProviderAdapterError({
      kind: transport.kind,
      retryable: true,
      message: error instanceof Error
        ? error.message
        : 'The model connection ended unexpectedly.',
      ...(transport.code ? { code: transport.code } : {}),
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

const responseReasoningParts = (
  blocks: readonly ReconciledResponsesBlock[],
  compatibilityKey: string,
  responseId: string,
): readonly Part[] =>
  blocks.flatMap((block): readonly Part[] => {
    if (block.type !== 'reasoning') {
      return [];
    }
    const replay = openAiResponsesPartReplay(
      compatibilityKey,
      responseId,
      { type: 'reasoning', item: block.item },
    );
    const parts: Part[] = [];
    const internal = (block.item.content ?? [])
      .map((part) => part.text)
      .join('');
    const summary = block.item.summary.map((part) => part.text).join('');
    if (internal) {
      parts.push({
        text: internal,
        thought: true,
        partMetadata: {
          ...modelItemMetadata(block.item.id, {
            phase: 'commentary',
            reasoningVisibility: 'internal',
          }),
          ...replay,
        },
      });
    }
    if (summary) {
      parts.push({
        text: summary,
        thought: true,
        partMetadata: {
          ...modelItemMetadata(block.item.id, {
            phase: 'commentary',
            reasoningVisibility: 'summary',
          }),
          ...replay,
        },
      });
    }
    if (
      parts.length === 0 &&
      typeof block.item.encrypted_content === 'string'
    ) {
      parts.push({
        text: '',
        thought: true,
        partMetadata: {
          ...modelItemMetadata(block.item.id, {
            phase: 'commentary',
            reasoningVisibility: 'internal',
          }),
          ...replay,
        },
      });
    }
    return parts;
  });

export class OpenAiLlm extends BaseLlm {
  static readonly supportedModels = [/^openai:/u];

  private readonly client: OpenAI;
  private readonly wireApi: OpenAiWireApi;
  private readonly parallelTools: boolean;
  private readonly maxRetries?: number;
  private readonly timeoutMs: number;
  private nativeCompaction: boolean;
  private readonly compactThresholdTokens?: number;
  private readonly compatibilityKey: string;
  private readonly reasoningEffort?: Exclude<
    ProviderAdapterOptions['reasoningEffort'],
    'auto' | undefined
  >;
  private readonly serviceTier?: 'default' | 'priority';

  constructor(options: OpenAiLlmOptions) {
    super({ model: options.model });
    const baseUrl = validateBaseUrl(options.baseUrl);
    this.wireApi = options.wireApi;
    this.parallelTools = options.parallelTools ?? false;
    this.maxRetries = options.maxRetries;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
    this.nativeCompaction = options.nativeCompaction === true;
    this.compactThresholdTokens = options.compactThresholdTokens;
    this.compatibilityKey = options.wireApi === 'openaiResponses'
      ? openAiResponsesCompatibilityKey(baseUrl, options.model)
      : `${options.wireApi}:${baseUrl}:${options.model}`;
    this.reasoningEffort = options.reasoningEffort === 'auto'
      ? undefined
      : options.reasoningEffort;
    this.serviceTier = options.serviceTier === 'fast'
      ? 'priority'
      : options.serviceTier === 'standard'
        ? 'default'
        : undefined;
    this.client = new OpenAI({
      apiKey: options.apiKey || 'sugarcode-no-key',
      baseURL: baseUrl,
      defaultHeaders: options.headers,
      timeout: Math.min(
        this.timeoutMs,
        MODEL_REQUEST_ATTEMPT_TIMEOUT_MS,
      ),
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
        yield* this.streamResponses(
          request,
          deadline.dispose,
          deadline.signal,
        );
      } else {
        yield* this.streamChatCompletions(
          request,
          deadline.dispose,
          deadline.signal,
        );
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
        error instanceof OpenAI.APIError &&
        /context_management|compaction/iu.test(error.message) &&
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
    settleRequestDeadline: () => void,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const reconciler = new OpenAiResponsesReconciler();
    const streamDiagnostics = new Map<string, Set<string>>();
    const completedCalls: ToolCallAccumulator[] = [];
    const textItems = new Map<string, TextItemAccumulator>();
    const stream = streamWithPreOutputRetry<ResponseStreamEvent>({
      signal: abortSignal,
      maxRetries: this.maxRetries,
      shouldRetry: (error) => mapOpenAiError(error, abortSignal).details.retryable,
      countsAsOutput: (event) =>
        event.type !== 'response.created' &&
        event.type !== 'response.in_progress' &&
        event.type !== 'response.queued',
      create: async () =>
        this.client.responses.create(
          {
            model: request.model,
            input: responseInput(request, this.compatibilityKey),
            instructions: request.system || undefined,
            tools: [...responseTools(request.tools)],
            parallel_tool_calls: this.parallelTools,
            max_output_tokens: maxOutputTokens(request),
            ...(this.reasoningEffort
              ? { reasoning: { effort: this.reasoningEffort } }
              : {}),
            ...(this.serviceTier
              ? { service_tier: this.serviceTier }
              : {}),
            ...(this.nativeCompaction
              ? {
                  context_management: [{
                    type: 'compaction',
                    ...(this.compactThresholdTokens === undefined
                      ? {}
                      : { compact_threshold: this.compactThresholdTokens }),
                  }],
                }
              : {}),
            stream: true,
            store: false,
          },
          { signal: abortSignal },
        ),
    });
    for await (const event of stream) {
      const fingerprints = streamDiagnostics.get(event.type) ?? new Set();
      fingerprints.add(protocolShapeSha256(event));
      streamDiagnostics.set(event.type, fingerprints);
      switch (event.type) {
        case 'response.output_text.delta': {
          const itemId = reconciler.onTextDelta(
            event.output_index,
            event.item_id,
            event.delta,
          );
          yield {
            content: {
              role: 'model',
              parts: [{
                text: event.delta,
                partMetadata: modelItemMetadata(itemId, {
                  phase: 'provisional',
                }),
              }],
            },
            partial: true,
          };
          break;
        }
        case 'response.reasoning_summary_text.delta': {
          const itemId = reconciler.onReasoningDelta(
            'summary',
            event.output_index,
            event.item_id,
            event.delta,
          );
          if (!itemId) {
            break;
          }
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
        }
        case 'response.reasoning_text.delta': {
          const itemId = reconciler.onReasoningDelta(
            'content',
            event.output_index,
            event.item_id,
            event.delta,
          );
          if (!itemId) {
            break;
          }
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
        }
        case 'response.output_item.added':
          reconciler.onOutputItemAdded(event.output_index, event.item);
          break;
        case 'response.function_call_arguments.done': {
          reconciler.onFunctionCallArgumentsDone({
            outputIndex: event.output_index,
            itemId: event.item_id,
            name: event.name,
            arguments: event.arguments,
          });
          break;
        }
        case 'response.output_item.done':
          reconciler.onOutputItemDone(event.output_index, event.item);
          break;
        case 'response.completed': {
          const terminal = reconciler.finish(event.response, event.type);
          completedCalls.length = 0;
          textItems.clear();
          for (const block of terminal.blocks) {
            if (block.type === 'text') {
              textItems.set(block.itemId, {
                id: block.itemId,
                phase: block.phase,
                text: block.text,
              });
            } else if (block.type === 'toolCall') {
              completedCalls.push({
                itemId: block.itemId ?? block.callId,
                id: block.callId,
                name: block.name,
                arguments: block.arguments,
              });
            }
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
          const refused = terminal.refused;
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
          const parts: Part[] = [...responseReasoningParts(
            terminal.blocks,
            this.compatibilityKey,
            terminal.responseId,
          )];
          parts.push(...resolvedTextItems
            .filter((item) => item.text.length > 0)
            .map((item) => ({
              text: item.text,
              partMetadata: {
                ...modelItemMetadata(item.id, {
                  phase: item.phase,
                  outcome,
                }),
                ...openAiResponsesPartReplay(
                  this.compatibilityKey,
                  terminal.responseId,
                  { type: 'text', itemId: item.id, phase: item.phase },
                ),
              },
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
              partMetadata: {
                ...modelItemMetadata(call.itemId, { outcome }),
                ...openAiResponsesPartReplay(
                  this.compatibilityKey,
                  terminal.responseId,
                  {
                    type: 'toolCall',
                    itemId: call.itemId,
                    callId: call.id,
                  },
                ),
              },
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
          for (const output of terminal.compactions) {
            parts.push({
              text: '',
              thought: true,
              partMetadata: {
                openaiCompaction: {
                  type: 'compaction',
                  id: output.id,
                  model: request.model,
                  compatibilityKey: this.compatibilityKey,
                  encrypted_content: output.encrypted_content,
                },
              },
            });
          }
          // ADK may pause this generator at the terminal yield while it runs
          // tool calls. Provider timeouts must not include that tool work.
          settleRequestDeadline();
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
              streamDiagnostics: [...streamDiagnostics.entries()].flatMap(
                ([eventType, shapes]) => [...shapes].map((shapeSha256) => ({
                  eventType,
                  shapeSha256,
                })),
              ),
              ...(typeof event.response.usage?.input_tokens === 'number'
                ? { contextInputTokens: event.response.usage.input_tokens }
                : {}),
            },
          };
          break;
        }
        case 'response.incomplete': {
          const terminal = reconciler.finish(event.response, event.type);
          textItems.clear();
          for (const block of terminal.blocks) {
            if (block.type === 'text') {
              textItems.set(block.itemId, {
                id: block.itemId,
                phase: 'commentary',
                text: block.text,
              });
            }
          }
          const outcome: ModelStepOutcome = {
            kind: 'continue',
            reason: 'maxOutputTokens',
          };
          const parts: Part[] = [...responseReasoningParts(
            terminal.blocks,
            this.compatibilityKey,
            terminal.responseId,
          )];
          parts.push(
            ...[...textItems.values()]
              .filter((item) => item.text.length > 0)
              .map((item) => ({
                text: item.text,
                partMetadata: {
                  ...modelItemMetadata(item.id, {
                    phase: 'commentary',
                    outcome,
                  }),
                  ...openAiResponsesPartReplay(
                    this.compatibilityKey,
                    terminal.responseId,
                    { type: 'text', itemId: item.id, phase: 'commentary' },
                  ),
                },
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
          // The provider is terminal even though ADK may take time to request
          // the next generator item.
          settleRequestDeadline();
          yield {
            content: { role: 'model', parts },
            partial: false,
            turnComplete: true,
            finishReason: FinishReason.STOP,
            usageMetadata: openAiUsage(event.response.usage),
            customMetadata: {
              provider: 'openai',
              wireApi: 'openaiResponses',
              responseId: event.response.id,
              streamDiagnostics: [...streamDiagnostics.entries()].flatMap(
                ([eventType, shapes]) => [...shapes].map((shapeSha256) => ({
                  eventType,
                  shapeSha256,
                })),
              ),
            },
          };
          break;
        }
        case 'response.failed':
          throw new ProviderAdapterError(protocolProviderError(
            `OpenAI Responses ended with status ${event.response.status}.`,
            {
              stage: 'streamEvent',
              code: 'terminalLifecycleViolation',
              eventType: event.type,
              value: event.response,
            },
          ));
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
    reconciler.assertTerminated();
  }

  private async *streamChatCompletions(
    request: NormalizedLlmRequest,
    settleRequestDeadline: () => void,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const calls = new Map<number, ToolCallAccumulator>();
    const textItemId = `message_${crypto.randomUUID()}`;
    const reasoningItemId = `reasoning_${crypto.randomUUID()}`;
    let text = '';
    let thought = '';
    let terminalReason: string | null | undefined;
    let usage: unknown;
    const messages = chatMessages(request);
    assertValidChatToolHistory(messages);
    const stream = streamWithPreOutputRetry({
      signal: abortSignal,
      maxRetries: this.maxRetries,
      shouldRetry: (error) => mapOpenAiError(error, abortSignal).details.retryable,
      countsAsOutput: chatCompletionChunkCountsAsOutput,
      create: async () =>
        this.client.chat.completions.create(
          {
            model: request.model,
            messages: [...messages],
            tools: [...chatTools(request.tools)],
            parallel_tool_calls: this.parallelTools,
            max_completion_tokens: maxOutputTokens(request),
            ...(this.reasoningEffort
              ? { reasoning_effort: this.reasoningEffort }
              : {}),
            ...(this.serviceTier
              ? { service_tier: this.serviceTier }
              : {}),
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
    // Tool execution begins after this terminal yield, outside provider time.
    settleRequestDeadline();
    yield {
      content: { role: 'model', parts },
      partial: false,
      turnComplete: true,
      finishReason: finishReason(terminalReason),
      usageMetadata: openAiUsage(usage),
      customMetadata: {
        provider: 'openai',
        wireApi: 'openaiChatCompletions',
        ...(isRecord(usage) && typeof usage.prompt_tokens === 'number'
          ? { contextInputTokens: usage.prompt_tokens }
          : {}),
      },
    };
  }
}
