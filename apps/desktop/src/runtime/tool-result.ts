const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const processOutcomeFailed = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'exitCode') {
    return typeof value.code === 'number' &&
      Number.isSafeInteger(value.code) &&
      value.code !== 0;
  }
  return value.type === 'signal' || value.type === 'timedOut';
};

export const toolResultFailed = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.ok === false ||
    value.status === 'error' ||
    value.status === 'failed' ||
    typeof value.error === 'string' ||
    isRecord(value.error)
  ) {
    return true;
  }
  const output = isRecord(value.output) ? value.output : undefined;
  return processOutcomeFailed(output?.outcome);
};

const isNotFoundResult = (value: unknown): boolean => {
  if (!isRecord(value) || value.ok !== false) {
    return false;
  }
  if (value.error === 'notFound' || value.kind === 'notFound') {
    return true;
  }
  return isRecord(value.error) && value.error.kind === 'notFound';
};

const isInformativeWorkspaceReadMiss = (value: unknown): boolean => {
  if (isNotFoundResult(value)) {
    return true;
  }
  if (!isRecord(value) || value.ok !== false || !Array.isArray(value.files)) {
    return false;
  }
  let hasMissingFile = false;
  for (const file of value.files) {
    if (isNotFoundResult(file)) {
      hasMissingFile = true;
      continue;
    }
    if (!isRecord(file) || file.ok !== true) {
      return false;
    }
  }
  return hasMissingFile;
};

export const toolResultRequiresFinalRecovery = (
  toolName: string,
  value: unknown,
): boolean =>
  toolResultFailed(value) &&
  !(toolName === 'workspace_read' && isInformativeWorkspaceReadMiss(value));
