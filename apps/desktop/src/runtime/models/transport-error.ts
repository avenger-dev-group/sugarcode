type TransportFailureKind = 'connection' | 'timeout';

export type TransportFailure = Readonly<{
  kind: TransportFailureKind;
  code?: string;
}>;

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

const CONNECTION_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT',
  'UND_ERR_SOCKET',
]);

const errorField = (
  value: unknown,
  field: 'cause' | 'code' | 'message' | 'name',
): unknown =>
  typeof value === 'object' && value !== null && field in value
    ? (value as Record<string, unknown>)[field]
    : undefined;

/**
 * Classifies transport failures which can escape provider SDK wrappers while
 * an SSE response body is being consumed. Only stable platform/Undici shapes
 * are accepted so arbitrary provider messages do not become retryable.
 */
export const classifyTransportError = (
  error: unknown,
): TransportFailure | undefined => {
  const visited = new Set<unknown>();
  let messageFallback: TransportFailure | undefined;
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (
      (typeof current === 'object' && current !== null) ||
      typeof current === 'function'
    ) {
      if (visited.has(current)) {
        break;
      }
      visited.add(current);
    }
    const code = errorField(current, 'code');
    if (typeof code === 'string') {
      if (TIMEOUT_CODES.has(code)) {
        return { kind: 'timeout', code };
      }
      if (CONNECTION_CODES.has(code)) {
        return { kind: 'connection', code };
      }
    }
    const name = errorField(current, 'name');
    if (name === 'TimeoutError') {
      return { kind: 'timeout' };
    }
    const message = errorField(current, 'message');
    if (
      name === 'TypeError' &&
      (message === 'fetch failed' || message === 'terminated')
    ) {
      messageFallback = { kind: 'connection' };
    }
    current = errorField(current, 'cause');
  }
  return messageFallback;
};
