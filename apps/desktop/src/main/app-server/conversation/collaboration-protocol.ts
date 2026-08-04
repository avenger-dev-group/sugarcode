const HIDDEN_COLLABORATION_TOOL_NAMES = new Set([
  'collaboration/dispatch',
  'collaboration/amend',
  'collaboration/wait',
  'collaboration/interrupt',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const isHiddenCollaborationItem = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !isId(value.callId) ||
    typeof value.name !== 'string' ||
    !HIDDEN_COLLABORATION_TOOL_NAMES.has(value.name)
  ) {
    return false;
  }
  if (value.type === 'toolCall') {
    return Object.keys(value).length === 5 && isRecord(value.arguments);
  }
  if (
    value.type !== 'toolResult' ||
    Object.keys(value).length !== 5 ||
    !isRecord(value.result)
  ) {
    return false;
  }
  if (
    value.result.type === 'success' &&
    Object.keys(value.result).length === 3 &&
    typeof value.result.content === 'string' &&
    typeof value.result.bytes === 'number' &&
    Number.isSafeInteger(value.result.bytes) &&
    value.result.bytes >= 0
  ) {
    return utf8Bytes(value.result.content) === value.result.bytes;
  }
  return (
    value.result.type === 'error' &&
    Object.keys(value.result).length === 2 &&
    typeof value.result.kind === 'string' &&
    value.result.kind.length > 0
  );
};
