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
  generateThreadTitle?: (
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
  constructor(
    private readonly client: JsonlClient,
    private readonly workspaceId: string,
  ) {}

  listActiveThreads = async (
    signal?: AbortSignal,
  ): Promise<ThreadListResponse> => {
    const response = parseThreadListResponse(
      await this.client.requestReady(
        'thread/list',
        { workspaceId: this.workspaceId, limit: 50 },
        signal,
      ),
    );
    this.assertThreadCollectionWorkspace(response.data);
    return response;
  };

  findLatestActiveThread = async (
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const response = await this.listActiveThreads(signal);
    return response.data[0]?.id ?? null;
  };

  searchThreads = async (
    query: string,
    signal?: AbortSignal,
  ): Promise<ThreadSearchResponse> => {
    const response = parseThreadSearchResponse(
      await this.client.requestReady(
        'thread/search',
        { workspaceId: this.workspaceId, query, limit: 50 },
        signal,
      ),
    );
    this.assertThreadCollectionWorkspace(response.data);
    return response;
  };

  resumeThread = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ResumeSnapshot> => {
    const response = parseThreadResumeResponse(
      await this.client.requestReady(
        'thread/resume',
        { threadId, workspaceId: this.workspaceId },
        signal,
      ),
    );
    this.assertSnapshotWorkspace(response);
    return response;
  };

  listDescendants = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<readonly ResumeSnapshot[]> => {
    const response = parseThreadDescendantsListResponse(
      await this.client.requestReady(
        'thread/descendants/list',
        { threadId },
        signal,
      ),
    );
    response.forEach(this.assertSnapshotWorkspace);
    return response;
  };

  forkThread = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ResumeSnapshot> => {
    const response = parseThreadForkResponse(
      await this.client.requestReady(
        'thread/fork',
        { threadId },
        signal,
      ),
    );
    this.assertSnapshotWorkspace(response);
    return response;
  };

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

  generateThreadTitle = async (
    threadId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    parseThreadEmptyResponse(
      await this.client.requestReady(
        'thread/title/generate',
        { threadId },
        signal,
      ),
      'thread/title/generate',
    );
  };

  startThread = async (
    signal?: AbortSignal,
  ): Promise<ThreadStartResponse> => {
    const response = parseThreadStartResponse(
      await this.client.requestReady(
        'thread/start',
        { workspaceId: this.workspaceId },
        signal,
      ),
    );
    if (response.thread.workspaceId !== this.workspaceId) {
      throw new Error('thread/start crossed workspace ownership.');
    }
    return response;
  };

  private readonly assertSnapshotWorkspace = (
    snapshot: ResumeSnapshot,
  ): void => {
    if (snapshot.workspaceId !== this.workspaceId) {
      throw new Error('Thread snapshot crossed workspace ownership.');
    }
  };

  private readonly assertThreadCollectionWorkspace = (
    threads: readonly Readonly<{ workspaceId: string }>[],
  ): void => {
    if (threads.some((thread) => thread.workspaceId !== this.workspaceId)) {
      throw new Error('Thread collection crossed workspace ownership.');
    }
  };

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
