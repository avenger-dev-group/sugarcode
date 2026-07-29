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
  outcome:
    | Readonly<{
        type: 'success';
        path: string;
        beforeSha256: string;
        afterSha256: string;
        beforeBytes: number;
        afterBytes: number;
      }>
    | Readonly<{ type: 'error'; kind: string }>;
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
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join(',') !==
      'afterBytes,afterSha256,beforeBytes,beforeSha256,kind,path' ||
    parsed.kind !== 'update' ||
    !isValidFileChangePath(parsed.path) ||
    !isValidSha256(parsed.beforeSha256) ||
    !isValidSha256(parsed.afterSha256) ||
    !isBoundedByteCount(parsed.beforeBytes) ||
    !isBoundedByteCount(parsed.afterBytes)
  ) {
    throw new Error('Invalid workspace/apply-patch success content.');
  }
  return {
    type: 'success',
    path: parsed.path,
    beforeSha256: parsed.beforeSha256,
    afterSha256: parsed.afterSha256,
    beforeBytes: parsed.beforeBytes,
    afterBytes: parsed.afterBytes,
  };
};

export const parseWorkspacePatchItem = (
  value: Record<string, unknown>,
): WorkspacePatchItem | null => {
  if (value.type === 'toolCall' && value.name === 'workspace/apply-patch') {
    if (
      !isId(value.id) ||
      !isId(value.callId) ||
      !isValidFileChangePath(value.path) ||
      Object.hasOwn(value, 'query') ||
      Object.hasOwn(value, 'command') ||
      Object.hasOwn(value, 'arguments') ||
      Object.hasOwn(value, 'patch')
    ) {
      throw new Error('Invalid workspace/apply-patch ToolCall Item.');
    }
    return {
      type: 'workspacePatchCall',
      id: value.id,
      callId: value.callId,
      path: value.path,
    };
  }

  if (value.type === 'fileChange') {
    if (
      !isId(value.id) ||
      !isId(value.callId) ||
      !isValidFileChangePath(value.path) ||
      value.kind !== 'update' ||
      !isValidFileChangeDiff(value.diff, value.path) ||
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
      kind: 'update',
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

  if (value.type === 'toolResult' && value.name === 'workspace/apply-patch') {
    if (!isId(value.id) || !isId(value.callId) || !isRecord(value.result)) {
      throw new Error('Invalid workspace/apply-patch ToolResult Item.');
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
    throw new Error('Invalid workspace/apply-patch ToolResult outcome.');
  }

  return null;
};
