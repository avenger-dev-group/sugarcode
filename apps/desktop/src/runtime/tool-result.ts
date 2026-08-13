const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const WORKSPACE_INSPECTION_RECOVERY_KEY = 'workspaceInspection';
const WORKSPACE_INSPECTION_TOOLS = new Set([
  'workspace_list',
  'workspace_read',
  'workspace_search',
]);
const SHELL_INSPECTION_EXECUTABLES = new Set([
  'cat',
  'find',
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'stat',
  'tail',
  'wc',
]);

export const toolFailureRecoveryKey = (
  toolName: string,
  argumentsValue: Readonly<Record<string, unknown>> | undefined,
): string => {
  if (WORKSPACE_INSPECTION_TOOLS.has(toolName)) {
    return WORKSPACE_INSPECTION_RECOVERY_KEY;
  }
  if (
    toolName === 'shell_exec' &&
    argumentsValue?.mode === 'sandboxed' &&
    typeof argumentsValue.command === 'string'
  ) {
    const executable = argumentsValue.command.split(/[\\/]/u).at(-1);
    if (executable && SHELL_INSPECTION_EXECUTABLES.has(executable)) {
      return WORKSPACE_INSPECTION_RECOVERY_KEY;
    }
  }
  return toolName;
};

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
