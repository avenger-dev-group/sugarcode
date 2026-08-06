import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';

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
        'A complete SugarCode apply_patch document with Begin Patch and End Patch markers.',
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
        'sandboxed runs an absolute executable read-only without network; fullAccess runs shell syntax after explicit approval.',
    },
    command: {
      type: Type.STRING,
      description:
        'Absolute executable path for sandboxed mode, or complete shell command for fullAccess mode.',
    },
    arguments: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Argument array for sandboxed mode. Omit for fullAccess mode.',
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
      'Read a UTF-8 text file inside the open workspace without following symlinks.',
    parameters: pathSchema,
    execute: async (input) =>
      parseNativeResult(
        await nativeRuntime.workspaceRead(workspaceId, pathArgument(input)),
      ),
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
      return runPrivileged(
        'workspace_apply_patch',
        { patch },
        async () => parseNativeResult(
          await nativeRuntime.workspaceApplyPatch(workspaceId, patch),
        ),
      );
    },
  }),
  new FunctionTool({
    name: 'shell_exec',
    description:
      'Run a bounded command in the workspace. Sandboxed mode is filesystem-read-only and network-denied. Full Access supports shell syntax and can modify files. Every execution requires user approval.',
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
      if (!runPrivileged) {
        return { ok: false, error: 'approvalUnavailable' };
      }
      const mode = input.mode;
      const command = input.command;
      if (
        command.trim().length === 0 ||
        timeoutMs < 1 ||
        timeoutMs > 600_000 ||
        (mode === 'sandboxed' && cwd !== '.') ||
        (mode === 'fullAccess' && commandArguments.length > 0)
      ) {
        throw new Error('shell_exec arguments are invalid for the selected mode');
      }
      return runPrivileged(
        'shell_exec',
        { mode, command, arguments: commandArguments, cwd, timeoutMs },
        async (operationId) => {
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
        },
      );
    },
  }),
  ];
  return access === 'readOnly' ? tools.slice(0, 3) : tools;
};
