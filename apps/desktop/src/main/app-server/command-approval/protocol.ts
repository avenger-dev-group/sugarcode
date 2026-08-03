import type {
  CommandApprovalParams,
  ItemCompletedNotification,
  RequestId,
} from '@sugarcode/app-server-protocol';
import path from 'node:path';

import type { ServerMessage } from '../transport/server-message';

const MAX_COMMAND_BYTES = 1024;
const MAX_DESCRIPTION_BYTES = 512;
const MAX_ARGUMENT_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;
const MAX_ARGUMENTS = 64;

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

const isBoundedIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 1024 &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));

const isWorkspaceId = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:unbound|[0-9a-f]{64})$/u.test(value);

const isBoundedCommandText = (
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string =>
  typeof value === 'string' &&
  (allowEmpty || value.length > 0) &&
  Buffer.byteLength(value) <= maxBytes &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));

const isAbsoluteCommand = (
  command: string,
  platform: NodeJS.Platform,
): boolean => {
  if (platform === 'win32') {
    return (
      path.win32.isAbsolute(command) &&
      !command.startsWith('\\\\') &&
      !command.startsWith('\\\\?\\') &&
      !command.startsWith('\\\\.\\')
    );
  }
  return path.posix.isAbsolute(command);
};

export const parseCommandApprovalRequest = (
  id: RequestId,
  value: unknown,
  platform: NodeJS.Platform,
): CommandApprovalParams | null => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'approvalId',
        'workspaceId',
        'threadId',
        'turnId',
        'callId',
        'description',
        'command',
        'arguments',
        'cwd',
        'approvalScope',
        'environmentPolicy',
        'sandboxed',
        'sandboxPolicy',
        'networkPolicy',
      ],
      ['workspaceWritePolicy', 'workspaceWriteRisk', 'sourceAgent'],
    ) ||
    typeof id !== 'string' ||
    !isBoundedIdentifier(value.approvalId) ||
    id !== value.approvalId ||
    !isWorkspaceId(value.workspaceId) ||
    !isBoundedIdentifier(value.threadId) ||
    !isBoundedIdentifier(value.turnId) ||
    !isBoundedIdentifier(value.callId) ||
    !isBoundedCommandText(value.description, MAX_DESCRIPTION_BYTES) ||
    !isBoundedCommandText(value.command, MAX_COMMAND_BYTES) ||
    !isAbsoluteCommand(value.command, platform) ||
    !Array.isArray(value.arguments) ||
    value.arguments.length > MAX_ARGUMENTS ||
    value.arguments.some(
      (argument) =>
        !isBoundedCommandText(argument, MAX_ARGUMENT_BYTES, true),
    ) ||
    value.cwd !== '.' ||
    value.approvalScope !== 'command' ||
    (value.environmentPolicy !== 'minimalV1' &&
      value.environmentPolicy !== 'hostInheritedV1') ||
    value.sandboxed !== true ||
    value.sandboxPolicy !== 'filesystemReadOnlyV1' ||
    (value.workspaceWritePolicy !== undefined &&
      value.workspaceWritePolicy !== 'commandWorkspaceWriteV1') ||
    (value.workspaceWriteRisk !== undefined &&
      value.workspaceWriteRisk !==
        'nonTransactionalWorkspaceTreeV1') ||
    (value.workspaceWritePolicy === 'commandWorkspaceWriteV1') !==
      (value.workspaceWriteRisk ===
        'nonTransactionalWorkspaceTreeV1') ||
    value.networkPolicy !== 'networkDeniedV1'
  ) {
    return null;
  }
  const sourceAgent = value.sourceAgent;
  if (
    sourceAgent !== undefined &&
    (!isRecord(sourceAgent) ||
      !hasOnlyKeys(sourceAgent, ['taskId', 'role']) ||
      !isBoundedIdentifier(sourceAgent.taskId) ||
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

  const argumentsList = value.arguments as string[];
  const totalBytes = argumentsList.reduce(
    (total, argument) => total + Buffer.byteLength(argument),
    Buffer.byteLength(value.command),
  );
  if (totalBytes > MAX_TOTAL_BYTES) {
    return null;
  }

  return {
    approvalId: value.approvalId,
    workspaceId: value.workspaceId,
    threadId: value.threadId,
    turnId: value.turnId,
    callId: value.callId,
    description: value.description,
    command: value.command,
    arguments: [...argumentsList],
    cwd: '.',
    approvalScope: 'command',
    environmentPolicy: value.environmentPolicy,
    sandboxed: true,
    sandboxPolicy: 'filesystemReadOnlyV1',
    ...(normalizedSourceAgent
      ? { sourceAgent: normalizedSourceAgent }
      : {}),
    ...(value.workspaceWritePolicy === 'commandWorkspaceWriteV1'
      ? {
          workspaceWritePolicy: 'commandWorkspaceWriteV1' as const,
          workspaceWriteRisk:
            'nonTransactionalWorkspaceTreeV1' as const,
        }
      : {}),
    networkPolicy: 'networkDeniedV1',
  };
};

export type CommandApprovalCompletion = Readonly<{
  workspaceId: string;
  threadId: string;
  turnId: string;
  approvalId: string;
  decision: string;
  workspaceWriteRiskAcknowledgement?:
    | 'nonTransactionalWorkspaceTreeV1'
    | undefined;
}>;

export const isCommandApprovalCompletionCandidate = (
  message: Extract<ServerMessage, { kind: 'notification' }>,
): boolean =>
  message.method === 'item/completed' &&
  isRecord(message.params) &&
  isRecord(message.params.item) &&
  message.params.item.type === 'commandApprovalDecision';

export const parseCommandApprovalCompletion = (
  message: Extract<ServerMessage, { kind: 'notification' }>,
): CommandApprovalCompletion | null => {
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
    !isBoundedIdentifier(message.params.threadId) ||
    !isBoundedIdentifier(message.params.turnId) ||
    !isRecord(message.params.item) ||
    !hasOnlyKeys(
      message.params.item,
      ['type', 'id', 'approvalId', 'decision'],
      ['workspaceWriteRiskAcknowledgement'],
    ) ||
    message.params.item.type !== 'commandApprovalDecision' ||
    !isBoundedIdentifier(message.params.item.id) ||
    !isBoundedIdentifier(message.params.item.approvalId) ||
    typeof message.params.item.decision !== 'string' ||
    (message.params.item.workspaceWriteRiskAcknowledgement !==
      undefined &&
      message.params.item.workspaceWriteRiskAcknowledgement !==
        'nonTransactionalWorkspaceTreeV1')
  ) {
    return null;
  }

  const params = message.params as unknown as ItemCompletedNotification;
  const item = params.item as Extract<
    ItemCompletedNotification['item'],
    { type: 'commandApprovalDecision' }
  >;
  return {
    workspaceId: params.workspaceId,
    threadId: params.threadId,
    turnId: params.turnId,
    approvalId: item.approvalId,
    decision: item.decision,
    ...(item.workspaceWriteRiskAcknowledgement ===
    'nonTransactionalWorkspaceTreeV1'
      ? {
          workspaceWriteRiskAcknowledgement:
            'nonTransactionalWorkspaceTreeV1' as const,
        }
      : {}),
  };
};
