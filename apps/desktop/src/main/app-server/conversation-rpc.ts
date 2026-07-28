import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadStartResponse,
  ThreadStartedNotification,
  TurnCompletedNotification,
  TurnError,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnStartedNotification,
} from '@sugarcode/app-server-protocol';

import type { JsonlClient } from './jsonl-client';
import type { ServerMessage } from './runtime-validation';

type TextItem = Extract<
  ItemStartedNotification['item'],
  { type: 'userMessage' | 'agentMessage' }
>;

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
      params: Omit<ItemStartedNotification, 'item'> & { item: TextItem };
    }>
  | Readonly<{
      type: 'agentDelta';
      params: AgentMessageDeltaNotification;
    }>
  | Readonly<{
      type: 'itemCompleted';
      params: Omit<ItemCompletedNotification, 'item'> & { item: TextItem };
    }>
  | Readonly<{
      type: 'turnCompleted';
      params: TurnCompletedNotification;
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

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

const parseThreadStartResponse = (value: unknown): ThreadStartResponse => {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    !isId(value.thread.id)
  ) {
    throw new Error('Invalid thread/start response.');
  }
  return { thread: { id: value.thread.id } };
};

const parseTurnStartResponse = (value: unknown): TurnStartResponse => {
  if (!isRecord(value)) {
    throw new Error('Invalid turn/start response.');
  }
  const turn = parseTurn(value.turn);
  if (turn.status !== 'inProgress') {
    throw new Error('turn/start did not return an in-progress Turn.');
  }
  return { turn };
};

const parseTurnInterruptResponse = (
  value: unknown,
): TurnInterruptResponse => {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new Error('Invalid turn/interrupt response.');
  }
  return {};
};

const parseTextItem = (value: unknown): TextItem | null => {
  if (!isRecord(value) || !isId(value.id) || typeof value.type !== 'string') {
    throw new Error('Invalid Item.');
  }
  if (value.type !== 'userMessage' && value.type !== 'agentMessage') {
    return null;
  }
  if (typeof value.text !== 'string') {
    throw new Error('Invalid text Item.');
  }
  return {
    type: value.type,
    id: value.id,
    text: value.text,
  };
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
      const item = parseTextItem((params as Record<string, unknown>).item);
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

export type ConversationRpc = Readonly<{
  startThread: (signal?: AbortSignal) => Promise<ThreadStartResponse>;
  startTurn: (
    threadId: string,
    input: string,
    signal?: AbortSignal,
  ) => Promise<TurnStartResponse>;
  interruptTurn: (
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ) => Promise<TurnInterruptResponse>;
}>;

export class ConversationRpcClient implements ConversationRpc {
  constructor(private readonly client: JsonlClient) {}

  startThread = async (
    signal?: AbortSignal,
  ): Promise<ThreadStartResponse> =>
    parseThreadStartResponse(
      await this.client.requestReady('thread/start', {}, signal),
    );

  startTurn = async (
    threadId: string,
    input: string,
    signal?: AbortSignal,
  ): Promise<TurnStartResponse> =>
    parseTurnStartResponse(
      await this.client.requestReady(
        'turn/start',
        { threadId, input },
        signal,
      ),
    );

  interruptTurn = async (
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<TurnInterruptResponse> =>
    parseTurnInterruptResponse(
      await this.client.requestReady(
        'turn/interrupt',
        { threadId, turnId },
        signal,
      ),
    );
}
