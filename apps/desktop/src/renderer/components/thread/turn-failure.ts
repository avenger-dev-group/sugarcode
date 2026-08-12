import type { ConversationTurnError } from '@/shared/conversation';

import type { ProcessLanguage, TurnFailureViewModel } from './types';

const FAILURE_SUMMARIES: Record<ConversationTurnError['kind'], string> = {
  authentication: 'Model authentication failed',
  contextWindowExceeded: 'The current request exceeded the model context window',
  invalidRequest: 'The model rejected this request',
  rateLimited: 'The model is rate limited',
  timeout: 'The model response timed out',
  transport: 'The model connection failed',
  disconnected: 'The model disconnected',
  server: 'The model service failed',
  protocol: 'The model response was invalid',
  incomplete: 'The model response was incomplete',
  filtered: 'The model response was filtered',
  unsupportedOutput: 'The model returned unsupported output',
  unsupportedToolArguments:
    'The model repeated the same failing tool call',
  providerRequestTooLarge: 'The provider rejected the request transport size',
  providerResponseTooLarge:
    'The provider returned an abnormally large internal response',
  outputTooLarge: 'The visible model or tool output exceeded the local limit',
  stateUnavailable: 'SugarCode could not save this Turn safely',
};

const LOCALIZED_TOOL_FAILURE = {
  en: {
    summary: 'The model repeated the same failing tool call',
    guidance:
      'SugarCode stopped the repeated failure before another attempt. Retry after reviewing the tool format, or choose a model with stronger structured-tool compatibility.',
  },
  zh: {
    summary: '模型重复提交了相同的失败工具调用',
    guidance:
      'SugarCode 已在再次尝试前停止重复失败。请检查工具格式后重试，或选择结构化工具兼容性更好的模型。',
  },
} as const;

const PROTOCOL_SUMMARIES: Record<
  NonNullable<ConversationTurnError['protocol']>['code'],
  string
> = {
  wireMismatch: 'The selected endpoint returned a different wire API',
  invalidEventShape: 'The model stream contained an invalid event shape',
  ambiguousOutputReconciliation:
    'The model output could not be reconciled safely',
  malformedToolCall: 'The model returned a malformed tool call',
  terminalLifecycleViolation:
    'The model stream continued after its terminal event',
  continuationOutputMismatch:
    'The model continuation did not match the current output',
  outputIndexMismatch: 'The model returned inconsistent output indexes',
};

const protocolGuidance = (
  protocol: NonNullable<ConversationTurnError['protocol']>,
): string =>
  protocol.code === 'wireMismatch'
    ? 'Review this profile’s configured wire API and gateway compatibility before trying again.'
    : protocol.code === 'malformedToolCall'
      ? 'Review the model’s tool-calling compatibility. SugarCode stopped before executing an ambiguous tool call.'
      : 'Retry only after reviewing the model or gateway stream compatibility. SugarCode stopped instead of guessing at the response.';

export const toTurnFailureViewModel = (
  error: ConversationTurnError,
  wireApi?:
    | 'openaiResponses'
    | 'openaiChatCompletions'
    | 'anthropicMessages',
  language: ProcessLanguage = 'en',
): TurnFailureViewModel => ({
  kind: error.kind,
  summary: error.protocol
    ? PROTOCOL_SUMMARIES[error.protocol.code]
    : error.kind === 'unsupportedToolArguments'
      ? LOCALIZED_TOOL_FAILURE[language].summary
      : FAILURE_SUMMARIES[error.kind],
  guidance:
    error.protocol
      ? protocolGuidance(error.protocol)
      : error.kind === 'stateUnavailable'
      ? 'Restart SugarCode before continuing. Your earlier saved messages are unchanged.'
      : error.kind === 'unsupportedToolArguments'
        ? LOCALIZED_TOOL_FAILURE[language].guidance
      : error.kind === 'outputTooLarge'
        ? 'Reduce the visible output or tool result size before trying again.'
        : error.kind === 'contextWindowExceeded'
          ? 'The provider still rejected the request after context recovery. Check the model context-window setting, run /compact, or choose a model with a larger context window.'
          : error.kind === 'providerRequestTooLarge'
            ? 'Reduce large visible inputs or choose a provider endpoint with a larger request-body limit.'
          : error.kind === 'providerResponseTooLarge'
              ? 'The conversation may still fit the model window. Retry or switch provider endpoints; an unusually large private continuation response was rejected for safety.'
              : error.kind === 'invalidRequest' &&
                  wireApi === 'openaiResponses'
                ? 'Verify the configured model ID and endpoint. If this is a general OpenAI-compatible gateway, switch the connection to Compatible Chat unless it explicitly supports Responses.'
                : error.kind === 'invalidRequest'
                  ? 'Verify the configured model ID, Base URL, and explicitly enabled capabilities before trying again.'
              : error.kind === 'protocol'
                ? 'This model did not follow the selected wire API. Review the gateway compatibility or switch model profiles before trying again.'
                : error.retryable
                  ? 'You can send another message to retry.'
                  : 'Review the request or model configuration before trying again.',
  retryable: error.retryable,
  protocol: error.protocol
    ? {
        stage: error.protocol.stage,
        code: error.protocol.code,
        eventType: error.protocol.eventType,
        fingerprint: error.protocol.shapeSha256.slice(0, 12),
      }
    : undefined,
});
