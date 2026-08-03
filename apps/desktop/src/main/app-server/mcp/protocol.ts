import type {
  JsonValue,
  McpToolCallApprovalParams,
  RequestId,
} from '@sugarcode/app-server-protocol';

import type { ServerMessage } from '../transport/server-message';

const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 2_048;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 1_024 &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));

const isWorkspaceId = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:unbound|[0-9a-f]{64})$/u.test(value);

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

const validateJsonValue = (
  value: unknown,
  depth: number,
  counter: { nodes: number },
): boolean => {
  counter.nodes += 1;
  if (depth > MAX_JSON_DEPTH || counter.nodes > MAX_JSON_NODES) {
    return false;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) =>
      validateJsonValue(entry, depth + 1, counter),
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).every(
      ([key, entry]) =>
        !Array.from(key).some((character) => /\p{Cc}/u.test(character)) &&
        validateJsonValue(entry, depth + 1, counter),
    );
  }
  return false;
};

export const canonicalizeMcpArguments = (
  value: Record<string, unknown>,
): string => {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) {
      return entry.map(canonicalize);
    }
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort((left, right) =>
            Buffer.from(left).compare(Buffer.from(right)),
          )
          .map((key) => [key, canonicalize(entry[key])]),
      );
    }
    return entry;
  };
  return JSON.stringify(canonicalize(value));
};

export type ParsedMcpApproval = Readonly<{
  params: McpToolCallApprovalParams;
  serverId: string;
  argumentsJson: string;
  argumentsBytes: number;
}>;

export const parseMcpApprovalRequest = (
  id: RequestId,
  value: unknown,
  activeServerIds: readonly string[],
): ParsedMcpApproval | null => {
  if (
    typeof id !== 'string' ||
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'approvalId',
        'workspaceId',
        'threadId',
        'turnId',
        'callId',
        'name',
        'arguments',
        'argumentsBytes',
        'argumentsSha256',
        'inventorySha256',
      ],
      ['sourceAgent'],
    ) ||
    value.approvalId !== id ||
    !isIdentifier(value.approvalId) ||
    !isWorkspaceId(value.workspaceId) ||
    !isIdentifier(value.threadId) ||
    !isIdentifier(value.turnId) ||
    !isIdentifier(value.callId) ||
    !isIdentifier(value.name) ||
    !isRecord(value.arguments) ||
    !Number.isSafeInteger(value.argumentsBytes) ||
    (value.argumentsBytes as number) < 2 ||
    (value.argumentsBytes as number) > MAX_ARGUMENT_BYTES ||
    !isSha256(value.argumentsSha256) ||
    !isSha256(value.inventorySha256) ||
    !validateJsonValue(value.arguments, 1, { nodes: 0 })
  ) {
    return null;
  }
  const sourceAgent = value.sourceAgent;
  if (
    sourceAgent !== undefined &&
    (!isRecord(sourceAgent) ||
      !hasOnlyKeys(sourceAgent, ['taskId', 'role']) ||
      !isIdentifier(sourceAgent.taskId) ||
      (sourceAgent.role !== 'explorer' &&
        sourceAgent.role !== 'worker' &&
        sourceAgent.role !== 'auditor'))
  ) {
    return null;
  }
  const normalizedSourceAgent = sourceAgent
    ? {
        taskId: (sourceAgent as Record<string, unknown>).taskId as string,
        role: (sourceAgent as Record<string, unknown>).role as
          | 'explorer'
          | 'worker'
          | 'auditor',
      }
    : undefined;
  const serverId = activeServerIds.find((server) =>
    (value.name as string).startsWith(`mcp__${server}__`),
  );
  if (!serverId || value.name === `mcp__${serverId}__`) {
    return null;
  }
  const argumentsJson = canonicalizeMcpArguments(value.arguments);
  if (Buffer.byteLength(argumentsJson) > MAX_ARGUMENT_BYTES) {
    return null;
  }
  return {
    params: {
      approvalId: value.approvalId,
      workspaceId: value.workspaceId,
      threadId: value.threadId,
      turnId: value.turnId,
      callId: value.callId,
      name: value.name,
      arguments: value.arguments as JsonValue,
      argumentsBytes: BigInt(value.argumentsBytes as number),
      argumentsSha256: value.argumentsSha256,
      inventorySha256: value.inventorySha256,
      ...(normalizedSourceAgent
        ? { sourceAgent: normalizedSourceAgent }
        : {}),
    },
    serverId,
    argumentsJson,
    argumentsBytes: value.argumentsBytes as number,
  };
};

export type McpApprovalCompletion = Readonly<{
  workspaceId: string;
  threadId: string;
  turnId: string;
  approvalId: string;
  decision: string;
}>;

export const isMcpApprovalCompletionCandidate = (
  message: Extract<ServerMessage, { kind: 'notification' }>,
): boolean =>
  message.method === 'item/completed' &&
  isRecord(message.params) &&
  isRecord(message.params.item) &&
  message.params.item.type === 'mcpToolCallApprovalDecision';

export const parseMcpApprovalCompletion = (
  message: Extract<ServerMessage, { kind: 'notification' }>,
): McpApprovalCompletion | null => {
  if (
    message.method !== 'item/completed' ||
    !isRecord(message.params) ||
    !hasOnlyKeys(message.params, [
      'workspaceId',
      'threadId',
      'turnId',
      'item',
    ]) ||
    !isWorkspaceId(message.params.workspaceId) ||
    !isIdentifier(message.params.threadId) ||
    !isIdentifier(message.params.turnId) ||
    !isRecord(message.params.item) ||
    !hasOnlyKeys(message.params.item, [
      'type',
      'id',
      'approvalId',
      'decision',
    ]) ||
    message.params.item.type !== 'mcpToolCallApprovalDecision' ||
    !isIdentifier(message.params.item.id) ||
    !isIdentifier(message.params.item.approvalId) ||
    typeof message.params.item.decision !== 'string'
  ) {
    return null;
  }
  return {
    workspaceId: message.params.workspaceId,
    threadId: message.params.threadId,
    turnId: message.params.turnId,
    approvalId: message.params.item.approvalId,
    decision: message.params.item.decision,
  };
};
