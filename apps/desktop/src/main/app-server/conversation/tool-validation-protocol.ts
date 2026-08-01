const VALIDATION_KINDS = new Set([
  'batchRejected',
  'invalidArguments',
  'unknownTool',
  'headerCountMismatch',
  'rangeOutOfBounds',
  'expectedMismatch',
  'baseRevisionMismatch',
  'unsupportedDiffFeature',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isOptionalIndex = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);

export const isToolValidationRejectedItem = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    value.type !== 'toolValidationRejected' ||
    !isId(value.id) ||
    !isId(value.callId) ||
    !isId(value.name) ||
    typeof value.kind !== 'string' ||
    !VALIDATION_KINDS.has(value.kind) ||
    typeof value.argumentsBytes !== 'number' ||
    !Number.isSafeInteger(value.argumentsBytes) ||
    value.argumentsBytes < 0 ||
    value.argumentsBytes > 96 * 1024 ||
    typeof value.argumentsSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.argumentsSha256) ||
    !isOptionalIndex(value.editIndex) ||
    !isOptionalIndex(value.hunkIndex) ||
    !isOptionalIndex(value.line) ||
    (value.expectedSummary !== undefined &&
      typeof value.expectedSummary !== 'string') ||
    (value.actualSummary !== undefined &&
      typeof value.actualSummary !== 'string') ||
    !isId(value.suggestedAction)
  ) {
    return false;
  }
  const allowedKeys = new Set([
    'type',
    'id',
    'callId',
    'name',
    'kind',
    'argumentsBytes',
    'argumentsSha256',
    'editIndex',
    'hunkIndex',
    'line',
    'expectedSummary',
    'actualSummary',
    'suggestedAction',
  ]);
  return Object.keys(value).every((key) => allowedKeys.has(key));
};
