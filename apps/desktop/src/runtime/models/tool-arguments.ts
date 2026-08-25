import { INVALID_TOOL_ARGUMENTS_TOOL_NAME } from './types.ts';

const MAX_ARGUMENT_TEXT_BYTES = 4_096;
const MAX_WORKSPACE_READ_PATHS = 8;
const MAX_WORKSPACE_LIST_PATHS = 8;
const MAX_COLLABORATION_TASKS = 12;
const MAX_COLLABORATION_TASKS_TEXT_BYTES = 64 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBoundedPathArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= MAX_WORKSPACE_READ_PATHS &&
  value.every((path) => typeof path === 'string' && path.length > 0);

const repairWorkspaceReadArguments = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  if (
    Object.keys(value).length !== 1 ||
    typeof value.paths !== 'string' ||
    value.paths.length > MAX_ARGUMENT_TEXT_BYTES
  ) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value.paths);
    return isBoundedPathArray(parsed) ? { paths: parsed } : value;
  } catch {
    return value;
  }
};

const repairCollaborationDispatchArguments = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  if (
    typeof value.tasks !== 'string' ||
    Buffer.byteLength(value.tasks, 'utf8') >
      MAX_COLLABORATION_TASKS_TEXT_BYTES
  ) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value.tasks);
    return Array.isArray(parsed) &&
        parsed.length >= 1 &&
        parsed.length <= MAX_COLLABORATION_TASKS &&
        parsed.every(isRecord)
      ? { ...value, tasks: parsed }
      : value;
  } catch {
    return value;
  }
};

const parseConcatenatedJsonObjects = (
  value: string,
): readonly Readonly<Record<string, unknown>>[] | undefined => {
  const source = value.trim();
  if (
    source.length === 0 ||
    source.length > MAX_ARGUMENT_TEXT_BYTES ||
    source[0] !== '{'
  ) {
    return undefined;
  }
  const objects: Readonly<Record<string, unknown>>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (depth === 0) {
      if (/\s/u.test(character ?? '')) {
        continue;
      }
      if (character !== '{') {
        return undefined;
      }
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(source.slice(start, index + 1));
          if (!isRecord(parsed)) {
            return undefined;
          }
          objects.push(parsed);
        } catch {
          return undefined;
        }
      }
    }
  }
  return depth === 0 && !inString && objects.length > 1 ? objects : undefined;
};

export const normalizeToolArguments = (
  toolName: string,
  value: string,
): Readonly<{ name: string; args: Record<string, unknown> }> => {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    if (isRecord(parsed)) {
      return {
        name: toolName,
        args: toolName === 'workspace_read'
          ? repairWorkspaceReadArguments(parsed)
          : toolName === 'collaboration_dispatch'
            ? repairCollaborationDispatchArguments(parsed)
          : parsed,
      };
    }
  } catch {
    // Report a wire-level tool argument failure before any tool or approval runs.
  }
  const concatenated = parseConcatenatedJsonObjects(value);
  if (
    toolName === 'workspace_read' &&
    concatenated &&
    concatenated.length <= MAX_WORKSPACE_READ_PATHS &&
    concatenated.every(
      (entry) =>
        Object.keys(entry).length === 1 &&
        typeof entry.path === 'string' &&
        entry.path.length > 0,
    )
  ) {
    return {
      name: toolName,
      args: { paths: concatenated.map((entry) => entry.path as string) },
    };
  }
  if (
    toolName === 'workspace_list' &&
    concatenated &&
    concatenated.length <= MAX_WORKSPACE_LIST_PATHS &&
    concatenated.every(
      (entry) =>
        Object.keys(entry).length === 1 &&
        typeof entry.path === 'string' &&
        entry.path.length > 0,
    )
  ) {
    return {
      name: toolName,
      args: { paths: concatenated.map((entry) => entry.path as string) },
    };
  }
  return {
    name: INVALID_TOOL_ARGUMENTS_TOOL_NAME,
    args: {
      toolName,
      argumentsText: value.slice(0, MAX_ARGUMENT_TEXT_BYTES),
    },
  };
};
