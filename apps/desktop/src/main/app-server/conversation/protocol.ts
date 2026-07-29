import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadListResponse,
  ThreadStartResponse,
  ThreadStartedNotification,
  TurnSnapshotStatus,
  TurnCompletedNotification,
  TurnError,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnStartedNotification,
} from '@sugarcode/app-server-protocol';
import path from 'node:path';

import type { ServerMessage } from '../transport/server-message';

type TextItem = Extract<
  ItemStartedNotification['item'],
  { type: 'userMessage' | 'agentMessage' }
>;

export type WorkspaceReadCallItem = Readonly<{
  type: 'workspaceReadCall';
  id: string;
  callId: string;
  path: string;
}>;

export type WorkspaceReadResultItem = Readonly<{
  type: 'workspaceReadResult';
  id: string;
  callId: string;
  outcome:
    | Readonly<{ type: 'success'; bytes: number }>
    | Readonly<{ type: 'error'; kind: string }>;
}>;

export type WorkspaceListCallItem = Readonly<{
  type: 'workspaceListCall';
  id: string;
  callId: string;
  path: string;
}>;

export type WorkspaceListResultItem = Readonly<{
  type: 'workspaceListResult';
  id: string;
  callId: string;
  outcome:
    | Readonly<{ type: 'success'; entries: number }>
    | Readonly<{ type: 'error'; kind: string }>;
}>;

export type WorkspaceSearchCallItem = Readonly<{
  type: 'workspaceSearchCall';
  id: string;
  callId: string;
  path: string;
  query: string;
}>;

export type WorkspaceSearchResultItem = Readonly<{
  type: 'workspaceSearchResult';
  id: string;
  callId: string;
  outcome:
    | Readonly<{
        type: 'success';
        matches: number;
        truncated: boolean;
      }>
    | Readonly<{ type: 'error'; kind: string }>;
}>;

export type CommandCallItem = Readonly<{
  type: 'commandCall';
  id: string;
  callId: string;
  command: string;
  arguments: readonly string[];
}>;

export type CommandApprovalRequestItem = Readonly<{
  type: 'commandApprovalRequest';
  id: string;
  approvalId: string;
  callId: string;
  command: string;
  arguments: readonly string[];
}>;

export type CommandApprovalDecisionItem = Readonly<{
  type: 'commandApprovalDecision';
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

type ConversationItem =
  | TextItem
  | WorkspaceReadCallItem
  | WorkspaceReadResultItem
  | WorkspaceListCallItem
  | WorkspaceListResultItem
  | WorkspaceSearchCallItem
  | WorkspaceSearchResultItem
  | CommandCallItem
  | CommandApprovalRequestItem
  | CommandApprovalDecisionItem;

export type ResumeItem =
  | ConversationItem
  | Readonly<{
      type: 'other';
      id: string;
    }>;

export type ResumeTurn = Readonly<{
  id: string;
  status: TurnSnapshotStatus;
  items: readonly ResumeItem[];
  error?: TurnError;
}>;

export type ResumeSnapshot = Readonly<{
  threadId: string;
  turns: readonly ResumeTurn[];
}>;

export type ConversationLifecycle =
  | Readonly<{
      type: 'threadStarted';
      params: ThreadStartedNotification;
    }>
  | Readonly<{
      type: 'turnStarted';
      params: TurnStartedNotification;
    }>
  | Readonly<{
      type: 'itemStarted';
      params: Omit<ItemStartedNotification, 'item'> & {
        item: ConversationItem;
      };
    }>
  | Readonly<{
      type: 'agentDelta';
      params: AgentMessageDeltaNotification;
    }>
  | Readonly<{
      type: 'itemCompleted';
      params: Omit<ItemCompletedNotification, 'item'> & {
        item: ConversationItem;
      };
    }>
  | Readonly<{
      type: 'turnCompleted';
      params: TurnCompletedNotification;
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const MAX_WORKSPACE_LIST_ENTRIES = 1_000;
const MAX_WORKSPACE_LIST_ENTRY_NAME_BYTES = 1_024;
const MAX_WORKSPACE_LIST_TOTAL_NAME_BYTES = 256 * 1_024;
const MAX_WORKSPACE_SEARCH_QUERY_BYTES = 256;
const MAX_WORKSPACE_SEARCH_MATCHES = 200;
const MAX_WORKSPACE_SEARCH_PATH_BYTES = 1_024;
const MAX_WORKSPACE_SEARCH_TOTAL_PATH_BYTES = 256 * 1_024;
const MAX_COMMAND_BYTES = 1_024;
const MAX_COMMAND_ARGUMENT_BYTES = 8 * 1_024;
const MAX_COMMAND_TOTAL_BYTES = 32 * 1_024;
const MAX_COMMAND_ARGUMENTS = 64;
const COMMAND_APPROVAL_DECISIONS = new Set([
  'approved',
  'denied',
  'timedOut',
  'unsupported',
  'cancelled',
  'clientDisconnected',
]);
const WORKSPACE_LIST_ENTRY_KINDS = new Set([
  'file',
  'directory',
  'link',
  'other',
]);

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => /\p{Cc}/u.test(character));

const parseCommandArguments = (value: unknown): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_COMMAND_ARGUMENTS ||
    value.some(
      (argument) =>
        typeof argument !== 'string' ||
        utf8Bytes(argument) > MAX_COMMAND_ARGUMENT_BYTES ||
        hasControlCharacters(argument),
    )
  ) {
    throw new Error('Invalid shell/exec arguments.');
  }
  return [...(value as string[])];
};

const validateCommandPayload = (
  command: unknown,
  argumentsValue: unknown,
): Readonly<{ command: string; arguments: readonly string[] }> => {
  if (
    typeof command !== 'string' ||
    command.length === 0 ||
    !path.isAbsolute(command) ||
    utf8Bytes(command) > MAX_COMMAND_BYTES ||
    hasControlCharacters(command)
  ) {
    throw new Error('Invalid shell/exec command.');
  }
  const argumentsList = parseCommandArguments(argumentsValue);
  if (
    utf8Bytes(command) +
      argumentsList.reduce((total, argument) => total + utf8Bytes(argument), 0) >
    MAX_COMMAND_TOTAL_BYTES
  ) {
    throw new Error('Invalid shell/exec command size.');
  }
  return { command, arguments: argumentsList };
};

const parseWorkspaceListEntryCount = (content: string): number => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid workspace/list success content.');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length > MAX_WORKSPACE_LIST_ENTRIES
  ) {
    throw new Error('Invalid workspace/list success content.');
  }
  let totalNameBytes = 0;
  for (const entry of parsed.entries) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      typeof entry.kind !== 'string' ||
      !WORKSPACE_LIST_ENTRY_KINDS.has(entry.kind)
    ) {
      throw new Error('Invalid workspace/list entry.');
    }
    const nameBytes = utf8Bytes(entry.name);
    if (nameBytes > MAX_WORKSPACE_LIST_ENTRY_NAME_BYTES) {
      throw new Error('Invalid workspace/list entry.');
    }
    totalNameBytes += nameBytes;
    if (totalNameBytes > MAX_WORKSPACE_LIST_TOTAL_NAME_BYTES) {
      throw new Error('Invalid workspace/list success content.');
    }
  }
  return parsed.entries.length;
};

const parseWorkspaceSearchResult = (
  content: string,
): Readonly<{ matches: number; truncated: boolean }> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid workspace/search success content.');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !Array.isArray(parsed.matches) ||
    parsed.matches.length > MAX_WORKSPACE_SEARCH_MATCHES ||
    typeof parsed.truncated !== 'boolean' ||
    (parsed.truncated &&
      parsed.matches.length !== MAX_WORKSPACE_SEARCH_MATCHES)
  ) {
    throw new Error('Invalid workspace/search success content.');
  }
  let totalPathBytes = 0;
  for (const match of parsed.matches) {
    if (
      !isRecord(match) ||
      Object.keys(match).length !== 2 ||
      typeof match.path !== 'string' ||
      match.path.length === 0 ||
      Array.from(match.path).some((character) => /\p{Cc}/u.test(character)) ||
      typeof match.line !== 'number' ||
      !Number.isSafeInteger(match.line) ||
      match.line < 1
    ) {
      throw new Error('Invalid workspace/search match.');
    }
    const pathBytes = utf8Bytes(match.path);
    if (pathBytes > MAX_WORKSPACE_SEARCH_PATH_BYTES) {
      throw new Error('Invalid workspace/search match.');
    }
    totalPathBytes += pathBytes;
    if (totalPathBytes > MAX_WORKSPACE_SEARCH_TOTAL_PATH_BYTES) {
      throw new Error('Invalid workspace/search success content.');
    }
  }
  return {
    matches: parsed.matches.length,
    truncated: parsed.truncated,
  };
};

const TURN_STATUSES = new Set([
  'inProgress',
  'completed',
  'failed',
  'interrupted',
]);

const TURN_ERROR_KINDS = new Set([
  'authentication',
  'invalidRequest',
  'rateLimited',
  'timeout',
  'transport',
  'disconnected',
  'server',
  'protocol',
  'incomplete',
  'filtered',
  'unsupportedOutput',
  'outputTooLarge',
  'stateUnavailable',
]);

const parseTurnError = (value: unknown): TurnError | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    !TURN_ERROR_KINDS.has(value.kind) ||
    typeof value.retryable !== 'boolean'
  ) {
    throw new Error('Invalid Turn error.');
  }
  return {
    kind: value.kind as TurnError['kind'],
    retryable: value.retryable,
  };
};

const parseTurn = (
  value: unknown,
): TurnStartResponse['turn'] => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.status !== 'string' ||
    !TURN_STATUSES.has(value.status)
  ) {
    throw new Error('Invalid Turn.');
  }
  const error = parseTurnError(value.error);
  if (
    (value.status === 'failed') !== (error !== undefined) ||
    (value.status !== 'failed' && Object.hasOwn(value, 'error'))
  ) {
    throw new Error('Invalid Turn terminal error.');
  }
  return {
    id: value.id,
    status: value.status as TurnStartResponse['turn']['status'],
    ...(error ? { error } : {}),
  };
};

export const parseThreadStartResponse = (
  value: unknown,
): ThreadStartResponse => {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    !isId(value.thread.id)
  ) {
    throw new Error('Invalid thread/start response.');
  }
  return { thread: { id: value.thread.id } };
};

export const parseThreadListResponse = (
  value: unknown,
): ThreadListResponse => {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Invalid thread/list response.');
  }
  if (value.data.length > 1) {
    throw new Error('Invalid thread/list response.');
  }
  const nextCursor = value.nextCursor;
  let parsedNextCursor: string | null;
  if (nextCursor === null) {
    parsedNextCursor = null;
  } else if (isId(nextCursor)) {
    parsedNextCursor = nextCursor;
  } else {
    throw new Error('Invalid thread/list response.');
  }
  const data = value.data.map((thread) => {
    if (!isRecord(thread) || !isId(thread.id)) {
      throw new Error('Invalid Thread in thread/list response.');
    }
    return { id: thread.id };
  });
  return {
    data,
    nextCursor: parsedNextCursor,
  };
};

const parseResumeItem = (value: unknown): ResumeItem => {
  if (!isRecord(value) || !isId(value.id) || typeof value.type !== 'string') {
    throw new Error('Invalid Item in thread/resume response.');
  }
  return parseConversationItem(value) ?? { type: 'other', id: value.id };
};

export const parseThreadResumeResponse = (
  value: unknown,
): ResumeSnapshot => {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    !isId(value.thread.id) ||
    !Array.isArray(value.turns)
  ) {
    throw new Error('Invalid thread/resume response.');
  }
  const turns = value.turns.map((turn): ResumeTurn => {
    if (!isRecord(turn) || !Array.isArray(turn.items)) {
      throw new Error('Invalid Turn in thread/resume response.');
    }
    const parsedTurn = parseTurn(turn);
    return {
      id: parsedTurn.id,
      status: parsedTurn.status,
      items: turn.items.map(parseResumeItem),
      ...(parsedTurn.error ? { error: parsedTurn.error } : {}),
    };
  });
  return {
    threadId: value.thread.id,
    turns,
  };
};

export const parseTurnStartResponse = (
  value: unknown,
): TurnStartResponse => {
  if (!isRecord(value)) {
    throw new Error('Invalid turn/start response.');
  }
  const turn = parseTurn(value.turn);
  if (turn.status !== 'inProgress') {
    throw new Error('turn/start did not return an in-progress Turn.');
  }
  return { turn };
};

export const parseTurnInterruptResponse = (
  value: unknown,
): TurnInterruptResponse => {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new Error('Invalid turn/interrupt response.');
  }
  return {};
};

const parseConversationItem = (value: unknown): ConversationItem | null => {
  if (!isRecord(value) || !isId(value.id) || typeof value.type !== 'string') {
    throw new Error('Invalid Item.');
  }
  if (value.type === 'userMessage' || value.type === 'agentMessage') {
    if (typeof value.text !== 'string') {
      throw new Error('Invalid text Item.');
    }
    return {
      type: value.type,
      id: value.id,
      text: value.text,
    };
  }
  if (value.type === 'toolCall' && value.name === 'shell/exec') {
    if (
      !isId(value.callId) ||
      value.path !== '.' ||
      Object.hasOwn(value, 'query')
    ) {
      throw new Error('Invalid shell/exec ToolCall Item.');
    }
    return {
      type: 'commandCall',
      id: value.id,
      callId: value.callId,
      ...validateCommandPayload(value.command, value.arguments),
    };
  }
  if (value.type === 'commandApprovalRequest') {
    if (
      !isId(value.approvalId) ||
      !isId(value.callId) ||
      value.cwd !== '.' ||
      value.environmentPolicy !== 'minimalV1' ||
      value.sandboxed !== true ||
      value.sandboxPolicy !== 'filesystemReadOnlyV1' ||
      value.networkPolicy !== 'networkDeniedV1'
    ) {
      throw new Error('Invalid command approval request Item.');
    }
    if (
      Object.hasOwn(value, 'workspaceWritePolicy') ||
      Object.hasOwn(value, 'workspaceWriteRisk')
    ) {
      return null;
    }
    return {
      type: 'commandApprovalRequest',
      id: value.id,
      approvalId: value.approvalId,
      callId: value.callId,
      ...validateCommandPayload(value.command, value.arguments),
    };
  }
  if (value.type === 'commandApprovalDecision') {
    if (Object.hasOwn(value, 'workspaceWriteRiskAcknowledgement')) {
      return null;
    }
    if (
      !isId(value.approvalId) ||
      typeof value.decision !== 'string' ||
      !COMMAND_APPROVAL_DECISIONS.has(value.decision)
    ) {
      throw new Error('Invalid command approval decision Item.');
    }
    return {
      type: 'commandApprovalDecision',
      id: value.id,
      approvalId: value.approvalId,
      decision: value.decision as CommandApprovalDecisionItem['decision'],
    };
  }
  if (value.type === 'toolCall' && value.name === 'workspace/read') {
    if (
      !isId(value.callId) ||
      typeof value.path !== 'string' ||
      value.path.length === 0 ||
      Object.hasOwn(value, 'query') ||
      Object.hasOwn(value, 'command') ||
      Object.hasOwn(value, 'arguments')
    ) {
      throw new Error('Invalid workspace/read ToolCall Item.');
    }
    return {
      type: 'workspaceReadCall',
      id: value.id,
      callId: value.callId,
      path: value.path,
    };
  }
  if (value.type === 'toolResult' && value.name === 'workspace/read') {
    if (!isId(value.callId) || !isRecord(value.result)) {
      throw new Error('Invalid workspace/read ToolResult Item.');
    }
    if (
      value.result.type === 'success' &&
      typeof value.result.content === 'string' &&
      typeof value.result.bytes === 'number' &&
      Number.isSafeInteger(value.result.bytes) &&
      value.result.bytes >= 0
    ) {
      return {
        type: 'workspaceReadResult',
        id: value.id,
        callId: value.callId,
        outcome: { type: 'success', bytes: value.result.bytes },
      };
    }
    if (
      value.result.type === 'error' &&
      typeof value.result.kind === 'string' &&
      value.result.kind.length > 0
    ) {
      return {
        type: 'workspaceReadResult',
        id: value.id,
        callId: value.callId,
        outcome: { type: 'error', kind: value.result.kind },
      };
    }
    throw new Error('Invalid workspace/read ToolResult outcome.');
  }
  if (value.type === 'toolCall' && value.name === 'workspace/list') {
    if (
      !isId(value.callId) ||
      typeof value.path !== 'string' ||
      value.path.length === 0 ||
      Object.hasOwn(value, 'query') ||
      Object.hasOwn(value, 'command') ||
      Object.hasOwn(value, 'arguments')
    ) {
      throw new Error('Invalid workspace/list ToolCall Item.');
    }
    return {
      type: 'workspaceListCall',
      id: value.id,
      callId: value.callId,
      path: value.path,
    };
  }
  if (value.type === 'toolResult' && value.name === 'workspace/list') {
    if (!isId(value.callId) || !isRecord(value.result)) {
      throw new Error('Invalid workspace/list ToolResult Item.');
    }
    if (
      value.result.type === 'success' &&
      typeof value.result.content === 'string' &&
      typeof value.result.bytes === 'number' &&
      Number.isSafeInteger(value.result.bytes) &&
      value.result.bytes >= 0 &&
      utf8Bytes(value.result.content) === value.result.bytes
    ) {
      return {
        type: 'workspaceListResult',
        id: value.id,
        callId: value.callId,
        outcome: {
          type: 'success',
          entries: parseWorkspaceListEntryCount(value.result.content),
        },
      };
    }
    if (
      value.result.type === 'error' &&
      typeof value.result.kind === 'string' &&
      value.result.kind.length > 0
    ) {
      return {
        type: 'workspaceListResult',
        id: value.id,
        callId: value.callId,
        outcome: { type: 'error', kind: value.result.kind },
      };
    }
    throw new Error('Invalid workspace/list ToolResult outcome.');
  }
  if (value.type === 'toolCall' && value.name === 'workspace/search') {
    if (
      !isId(value.callId) ||
      typeof value.path !== 'string' ||
      value.path.length === 0 ||
      typeof value.query !== 'string' ||
      value.query.length === 0 ||
      utf8Bytes(value.query) > MAX_WORKSPACE_SEARCH_QUERY_BYTES ||
      Array.from(value.query).some((character) => /\p{Cc}/u.test(character)) ||
      Array.from(value.query).every((character) => /\s/u.test(character)) ||
      Object.hasOwn(value, 'command') ||
      Object.hasOwn(value, 'arguments')
    ) {
      throw new Error('Invalid workspace/search ToolCall Item.');
    }
    return {
      type: 'workspaceSearchCall',
      id: value.id,
      callId: value.callId,
      path: value.path,
      query: value.query,
    };
  }
  if (value.type === 'toolResult' && value.name === 'workspace/search') {
    if (!isId(value.callId) || !isRecord(value.result)) {
      throw new Error('Invalid workspace/search ToolResult Item.');
    }
    if (
      value.result.type === 'success' &&
      typeof value.result.content === 'string' &&
      typeof value.result.bytes === 'number' &&
      Number.isSafeInteger(value.result.bytes) &&
      value.result.bytes >= 0 &&
      utf8Bytes(value.result.content) === value.result.bytes
    ) {
      return {
        type: 'workspaceSearchResult',
        id: value.id,
        callId: value.callId,
        outcome: {
          type: 'success',
          ...parseWorkspaceSearchResult(value.result.content),
        },
      };
    }
    if (
      value.result.type === 'error' &&
      typeof value.result.kind === 'string' &&
      value.result.kind.length > 0
    ) {
      return {
        type: 'workspaceSearchResult',
        id: value.id,
        callId: value.callId,
        outcome: { type: 'error', kind: value.result.kind },
      };
    }
    throw new Error('Invalid workspace/search ToolResult outcome.');
  }
  return null;
};

const parseThreadAndTurn = (
  value: unknown,
): { threadId: string; turnId: string } => {
  if (!isRecord(value) || !isId(value.threadId) || !isId(value.turnId)) {
    throw new Error('Invalid conversation lifecycle correlation.');
  }
  return { threadId: value.threadId, turnId: value.turnId };
};

export const parseConversationLifecycle = (
  message: Extract<ServerMessage, { kind: 'notification' }>,
): ConversationLifecycle | null => {
  const params = message.params;
  switch (message.method) {
    case 'thread/started': {
      if (
        !isRecord(params) ||
        !isRecord(params.thread) ||
        !isId(params.thread.id)
      ) {
        throw new Error('Invalid thread/started notification.');
      }
      return {
        type: 'threadStarted',
        params: { thread: { id: params.thread.id } },
      };
    }
    case 'turn/started': {
      if (!isRecord(params) || !isId(params.threadId)) {
        throw new Error('Invalid turn/started notification.');
      }
      const turn = parseTurn(params.turn);
      if (turn.status !== 'inProgress') {
        throw new Error('turn/started did not contain an in-progress Turn.');
      }
      return {
        type: 'turnStarted',
        params: { threadId: params.threadId, turn },
      };
    }
    case 'item/started':
    case 'item/completed': {
      const correlation = parseThreadAndTurn(params);
      const item = parseConversationItem(
        (params as Record<string, unknown>).item,
      );
      if (!item) {
        return null;
      }
      return {
        type:
          message.method === 'item/started'
            ? 'itemStarted'
            : 'itemCompleted',
        params: { ...correlation, item },
      };
    }
    case 'item/agentMessage/delta': {
      if (
        !isRecord(params) ||
        !isId(params.threadId) ||
        !isId(params.turnId) ||
        !isId(params.itemId) ||
        typeof params.delta !== 'string'
      ) {
        throw new Error('Invalid AgentMessage delta notification.');
      }
      return {
        type: 'agentDelta',
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          delta: params.delta,
        },
      };
    }
    case 'turn/completed': {
      if (!isRecord(params) || !isId(params.threadId)) {
        throw new Error('Invalid turn/completed notification.');
      }
      const turn = parseTurn(params.turn);
      if (turn.status === 'inProgress') {
        throw new Error('turn/completed contained an in-progress Turn.');
      }
      return {
        type: 'turnCompleted',
        params: { threadId: params.threadId, turn },
      };
    }
    default:
      return null;
  }
};
