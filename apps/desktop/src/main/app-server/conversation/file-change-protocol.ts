import type { ConversationFileChangeProposal } from '@/shared/conversation';
import {
  isValidFileChangeDiff,
  isValidFileChangePath,
  isValidSha256,
} from '@/shared/conversation';

export type WorkspacePatchCallItem = Readonly<{
  type: 'workspacePatchCall';
  id: string;
  callId: string;
  path: string;
  paths: readonly string[];
}>;

export type WorkspacePatchChangeItem = ConversationFileChangeProposal &
  Readonly<{
    type: 'workspacePatchChange';
    callId: string;
  }>;

export type WorkspacePatchResultItem = Readonly<{
  type: 'workspacePatchResult';
  id: string;
  callId: string;
  outcome: import('@/shared/conversation').ConversationFileChangeResultOutcome;
}>;

export type WorkspacePatchItem =
  | WorkspacePatchCallItem
  | WorkspacePatchChangeItem
  | WorkspacePatchResultItem;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isBoundedByteCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 256 * 1024;

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const parseSuccessContent = (
  content: string,
): Extract<WorkspacePatchResultItem['outcome'], { type: 'success' }> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid workspace/apply-diff success content.');
  }
  const parseReceipt = (receipt: unknown) => {
    if (
      !isRecord(receipt) ||
      Object.keys(receipt).sort().join(',') !==
        'afterBytes,afterSha256,beforeBytes,beforeSha256,kind,path' ||
      (receipt.kind !== 'create' && receipt.kind !== 'update' && receipt.kind !== 'delete') ||
      !isValidFileChangePath(receipt.path) ||
      !isValidSha256(receipt.beforeSha256) ||
      !isValidSha256(receipt.afterSha256) ||
      !isBoundedByteCount(receipt.beforeBytes) ||
      !isBoundedByteCount(receipt.afterBytes)
    ) {
      throw new Error('Invalid workspace/apply-diff success receipt.');
    }
    return {
      path: receipt.path,
      kind: receipt.kind,
      beforeSha256: receipt.beforeSha256,
      afterSha256: receipt.afterSha256,
      beforeBytes: receipt.beforeBytes,
      afterBytes: receipt.afterBytes,
    } as const;
  };
  if (isRecord(parsed) && Object.keys(parsed).length === 1 && Array.isArray(parsed.files)) {
    if (parsed.files.length === 0 || parsed.files.length > 64) {
      throw new Error('Invalid workspace/apply-diff success content.');
    }
    return { type: 'success', files: parsed.files.map(parseReceipt) };
  }
  const receipt = parseReceipt(parsed);
  if (receipt.kind !== 'update') {
    throw new Error('Invalid workspace/apply-diff success content.');
  }
  return {
    type: 'success',
    path: receipt.path,
    beforeSha256: receipt.beforeSha256,
    afterSha256: receipt.afterSha256,
    beforeBytes: receipt.beforeBytes,
    afterBytes: receipt.afterBytes,
  };
};

export const parseWorkspacePatchItem = (
  value: Record<string, unknown>,
): WorkspacePatchItem | null => {
  const isWorkspaceWrite =
    value.name === 'workspace/edit' || value.name === 'workspace/apply-diff';
  if (value.type === 'toolCall' && isWorkspaceWrite) {
    const argumentsValue = value.arguments;
    if (
      !isId(value.id) ||
      !isId(value.callId) ||
      !isRecord(argumentsValue)
    ) {
      throw new Error('Invalid workspace write ToolCall Item.');
    }
    const batchEntries = value.name === 'workspace/edit'
      ? argumentsValue.operations
      : argumentsValue.files;
    if (Array.isArray(batchEntries)) {
      if (
        Object.keys(argumentsValue).length !== 1 ||
        batchEntries.length === 0 ||
        batchEntries.length > 64 ||
        batchEntries.some(
          (entry) => !isRecord(entry) || !isValidFileChangePath(entry.path),
        )
      ) {
        throw new Error('Invalid batch workspace write ToolCall arguments.');
      }
      const paths = batchEntries.map((entry) => (entry as Record<string, unknown>).path as string);
      const path = paths[0];
      if (path === undefined) {
        throw new Error('Batch workspace write requires one path.');
      }
      return {
        type: 'workspacePatchCall',
        id: value.id,
        callId: value.callId,
        path,
        paths,
      };
    }
    if (!isValidFileChangePath(argumentsValue.path)) {
      throw new Error('Invalid legacy workspace write ToolCall Item.');
    }
    const allowedKeys =
      value.name === 'workspace/edit'
        ? new Set(['path', 'baseSha256', 'edits'])
        : new Set(['path', 'baseSha256', 'diff']);
    if (
      Object.keys(argumentsValue).some((key) => !allowedKeys.has(key)) ||
      (Object.hasOwn(argumentsValue, 'baseSha256') &&
        !isValidSha256(argumentsValue.baseSha256)) ||
      (value.name === 'workspace/apply-diff' &&
        (typeof argumentsValue.diff !== 'string' ||
          argumentsValue.diff.length === 0 ||
          utf8Bytes(argumentsValue.diff) > 96 * 1024)) ||
      (value.name === 'workspace/edit' &&
        (!Array.isArray(argumentsValue.edits) ||
          argumentsValue.edits.length === 0 ||
          argumentsValue.edits.length > 128 ||
          argumentsValue.edits.some(
            (edit) =>
              !isRecord(edit) ||
              Object.keys(edit).sort().join(',') !==
                'deleteLineCount,expected,replacement,startLine' ||
              !Number.isSafeInteger(edit.startLine) ||
              (edit.startLine as number) < 1 ||
              !Number.isSafeInteger(edit.deleteLineCount) ||
              (edit.deleteLineCount as number) < 0 ||
              typeof edit.expected !== 'string' ||
              typeof edit.replacement !== 'string',
          )))
    ) {
      throw new Error('Invalid workspace write ToolCall arguments.');
    }
    return {
      type: 'workspacePatchCall',
      id: value.id,
      callId: value.callId,
      path: argumentsValue.path,
      paths: [argumentsValue.path],
    };
  }

  if (value.type === 'fileChange') {
    if (
      !isId(value.id) ||
      !isId(value.callId) ||
      !isValidFileChangePath(value.path) ||
      (value.kind !== 'create' && value.kind !== 'update' && value.kind !== 'delete') ||
      !isValidFileChangeDiff(value.diff, value.path, value.kind) ||
      !isValidSha256(value.beforeSha256) ||
      !isValidSha256(value.afterSha256) ||
      !isBoundedByteCount(value.beforeBytes) ||
      !isBoundedByteCount(value.afterBytes) ||
      (value.newlineStyle !== 'lf' && value.newlineStyle !== 'crLf') ||
      typeof value.finalNewline !== 'boolean'
    ) {
      throw new Error('Invalid FileChange Item.');
    }
    return {
      type: 'workspacePatchChange',
      id: value.id,
      callId: value.callId,
      path: value.path,
      kind: value.kind,
      diff: value.diff,
      beforeSha256: value.beforeSha256,
      afterSha256: value.afterSha256,
      beforeBytes: value.beforeBytes,
      afterBytes: value.afterBytes,
      newlineStyle: value.newlineStyle,
      finalNewline: value.finalNewline,
      status: 'inProgress',
    };
  }

  if (value.type === 'toolResult' && isWorkspaceWrite) {
    if (!isId(value.id) || !isId(value.callId) || !isRecord(value.result)) {
      throw new Error('Invalid workspace write ToolResult Item.');
    }
    if (
      value.result.type === 'success' &&
      typeof value.result.content === 'string' &&
      isBoundedByteCount(value.result.bytes) &&
      utf8Bytes(value.result.content) === value.result.bytes
    ) {
      return {
        type: 'workspacePatchResult',
        id: value.id,
        callId: value.callId,
        outcome: parseSuccessContent(value.result.content),
      };
    }
    if (
      value.result.type === 'error' &&
      typeof value.result.kind === 'string' &&
      value.result.kind.length > 0
    ) {
      return {
        type: 'workspacePatchResult',
        id: value.id,
        callId: value.callId,
        outcome: { type: 'error', kind: value.result.kind },
      };
    }
    throw new Error('Invalid workspace write ToolResult outcome.');
  }

  return null;
};
