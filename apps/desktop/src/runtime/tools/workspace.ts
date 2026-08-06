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

const parseNativeResult = (value: string): unknown => JSON.parse(value) as unknown;

export const createWorkspaceTools = (
  nativeRuntime: NativeRuntimeBinding,
  workspaceId: string,
  runPrivileged?: (
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    execute: () => Promise<unknown>,
  ) => Promise<unknown>,
): readonly FunctionTool<Schema>[] => [
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
];
