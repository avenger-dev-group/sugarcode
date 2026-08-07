import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';
import { isAbsolute } from 'node:path';

import type { NativeRuntimeBinding } from '../native.ts';

const pathProperty = {
  type: Type.STRING,
  description: 'Workspace-relative path. Use . for the workspace root.',
} satisfies Schema;

const pathSchema = {
  type: Type.OBJECT,
  properties: { path: pathProperty },
  required: ['path'],
} satisfies Schema;

const readSchema = {
  type: Type.OBJECT,
  properties: {
    path: pathProperty,
    paths: {
      type: Type.ARRAY,
      items: pathProperty,
      minItems: '1',
      maxItems: '8',
      description:
        'Read 1 through 8 workspace-relative files in one call. Use either path or paths, never both.',
    },
  },
  description: 'Provide exactly one of path or paths.',
} satisfies Schema;

const pathArgument = (input: unknown): string => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('path' in input) ||
    typeof input.path !== 'string'
  ) {
    throw new Error('path must be a string');
  }
  return input.path;
};

const readPathArguments = (input: unknown): readonly string[] => {
  if (typeof input !== 'object' || input === null) {
    throw new Error('path or paths must be provided');
  }
  const path = 'path' in input ? input.path : undefined;
  const paths = 'paths' in input ? input.paths : undefined;
  if (typeof path === 'string' && paths === undefined) {
    return [path];
  }
  if (
    path === undefined &&
    Array.isArray(paths) &&
    paths.length >= 1 &&
    paths.length <= 8 &&
    paths.every((entry) => typeof entry === 'string')
  ) {
    return paths;
  }
  throw new Error('Provide either one path or 1 through 8 paths');
};

const searchArguments = (input: unknown): { path: string; query: string } => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('path' in input) ||
    typeof input.path !== 'string' ||
    !('query' in input) ||
    typeof input.query !== 'string'
  ) {
    throw new Error('path and query must be strings');
  }
  return { path: input.path, query: input.query };
};

const searchSchema = {
  type: Type.OBJECT,
  properties: {
    path: pathProperty,
    query: {
      type: Type.STRING,
      description: 'Literal text to search for in UTF-8 workspace files.',
    },
  },
  required: ['path', 'query'],
} satisfies Schema;

const patchSchema = {
  type: Type.OBJECT,
  properties: {
    patch: {
      type: Type.STRING,
      description:
        'A complete SugarCode patch using exact `*** Begin Patch`, `*** Add File: path` / `*** Update File: path` / `*** Delete File: path`, and `*** End Patch` markers. GNU unified-diff `--- a/` and `+++ b/` headers are unsupported.',
    },
  },
  required: ['patch'],
} satisfies Schema;

const commandSchema = {
  type: Type.OBJECT,
  properties: {
    mode: {
      type: Type.STRING,
      enum: ['sandboxed', 'fullAccess'],
      description:
        'Use sandboxed for one direct absolute executable with no shell syntax; use fullAccess for pipelines, redirects, command chaining, or workspace writes.',
    },
    command: {
      type: Type.STRING,
      description:
        'For sandboxed mode, an absolute executable path such as /usr/bin/find. Never include arguments, pipes, redirects, or && here. For fullAccess mode, the complete shell command.',
    },
    arguments: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Each sandboxed executable argument as a separate string, for example ["src", "-type", "f"]. Omit for fullAccess mode.',
    },
    cwd: {
      type: Type.STRING,
      description:
        'Workspace-relative working directory for fullAccess mode. Sandboxed mode is fixed to the workspace root.',
    },
    timeoutMs: {
      type: Type.INTEGER,
      description: 'Full Access timeout in milliseconds, from 1 through 600000.',
    },
  },
  required: ['mode', 'command'],
} satisfies Schema;

const parseNativeResult = (value: string): unknown => JSON.parse(value) as unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidPatchFormat = (): Readonly<Record<string, unknown>> => ({
  ok: false,
  error: 'invalidPatchFormat',
  message:
    'Use the SugarCode patch format: `*** Begin Patch`, one or more `*** Add File: path`, `*** Update File: path`, or `*** Delete File: path` operations, then `*** End Patch`. GNU unified-diff headers are unsupported.',
});

const validPatchDocument = (patch: string): boolean => {
  const normalized = patch.replace(/\r\n/gu, '\n').trim();
  return (
    normalized.startsWith('*** Begin Patch\n') &&
    normalized.endsWith('\n*** End Patch') &&
    /^\*\*\* (?:Add|Update|Delete) File: .+$/mu.test(normalized)
  );
};

const explainPatchFailure = (result: unknown): unknown => {
  if (
    isRecord(result) &&
    result.ok === false &&
    result.error === 'UnsupportedDiffFeature'
  ) {
    return {
      ...result,
      message:
        'The patch used unsupported diff syntax. Retry with exact SugarCode `*** Begin Patch` and `*** Add File:`, `*** Update File:`, or `*** Delete File:` operation markers; do not use GNU `--- a/` or `+++ b/` headers.',
    };
  }
  return result;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const optionalStringArray = (value: unknown): string[] => {
  if (value === undefined) {
    return [];
  }
  if (!isStringArray(value)) {
    throw new Error('shell_exec arguments are invalid');
  }
  return value;
};

const optionalString = (value: unknown, fallback: string): string => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new Error('shell_exec arguments are invalid');
  }
  return value;
};

const optionalInteger = (value: unknown, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('shell_exec arguments are invalid');
  }
  return value;
};

const shellExecArgumentError = (
  mode: 'sandboxed' | 'fullAccess',
  command: string,
  commandArguments: readonly string[],
  cwd: string,
  timeoutMs: number,
): string | undefined => {
  if (command.trim().length === 0) {
    return 'shell_exec command must not be empty.';
  }
  if (timeoutMs < 1 || timeoutMs > 600_000) {
    return 'shell_exec timeoutMs must be an integer from 1 through 600000.';
  }
  if (mode === 'sandboxed' && cwd !== '.') {
    return 'Sandboxed shell_exec always runs at the workspace root; omit cwd or use ".".';
  }
  if (mode === 'sandboxed' && !isAbsolute(command)) {
    return 'Sandboxed shell_exec requires command to be one absolute executable path and accepts its arguments only through the arguments array. Use fullAccess for pipes, redirects, command chaining, or other shell syntax.';
  }
  if (mode === 'fullAccess' && commandArguments.length > 0) {
    return 'Full Access shell_exec requires the complete shell expression in command and does not accept an arguments array.';
  }
  return undefined;
};

const invalidShellExecArguments = (
  message: string,
): Readonly<Record<string, unknown>> => ({
  ok: false,
  error: 'invalidArguments',
  message,
});

export const executePrivilegedWorkspaceTool = async (
  nativeRuntime: NativeRuntimeBinding,
  operationId: string,
  workspaceId: string,
  toolName: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  onCommandOutput?: (
    operationId: string,
    stream: 'stdout' | 'stderr',
    delta: string,
  ) => void,
): Promise<unknown> => {
  if (toolName === 'workspace_apply_patch') {
    if (typeof argumentsValue.patch !== 'string') {
      throw new Error('workspace_apply_patch arguments are invalid');
    }
    return explainPatchFailure(parseNativeResult(
      await nativeRuntime.workspaceApplyPatch(
        workspaceId,
        argumentsValue.patch,
      ),
    ));
  }
  if (
    toolName !== 'shell_exec' ||
    (argumentsValue.mode !== 'sandboxed' &&
      argumentsValue.mode !== 'fullAccess') ||
    typeof argumentsValue.command !== 'string'
  ) {
    throw new Error(`Privileged workspace tool ${toolName} is not recoverable`);
  }
  const mode = argumentsValue.mode;
  const command = argumentsValue.command;
  const commandArguments = optionalStringArray(argumentsValue.arguments);
  const cwd = optionalString(argumentsValue.cwd, '.');
  const timeoutMs = optionalInteger(argumentsValue.timeoutMs, 300_000);
  const argumentError = shellExecArgumentError(
    mode,
    command,
    commandArguments,
    cwd,
    timeoutMs,
  );
  if (argumentError) {
    throw new Error(argumentError);
  }
  const flushOutput = (): void => {
    const chunks = parseNativeResult(
      nativeRuntime.drainCommandOutputJson(operationId),
    );
    if (!Array.isArray(chunks)) {
      throw new Error('Native command output was invalid');
    }
    for (const chunk of chunks) {
      if (
        typeof chunk !== 'object' ||
        chunk === null ||
        !('stream' in chunk) ||
        (chunk.stream !== 'stdout' && chunk.stream !== 'stderr') ||
        !('delta' in chunk) ||
        typeof chunk.delta !== 'string'
      ) {
        throw new Error('Native command output was invalid');
      }
      onCommandOutput?.(operationId, chunk.stream, chunk.delta);
    }
  };
  const execution = nativeRuntime.executeCommandJson(
    operationId,
    workspaceId,
    mode,
    command,
    JSON.stringify(commandArguments),
    cwd,
    timeoutMs,
  );
  const timer = setInterval(flushOutput, 16);
  try {
    const result = parseNativeResult(await execution);
    flushOutput();
    return result;
  } finally {
    clearInterval(timer);
    try {
      flushOutput();
    } finally {
      nativeRuntime.finishCommandOutput(operationId);
    }
  }
};

export const createWorkspaceTools = (
  nativeRuntime: NativeRuntimeBinding,
  workspaceId: string,
  runPrivileged?: (
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    execute: (operationId: string) => Promise<unknown>,
  ) => Promise<unknown>,
  onCommandOutput?: (
    operationId: string,
    stream: 'stdout' | 'stderr',
    delta: string,
  ) => void,
  access: 'readOnly' | 'workspaceWrite' = 'workspaceWrite',
): readonly FunctionTool<Schema>[] => {
  const tools: readonly FunctionTool<Schema>[] = [
  new FunctionTool({
    name: 'workspace_read',
    description:
      'Read one UTF-8 text file, or up to 8 files with paths, inside the open workspace without following symlinks.',
    parameters: readSchema,
    execute: async (input) => {
      const paths = readPathArguments(input);
      if (paths.length === 1) {
        return parseNativeResult(
          await nativeRuntime.workspaceRead(workspaceId, paths[0] ?? ''),
        );
      }
      const files: Readonly<Record<string, unknown>>[] = await Promise.all(
        paths.map(async (path) => {
          const result = parseNativeResult(
            await nativeRuntime.workspaceRead(workspaceId, path),
          );
          return isRecord(result)
            ? { ...result, path }
            : { path, result };
        }),
      );
      return {
        ok: files.every((file) => file.ok !== false),
        files,
      };
    },
  }),
  new FunctionTool({
    name: 'workspace_list',
    description:
      'List the direct children of a directory inside the open workspace.',
    parameters: pathSchema,
    execute: async (input) =>
      parseNativeResult(
        await nativeRuntime.workspaceList(workspaceId, pathArgument(input)),
      ),
  }),
  new FunctionTool({
    name: 'workspace_search',
    description:
      'Search UTF-8 files under a workspace directory for literal text.',
    parameters: searchSchema,
    execute: async (input) => {
      const { path, query } = searchArguments(input);
      return parseNativeResult(
        await nativeRuntime.workspaceSearch(workspaceId, path, query),
      );
    },
  }),
  new FunctionTool({
    name: 'workspace_apply_patch',
    description:
      'Create, update, move, or delete workspace files with an atomic apply_patch document. User approval is required before commit.',
    parameters: patchSchema,
    execute: async (input) => {
      if (
        typeof input !== 'object' ||
        input === null ||
        !('patch' in input) ||
        typeof input.patch !== 'string'
      ) {
        throw new Error('patch must be a string');
      }
      if (!runPrivileged) {
        return { ok: false, error: 'approvalUnavailable' };
      }
      const patch = input.patch;
      if (!validPatchDocument(patch)) {
        return invalidPatchFormat();
      }
      return runPrivileged(
        'workspace_apply_patch',
        { patch },
        async (operationId) => executePrivilegedWorkspaceTool(
          nativeRuntime,
          operationId,
          workspaceId,
          'workspace_apply_patch',
          { patch },
          onCommandOutput,
        ),
      );
    },
  }),
  new FunctionTool({
    name: 'shell_exec',
    description:
      'Run a bounded command in the workspace. Prefer sandboxed for a single absolute executable plus a separate arguments array; it is filesystem-read-only and network-denied. Use fullAccess only when shell syntax or writes are required. Every valid execution requires user approval.',
    parameters: commandSchema,
    execute: async (input) => {
      if (
        typeof input !== 'object' ||
        input === null ||
        !('mode' in input) ||
        (input.mode !== 'sandboxed' && input.mode !== 'fullAccess') ||
        !('command' in input) ||
        typeof input.command !== 'string'
      ) {
        throw new Error('shell_exec arguments are invalid');
      }
      const commandArgumentsValue = 'arguments' in input
        ? input.arguments
        : undefined;
      const cwdValue = 'cwd' in input ? input.cwd : undefined;
      const timeoutValue = 'timeoutMs' in input ? input.timeoutMs : undefined;
      const commandArguments = optionalStringArray(commandArgumentsValue);
      const cwd = optionalString(cwdValue, '.');
      const timeoutMs = optionalInteger(timeoutValue, 300_000);
      const mode = input.mode;
      const command = input.command;
      const argumentError = shellExecArgumentError(
        mode,
        command,
        commandArguments,
        cwd,
        timeoutMs,
      );
      if (argumentError) {
        return invalidShellExecArguments(argumentError);
      }
      if (!runPrivileged) {
        return { ok: false, error: 'approvalUnavailable' };
      }
      return runPrivileged(
        'shell_exec',
        { mode, command, arguments: commandArguments, cwd, timeoutMs },
        async (operationId) => executePrivilegedWorkspaceTool(
          nativeRuntime,
          operationId,
          workspaceId,
          'shell_exec',
          { mode, command, arguments: commandArguments, cwd, timeoutMs },
          onCommandOutput,
        ),
      );
    },
  }),
  ];
  return access === 'readOnly' ? tools.slice(0, 3) : tools;
};
