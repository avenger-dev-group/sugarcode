import type { RuntimeProviderError } from '../protocol.ts';

export class ProviderAdapterError extends Error {
  readonly details: RuntimeProviderError;

  constructor(details: RuntimeProviderError) {
    super(details.message);
    this.name = 'ProviderAdapterError';
    this.details = details;
  }
}

export const cancelledProviderError = (): ProviderAdapterError =>
  new ProviderAdapterError({
    kind: 'cancelled',
    retryable: false,
    message: 'The model request was cancelled.',
  });
