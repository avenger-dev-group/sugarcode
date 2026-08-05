import type { ConversationFileChangeProposal } from '@/shared/conversation';
import {
  isValidFileChangeDiff,
  isValidFileChangePath,
  isValidSha256,
} from '@/shared/conversation';
import { parseWorkspaceApplyPatchPaths } from './workspace-apply-patch';

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
    throw new Error('Invalid workspace/apply-patch success content.');
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
      throw new Error('Invalid workspace/apply-patch success receipt.');
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
      throw new Error('Invalid workspace/apply-patch success content.');
    }
    return { type: 'success', files: parsed.files.map(parseReceipt) };
  }
  throw new Error('Invalid workspace/apply-patch success content.');
};

export const parseWorkspacePatchItem = (
  value: Record<string, unknown>,
): WorkspacePatchItem | null => {
  const isWorkspaceWrite = value.name === 'workspace/apply-patch';
  if (value.type === 'toolCall' && isWorkspaceWrite) {
    const argumentsValue = value.arguments;
    if (!isId(value.id) || !isId(value.callId)) {
      throw new Error('Invalid workspace/apply-patch ToolCall Item.');
    }
    const paths = parseWorkspaceApplyPatchPaths(
      argumentsValue,
      isValidFileChangePath,
    );
    const path = paths[0];
    if (path === undefined) {
      throw new Error('workspace/apply-patch requires one path.');
    }
    return {
      type: 'workspacePatchCall',
      id: value.id,
      callId: value.callId,
      path,
      paths,
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
