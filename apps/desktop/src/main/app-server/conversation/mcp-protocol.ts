import { canonicalizeMcpArguments } from '../mcp/protocol';

const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 384 * 1024;
const MCP_DECISIONS = new Set([
  'approved',
  'denied',
  'timedOut',
  'unsupported',
  'cancelled',
  'clientDisconnected',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const isCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;
const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export type McpCallItem = Readonly<{
  type: 'mcpCall';
  id: string;
  callId: string;
  name: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  argumentSignature: string;
}>;

export type McpApprovalRequestItem = Readonly<{
  type: 'mcpApprovalRequest';
  id: string;
  approvalId: string;
  callId: string;
  name: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  argumentSignature: string;
}>;

export type McpApprovalDecisionItem = Readonly<{
  type: 'mcpApprovalDecision';
  id: string;
  approvalId: string;
  decision:
    | 'approved'
    | 'denied'
    | 'timedOut'
    | 'unsupported'
    | 'cancelled'
    | 'clientDisconnected';
}>;

export type McpExecutionAttemptItem = Readonly<{
  type: 'mcpExecutionAttempt';
  id: string;
  approvalId: string;
  callId: string;
  inventorySha256: string;
}>;

export type McpResultReceipt =
  | Readonly<{
      type: 'completed';
      isError: boolean;
      observedBytes: number;
      canonicalBytes: number;
      retainedBytes: number;
      truncated: boolean;
      sha256: string;
      contentBlocks: number;
      structuredContent: boolean;
    }>
  | Readonly<{
      type: 'error';
      kind: string;
      requestState: string;
    }>;

export type McpResultItem = Readonly<{
  type: 'mcpResult';
  id: string;
  callId: string;
  name: string;
  receipt: McpResultReceipt;
}>;

export type McpConversationItem =
  | McpCallItem
  | McpApprovalRequestItem
  | McpApprovalDecisionItem
  | McpExecutionAttemptItem
  | McpResultItem;

const parseCallMetadata = (
  value: Record<string, unknown>,
): Omit<McpCallItem, 'type' | 'id'> => {
  if (
    !isId(value.callId) ||
    !isId(value.name) ||
    !value.name.startsWith('mcp__') ||
    !isRecord(value.arguments) ||
    !isCount(value.argumentsBytes, MAX_ARGUMENT_BYTES) ||
    !isSha(value.argumentsSha256) ||
    !isSha(value.inventorySha256)
  ) {
    throw new Error('Invalid MCP call metadata.');
  }
  const argumentSignature = canonicalizeMcpArguments(value.arguments);
  if (Buffer.byteLength(argumentSignature) > MAX_ARGUMENT_BYTES) {
    throw new Error('Invalid MCP arguments.');
  }
  return {
    callId: value.callId,
    name: value.name,
    argumentsBytes: value.argumentsBytes,
    argumentsSha256: value.argumentsSha256,
    inventorySha256: value.inventorySha256,
    argumentSignature,
  };
};

export const parseMcpConversationItem = (
  value: Record<string, unknown>,
): McpConversationItem | null => {
  if (value.type === 'mcpToolCall') {
    if (
      !hasOnlyKeys(value, [
        'type',
        'id',
        'callId',
        'name',
        'arguments',
        'argumentsBytes',
        'argumentsSha256',
        'inventorySha256',
      ])
    ) {
      throw new Error('Invalid MCP ToolCall Item.');
    }
    return {
      type: 'mcpCall',
      id: value.id as string,
      ...parseCallMetadata(value),
    };
  }
  if (value.type === 'mcpToolCallApprovalRequest') {
    if (
      !hasOnlyKeys(value, [
        'type',
        'id',
        'approvalId',
        'callId',
        'name',
        'arguments',
        'argumentsBytes',
        'argumentsSha256',
        'inventorySha256',
      ]) ||
      !isId(value.approvalId)
    ) {
      throw new Error('Invalid MCP approval request Item.');
    }
    return {
      type: 'mcpApprovalRequest',
      id: value.id as string,
      approvalId: value.approvalId,
      ...parseCallMetadata(value),
    };
  }
  if (value.type === 'mcpToolCallApprovalDecision') {
    if (
      !hasOnlyKeys(value, ['type', 'id', 'approvalId', 'decision']) ||
      !isId(value.approvalId) ||
      typeof value.decision !== 'string' ||
      !MCP_DECISIONS.has(value.decision)
    ) {
      throw new Error('Invalid MCP approval decision Item.');
    }
    return {
      type: 'mcpApprovalDecision',
      id: value.id as string,
      approvalId: value.approvalId,
      decision: value.decision as McpApprovalDecisionItem['decision'],
    };
  }
  if (value.type === 'mcpToolExecutionAttempt') {
    if (
      !hasOnlyKeys(value, [
        'type',
        'id',
        'approvalId',
        'callId',
        'inventorySha256',
      ]) ||
      !isId(value.approvalId) ||
      !isId(value.callId) ||
      !isSha(value.inventorySha256)
    ) {
      throw new Error('Invalid MCP execution attempt Item.');
    }
    return {
      type: 'mcpExecutionAttempt',
      id: value.id as string,
      approvalId: value.approvalId,
      callId: value.callId,
      inventorySha256: value.inventorySha256,
    };
  }
  if (value.type === 'mcpToolResult') {
    if (
      !hasOnlyKeys(value, ['type', 'id', 'callId', 'name', 'result']) ||
      !isId(value.callId) ||
      !isId(value.name) ||
      !value.name.startsWith('mcp__') ||
      !isRecord(value.result)
    ) {
      throw new Error('Invalid MCP result Item.');
    }
    if (
      value.result.type === 'completed' &&
      hasOnlyKeys(value.result, [
        'type',
        'content',
        'is_error',
        'observed_bytes',
        'canonical_bytes',
        'retained_bytes',
        'truncated',
        'sha256',
        'content_blocks',
        'structured_content',
      ]) &&
      typeof value.result.content === 'string' &&
      typeof value.result.is_error === 'boolean' &&
      isCount(value.result.observed_bytes) &&
      isCount(value.result.canonical_bytes) &&
      isCount(value.result.retained_bytes, MAX_RESULT_BYTES) &&
      typeof value.result.truncated === 'boolean' &&
      isSha(value.result.sha256) &&
      isCount(value.result.content_blocks, 32) &&
      typeof value.result.structured_content === 'boolean' &&
      Buffer.byteLength(value.result.content) === value.result.retained_bytes
    ) {
      return {
        type: 'mcpResult',
        id: value.id as string,
        callId: value.callId,
        name: value.name,
        receipt: {
          type: 'completed',
          isError: value.result.is_error,
          observedBytes: value.result.observed_bytes,
          canonicalBytes: value.result.canonical_bytes,
          retainedBytes: value.result.retained_bytes,
          truncated: value.result.truncated,
          sha256: value.result.sha256,
          contentBlocks: value.result.content_blocks,
          structuredContent: value.result.structured_content,
        },
      };
    }
    if (
      value.result.type === 'error' &&
      hasOnlyKeys(value.result, ['type', 'kind', 'request_state']) &&
      isId(value.result.kind) &&
      isId(value.result.request_state)
    ) {
      return {
        type: 'mcpResult',
        id: value.id as string,
        callId: value.callId,
        name: value.name,
        receipt: {
          type: 'error',
          kind: value.result.kind,
          requestState: value.result.request_state,
        },
      };
    }
    throw new Error('Invalid MCP result receipt.');
  }
  return null;
};
