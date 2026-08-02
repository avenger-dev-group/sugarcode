import type { ConversationTurnError } from '@/shared/conversation';

import type { TurnFailureViewModel } from './types';

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
    'The model repeatedly returned invalid tool arguments',
  providerRequestTooLarge: 'The provider rejected the request transport size',
  providerResponseTooLarge:
    'The provider returned an abnormally large internal response',
  outputTooLarge: 'The visible model or tool output exceeded the local limit',
  stateUnavailable: 'SugarCode could not save this Turn safely',
};

export const toTurnFailureViewModel = (
  error: ConversationTurnError,
): TurnFailureViewModel => ({
  kind: error.kind,
  summary: FAILURE_SUMMARIES[error.kind],
  guidance:
    error.kind === 'stateUnavailable'
      ? 'Restart SugarCode before continuing. Your earlier saved messages are unchanged.'
      : error.kind === 'outputTooLarge'
        ? 'Reduce the visible output or tool result size before trying again.'
        : error.kind === 'contextWindowExceeded'
          ? 'SugarCode already attempted context recovery. Continue in a new task or choose a model with a larger context window.'
          : error.kind === 'providerRequestTooLarge'
            ? 'Reduce large visible inputs or choose a provider endpoint with a larger request-body limit.'
            : error.kind === 'providerResponseTooLarge'
              ? 'The conversation may still fit the model window. Retry or switch provider endpoints; an unusually large private continuation response was rejected for safety.'
              : error.kind === 'protocol'
                ? 'This model did not follow the selected wire API. Review the gateway compatibility or switch model profiles before trying again.'
                : error.retryable
                  ? 'You can send another message to retry.'
                  : 'Review the request or model configuration before trying again.',
  retryable: error.retryable,
});
