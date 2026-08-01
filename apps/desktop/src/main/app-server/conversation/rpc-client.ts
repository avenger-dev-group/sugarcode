import type {
  AssetImportParams,
  AssetImportResponse,
  ThreadListResponse,
  ThreadSearchResponse,
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnInputPart,
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
  parseThreadEmptyResponse,
  parseThreadDescendantsListResponse,
  parseThreadForkResponse,
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
  listDescendants?: (
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<readonly ResumeSnapshot[]>;
  forkThread?: (
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<ResumeSnapshot>;
  archiveThread?: (
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  unarchiveThread?: (
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  deleteThread?: (
    threadId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  startThread: (signal?: AbortSignal) => Promise<ThreadStartResponse>;
  importAsset: (
    params: AssetImportParams,
    signal?: AbortSignal,
  ) => Promise<AssetImportResponse>;
  startTurn: (
    threadId: string,
    input: TurnInputPart[],
    modelProfileId?: string,
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

  listDescendants = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<readonly ResumeSnapshot[]> =>
    parseThreadDescendantsListResponse(
      await this.client.requestReady(
        'thread/descendants/list',
        { threadId },
        signal,
      ),
    );

  forkThread = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ResumeSnapshot> =>
    parseThreadForkResponse(
      await this.client.requestReady(
        'thread/fork',
        { threadId },
        signal,
      ),
    );

  archiveThread = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    parseThreadEmptyResponse(
      await this.client.requestReady(
        'thread/archive',
        { threadId },
        signal,
      ),
      'thread/archive',
    );
  };

  unarchiveThread = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    parseThreadEmptyResponse(
      await this.client.requestReady(
        'thread/unarchive',
        { threadId },
        signal,
      ),
      'thread/unarchive',
    );
  };

  deleteThread = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    parseThreadEmptyResponse(
      await this.client.requestReady(
        'thread/delete',
        { threadId },
        signal,
      ),
      'thread/delete',
    );
  };

  startThread = async (
    signal?: AbortSignal,
  ): Promise<ThreadStartResponse> =>
    parseThreadStartResponse(
      await this.client.requestReady('thread/start', {}, signal),
    );

  importAsset = async (
    params: AssetImportParams,
    signal?: AbortSignal,
  ): Promise<AssetImportResponse> => {
    const value = await this.client.requestReady('asset/import', params, signal);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('asset' in value) ||
      typeof value.asset !== 'object' ||
      value.asset === null
    ) {
      throw new Error('Invalid asset/import response.');
    }
    return value as AssetImportResponse;
  };

  startTurn = async (
    threadId: string,
    input: TurnInputPart[],
    modelProfileId?: string,
    signal?: AbortSignal,
  ): Promise<TurnStartResponse> =>
    parseTurnStartResponse(
      await this.client.requestReady(
        'turn/start',
        {
          threadId,
          input,
          ...(modelProfileId ? { modelProfileId } : {}),
        },
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
