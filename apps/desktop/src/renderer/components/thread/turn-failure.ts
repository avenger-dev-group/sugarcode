import type { ConversationTurnError } from '@/shared/conversation';

import type { TurnFailureViewModel } from './types';

const FAILURE_SUMMARIES: Record<ConversationTurnError['kind'], string> = {
  authentication: 'Model authentication failed',
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
  outputTooLarge: 'The model output was too large',
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
      : error.retryable
        ? 'You can send another message to retry.'
        : 'Review the request or model configuration before trying again.',
  retryable: error.retryable,
});
