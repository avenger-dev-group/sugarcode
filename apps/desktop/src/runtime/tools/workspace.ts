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

const parseNativeResult = (value: string): unknown => JSON.parse(value) as unknown;

export const createWorkspaceTools = (
  nativeRuntime: NativeRuntimeBinding,
  workspaceId: string,
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
];
