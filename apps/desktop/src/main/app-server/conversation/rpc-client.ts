import type {
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartResponse,
} from '@sugarcode/app-server-protocol';

import type { JsonlClient } from '../transport/jsonl-client';
import {
  type ResumeSnapshot,
  parseThreadListResponse,
  parseThreadResumeResponse,
  parseThreadStartResponse,
  parseTurnInterruptResponse,
  parseTurnStartResponse,
} from './protocol';

export type ConversationRpc = Readonly<{
  findLatestActiveThread: (
    signal?: AbortSignal,
  ) => Promise<string | null>;
  resumeThread: (
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<ResumeSnapshot>;
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

  findLatestActiveThread = async (
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const response = parseThreadListResponse(
      await this.client.requestReady(
        'thread/list',
        { limit: 1 },
        signal,
      ),
    );
    return response.data[0]?.id ?? null;
  };

  resumeThread = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ResumeSnapshot> =>
    parseThreadResumeResponse(
      await this.client.requestReady(
        'thread/resume',
        { threadId },
        signal,
      ),
    );

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
