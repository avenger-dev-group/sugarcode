import type {
  ThreadListResponse,
  ThreadSearchResponse,
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartResponse,
} from '@sugarcode/app-server-protocol';

import type { JsonlClient } from '../transport/jsonl-client';
import {
  type ResumeSnapshot,
  parseThreadResumeResponse,
  parseThreadStartResponse,
  parseTurnInterruptResponse,
  parseTurnStartResponse,
} from './protocol';
import {
  parseThreadListResponse,
  parseThreadSearchResponse,
} from './thread-protocol';

export type ConversationRpc = Readonly<{
  findLatestActiveThread: (
    signal?: AbortSignal,
  ) => Promise<string | null>;
  listActiveThreads?: (
    signal?: AbortSignal,
  ) => Promise<ThreadListResponse>;
  searchThreads?: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<ThreadSearchResponse>;
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

  listActiveThreads = async (
    signal?: AbortSignal,
  ): Promise<ThreadListResponse> =>
    parseThreadListResponse(
      await this.client.requestReady(
        'thread/list',
        { limit: 50 },
        signal,
      ),
    );

  findLatestActiveThread = async (
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const response = await this.listActiveThreads(signal);
    return response.data[0]?.id ?? null;
  };

  searchThreads = async (
    query: string,
    signal?: AbortSignal,
  ): Promise<ThreadSearchResponse> =>
    parseThreadSearchResponse(
      await this.client.requestReady(
        'thread/search',
        { query, limit: 50 },
        signal,
      ),
    );

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
