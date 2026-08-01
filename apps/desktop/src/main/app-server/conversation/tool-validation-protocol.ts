const RECOVERABLE_VALIDATION_KINDS = new Set([
  'batchRejected',
  'invalidArguments',
  'unknownTool',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const hasOnlyKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

export const isRecoverableToolValidationItem = (
  value: unknown,
): boolean => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    !isId(value.name)
  ) {
    return false;
  }

  if (value.type === 'toolCall') {
    return (
      hasOnlyKeys(value, ['type', 'id', 'callId', 'name', 'path']) &&
      value.path === ''
    );
  }

  return (
    value.type === 'toolResult' &&
    hasOnlyKeys(value, ['type', 'id', 'callId', 'name', 'result']) &&
    isRecord(value.result) &&
    hasOnlyKeys(value.result, ['type', 'kind']) &&
    value.result.type === 'error' &&
    typeof value.result.kind === 'string' &&
    RECOVERABLE_VALIDATION_KINDS.has(value.result.kind)
  );
};
