import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  ModelSelectionSnapshot,
  ThreadStartResponse,
  ThreadStartedNotification,
  ThreadTitleUpdatedNotification,
  TurnSnapshotStatus,
  TurnCompletedNotification,
  TurnError,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnStartedNotification,
} from '@sugarcode/app-server-protocol';
import path from 'node:path';

import type { ServerMessage } from '../transport/server-message';
import {
  parseWorkspacePatchItem,
  type WorkspacePatchItem,
} from './file-change-protocol';
import {
  parseMcpConversationItem,
  type McpConversationItem,
} from './mcp-protocol';
import { parseShellToolCallPayload } from './shell-tool-protocol';
import { isThreadTitle } from './thread-title';
import { isToolValidationRejectedItem } from './tool-validation-protocol';

export { parseThreadListResponse } from './thread-protocol';

type AgentTextItem = Extract<
  ItemStartedNotification['item'],
  { type: 'agentMessage' }
>;

export type UserMessageItem = Readonly<{
  type: 'userMessage';
  id: string;
  text: string;
  attachments: readonly Readonly<{
    assetId: string;
    sha256: string;
    mediaType: string;
    originalName: string;
    sizeBytes: number;
    kind: 'image' | 'pdf' | 'text';
  }>[];
}>;

export type AgentCommentaryItem = Readonly<{
  type: 'agentCommentary';
  id: string;
  text: string;
}>;

export type AgentOutputRef = Readonly<{
  responseOrdinal: number;
  outputIndex: number;
}>;

export type ContextCompactionItem = Readonly<{
  type: 'contextCompaction';
  id: string;
  strategy: 'modelGeneratedActiveTurnV1';
  ordinal: number;
  preContextBytes: number;
  sourceMessages: number;
  sourceBytes: number;
  sourceSha256: string;
  outcome?:
    | Readonly<{
        type: 'completed';
        postContextBytes: number;
        summaryBytes: number;
        summarySha256: string;
      }>
    | Readonly<{ type: 'failed'; kind: string }>
    | Readonly<{ type: 'interrupted' }>;
}>;

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

export type CommandExecutionAttemptItem = Readonly<{
  type: 'commandExecutionAttempt';
  id: string;
  approvalId: string;
  callId: string;
}>;

export type CommandExecutionResultOutcome =
  | Readonly<{ type: 'error'; kind: string }>
  | Readonly<{
      type: 'process';
      stdoutBytes: number;
      stderrBytes: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      encoding: 'utf8Lossy';
      durationMs: number;
      outcome:
        | Readonly<{ type: 'exitCode'; code: number }>
        | Readonly<{ type: 'signal'; signal: number }>
        | Readonly<{ type: 'timedOut' }>;
      sandboxPolicy: 'filesystemReadOnlyV1';
      networkPolicy: 'networkDeniedV1';
    }>;

export type CommandExecutionResultItem = Readonly<{
  type: 'commandExecutionResult';
  id: string;
  callId: string;
  outcome: CommandExecutionResultOutcome;
}>;

export type AgentTaskItem = Readonly<{
  type: 'agentTask';
  id: string;
  orchestrationId: string;
  taskId: string;
  clientTaskKey: string;
  childThreadId: string;
  title: string;
  role: 'explorer' | 'worker' | 'auditor';
  access: 'readOnly' | 'workspaceWrite';
  dependsOn: readonly string[];
  taskMarkdown: string;
}>;

export type AgentTaskAmendmentItem = Readonly<{
  type: 'agentTaskAmendment';
  id: string;
  orchestrationId: string;
  taskId: string;
  amendmentMarkdown: string;
}>;

export type AgentTaskResultItem = Readonly<{
  type: 'agentTaskResult';
  id: string;
  orchestrationId: string;
  taskId: string;
  status:
    | 'queued'
    | 'running'
    | 'waitingApproval'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'cancelled';
  summaryMarkdown: string;
  durationMs: number;
}>;

type ConversationItem =
  | UserMessageItem
  | AgentTextItem
  | AgentCommentaryItem
  | ContextCompactionItem
  | WorkspaceReadCallItem
  | WorkspaceReadResultItem
  | WorkspaceListCallItem
  | WorkspaceListResultItem
  | WorkspaceSearchCallItem
  | WorkspaceSearchResultItem
  | WorkspacePatchItem
  | CommandCallItem
  | CommandApprovalRequestItem
  | CommandApprovalDecisionItem
  | CommandExecutionAttemptItem
  | CommandExecutionResultItem
  | AgentTaskItem
  | AgentTaskAmendmentItem
  | AgentTaskResultItem
  | McpConversationItem;

export type ResumeItem =
  | ConversationItem
  | Readonly<{
      type: 'other';
      id: string;
    }>;

export type ResumeTurn = Readonly<{
  id: string;
  status: TurnSnapshotStatus;
  model?: ModelSelectionSnapshot;
  items: readonly ResumeItem[];
  error?: TurnError;
  usage?: TokenUsageValue;
}>;

export type TokenUsageValue = Readonly<{
  lastRequest: Readonly<{
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  }>;
  turnTotal: Readonly<{
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  }>;
  requestCount: number;
  contextWindowTokens: number;
  source: 'provider' | 'estimated';
}>;

export type ResumeSnapshot = Readonly<{
  threadId: string;
  workspaceId: string;
  title?: string;
  origin?: Readonly<{
    type: 'subagent';
    parentThreadId: string;
    parentTurnId: string;
    orchestrationId: string;
    taskId: string;
    role: 'explorer' | 'worker' | 'auditor';
  }>;
  turns: readonly ResumeTurn[];
}>;

export type ConversationLifecycle =
  | Readonly<{
      type: 'threadStarted';
      params: ThreadStartedNotification;
    }>
  | Readonly<{
      type: 'threadTitleUpdated';
      params: ThreadTitleUpdatedNotification;
    }>
  | Readonly<{
      type: 'turnStarted';
      params: TurnStartedNotification;
    }>
  | Readonly<{
      type: 'itemStarted';
      params: Omit<ItemStartedNotification, 'item' | 'agentOutput'> & {
        item: ConversationItem;
        agentOutput?: AgentOutputRef;
      };
    }>
  | Readonly<{
      type: 'agentDelta';
      params: AgentMessageDeltaNotification;
    }>
  | Readonly<{
      type: 'agentOutputDelta';
      params: Readonly<{
        workspaceId: string;
        threadId: string;
        turnId: string;
        output: AgentOutputRef;
        delta: string;
      }>;
    }>
  | Readonly<{
      type: 'agentOutputDiscarded';
      params: Readonly<{
        workspaceId: string;
        threadId: string;
        turnId: string;
        output: AgentOutputRef;
      }>;
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
    }>
  | Readonly<{
      type: 'tokenUsageUpdated';
      params: Readonly<{
        workspaceId: string;
        threadId: string;
        turnId: string;
        usage: TokenUsageValue;
      }>;
    }>
  | Readonly<{
      type: 'warning';
      params: Readonly<{
        workspaceId: string;
        threadId: string;
        turnId: string;
        code:
          | 'providerManagedContinuationFallback'
          | 'historicalContextDowngraded';
      }>;
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const WORKSPACE_ID_PATTERN = /^(?:unbound|[0-9a-f]{64})$/u;

export const isWorkspaceId = (value: unknown): value is string =>
  typeof value === 'string' && WORKSPACE_ID_PATTERN.test(value);

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUuidV7 = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V7_PATTERN.test(value);

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
      argumentsList.reduce(
        (total, argument) => total + utf8Bytes(argument),
        0,
      ) >
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
    (parsed.truncated && parsed.matches.length !== MAX_WORKSPACE_SEARCH_MATCHES)
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
  'contextWindowExceeded',
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
  'unsupportedToolArguments',
  'providerRequestTooLarge',
  'providerResponseTooLarge',
  'outputTooLarge',
  'stateUnavailable',
]);

const parseTokenSample = (
  value: unknown,
): TokenUsageValue['lastRequest'] => {
  if (!isRecord(value)) {
    throw new Error('Invalid token usage sample.');
  }
  const parsed: Record<string, number> = {};
  for (const key of [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
  ] as const) {
    const candidate = value[key];
    if (candidate === null || candidate === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new Error('Invalid token usage sample.');
    }
    parsed[key] = candidate as number;
  }
  return parsed;
};

const parseTokenUsage = (value: unknown): TokenUsageValue => {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.requestCount) ||
    (value.requestCount as number) < 1 ||
    !Number.isInteger(value.contextWindowTokens) ||
    (value.contextWindowTokens as number) < 4_096 ||
    (value.contextWindowTokens as number) > 2_097_152 ||
    (value.source !== 'provider' && value.source !== 'estimated')
  ) {
    throw new Error('Invalid token usage.');
  }
  return {
    lastRequest: parseTokenSample(value.lastRequest),
    turnTotal: parseTokenSample(value.turnTotal),
    requestCount: value.requestCount as number,
    contextWindowTokens: value.contextWindowTokens as number,
    source: value.source,
  };
};

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
  if (value.protocol !== undefined) {
    if (
      !isRecord(value.protocol) ||
      ![
        'streamEvent',
        'responseAssembly',
        'outputNormalization',
        'runtimeClassification',
      ].includes(value.protocol.stage as string) ||
      ![
        'wireMismatch',
        'invalidEventShape',
        'ambiguousOutputReconciliation',
        'malformedToolCall',
        'terminalLifecycleViolation',
        'continuationOutputMismatch',
        'outputIndexMismatch',
      ].includes(value.protocol.code as string) ||
      (value.protocol.eventType !== undefined &&
        (typeof value.protocol.eventType !== 'string' ||
          !/^[A-Za-z0-9_./-]{1,128}$/.test(value.protocol.eventType))) ||
      typeof value.protocol.shapeSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.protocol.shapeSha256)
    ) {
      throw new Error('Invalid Turn protocol diagnostic.');
    }
  }
  return {
    kind: value.kind as TurnError['kind'],
    retryable: value.retryable,
    protocol: value.protocol as TurnError['protocol'],
  };
};

const parseModelSelection = (
  value: unknown,
): ModelSelectionSnapshot | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.profileId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(value.profileId) ||
    ![
      'openai',
      'anthropic',
    ].includes(value.providerFamily as string) ||
    ![
      'openaiResponses',
      'openaiChatCompletions',
      'anthropicMessages',
    ].includes(value.wireApi as string) ||
    typeof value.modelId !== 'string' ||
    typeof value.displayName !== 'string' ||
    !Number.isInteger(value.contextWindowTokens) ||
    (value.contextWindowTokens as number) < 4_096 ||
    (value.contextWindowTokens as number) > 2_097_152 ||
    !isRecord(value.effectiveCapabilities) ||
    ![
      'toolCalls',
      'strictTools',
      'parallelTools',
      'imageInput',
      'pdfInput',
    ].every(
      (key) =>
        typeof (
          value.effectiveCapabilities as Record<string, unknown>
        )[key] === 'boolean',
    )
  ) {
    throw new Error('Invalid Turn model selection.');
  }
  return {
    profileId: value.profileId,
    providerFamily:
      value.providerFamily as ModelSelectionSnapshot['providerFamily'],
    wireApi: value.wireApi as ModelSelectionSnapshot['wireApi'],
    modelId: value.modelId,
    displayName: value.displayName,
    contextWindowTokens: value.contextWindowTokens as number,
    effectiveCapabilities:
      value.effectiveCapabilities as ModelSelectionSnapshot['effectiveCapabilities'],
  };
};

const parseTurn = (value: unknown): TurnStartResponse['turn'] => {
  if (
    !isRecord(value) ||
    !isUuidV7(value.id) ||
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
  const model = parseModelSelection(value.model);
  return {
    id: value.id,
    status: value.status as TurnStartResponse['turn']['status'],
    ...(model ? { model } : {}),
    ...(error ? { error } : {}),
  };
};

export const parseThreadStartResponse = (
  value: unknown,
): ThreadStartResponse => {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    !isUuidV7(value.thread.id) ||
    !isId(value.thread.workspaceId)
  ) {
    throw new Error('Invalid thread/start response.');
  }
  return {
    thread: { id: value.thread.id, workspaceId: value.thread.workspaceId },
  };
};

const parseResumeItem = (value: unknown): ResumeItem => {
  if (!isRecord(value) || !isUuidV7(value.id) || typeof value.type !== 'string') {
    throw new Error('Invalid Item in thread/resume response.');
  }
  return parseConversationItem(value) ?? { type: 'other', id: value.id };
};

export const parseThreadResumeResponse = (value: unknown): ResumeSnapshot => {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    !isUuidV7(value.thread.id) ||
    !isId(value.thread.workspaceId) ||
    (Object.hasOwn(value.thread, 'title') &&
      !isThreadTitle(value.thread.title)) ||
    !Array.isArray(value.turns)
  ) {
    throw new Error('Invalid thread/resume response.');
  }
  const turns = value.turns.map((turn): ResumeTurn => {
    if (!isRecord(turn) || !Array.isArray(turn.items)) {
      throw new Error('Invalid Turn in thread/resume response.');
    }
    const parsedTurn = parseTurn(turn);
    const usage = Object.hasOwn(turn, 'usage')
      ? parseTokenUsage(turn.usage)
      : undefined;
    return {
      id: parsedTurn.id,
      status: parsedTurn.status,
      ...(parsedTurn.model ? { model: parsedTurn.model } : {}),
      items: turn.items.map(parseResumeItem),
      ...(parsedTurn.error ? { error: parsedTurn.error } : {}),
      ...(usage ? { usage } : {}),
    };
  });
  let origin: ResumeSnapshot['origin'];
  if (value.thread.origin !== undefined) {
    const candidate = value.thread.origin;
    if (
      !isRecord(candidate) ||
      candidate.type !== 'subagent' ||
      !isId(candidate.parentThreadId) ||
      !isId(candidate.parentTurnId) ||
      !isId(candidate.orchestrationId) ||
      !isId(candidate.taskId) ||
      (candidate.role !== 'explorer' &&
        candidate.role !== 'worker' &&
        candidate.role !== 'auditor')
    ) {
      throw new Error('Invalid subagent Thread origin.');
    }
    origin = {
      type: 'subagent',
      parentThreadId: candidate.parentThreadId,
      parentTurnId: candidate.parentTurnId,
      orchestrationId: candidate.orchestrationId,
      taskId: candidate.taskId,
      role: candidate.role,
    };
  }
  return {
    threadId: value.thread.id,
    workspaceId: value.thread.workspaceId,
    ...(typeof value.thread.title === 'string'
      ? { title: value.thread.title }
      : {}),
    ...(origin ? { origin } : {}),
    turns,
  };
};

export const parseTurnStartResponse = (value: unknown): TurnStartResponse => {
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
  if (!isRecord(value) || !isUuidV7(value.id) || typeof value.type !== 'string') {
    throw new Error('Invalid Item.');
  }
  if (isToolValidationRejectedItem(value)) {
    return null;
  }
  if (value.type === 'userMessage') {
    if (!Array.isArray(value.content)) {
      throw new Error('Invalid userMessage content.');
    }
    const text: string[] = [];
    const attachments: UserMessageItem['attachments'][number][] = [];
    for (const part of value.content) {
      if (!isRecord(part) || typeof part.type !== 'string') {
        throw new Error('Invalid userMessage content part.');
      }
      if (part.type === 'text') {
        if (typeof part.text !== 'string') {
          throw new Error('Invalid userMessage text part.');
        }
        text.push(part.text);
        continue;
      }
      if (
        (part.type !== 'image' && part.type !== 'document') ||
        !isRecord(part.asset) ||
        typeof part.asset.assetId !== 'string' ||
        typeof part.asset.sha256 !== 'string' ||
        typeof part.asset.mediaType !== 'string' ||
        typeof part.asset.originalName !== 'string' ||
        typeof part.asset.sizeBytes !== 'number' ||
        !Number.isSafeInteger(part.asset.sizeBytes) ||
        part.asset.sizeBytes <= 0 ||
        (part.asset.kind !== 'image' &&
          part.asset.kind !== 'pdf' &&
          part.asset.kind !== 'text')
      ) {
        throw new Error('Invalid userMessage attachment part.');
      }
      attachments.push({
        assetId: part.asset.assetId,
        sha256: part.asset.sha256,
        mediaType: part.asset.mediaType,
        originalName: part.asset.originalName,
        sizeBytes: part.asset.sizeBytes,
        kind: part.asset.kind,
      });
    }
    return {
      type: 'userMessage',
      id: value.id,
      text: text.join(''),
      attachments,
    };
  }
  if (value.type === 'agentMessage') {
    if (typeof value.text !== 'string') {
      throw new Error('Invalid text Item.');
    }
    return {
      type: value.type,
      id: value.id,
      text: value.text,
    };
  }
  if (value.type === 'agentCommentary') {
    if (
      typeof value.text !== 'string' ||
      value.text.length === 0 ||
      utf8Bytes(value.text) > 4 * 1024
    ) {
      throw new Error('Invalid agentCommentary Item.');
    }
    return {
      type: 'agentCommentary',
      id: value.id,
      text: value.text,
    };
  }
  if (value.type === 'contextCompaction') {
    const integerFields = [
      value.ordinal,
      value.preContextBytes,
      value.sourceMessages,
      value.sourceBytes,
    ];
    if (
      value.strategy !== 'modelGeneratedActiveTurnV1' ||
      integerFields.some(
        (field) =>
          typeof field !== 'number' ||
          !Number.isSafeInteger(field) ||
          field < 0,
      ) ||
      typeof value.sourceSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.sourceSha256)
    ) {
      throw new Error('Invalid contextCompaction Item.');
    }
    let outcome: ContextCompactionItem['outcome'];
    if (value.outcome !== undefined) {
      if (!isRecord(value.outcome) || typeof value.outcome.type !== 'string') {
        throw new Error('Invalid contextCompaction outcome.');
      }
      if (value.outcome.type === 'completed') {
        if (
          typeof value.outcome.postContextBytes !== 'number' ||
          !Number.isSafeInteger(value.outcome.postContextBytes) ||
          value.outcome.postContextBytes < 0 ||
          typeof value.outcome.summaryBytes !== 'number' ||
          !Number.isSafeInteger(value.outcome.summaryBytes) ||
          value.outcome.summaryBytes < 0 ||
          typeof value.outcome.summarySha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(value.outcome.summarySha256)
        ) {
          throw new Error('Invalid completed contextCompaction outcome.');
        }
        outcome = {
          type: 'completed',
          postContextBytes: value.outcome.postContextBytes,
          summaryBytes: value.outcome.summaryBytes,
          summarySha256: value.outcome.summarySha256,
        };
      } else if (
        value.outcome.type === 'failed' &&
        typeof value.outcome.kind === 'string' &&
        value.outcome.kind.length > 0
      ) {
        outcome = { type: 'failed', kind: value.outcome.kind };
      } else if (
        value.outcome.type === 'interrupted' &&
        Object.keys(value.outcome).length === 1
      ) {
        outcome = { type: 'interrupted' };
      } else {
        throw new Error('Invalid contextCompaction outcome.');
      }
    }
    return {
      type: 'contextCompaction',
      id: value.id,
      strategy: 'modelGeneratedActiveTurnV1',
      ordinal: value.ordinal as number,
      preContextBytes: value.preContextBytes as number,
      sourceMessages: value.sourceMessages as number,
      sourceBytes: value.sourceBytes as number,
      sourceSha256: value.sourceSha256,
      ...(outcome ? { outcome } : {}),
    };
  }
  if (value.type === 'agentTask') {
    const roles = new Set(['explorer', 'worker', 'auditor']);
    const accesses = new Set(['readOnly', 'workspaceWrite']);
    if (
      !isId(value.orchestrationId) ||
      !isId(value.taskId) ||
      !isId(value.clientTaskKey) ||
      !isId(value.childThreadId) ||
      typeof value.title !== 'string' ||
      value.title.length === 0 ||
      typeof value.role !== 'string' ||
      !roles.has(value.role) ||
      typeof value.access !== 'string' ||
      !accesses.has(value.access) ||
      !Array.isArray(value.dependsOn) ||
      value.dependsOn.some((dependency) => !isId(dependency)) ||
      typeof value.taskMarkdown !== 'string' ||
      value.taskMarkdown.length === 0
    ) {
      throw new Error('Invalid agentTask Item.');
    }
    return {
      type: 'agentTask',
      id: value.id,
      orchestrationId: value.orchestrationId,
      taskId: value.taskId,
      clientTaskKey: value.clientTaskKey,
      childThreadId: value.childThreadId,
      title: value.title,
      role: value.role as AgentTaskItem['role'],
      access: value.access as AgentTaskItem['access'],
      dependsOn: [...(value.dependsOn as string[])],
      taskMarkdown: value.taskMarkdown,
    };
  }
  if (value.type === 'agentTaskAmendment') {
    if (
      !isId(value.orchestrationId) ||
      !isId(value.taskId) ||
      typeof value.amendmentMarkdown !== 'string' ||
      value.amendmentMarkdown.length === 0
    ) {
      throw new Error('Invalid agentTaskAmendment Item.');
    }
    return {
      type: 'agentTaskAmendment',
      id: value.id,
      orchestrationId: value.orchestrationId,
      taskId: value.taskId,
      amendmentMarkdown: value.amendmentMarkdown,
    };
  }
  if (value.type === 'agentTaskResult') {
    const statuses = new Set([
      'queued',
      'running',
      'waitingApproval',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
    ]);
    if (
      !isId(value.orchestrationId) ||
      !isId(value.taskId) ||
      typeof value.status !== 'string' ||
      !statuses.has(value.status) ||
      typeof value.summaryMarkdown !== 'string' ||
      typeof value.durationMs !== 'number' ||
      !Number.isSafeInteger(value.durationMs) ||
      value.durationMs < 0
    ) {
      throw new Error('Invalid agentTaskResult Item.');
    }
    return {
      type: 'agentTaskResult',
      id: value.id,
      orchestrationId: value.orchestrationId,
      taskId: value.taskId,
      status: value.status as AgentTaskResultItem['status'],
      summaryMarkdown: value.summaryMarkdown,
      durationMs: value.durationMs,
    };
  }
  const workspacePatch = parseWorkspacePatchItem(value);
  if (workspacePatch) {
    return workspacePatch;
  }
  const mcpItem = parseMcpConversationItem(value);
  if (mcpItem) {
    return mcpItem;
  }
  if (value.type === 'toolCall' && value.name === 'shell/exec') {
    const argumentsValue = value.arguments;
    if (
      !isId(value.callId) ||
      !isRecord(argumentsValue)
    ) {
      throw new Error('Invalid shell/exec ToolCall Item.');
    }
    const payload = parseShellToolCallPayload(argumentsValue);
    return {
      type: 'commandCall',
      id: value.id,
      callId: value.callId,
      command: payload.command,
      arguments: payload.arguments,
    };
  }
  if (value.type === 'commandApprovalRequest') {
    if (
      !isId(value.approvalId) ||
      !isId(value.callId) ||
      value.cwd !== '.' ||
      (value.environmentPolicy !== 'minimalV1' &&
        value.environmentPolicy !== 'hostInheritedV1') ||
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
  if (value.type === 'commandExecutionAttempt') {
    if (!isId(value.approvalId) || !isId(value.callId)) {
      throw new Error('Invalid command execution attempt Item.');
    }
    return {
      type: 'commandExecutionAttempt',
      id: value.id,
      approvalId: value.approvalId,
      callId: value.callId,
    };
  }
  if (value.type === 'toolResult' && value.name === 'shell/exec') {
    if (!isId(value.callId) || !isRecord(value.result)) {
      throw new Error('Invalid shell/exec ToolResult Item.');
    }
    if (
      value.result.type === 'error' &&
      Object.keys(value.result).length === 2 &&
      typeof value.result.kind === 'string' &&
      value.result.kind.length > 0
    ) {
      return {
        type: 'commandExecutionResult',
        id: value.id,
        callId: value.callId,
        outcome: { type: 'error', kind: value.result.kind },
      };
    }
    if (
      value.result.type !== 'process' ||
      Object.keys(value.result).length !== 12 ||
      typeof value.result.stdout !== 'string' ||
      typeof value.result.stderr !== 'string' ||
      typeof value.result.stdoutBytes !== 'number' ||
      !Number.isSafeInteger(value.result.stdoutBytes) ||
      value.result.stdoutBytes < 0 ||
      typeof value.result.stderrBytes !== 'number' ||
      !Number.isSafeInteger(value.result.stderrBytes) ||
      value.result.stderrBytes < 0 ||
      typeof value.result.stdoutTruncated !== 'boolean' ||
      typeof value.result.stderrTruncated !== 'boolean' ||
      value.result.encoding !== 'utf8Lossy' ||
      typeof value.result.durationMs !== 'number' ||
      !Number.isSafeInteger(value.result.durationMs) ||
      value.result.durationMs < 0 ||
      value.result.sandboxPolicy !== 'filesystemReadOnlyV1' ||
      value.result.networkPolicy !== 'networkDeniedV1' ||
      Object.hasOwn(value.result, 'workspaceWritePolicy') ||
      !isRecord(value.result.outcome)
    ) {
      throw new Error('Invalid shell/exec ToolResult outcome.');
    }
    const processOutcome = (() => {
      if (
        value.result.outcome.type === 'exitCode' &&
        Object.keys(value.result.outcome).length === 2 &&
        typeof value.result.outcome.code === 'number' &&
        Number.isSafeInteger(value.result.outcome.code)
      ) {
        return {
          type: 'exitCode',
          code: value.result.outcome.code,
        } as const;
      }
      if (
        value.result.outcome.type === 'signal' &&
        Object.keys(value.result.outcome).length === 2 &&
        typeof value.result.outcome.signal === 'number' &&
        Number.isSafeInteger(value.result.outcome.signal)
      ) {
        return {
          type: 'signal',
          signal: value.result.outcome.signal,
        } as const;
      }
      if (
        value.result.outcome.type === 'timedOut' &&
        Object.keys(value.result.outcome).length === 1
      ) {
        return { type: 'timedOut' } as const;
      }
      throw new Error('Invalid shell/exec process outcome.');
    })();
    return {
      type: 'commandExecutionResult',
      id: value.id,
      callId: value.callId,
      outcome: {
        type: 'process',
        stdoutBytes: value.result.stdoutBytes,
        stderrBytes: value.result.stderrBytes,
        stdoutTruncated: value.result.stdoutTruncated,
        stderrTruncated: value.result.stderrTruncated,
        encoding: 'utf8Lossy',
        durationMs: value.result.durationMs,
        outcome: processOutcome,
        sandboxPolicy: 'filesystemReadOnlyV1',
        networkPolicy: 'networkDeniedV1',
      },
    };
  }
  if (value.type === 'toolCall' && value.name === 'workspace/read') {
    const argumentsValue = value.arguments;
    if (
      !isId(value.callId) ||
      !isRecord(argumentsValue) ||
      Object.keys(argumentsValue).join(',') !== 'path' ||
      typeof argumentsValue.path !== 'string' ||
      argumentsValue.path.length === 0
    ) {
      throw new Error('Invalid workspace/read ToolCall Item.');
    }
    return {
      type: 'workspaceReadCall',
      id: value.id,
      callId: value.callId,
      path: argumentsValue.path,
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
    const argumentsValue = value.arguments;
    if (
      !isId(value.callId) ||
      !isRecord(argumentsValue) ||
      Object.keys(argumentsValue).join(',') !== 'path' ||
      typeof argumentsValue.path !== 'string' ||
      argumentsValue.path.length === 0
    ) {
      throw new Error('Invalid workspace/list ToolCall Item.');
    }
    return {
      type: 'workspaceListCall',
      id: value.id,
      callId: value.callId,
      path: argumentsValue.path,
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
    const argumentsValue = value.arguments;
    if (
      !isId(value.callId) ||
      !isRecord(argumentsValue) ||
      Object.keys(argumentsValue).sort().join(',') !== 'path,query' ||
      typeof argumentsValue.path !== 'string' ||
      argumentsValue.path.length === 0 ||
      typeof argumentsValue.query !== 'string' ||
      argumentsValue.query.length === 0 ||
      utf8Bytes(argumentsValue.query) > MAX_WORKSPACE_SEARCH_QUERY_BYTES ||
      Array.from(argumentsValue.query).some((character) =>
        /\p{Cc}/u.test(character),
      ) ||
      Array.from(argumentsValue.query).every((character) =>
        /\s/u.test(character),
      )
    ) {
      throw new Error('Invalid workspace/search ToolCall Item.');
    }
    return {
      type: 'workspaceSearchCall',
      id: value.id,
      callId: value.callId,
      path: argumentsValue.path,
      query: argumentsValue.query,
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
): { workspaceId: string; threadId: string; turnId: string } => {
  if (
    !isRecord(value) ||
    !isWorkspaceId(value.workspaceId) ||
    !isUuidV7(value.threadId) ||
    !isUuidV7(value.turnId)
  ) {
    throw new Error('Invalid conversation lifecycle correlation.');
  }
  return {
    workspaceId: value.workspaceId,
    threadId: value.threadId,
    turnId: value.turnId,
  };
};

export type ConversationLifecycleRoute = Readonly<{
  workspaceId: string;
  threadId: string;
}>;

const CONVERSATION_LIFECYCLE_METHODS = new Set([
  'thread/started',
  'thread/title/updated',
  'turn/started',
  'item/started',
  'turn/agentOutput/delta',
  'turn/agentOutput/discarded',
  'item/agentMessage/delta',
  'item/completed',
  'thread/tokenUsage/updated',
  'turn/warning',
  'turn/completed',
]);

export const parseConversationLifecycleRoute = (
  message: Extract<ServerMessage, { kind: 'notification' }>,
): ConversationLifecycleRoute | null => {
  if (!CONVERSATION_LIFECYCLE_METHODS.has(message.method)) {
    return null;
  }
  if (!isRecord(message.params)) {
    throw new Error('Invalid conversation lifecycle route.');
  }
  if (message.method === 'thread/started') {
    const thread = message.params.thread;
    if (
      !isRecord(thread) ||
      !isUuidV7(thread.id) ||
      !isWorkspaceId(thread.workspaceId)
    ) {
      throw new Error('Invalid thread/started route.');
    }
    return { workspaceId: thread.workspaceId, threadId: thread.id };
  }
  if (
    !isWorkspaceId(message.params.workspaceId) ||
    !isUuidV7(message.params.threadId)
  ) {
    throw new Error('Invalid conversation lifecycle route.');
  }
  return {
    workspaceId: message.params.workspaceId,
    threadId: message.params.threadId,
  };
};

const parseAgentOutputRef = (value: unknown): AgentOutputRef => {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.responseOrdinal) ||
    (value.responseOrdinal as number) < 1 ||
    !Number.isSafeInteger(value.outputIndex) ||
    (value.outputIndex as number) < 0
  ) {
    throw new Error('Invalid Agent output reference.');
  }
  return {
    responseOrdinal: value.responseOrdinal as number,
    outputIndex: value.outputIndex as number,
  };
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
        !isUuidV7(params.thread.id) ||
        !isWorkspaceId(params.thread.workspaceId)
      ) {
        throw new Error('Invalid thread/started notification.');
      }
      return {
        type: 'threadStarted',
        params: {
          thread: {
            id: params.thread.id,
            workspaceId: params.thread.workspaceId,
          },
        },
      };
    }
    case 'thread/title/updated': {
      if (
        !isRecord(params) ||
        !isWorkspaceId(params.workspaceId) ||
        !isUuidV7(params.threadId) ||
        !isThreadTitle(params.title)
      ) {
        throw new Error('Invalid thread/title/updated notification.');
      }
      return {
        type: 'threadTitleUpdated',
        params: {
          workspaceId: params.workspaceId,
          threadId: params.threadId,
          title: params.title,
        },
      };
    }
    case 'turn/started': {
      if (
        !isRecord(params) ||
        !isWorkspaceId(params.workspaceId) ||
        !isUuidV7(params.threadId)
      ) {
        throw new Error('Invalid turn/started notification.');
      }
      const turn = parseTurn(params.turn);
      if (turn.status !== 'inProgress') {
        throw new Error('turn/started did not contain an in-progress Turn.');
      }
      return {
        type: 'turnStarted',
        params: {
          workspaceId: params.workspaceId,
          threadId: params.threadId,
          turn,
        },
      };
    }
    case 'item/started':
    case 'item/completed': {
      const correlation = parseThreadAndTurn(params);
      const rawItem = (params as Record<string, unknown>).item;
      if (isToolValidationRejectedItem(rawItem)) {
        return null;
      }
      const item = parseConversationItem(rawItem);
      if (!item) {
        throw new Error('Unsupported conversation lifecycle Item.');
      }
      return {
        type:
          message.method === 'item/started' ? 'itemStarted' : 'itemCompleted',
        params: {
          ...correlation,
          item,
          ...(message.method === 'item/started' &&
          isRecord(params) &&
          Object.hasOwn(params, 'agentOutput')
            ? { agentOutput: parseAgentOutputRef(params.agentOutput) }
            : {}),
        },
      };
    }
    case 'turn/agentOutput/delta': {
      const correlation = parseThreadAndTurn(params);
      if (
        !isRecord(params) ||
        typeof params.delta !== 'string' ||
        params.delta.length === 0
      ) {
        throw new Error('Invalid Agent output delta notification.');
      }
      return {
        type: 'agentOutputDelta',
        params: {
          ...correlation,
          output: parseAgentOutputRef(params.output),
          delta: params.delta,
        },
      };
    }
    case 'turn/agentOutput/discarded': {
      const correlation = parseThreadAndTurn(params);
      if (!isRecord(params)) {
        throw new Error('Invalid discarded Agent output notification.');
      }
      return {
        type: 'agentOutputDiscarded',
        params: {
          ...correlation,
          output: parseAgentOutputRef(params.output),
        },
      };
    }
    case 'item/agentMessage/delta': {
      if (
        !isRecord(params) ||
        !isWorkspaceId(params.workspaceId) ||
        !isUuidV7(params.threadId) ||
        !isUuidV7(params.turnId) ||
        !isUuidV7(params.itemId) ||
        typeof params.delta !== 'string'
      ) {
        throw new Error('Invalid AgentMessage delta notification.');
      }
      return {
        type: 'agentDelta',
        params: {
          workspaceId: params.workspaceId,
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          delta: params.delta,
        },
      };
    }
    case 'turn/completed': {
      if (
        !isRecord(params) ||
        !isWorkspaceId(params.workspaceId) ||
        !isUuidV7(params.threadId)
      ) {
        throw new Error('Invalid turn/completed notification.');
      }
      const turn = parseTurn(params.turn);
      if (turn.status === 'inProgress') {
        throw new Error('turn/completed contained an in-progress Turn.');
      }
      return {
        type: 'turnCompleted',
        params: {
          workspaceId: params.workspaceId,
          threadId: params.threadId,
          turn,
        },
      };
    }
    case 'thread/tokenUsage/updated': {
      const correlation = parseThreadAndTurn(params);
      if (!isRecord(params)) {
        throw new Error('Invalid token usage notification.');
      }
      return {
        type: 'tokenUsageUpdated',
        params: {
          ...correlation,
          usage: parseTokenUsage(params.usage),
        },
      };
    }
    case 'turn/warning': {
      const correlation = parseThreadAndTurn(params);
      if (
        !isRecord(params) ||
        params.code !== 'providerManagedContinuationFallback' &&
        params.code !== 'historicalContextDowngraded'
      ) {
        throw new Error('Invalid turn warning notification.');
      }
      return {
        type: 'warning',
        params: { ...correlation, code: params.code },
      };
    }
    default:
      return null;
  }
};
