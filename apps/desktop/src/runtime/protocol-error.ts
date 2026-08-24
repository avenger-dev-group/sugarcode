import { createHash } from 'node:crypto';

import type { RuntimeProviderError } from './protocol.ts';

type RuntimeProtocol = NonNullable<RuntimeProviderError['protocol']>;

const structuralShape = (value: unknown): unknown => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return value.map(structuralShape);
  }
  if (typeof value !== 'object') {
    return typeof value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, structuralShape(entry)]),
  );
};

export const protocolShapeSha256 = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(structuralShape(value)))
    .digest('hex');

export const protocolProviderError = (
  message: string,
  options: Readonly<{
    stage: RuntimeProtocol['stage'];
    code: RuntimeProtocol['code'];
    value: unknown;
    eventType?: string;
  }>,
): RuntimeProviderError => ({
  kind: 'protocol',
  retryable: false,
  message,
  protocol: {
    stage: options.stage,
    code: options.code,
    ...(options.eventType ? { eventType: options.eventType } : {}),
    shapeSha256: protocolShapeSha256(options.value),
  },
});

export class RuntimeProtocolError extends Error {
  readonly details: RuntimeProviderError;

  constructor(details: RuntimeProviderError) {
    super(details.message);
    this.name = 'RuntimeProtocolError';
    this.details = details;
  }
}
