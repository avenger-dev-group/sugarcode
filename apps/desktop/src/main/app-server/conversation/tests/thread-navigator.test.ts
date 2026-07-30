import type {
  ThreadSearchResponse,
  TurnStartResponse,
} from '@sugarcode/app-server-protocol';

import { describe, expect, it, vi } from 'vitest';

import { ConversationController } from '../controller';
import type { ResumeSnapshot } from '../protocol';
import type { ConversationRpc } from '../rpc-client';

const THREAD_A = 'thr_0000000000000002';
const THREAD_B = 'thr_0000000000000001';
const THREAD_FORK = 'thr_0000000000000003';

const resume = (
  threadId: string,
  output: string,
): ResumeSnapshot => ({
  threadId,
  turns: [
    {
      id: `turn_${threadId.slice(4)}`,
      status: 'completed',
      items: [
        {
          type: 'agentMessage',
          id: `item_${threadId.slice(4)}`,
          text: output,
        },
      ],
    },
  ],
});

const createController = (rpc: ConversationRpc) => {
  const onProtocolFailure = vi.fn();
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure,
  });
  return { controller, onProtocolFailure };
};

describe('Desktop Thread Navigator', () => {
  it('loads a bounded active list, searches, and atomically replaces a transcript', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => THREAD_A),
      listActiveThreads: vi.fn(async () => ({
        data: [{ id: THREAD_A }, { id: THREAD_B }],
        nextCursor: 'thr_0000000000000000',
      })),
      searchThreads: vi.fn(
        async (): Promise<ThreadSearchResponse> => ({
          data: [{ id: THREAD_B }],
          nextCursor: null,
        }),
      ),
      resumeThread: vi.fn(async (threadId: string) =>
        resume(
          threadId,
          threadId === THREAD_A ? 'Latest answer.' : 'Historical answer.',
        ),
      ),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createController(rpc);

    await expect(controller.loadThreadIndex()).resolves.toBe(true);
    controller.connectionReady();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      turns: [],
      navigator: {
        status: 'ready',
        activeThreadIds: [THREAD_A, THREAD_B],
        activeTruncated: true,
      },
    });
    expect(controller.getSnapshot().threadId).toBeUndefined();
    expect(rpc.resumeThread).not.toHaveBeenCalled();

    await expect(
      controller.searchThreads('historical answer'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(rpc.searchThreads).toHaveBeenCalledWith(
      'historical answer',
      expect.any(AbortSignal),
    );
    expect(controller.getSnapshot().navigator.search).toMatchObject({
      query: 'historical answer',
      status: 'ready',
      threadIds: [THREAD_B],
    });

    await expect(controller.selectThread(THREAD_B)).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(controller.getSnapshot()).toMatchObject({
      threadId: THREAD_B,
      turns: [
        {
          messages: [{ role: 'agent', text: 'Historical answer.' }],
        },
      ],
    });
    expect(
      controller.getSnapshot().navigator.pendingThreadId,
    ).toBeUndefined();
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('discards stale searches and fails closed while a Turn is active', async () => {
    let resolveFirst!: (value: ThreadSearchResponse) => void;
    const first = new Promise<ThreadSearchResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const searchThreads = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ data: [{ id: THREAD_A }], nextCursor: null });
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => THREAD_A),
      listActiveThreads: vi.fn(async () => ({
        data: [{ id: THREAD_A }, { id: THREAD_B }],
        nextCursor: null,
      })),
      searchThreads,
      resumeThread: vi.fn(async (threadId: string) =>
        resume(threadId, 'Recovered answer.'),
      ),
      startThread: vi.fn(),
      startTurn: vi.fn(
        async (): Promise<TurnStartResponse> => ({
          turn: {
            id: 'turn_0000000000000099',
            status: 'inProgress',
          },
        }),
      ),
      interruptTurn: vi.fn(),
    };
    const { controller } = createController(rpc);
    await controller.loadThreadIndex();
    controller.connectionReady();

    const stale = controller.searchThreads('first query');
    const latest = controller.searchThreads('second query');
    await latest;
    resolveFirst({ data: [{ id: THREAD_B }], nextCursor: null });
    await stale;
    expect(controller.getSnapshot().navigator.search).toMatchObject({
      query: 'second query',
      threadIds: [THREAD_A],
    });

    await controller.selectThread(THREAD_A);
    await controller.startTurn('Keep this Turn active.');
    await expect(controller.selectThread(THREAD_B)).resolves.toEqual({
      accepted: false,
      reason: 'turnActive',
    });
    expect(rpc.resumeThread).toHaveBeenCalledTimes(1);
  });

  it('lets the latest rapid selection win without mixing transcripts', async () => {
    let resolveHistorical!: (value: ResumeSnapshot) => void;
    const historical = new Promise<ResumeSnapshot>((resolve) => {
      resolveHistorical = resolve;
    });
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => THREAD_A),
      listActiveThreads: vi.fn(async () => ({
        data: [{ id: THREAD_A }, { id: THREAD_B }],
        nextCursor: null,
      })),
      searchThreads: vi.fn(),
      resumeThread: vi.fn(async (threadId: string) => {
        if (threadId === THREAD_B) {
          return historical;
        }
        return resume(THREAD_A, 'Latest answer wins.');
      }),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const { controller } = createController(rpc);
    await controller.loadThreadIndex();
    controller.connectionReady();

    const stale = controller.selectThread(THREAD_B);
    const latest = controller.selectThread(THREAD_A);
    await latest;
    resolveHistorical(resume(THREAD_B, 'Stale historical answer.'));
    await stale;

    expect(controller.getSnapshot()).toMatchObject({
      threadId: THREAD_A,
      turns: [
        {
          messages: [{ text: 'Latest answer wins.' }],
        },
      ],
    });
  });

  it('rejects malformed search input and unknown Thread identities', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      listActiveThreads: vi.fn(async () => ({
        data: [],
        nextCursor: null,
      })),
      searchThreads: vi.fn(),
      resumeThread: vi.fn(),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const { controller } = createController(rpc);
    await controller.loadThreadIndex();
    controller.connectionReady();

    await expect(
      controller.searchThreads('word '.repeat(17)),
    ).resolves.toEqual({ accepted: false, reason: 'invalidSearch' });
    await expect(
      controller.selectThread('thr_not_in_snapshot'),
    ).resolves.toEqual({ accepted: false, reason: 'unknownThread' });
    expect(rpc.searchThreads).not.toHaveBeenCalled();
    expect(rpc.resumeThread).not.toHaveBeenCalled();
  });

  it('validates a complete fork snapshot before atomically selecting the new Thread', async () => {
    let resolveFork!: (value: ResumeSnapshot) => void;
    const forked = new Promise<ResumeSnapshot>((resolve) => {
      resolveFork = resolve;
    });
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => THREAD_A),
      listActiveThreads: vi.fn(async () => ({
        data: [{ id: THREAD_A }, { id: THREAD_B }],
        nextCursor: null,
      })),
      searchThreads: vi.fn(async () => ({
        data: [{ id: THREAD_B }],
        nextCursor: null,
      })),
      resumeThread: vi.fn(async () => resume(THREAD_A, 'Source answer.')),
      forkThread: vi.fn(() => forked),
      archiveThread: vi.fn(),
      unarchiveThread: vi.fn(),
      deleteThread: vi.fn(),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createController(rpc);
    await controller.loadThreadIndex();
    controller.connectionReady();
    await controller.searchThreads('source');

    const action = controller.forkThread(THREAD_A);
    expect(controller.getSnapshot().navigator.pendingMutation).toEqual({
      kind: 'fork',
      threadId: THREAD_A,
    });
    resolveFork(resume(THREAD_FORK, 'Forked answer.'));
    await expect(action).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      threadId: THREAD_FORK,
      turns: [{ messages: [{ text: 'Forked answer.' }] }],
      navigator: {
        activeThreadIds: [THREAD_FORK, THREAD_A, THREAD_B],
        search: { query: '', status: 'idle', threadIds: [] },
        mutationNotice: `Forked and selected Thread ${THREAD_FORK}.`,
      },
    });
    expect(
      controller.getSnapshot().navigator.pendingMutation,
    ).toBeUndefined();
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('archives the selected Thread, chooses a deterministic fallback, and supports one-level undo', async () => {
    const listActiveThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: THREAD_A }, { id: THREAD_B }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: THREAD_B }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: THREAD_A }, { id: THREAD_B }],
        nextCursor: null,
      });
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => THREAD_A),
      listActiveThreads,
      searchThreads: vi.fn(),
      resumeThread: vi.fn(async (threadId: string) =>
        resume(threadId, `${threadId} answer.`),
      ),
      forkThread: vi.fn(),
      archiveThread: vi.fn(async () => undefined),
      unarchiveThread: vi.fn(async () => undefined),
      deleteThread: vi.fn(),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const { controller } = createController(rpc);
    await controller.loadThreadIndex();
    controller.connectionReady();
    await controller.selectThread(THREAD_A);

    await expect(controller.archiveThread(THREAD_A)).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(controller.getSnapshot()).toMatchObject({
      threadId: THREAD_B,
      navigator: {
        activeThreadIds: [THREAD_B],
        archivedUndoThreadId: THREAD_A,
      },
    });
    expect(rpc.archiveThread).toHaveBeenCalledWith(
      THREAD_A,
      expect.any(AbortSignal),
    );

    await expect(controller.unarchiveThread(THREAD_A)).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(controller.getSnapshot()).toMatchObject({
      threadId: THREAD_A,
      navigator: {
        activeThreadIds: [THREAD_A, THREAD_B],
        mutationNotice: `Restored and selected Thread ${THREAD_A}.`,
      },
    });
    expect(
      controller.getSnapshot().navigator.archivedUndoThreadId,
    ).toBeUndefined();
    await expect(controller.unarchiveThread(THREAD_A)).resolves.toEqual({
      accepted: false,
      reason: 'unknownThread',
    });
  });

  it('deletes only known idle Threads and never exposes a stale selected transcript', async () => {
    const listActiveThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: THREAD_A }, { id: THREAD_B }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: THREAD_B }],
        nextCursor: null,
      });
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => THREAD_A),
      listActiveThreads,
      searchThreads: vi.fn(),
      resumeThread: vi.fn(async (threadId: string) =>
        resume(threadId, `${threadId} answer.`),
      ),
      forkThread: vi.fn(),
      archiveThread: vi.fn(),
      unarchiveThread: vi.fn(),
      deleteThread: vi.fn(async () => undefined),
      startThread: vi.fn(),
      startTurn: vi.fn(
        async (): Promise<TurnStartResponse> => ({
          turn: {
            id: 'turn_0000000000000099',
            status: 'inProgress',
          },
        }),
      ),
      interruptTurn: vi.fn(),
    };
    const { controller } = createController(rpc);
    await controller.loadThreadIndex();
    controller.connectionReady();
    await controller.selectThread(THREAD_A);
    await controller.startTurn('Keep this Turn active.');
    await expect(controller.deleteThread(THREAD_A)).resolves.toEqual({
      accepted: false,
      reason: 'turnActive',
    });
    expect(rpc.deleteThread).not.toHaveBeenCalled();

    const idleRpc: ConversationRpc = {
      ...rpc,
      listActiveThreads: vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: THREAD_A }, { id: THREAD_B }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: THREAD_B }],
          nextCursor: null,
        }),
      deleteThread: vi.fn(async () => undefined),
    };
    const idleController = createController(idleRpc).controller;
    await idleController.loadThreadIndex();
    idleController.connectionReady();
    await idleController.selectThread(THREAD_A);
    await expect(idleController.deleteThread(THREAD_A)).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(idleController.getSnapshot()).toMatchObject({
      threadId: THREAD_B,
      turns: [{ messages: [{ text: `${THREAD_B} answer.` }] }],
      navigator: {
        activeThreadIds: [THREAD_B],
        mutationNotice: `Deleted Thread ${THREAD_A}.`,
      },
    });
  });
});
