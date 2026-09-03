import { BasePlugin, type LlmResponse } from '@google/adk';

import type { RuntimeProviderError } from '../contracts/protocol.ts';

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

export class ProviderErrorCapturePlugin extends BasePlugin {
  private capturedError: RuntimeProviderError | undefined;

  constructor() {
    super('sugarcode_provider_error_capture');
  }

  override async onModelErrorCallback(
    { error }: Parameters<BasePlugin['onModelErrorCallback']>[0],
  ): Promise<LlmResponse | undefined> {
    if (error instanceof ProviderAdapterError) {
      this.capturedError = error.details;
    }
    return undefined;
  }

  takeCapturedError = (): RuntimeProviderError | undefined => {
    const error = this.capturedError;
    this.capturedError = undefined;
    return error;
  };
}
