import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';
import { basename, isAbsolute } from 'node:path';

import type { NativeRuntimeBinding } from '../native.ts';
import {
  drawioAddPatch,
  isDrawioPath,
  validateDrawioXml,
} from './drawio.ts';
import {
  instructionScopeForFile,
  instructionScopesForPatch,
  type WorkspaceInstructionContext,
  type WorkspaceInstructionError,
} from '../workspace-instructions.ts';

const MAX_DECLARED_WORKSPACE_READ_PATHS = 8;
const MAX_COMPATIBLE_WORKSPACE_READ_PATHS = 16;

const pathProperty = {
  type: Type.STRING,
  description: 'Workspace-relative path. Use . for the workspace root.',
} satisfies Schema;

const readPathProperty = {
  type: Type.STRING,
  description:
    'Workspace-relative path to one UTF-8 regular file. Never pass a directory; use workspace_list for an entry whose kind is directory.',
} satisfies Schema;

const pathSchema = {
  type: Type.OBJECT,
  properties: { path: pathProperty },
  required: ['path'],
} satisfies Schema;

const readSchema = {
  type: Type.OBJECT,
  properties: {
    path: readPathProperty,
    paths: {
      type: Type.ARRAY,
      items: readPathProperty,
      minItems: '1',
      maxItems: String(MAX_DECLARED_WORKSPACE_READ_PATHS),
      description:
        `Read 1 through ${MAX_DECLARED_WORKSPACE_READ_PATHS} workspace-relative files in one call. Use either path or paths, never both.`,
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
    paths.length <= MAX_COMPATIBLE_WORKSPACE_READ_PATHS &&
    paths.every((entry) => typeof entry === 'string')
  ) {
    return paths;
  }
  const requested = Array.isArray(paths) ? paths.length : undefined;
  throw new Error(
    requested !== undefined && requested > MAX_COMPATIBLE_WORKSPACE_READ_PATHS
      ? `Requested ${requested} paths; the hard limit is ${MAX_COMPATIBLE_WORKSPACE_READ_PATHS}. Split them across multiple workspace_read calls.`
      : `Provide either one path or a paths array. Use no more than ${MAX_DECLARED_WORKSPACE_READ_PATHS} paths per call.`,
  );
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
        'A complete SugarCode patch with one outer `*** Begin Patch` / `*** End Patch` pair around all file operations. For Add File, provide the complete unprefixed body or prefix every body line with `+`; do not mix forms. Every Update File body is a patch hunk with removed lines prefixed by `-` and added lines prefixed by `+`; unchanged context may appear around `@@`. Never paste an unprefixed complete file body after Update File. Keep patches small; after a context mismatch, re-read and retry only the affected file. GNU unified-diff headers are unsupported. Example: `*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-old\\n+new\\n*** End Patch`.',
    },
  },
  required: ['patch'],
} satisfies Schema;

const drawioSchema = {
  type: Type.OBJECT,
  properties: {
    path: {
      type: Type.STRING,
      description:
        'New workspace-relative .drawio file path, for example leave-approval.drawio. Use a descriptive unique name; existing files are not overwritten. Prefer the workspace root unless you already verified that a target directory exists.',
    },
    xml: {
      type: Type.STRING,
      description:
        'Complete, uncompressed Draw.io XML with an mxGraphModel root, or an mxfile containing an inline mxGraphModel. Write native mxCell nodes, mxGeometry coordinates, styles, and edges directly. Do not wrap it in Markdown fences. Use unique ids, standard root cells 0 and 1, labels in the user\'s language, non-overlapping coordinates, distinct colors by node role, and orthogonal arrows where useful. Escape XML attribute characters. Do not use DOCTYPE, ENTITY, scripts, external images, or compressed diagram payloads.',
    },
  },
  required: ['path', 'xml'],
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
        'For sandboxed mode, an absolute executable path such as /usr/bin/find. Never include arguments, pipes, redirects, or && here. For fullAccess mode, the complete shell command. The selected workspace is already the working directory; never prepend `cd` to an invented absolute project path. Use the workspace-relative cwd field when a subdirectory is required.',
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
        'Workspace-relative working directory for fullAccess mode; omit it for the selected workspace root. Sandboxed mode is fixed to the workspace root.',
    },
    timeoutMs: {
      type: Type.INTEGER,
      description: 'Full Access timeout in milliseconds, from 1 through 600000.',
    },
  },
  required: ['mode', 'command'],
} satisfies Schema;

const projectActionSchema = {
  type: Type.OBJECT,
  properties: {
    actionId: {
      type: Type.STRING,
      description: 'The exact action id declared in .sugarcode/project.json.',
    },
  },
  required: ['actionId'],
} satisfies Schema;

const parseNativeResult = (value: string): unknown => JSON.parse(value) as unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withInstructionWarnings = (
  result: unknown,
  warnings: readonly WorkspaceInstructionError[],
): unknown => warnings.length === 0
  ? result
  : isRecord(result)
    ? { ...result, workspaceInstructionsWarning: warnings }
    : { result, workspaceInstructionsWarning: warnings };

const workspaceReadResult = (result: unknown, path: string): unknown =>
  isRecord(result) && result.ok === false && result.error === 'notRegularFile'
    ? {
        ...result,
        message: `${path} is not a regular file. If it is a directory, inspect it with workspace_list and read only returned entries whose kind is file.`,
      }
    : result;

const invalidPatchFormat = (): Readonly<Record<string, unknown>> => ({
  ok: false,
  error: 'invalidPatchFormat',
  message:
    'Use a SugarCode `*** Begin Patch` / file-operation / `*** End Patch` document containing at least one `*** Add File: path`, `*** Update File: path`, or `*** Delete File: path` operation. GNU unified-diff headers are unsupported.',
});

const normalizePatchDocument = (patch: string): string => {
  let lines = patch.replace(/\r\n/gu, '\n').trim().split('\n');
  if (
    /^```(?:patch|diff)?$/iu.test(lines[0]?.trim() ?? '') &&
    lines.at(-1)?.trim() === '```' &&
    lines.length >= 4
  ) {
    lines = lines.slice(1, -1);
  }
  const heredoc = /^(?:(?:workspace_apply_patch|apply_patch)\s+)?<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1$/u.exec(
    lines[0]?.trim() ?? '',
  );
  if (
    heredoc?.[2] &&
    lines.at(-1)?.trim() === heredoc[2] &&
    lines.length >= 4
  ) {
    lines = lines.slice(1, -1);
  }
  const hasBegin = lines.some((line) => line.trim() === '*** Begin Patch');
  const hasEnd = lines.some((line) => line.trim() === '*** End Patch');
  if (!hasBegin || !hasEnd) {
    return lines.join('\n');
  }
  const body = lines.filter(
    (line) =>
      line.trim() !== '*** Begin Patch' &&
      line.trim() !== '*** End Patch',
  );
  return ['*** Begin Patch', ...body, '*** End Patch'].join('\n');
};

const validPatchDocument = (patch: string): boolean => {
  const normalized = patch.trim();
  const lines = normalized.split('\n');
  return (
    lines[0] === '*** Begin Patch' &&
    lines.at(-1) === '*** End Patch' &&
    lines.filter((line) => line === '*** Begin Patch').length === 1 &&
    lines.filter((line) => line === '*** End Patch').length === 1 &&
    /^\*\*\* (?:Add|Update|Delete) File: .+$/mu.test(normalized)
  );
};

const updateSectionsHaveChanges = (patch: string): boolean => {
  const lines = patch.replace(/\r\n/gu, '\n').trim().split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.startsWith('*** Update File: ')) {
      continue;
    }
    let bodyIndex = index + 1;
    if (lines[bodyIndex]?.startsWith('*** Move to: ')) {
      bodyIndex += 1;
      if (
        bodyIndex >= lines.length ||
        lines[bodyIndex]?.startsWith('*** Add File: ') ||
        lines[bodyIndex]?.startsWith('*** Update File: ') ||
        lines[bodyIndex]?.startsWith('*** Delete File: ') ||
        lines[bodyIndex] === '*** End Patch'
      ) {
        continue;
      }
    }
    let hasChangeLine = false;
    while (bodyIndex < lines.length) {
      const line = lines[bodyIndex] ?? '';
      if (
        line.startsWith('*** Add File: ') ||
        line.startsWith('*** Update File: ') ||
        line.startsWith('*** Delete File: ') ||
        line === '*** End Patch'
      ) {
        break;
      }
      if (line.startsWith('+') || line.startsWith('-')) {
        hasChangeLine = true;
      }
      bodyIndex += 1;
    }
    if (!hasChangeLine) {
      return false;
    }
  }
  return true;
};

const invalidPatchUpdate = (): Readonly<Record<string, unknown>> => ({
  ok: false,
  error: 'invalidPatchUpdate',
  message:
    'Each `*** Update File:` body must contain changed lines: prefix removed lines with `-` and added lines with `+` (an optional `@@` context marker may come first). Do not paste the complete file body without diff prefixes. Example: `*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-old\\n+new\\n*** End Patch`.',
});

const updateSectionsHaveEffectiveChanges = (patch: string): boolean => {
  const lines = patch.replace(/\r\n/gu, '\n').trim().split('\n');
  let removed: string[] = [];
  let added: string[] = [];
  let inUpdate = false;
  const flushHunk = (): boolean => {
    const identical =
      removed.length > 0 &&
      removed.length === added.length &&
      removed.every((line, index) => line === added[index]);
    removed = [];
    added = [];
    return !identical;
  };

  for (const line of lines) {
    if (
      line.startsWith('*** Add File: ') ||
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Delete File: ') ||
      line === '*** End Patch'
    ) {
      if (inUpdate && !flushHunk()) {
        return false;
      }
      inUpdate = line.startsWith('*** Update File: ');
      continue;
    }
    if (!inUpdate) {
      continue;
    }
    if (line.startsWith('@@')) {
      if (!flushHunk()) {
        return false;
      }
      continue;
    }
    if (line.startsWith('-')) {
      removed.push(line.slice(1));
    } else if (line.startsWith('+')) {
      added.push(line.slice(1));
    }
  }
  return !inUpdate || flushHunk();
};

const invalidPatchNoop = (): Readonly<Record<string, unknown>> => ({
  ok: false,
  error: 'invalidPatchNoop',
  message:
    'A patch hunk removes and re-adds identical text, so it cannot change the file. To replace a line, prefix the existing workspace line with `-` and the different replacement line with `+`. Re-read the file first if the expected text has already changed.',
});

const patchPathAtOperation = (
  patch: string,
  operationIndex: number,
): string | undefined =>
  patch
    .split('\n')
    .flatMap((line) => {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(
        line.trim(),
      );
      return match?.[1] ? [match[1].trim()] : [];
    })[operationIndex];

type WorkspacePatchApprovalOperation = Readonly<{
  kind: 'create' | 'update' | 'delete' | 'move';
  path: string;
  destination?: string;
}>;

const workspacePatchApprovalOperations = (
  patch: string,
): readonly WorkspacePatchApprovalOperation[] => {
  const operations: WorkspacePatchApprovalOperation[] = [];
  const lines = patch.replace(/\r\n/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(
      lines[index]?.trim() ?? '',
    );
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const path = match[2].trim();
    const destination = match[1] === 'Update'
      ? /^\*\*\* Move to: (.+)$/u.exec(lines[index + 1]?.trim() ?? '')?.[1]
      : undefined;
    operations.push({
      kind: destination
        ? 'move'
        : match[1] === 'Add'
          ? 'create'
          : match[1] === 'Delete'
            ? 'delete'
            : 'update',
      path,
      ...(destination ? { destination: destination.trim() } : {}),
    });
  }
  return operations;
};

const workspacePatchInstructionPaths = (patch: string): readonly string[] =>
  workspacePatchApprovalOperations(patch).flatMap((operation) =>
    operation.destination
      ? [operation.path, operation.destination]
      : [operation.path]
  );

const safeApprovalPath = (value: string): string => {
  let result = '';
  for (const character of value) {
    if (/\p{Cc}/u.test(character)) {
      continue;
    }
    if (Buffer.byteLength(result + character, 'utf8') > 240) {
      break;
    }
    result += character;
  }
  return result;
};

export const workspacePatchApprovalSummary = (patch: string): string => {
  const operations = workspacePatchApprovalOperations(patch);
  if (operations.length === 0) {
    return 'Modify workspace files';
  }
  const labels: Record<WorkspacePatchApprovalOperation['kind'], string> = {
    create: 'Create',
    update: 'Update',
    delete: 'Delete',
    move: 'Move',
  };
  const heading = `${operations.length} workspace file ${operations.length === 1 ? 'change' : 'changes'}`;
  const lines: string[] = [heading];
  for (const [index, operation] of operations.entries()) {
    const source = safeApprovalPath(operation.path);
    const destination = operation.destination
      ? safeApprovalPath(operation.destination)
      : undefined;
    const line = destination
      ? `${labels[operation.kind]} ${source} -> ${destination}`
      : `${labels[operation.kind]} ${source}`;
    const remaining = operations.length - index;
    const suffix = remaining > 1 ? `\n...and ${remaining} more` : '';
    if (
      Buffer.byteLength(`${lines.join('\n')}\n${line}${suffix}`, 'utf8') >
      1_024
    ) {
      lines.push(`...and ${remaining} more`);
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
};

const explainPatchFailure = (result: unknown, patch: string): unknown => {
  if (
    isRecord(result) &&
    result.ok === false &&
    result.error === 'UnsupportedDiffFeature'
  ) {
    return {
      ...result,
      message:
        'The patch used unsupported SugarCode syntax. For `*** Add File:`, provide the complete unprefixed body or prefix every body line with `+`. For `*** Update File:`, send a hunk with removed lines prefixed by `-` and added lines prefixed by `+`; unchanged context may appear around `@@`. Do not use GNU `--- a/` or `+++ b/` headers.',
    };
  }
  if (
    isRecord(result) &&
    result.ok === false &&
    result.error === 'ExpectedMismatch'
  ) {
    const operationIndex =
      typeof result.operationIndex === 'number' &&
      Number.isSafeInteger(result.operationIndex) &&
      result.operationIndex >= 0
        ? result.operationIndex
        : undefined;
    const failedPath = operationIndex === undefined
      ? undefined
      : patchPathAtOperation(patch, operationIndex);
    const diagnostic = isRecord(result.diagnostic)
      ? result.diagnostic
      : undefined;
    const line =
      typeof diagnostic?.line === 'number' &&
      Number.isSafeInteger(diagnostic.line)
        ? diagnostic.line
        : undefined;
    const target = failedPath ? ` \`${failedPath}\`` : ' the affected file';
    const location = line === undefined ? '' : ` near line ${line}`;
    return {
      ...result,
      ...(failedPath ? { failedPath } : {}),
      message:
        `Patch context for${target} did not match the current workspace${location}. ` +
        `No files were changed because the patch is atomic. Re-read${target} and retry that file in a small patch.`,
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
  if (
    mode === 'sandboxed' &&
    basename(command) === 'find' &&
    (commandArguments.length === 0 || commandArguments[0]?.startsWith('-'))
  ) {
    return 'Sandboxed find requires an explicit search path as its first argument (usually ".") before predicates such as -name. Prefer workspace_search for workspace file discovery.';
  }
  if (mode === 'fullAccess' && commandArguments.length > 0) {
    return 'Full Access shell_exec requires the complete shell expression in command and does not accept an arguments array.';
  }
  if (mode === 'fullAccess' && /^\s*cd\s+(?:--\s+)?["']?\//u.test(command)) {
    return 'Full Access shell_exec already starts at the selected workspace root. Remove the leading absolute-path `cd`; use the workspace-relative cwd field for a real subdirectory.';
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
  threadId: string = workspaceId,
): Promise<unknown> => {
  if (toolName === 'project_environment_trust') {
    if (
      typeof argumentsValue.expectedHash !== 'string' ||
      argumentsValue.expectedHash.length !== 64
    ) {
      throw new Error('Project environment trust arguments are invalid');
    }
    const trust = parseNativeResult(
      await nativeRuntime.trustProjectEnvironmentJson(
        workspaceId,
        argumentsValue.expectedHash,
        threadId,
      ),
    );
    if (!isRecord(trust) || trust.accepted !== true) {
      return {
        ok: false,
        error:
          isRecord(trust) && typeof trust.reason === 'string'
            ? `projectEnvironment${trust.reason}`
            : 'projectEnvironmentTrustFailed',
      };
    }
    if (
      typeof argumentsValue.projectActionId === 'string' &&
      argumentsValue.projectActionId.length > 0
    ) {
      return parseNativeResult(
        await nativeRuntime.runProjectEnvironmentActionJson(
          workspaceId,
          threadId,
          argumentsValue.projectActionId,
        ),
      );
    }
    return executePrivilegedWorkspaceTool(
      nativeRuntime,
      operationId,
      workspaceId,
      'shell_exec',
      argumentsValue,
      onCommandOutput,
      threadId,
    );
  }
  if (toolName === 'workspace_apply_patch') {
    if (typeof argumentsValue.patch !== 'string') {
      throw new Error('workspace_apply_patch arguments are invalid');
    }
    return explainPatchFailure(
      parseNativeResult(
        await nativeRuntime.workspaceApplyPatch(
          workspaceId,
          argumentsValue.patch,
        ),
      ),
      argumentsValue.patch,
    );
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
    const combined = { stdout: '', stderr: '' };
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
      const stream = chunk.stream as 'stdout' | 'stderr';
      combined[stream] += chunk.delta;
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      if (combined[stream]) {
        onCommandOutput?.(operationId, stream, combined[stream]);
      }
    }
  };
  const execution = nativeRuntime.executeCommandJson(
    operationId,
    workspaceId,
    threadId,
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
  instructionContext?: WorkspaceInstructionContext,
  threadId: string = workspaceId,
  nativeWorkspaceId: string = workspaceId,
): readonly FunctionTool<Schema>[] => {
  const tools: readonly FunctionTool<Schema>[] = [
  new FunctionTool({
    name: 'workspace_read',
    description:
      `Read one UTF-8 regular text file, or up to ${MAX_DECLARED_WORKSPACE_READ_PATHS} regular files with paths, inside the open workspace without following symlinks. Directories are invalid; inspect them with workspace_list first.`,
    parameters: readSchema,
    execute: async (input) => {
      const paths = readPathArguments(input);
      const warnings = instructionContext?.warningsForRead(
        paths.map(instructionScopeForFile),
      ) ?? [];
      if (paths.length === 1) {
        const path = paths[0] ?? '';
        return withInstructionWarnings(workspaceReadResult(
          parseNativeResult(
            await nativeRuntime.workspaceRead(nativeWorkspaceId, path),
          ),
          path,
        ), warnings);
      }
      const files: Readonly<Record<string, unknown>>[] = [];
      for (
        let offset = 0;
        offset < paths.length;
        offset += MAX_DECLARED_WORKSPACE_READ_PATHS
      ) {
        const batch = paths.slice(
          offset,
          offset + MAX_DECLARED_WORKSPACE_READ_PATHS,
        );
        files.push(...await Promise.all(
          batch.map(async (path) => {
            const result = workspaceReadResult(
              parseNativeResult(
                await nativeRuntime.workspaceRead(nativeWorkspaceId, path),
              ),
              path,
            );
            return isRecord(result)
              ? { ...result, path }
              : { path, result };
          }),
        ));
      }
      return withInstructionWarnings({
        ok: files.every((file) => file.ok !== false),
        files,
      }, warnings);
    },
  }),
  new FunctionTool({
    name: 'workspace_list',
    description:
      'List the direct children of a directory inside the open workspace.',
    parameters: pathSchema,
    execute: async (input) => {
      const path = pathArgument(input);
      const warnings = instructionContext?.warningsForRead([path]) ?? [];
      return withInstructionWarnings(
        parseNativeResult(await nativeRuntime.workspaceList(nativeWorkspaceId, path)),
        warnings,
      );
    },
  }),
  new FunctionTool({
    name: 'workspace_search',
    description:
      'Search relevant UTF-8 source files under a workspace directory for literal text. Dependency, generated, cache, runtime-log, coverage, temporary, source-map, and minified content is skipped during recursive traversal.',
    parameters: searchSchema,
    execute: async (input) => {
      const { path, query } = searchArguments(input);
      const warnings = instructionContext?.warningsForRead([path]) ?? [];
      return withInstructionWarnings(
        parseNativeResult(await nativeRuntime.workspaceSearch(nativeWorkspaceId, path, query)),
        warnings,
      );
    },
  }),
  new FunctionTool({
    name: 'workspace_apply_patch',
    description:
      'Create, update, move, or delete files inside the open workspace with an atomic apply_patch document. Valid workspace-confined changes execute automatically.',
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
      const patch = normalizePatchDocument(input.patch);
      if (!validPatchDocument(patch)) {
        return invalidPatchFormat();
      }
      if (!updateSectionsHaveChanges(patch)) {
        return invalidPatchUpdate();
      }
      if (!updateSectionsHaveEffectiveChanges(patch)) {
        return invalidPatchNoop();
      }
      const instructionScopes = instructionScopesForPatch(patch);
      const instructionCheck = instructionContext?.checkWrite(instructionScopes);
      if (instructionCheck) {
        return instructionCheck;
      }
      const result = await runPrivileged(
        'workspace_apply_patch',
        { patch },
        async (operationId) => {
          const revalidated = instructionContext?.revalidateWrite(instructionScopes);
          return revalidated ?? executePrivilegedWorkspaceTool(
            nativeRuntime,
            operationId,
            nativeWorkspaceId,
            'workspace_apply_patch',
            { patch },
            onCommandOutput,
            threadId,
          );
        },
      );
      if (isRecord(result) && result.ok === true) {
        instructionContext?.invalidateAfterWrite(
          workspacePatchInstructionPaths(patch),
        );
      }
      return result;
    },
  }),
  new FunctionTool({
    name: 'drawio_generate',
    description:
      'Validate and save one new editable Draw.io diagram from complete native mxGraph XML. Use this for flowcharts, technical architecture, swimlanes, topology, ER diagrams, mind maps, product proposals, operations and sales processes, training flows, project implementation diagrams, and general presentation graphics. Generate the final XML directly rather than converting from Mermaid or another intermediate format.',
    parameters: drawioSchema,
    execute: async (input) => {
      if (
        typeof input !== 'object' ||
        input === null ||
        !('path' in input) ||
        typeof input.path !== 'string' ||
        !('xml' in input) ||
        typeof input.xml !== 'string'
      ) {
        throw new Error('drawio_generate arguments are invalid');
      }
      const path = input.path.replaceAll('\\', '/');
      if (!isDrawioPath(path)) {
        return {
          ok: false,
          error: 'invalidPath',
          message: 'Use a safe workspace-relative path ending in .drawio.',
        };
      }
      const validation = validateDrawioXml(input.xml);
      if (!validation.ok) {
        return validation;
      }
      if (!runPrivileged) {
        return { ok: false, error: 'approvalUnavailable' };
      }
      const instructionCheck = instructionContext?.checkWrite([path]);
      if (instructionCheck) {
        return instructionCheck;
      }
      const patch = drawioAddPatch(path, validation.xml);
      const result = await runPrivileged(
        'workspace_apply_patch',
        { patch },
        async (operationId) => {
          const revalidated = instructionContext?.revalidateWrite([path]);
          return revalidated ?? executePrivilegedWorkspaceTool(
            nativeRuntime,
            operationId,
            nativeWorkspaceId,
            'workspace_apply_patch',
            { patch },
            onCommandOutput,
            threadId,
          );
        },
      );
      if (isRecord(result) && result.ok === true) {
        instructionContext?.invalidateAfterWrite([path]);
        return {
          ...result,
          artifact: {
            kind: 'drawio',
            path,
            cells: validation.cells,
            edges: validation.edges,
          },
          finalDirective: `::draw{path="${path}"}`,
        };
      }
      return result;
    },
  }),
  new FunctionTool({
    name: 'project_action',
    description:
      'Run one named action declared by the repository in .sugarcode/project.json. Read that file first and use an exact action id. SugarCode shows the complete hash-bound project setup, environment, and actions for explicit trust before the first execution.',
    parameters: projectActionSchema,
    execute: async (input) => {
      if (
        typeof input !== 'object' ||
        input === null ||
        !('actionId' in input) ||
        typeof input.actionId !== 'string' ||
        input.actionId.length === 0 ||
        input.actionId.length > 64
      ) {
        throw new Error('project_action arguments are invalid');
      }
      if (!runPrivileged) {
        return { ok: false, error: 'approvalUnavailable' };
      }
      const actionId = input.actionId;
      const instructionCheck = instructionContext?.checkWrite(['.']);
      if (instructionCheck) {
        return instructionCheck;
      }
      const inspection = parseNativeResult(
        await nativeRuntime.inspectProjectEnvironmentJson(workspaceId, threadId),
      );
      if (!isRecord(inspection)) {
        return { ok: false, error: 'projectEnvironmentUnavailable' };
      }
      const matchingAction = Array.isArray(inspection.actions) &&
        inspection.actions.some(
          (action) => isRecord(action) && action.id === actionId,
        );
      if (!matchingAction) {
        return {
          ok: false,
          error: inspection.state === 'invalid'
            ? 'projectEnvironmentInvalid'
            : 'projectActionNotFound',
          ...(typeof inspection.lastError === 'string'
            ? { message: inspection.lastError }
            : {}),
        };
      }
      const execute = async (): Promise<unknown> => {
        const revalidated = instructionContext?.revalidateWrite(['.']);
        return revalidated ?? parseNativeResult(
          await nativeRuntime.runProjectEnvironmentActionJson(
            workspaceId,
            threadId,
            actionId,
          ),
        );
      };
      const result = inspection.state === 'trustRequired' &&
          typeof inspection.configHash === 'string'
        ? await runPrivileged(
            'project_environment_trust',
            {
              expectedHash: inspection.configHash,
              projectEnvironment: inspection,
              projectActionId: actionId,
            },
            async (operationId) => {
              const revalidated = instructionContext?.revalidateWrite(['.']);
              return revalidated ?? executePrivilegedWorkspaceTool(
                nativeRuntime,
                operationId,
                workspaceId,
                'project_environment_trust',
                {
                  expectedHash: inspection.configHash,
                  projectEnvironment: inspection,
                  projectActionId: actionId,
                },
                onCommandOutput,
                threadId,
              );
            },
          )
        : inspection.state === 'trusted'
          ? await execute()
          : { ok: false, error: 'projectEnvironmentUnavailable' };
      if (isRecord(result) && result.accepted === true) {
        instructionContext?.invalidateAfterWrite(['*']);
      }
      return result;
    },
  }),
  new FunctionTool({
    name: 'shell_exec',
    description:
      'Run a bounded command in the workspace. Prefer workspace_list, workspace_read, and workspace_search for file inspection. Sandboxed mode accepts a single verified absolute executable plus a separate arguments array; do not guess executable paths, and pass an explicit search root such as "." as the first argument to find. It is filesystem-read-only, network-denied, and executes automatically. Full Access uses the selected Shell with a lazily captured, task-bound exported environment; check the result environment metadata before concluding that a command is not installed. Use fullAccess only when shell syntax, writes, network, or access outside the workspace is required; Full Access requires approval unless the current conversation or project is trusted.',
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
      const instructionScopes = [cwd];
      if (mode === 'fullAccess') {
        const instructionCheck = instructionContext?.checkWrite(instructionScopes);
        if (instructionCheck) {
          return instructionCheck;
        }
      }
      const operationInspection = parseNativeResult(
        await nativeRuntime.inspectProjectEnvironmentJson(workspaceId, threadId),
      );
      const projectConfigHash =
        isRecord(operationInspection) &&
        operationInspection.state === 'trustRequired' &&
        typeof operationInspection.configHash === 'string'
          ? operationInspection.configHash
          : undefined;
      const operationToolName = projectConfigHash
        ? 'project_environment_trust'
        : 'shell_exec';
      const operationArguments: Readonly<Record<string, unknown>> = {
        mode,
        command,
        arguments: commandArguments,
        cwd,
        timeoutMs,
        ...(operationToolName === 'project_environment_trust'
          ? {
              expectedHash: projectConfigHash,
              projectEnvironment: operationInspection,
            }
          : {}),
      };
      const result = await runPrivileged(
        operationToolName,
        operationArguments,
        async (operationId) => {
          const revalidated = mode === 'fullAccess'
            ? instructionContext?.revalidateWrite(instructionScopes)
            : undefined;
          return revalidated ?? executePrivilegedWorkspaceTool(
            nativeRuntime,
            operationId,
            workspaceId,
            operationToolName,
            operationArguments,
            onCommandOutput,
            threadId,
          );
        },
      );
      if (mode === 'fullAccess' && isRecord(result) && result.ok !== false) {
        instructionContext?.invalidateAfterWrite(['*']);
      }
      return result;
    },
  }),
  ];
  return access === 'readOnly' ? tools.slice(0, 3) : tools;
};
