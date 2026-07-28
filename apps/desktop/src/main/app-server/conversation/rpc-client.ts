import type {
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartResponse,
} from '@sugarcode/app-server-protocol';

import type { JsonlClient } from '../transport/jsonl-client';
import {
  parseThreadStartResponse,
  parseTurnInterruptResponse,
  parseTurnStartResponse,
} from './protocol';

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
