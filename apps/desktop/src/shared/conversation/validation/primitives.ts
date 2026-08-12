export const isRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const hasBoundedText = (
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string =>
  typeof value === 'string' &&
  (allowEmpty || value.trim().length > 0) &&
  new TextEncoder().encode(value).byteLength <= maxBytes &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));
