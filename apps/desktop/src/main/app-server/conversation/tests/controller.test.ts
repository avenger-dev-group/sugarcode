import type {
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartResponse,
} from '@sugarcode/app-server-protocol';

import { describe, expect, it, vi } from 'vitest';

import { isConversationStateSnapshot } from '@/shared/conversation';

import { ConversationController } from '../controller';
import type { ResumeSnapshot } from '../protocol';
import type { ConversationRpc } from '../rpc-client';
import { RpcResponseError } from '../../transport/jsonl-client';

type Deferred<Value> = Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}>;

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

const notification = (method: string, params: unknown) =>
  ({
    kind: 'notification',
    method,
    params,
  }) as const;

const createHarness = (rpc: ConversationRpc) => {
  const onProtocolFailure = vi.fn();
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure,
  });
  controller.connectionReady();
  return { controller, onProtocolFailure };
};

describe('ConversationController', () => {
  it('starts a fresh durable Thread after clearing the current selection', async () => {
    const startThread = vi.fn(async (): Promise<ThreadStartResponse> => ({
      thread: { id: 'thr_0000000000000002' },
    }));
    const startTurn = vi.fn(async (): Promise<TurnStartResponse> => ({
      turn: { id: 'turn_0000000000000002', status: 'inProgress' },
    }));
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => 'thr_0000000000000001'),
      resumeThread: vi.fn(async (): Promise<ResumeSnapshot> => ({
        threadId: 'thr_0000000000000001',
        turns: [],
      })),
      startThread,
      startTurn,
      interruptTurn: vi.fn(),
    };
    const controllerWithIndex = new ConversationController({
      getRpc: () => rpc,
      onProtocolFailure: vi.fn(),
    });
    await expect(controllerWithIndex.loadThreadIndex()).resolves.toBe(true);
    controllerWithIndex.connectionReady();
    await expect(
      controllerWithIndex.selectThread('thr_0000000000000001'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });

    expect(controllerWithIndex.startNewThread()).toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(controllerWithIndex.getSnapshot()).not.toHaveProperty('threadId');
    expect(controllerWithIndex.getSnapshot().turns).toEqual([]);

    await expect(
      controllerWithIndex.startTurn('Begin a separate task.'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(startThread).toHaveBeenCalledOnce();
    expect(startTurn).toHaveBeenCalledWith(
      'thr_0000000000000002',
      'Begin a separate task.',
      expect.any(AbortSignal),
    );
  });

  it('projects completed Agent commentary before later tool activity', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async (): Promise<ThreadStartResponse> => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await expect(controller.startTurn('Inspect it.')).resolves.toMatchObject({
      accepted: true,
    });

    for (const method of ['item/started', 'item/completed']) {
      controller.handleNotification(
        notification(method, {
          threadId: 'thr_0000000000000001',
          turnId: 'turn_0000000000000001',
          item: {
            type: 'agentCommentary',
            id: 'item_commentary',
            text: 'I will inspect the workspace first.',
          },
        }),
      );
    }
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'toolCall',
          id: 'item_tool',
          callId: 'call_1',
          name: 'workspace/read',
          path: 'README.md',
        },
      }),
    );

    expect(controller.getSnapshot().turns[0]?.activities).toMatchObject([
      {
        type: 'commentary',
        activity: {
          id: 'item_commentary',
          text: 'I will inspect the workspace first.',
          status: 'completed',
        },
      },
      {
        type: 'workspaceRead',
        activity: { id: 'item_tool', path: 'README.md' },
      },
    ]);
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('projects approval wait state onto the originating Agent task', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async (): Promise<ThreadStartResponse> => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await expect(controller.startTurn('Delegate this task.')).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'agentTask',
          id: 'item_task',
          orchestrationId: 'orch/root/turn',
          taskId: 'task_worker',
          clientTaskKey: 'worker',
          childThreadId: 'thr_0000000000000002',
          title: 'Implement the change',
          role: 'worker',
          access: 'workspaceWrite',
          dependsOn: [],
          taskMarkdown: '# Objective\nImplement.',
        },
      }),
    );

    controller.setAgentApprovalTasks(new Set(['task_worker']));
    expect(controller.getSnapshot().turns[0]?.activities?.[0]).toMatchObject({
      type: 'orchestration',
      activity: {
        tasks: [{ taskId: 'task_worker', status: 'waitingApproval' }],
      },
    });

    controller.setAgentApprovalTasks(new Set());
    expect(controller.getSnapshot().turns[0]?.activities?.[0]).toMatchObject({
      type: 'orchestration',
      activity: {
        tasks: [{ taskId: 'task_worker', status: 'running' }],
      },
    });
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('loads the active Thread index without selecting until the user chooses', async () => {
    const startThread = vi.fn();
    const startTurn = vi.fn(async (): Promise<TurnStartResponse> => ({
      turn: { id: 'turn_0000000000000002', status: 'inProgress' },
    }));
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => 'thr_0000000000000001'),
      resumeThread: vi.fn(async (): Promise<ResumeSnapshot> => ({
        threadId: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000001',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'item_0000000000000001',
                text: 'Recovered input.',
              },
              {
                type: 'agentMessage',
                id: 'item_0000000000000002',
                text: 'Recovered output.',
              },
            ],
          },
        ],
      })),
      startThread,
      startTurn,
      interruptTurn: vi.fn(),
    };
    const onProtocolFailure = vi.fn();
    const controller = new ConversationController({
      getRpc: () => rpc,
      onProtocolFailure,
    });

    await expect(controller.loadThreadIndex()).resolves.toBe(true);
    expect(controller.getSnapshot().phase).toBe('unavailable');
    controller.connectionReady();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      navigator: {
        status: 'ready',
        activeThreadIds: ['thr_0000000000000001'],
        activeTruncated: false,
        search: {
          query: '',
          status: 'idle',
          threadIds: [],
          truncated: false,
        },
      },
      turns: [],
    });
    expect(controller.getSnapshot().threadId).toBeUndefined();
    expect(rpc.resumeThread).not.toHaveBeenCalled();

    await expect(
      controller.selectThread('thr_0000000000000001'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          messages: [
            { role: 'user', text: 'Recovered input.' },
            { role: 'agent', text: 'Recovered output.' },
          ],
        },
      ],
    });

    await expect(
      controller.startTurn('Continue the recovered Thread.'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(startThread).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledWith(
      'thr_0000000000000001',
      'Continue the recovered Thread.',
      expect.any(AbortSignal),
    );
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('drops the previous transcript when a replacement runtime has no preferred Thread', async () => {
    const previousThreadId = 'thr_0000000000000001';
    let rpc: ConversationRpc = {
      listActiveThreads: vi.fn(async () => ({
        data: [{ id: previousThreadId }],
        nextCursor: null,
      })),
      findLatestActiveThread: vi.fn(async () => previousThreadId),
      resumeThread: vi.fn(async (): Promise<ResumeSnapshot> => ({
        threadId: previousThreadId,
        turns: [
          {
            id: 'turn_0000000000000001',
            status: 'completed',
            items: [
              {
                type: 'agentMessage',
                id: 'item_0000000000000001',
                text: 'Previous workspace transcript.',
              },
            ],
          },
        ],
      })),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const controller = new ConversationController({
      getRpc: () => rpc,
      onProtocolFailure: vi.fn(),
    });

    await expect(
      controller.restoreForConnection(previousThreadId),
    ).resolves.toBe(true);
    controller.connectionReady();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      threadId: previousThreadId,
      turns: [{ id: 'turn_0000000000000001' }],
    });

    controller.connectionRestarting();
    rpc = {
      listActiveThreads: vi.fn(async () => ({
        data: [{ id: 'thr_0000000000000002' }],
        nextCursor: null,
      })),
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };

    await expect(controller.restoreForConnection()).resolves.toBe(true);
    controller.connectionReady();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      turns: [],
      navigator: {
        status: 'ready',
        activeThreadIds: ['thr_0000000000000002'],
      },
    });
    expect(controller.getSnapshot()).not.toHaveProperty('threadId');
  });

  it('starts idle for an empty home and fails closed on recovery RPC error', async () => {
    const emptyRpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const empty = new ConversationController({
      getRpc: () => emptyRpc,
      onProtocolFailure: vi.fn(),
    });
    await expect(empty.loadThreadIndex()).resolves.toBe(true);
    empty.connectionReady();
    expect(empty.getSnapshot()).toMatchObject({
      phase: 'idle',
      turns: [],
    });

    const failedRpc: ConversationRpc = {
      ...emptyRpc,
      findLatestActiveThread: vi.fn(async () => {
        throw new RpcResponseError(-32002, 'State unavailable');
      }),
    };
    const failed = new ConversationController({
      getRpc: () => failedRpc,
      onProtocolFailure: vi.fn(),
    });
    await expect(failed.loadThreadIndex()).resolves.toBe(false);
    expect(failed.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      notice: {
        kind: 'requestFailed',
        summary: 'The durable conversation could not be restored safely.',
      },
    });
  });

  it('buffers lifecycle delivered beside the accepted response and projects durable text', async () => {
    const turnResponse = deferred<TurnStartResponse>();
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async (): Promise<ThreadStartResponse> => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(() => turnResponse.promise),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    const snapshots: unknown[] = [];
    controller.subscribe((snapshot) => snapshots.push(snapshot));

    const action = controller.startTurn('Preserve this exact input.');
    await vi.waitFor(() =>
      expect(rpc.startTurn).toHaveBeenCalledWith(
        'thr_0000000000000001',
        'Preserve this exact input.',
        expect.any(AbortSignal),
      ),
    );

    controller.handleNotification(
      notification('thread/started', {
        thread: { id: 'thr_0000000000000001' },
      }),
    );
    controller.handleNotification(
      notification('turn/started', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      }),
    );
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'userMessage',
          id: 'item_0000000000000001',
          text: 'Preserve this exact input.',
        },
      }),
    );
    controller.handleNotification(
      notification('item/completed', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'userMessage',
          id: 'item_0000000000000001',
          text: 'Preserve this exact input.',
        },
      }),
    );
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'agentMessage',
          id: 'item_0000000000000002',
          text: '',
        },
      }),
    );
    controller.handleNotification(
      notification('item/agentMessage/delta', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        itemId: 'item_0000000000000002',
        delta: 'Streamed ',
      }),
    );
    controller.handleNotification(
      notification('item/agentMessage/delta', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        itemId: 'item_0000000000000002',
        delta: 'answer.',
      }),
    );
    controller.handleNotification(
      notification('item/completed', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'agentMessage',
          id: 'item_0000000000000002',
          text: 'Streamed answer.',
        },
      }),
    );
    controller.handleNotification(
      notification('turn/completed', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_0000000000000001', status: 'completed' },
      }),
    );

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'starting',
      turns: [],
    });
    turnResponse.resolve({
      turn: { id: 'turn_0000000000000001', status: 'inProgress' },
    });
    await expect(action).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(controller.getSnapshot()).toEqual({
      revision: expect.any(Number),
      phase: 'ready',
      threadId: 'thr_0000000000000001',
      navigator: {
        status: 'ready',
        activeThreadIds: ['thr_0000000000000001'],
        activeTruncated: false,
        search: {
          query: '',
          status: 'idle',
          threadIds: [],
          truncated: false,
        },
      },
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          messages: [
            {
              id: 'item_0000000000000001',
              role: 'user',
              text: 'Preserve this exact input.',
              status: 'completed',
            },
            {
              id: 'item_0000000000000002',
              role: 'agent',
              text: 'Streamed answer.',
              status: 'completed',
            },
          ],
        },
      ],
    });
    expect(snapshots.length).toBeGreaterThan(4);
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('treats interrupt response as acknowledgement after the terminal lifecycle', async () => {
    const interruptResponse = deferred<TurnInterruptResponse>();
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(() => interruptResponse.promise),
    };
    const { controller } = createHarness(rpc);
    await controller.startTurn('Stop after starting.');
    controller.handleNotification(
      notification('turn/started', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      }),
    );
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'userMessage',
          id: 'item_0000000000000001',
          text: 'Stop after starting.',
        },
      }),
    );
    controller.handleNotification(
      notification('item/completed', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'userMessage',
          id: 'item_0000000000000001',
          text: 'Stop after starting.',
        },
      }),
    );

    const stop = controller.stopTurn();
    expect(controller.getSnapshot().phase).toBe('stopping');
    controller.handleNotification(
      notification('turn/completed', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_0000000000000001', status: 'interrupted' },
      }),
    );
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      turns: [{ status: 'interrupted' }],
    });
    interruptResponse.resolve({});
    await expect(stop).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
  });

  it('projects only the correlated durable Turn failure', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);

    await expect(
      controller.startTurn('Reach a durable failure.'),
    ).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    controller.handleNotification(
      notification('turn/completed', {
        threadId: 'thr_0000000000000001',
        turn: {
          id: 'turn_0000000000000001',
          status: 'failed',
          error: { kind: 'rateLimited', retryable: true },
        },
      }),
    );

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      turns: [
        {
          status: 'failed',
          error: { kind: 'rateLimited', retryable: true },
        },
      ],
    });
    expect(onProtocolFailure).not.toHaveBeenCalled();

    controller.handleNotification(
      notification('turn/completed', {
        threadId: 'thr_0000000000000001',
        turn: {
          id: 'turn_0000000000000001',
          status: 'failed',
          error: { kind: 'rateLimited', retryable: true },
        },
      }),
    );
    expect(onProtocolFailure).toHaveBeenCalledOnce();
  });

  it('keeps partial lifecycle uncertain after transport loss', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller } = createHarness(rpc);

    await controller.startTurn('Keep the partial response.');
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'agentMessage',
          id: 'item_0000000000000001',
          text: '',
        },
      }),
    );
    controller.handleNotification(
      notification('item/agentMessage/delta', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        itemId: 'item_0000000000000001',
        delta: 'Durable status is not known yet.',
      }),
    );

    controller.transportClosed();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      threadId: 'thr_0000000000000001',
      activeTurnId: 'turn_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'inProgress',
          messages: [
            {
              id: 'item_0000000000000001',
              role: 'agent',
              text: 'Durable status is not known yet.',
              status: 'inProgress',
            },
          ],
        },
      ],
      notice: { kind: 'connectionLost' },
    });
    await expect(controller.startTurn('Do not replace it.')).resolves.toEqual({
      accepted: false,
      reason: 'unavailable',
    });
    await expect(controller.stopTurn()).resolves.toEqual({
      accepted: false,
      reason: 'unavailable',
    });
  });

  it('suppresses connection-loss copy during an intentional runtime restart', () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(),
      startTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const { controller } = createHarness(rpc);

    controller.connectionRestarting();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      navigator: { status: 'unavailable' },
    });
    expect(controller.getSnapshot()).not.toHaveProperty('notice');

    controller.transportClosed();
    expect(controller.getSnapshot()).toMatchObject({
      notice: {
        kind: 'connectionLost',
        summary: 'The local Agent connection is unavailable.',
      },
    });
  });

  it('projects one durable workspace read without exposing result content', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await controller.startTurn('Read notes.txt.');

    const call = {
      type: 'toolCall',
      id: 'item_0000000000000001',
      callId: 'call_read',
      name: 'workspace/read',
      path: 'notes.txt',
    };
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: call,
      }),
    );
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'inProgress',
      turns: [
        {
          workspaceRead: {
            path: 'notes.txt',
            callStatus: 'inProgress',
          },
        },
      ],
    });
    controller.handleNotification(
      notification('item/completed', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: call,
      }),
    );

    const result = {
      type: 'toolResult',
      id: 'item_0000000000000002',
      callId: 'call_read',
      name: 'workspace/read',
      result: {
        type: 'success',
        content: 'private file contents',
        bytes: 21,
      },
    };
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: result,
      }),
    );
    controller.handleNotification(
      notification('item/completed', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: result,
      }),
    );
    controller.handleNotification(
      notification('turn/completed', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_0000000000000001', status: 'completed' },
      }),
    );

    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({
      phase: 'ready',
      turns: [
        {
          status: 'completed',
          workspaceRead: {
            path: 'notes.txt',
            callStatus: 'completed',
            result: {
              status: 'completed',
              outcome: { type: 'success', bytes: 21 },
            },
          },
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private file contents');
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('projects a read-only batch with repeated workspace reads', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await controller.startTurn('Inspect this project.');

    const listCall = {
      type: 'toolCall',
      id: 'item_list_call',
      callId: 'call_list',
      name: 'workspace/list',
      path: '.',
    };
    const listContent = JSON.stringify({ entries: [] });
    const listResult = {
      type: 'toolResult',
      id: 'item_list_result',
      callId: 'call_list',
      name: 'workspace/list',
      result: {
        type: 'success',
        content: listContent,
        bytes: new TextEncoder().encode(listContent).byteLength,
      },
    };
    for (const item of [listCall, listResult]) {
      for (const method of ['item/started', 'item/completed']) {
        controller.handleNotification(
          notification(method, {
            threadId: 'thr_0000000000000001',
            turnId: 'turn_0000000000000001',
            item,
          }),
        );
      }
    }

    const calls = ['package.json', 'src/main.ts', 'index.html'].map(
      (path, index) => ({
        type: 'toolCall',
        id: `item_read_call_${index}`,
        callId: `call_read_${index}`,
        name: 'workspace/read',
        path,
      }),
    );
    for (const item of calls) {
      for (const method of ['item/started', 'item/completed']) {
        controller.handleNotification(
          notification(method, {
            threadId: 'thr_0000000000000001',
            turnId: 'turn_0000000000000001',
            item,
          }),
        );
      }
    }
    for (const [index, call] of calls.entries()) {
      const item = {
        type: 'toolResult',
        id: `item_read_result_${index}`,
        callId: call.callId,
        name: 'workspace/read',
        result: {
          type: 'success',
          content: `private content ${index}`,
          bytes: 17,
        },
      };
      for (const method of ['item/started', 'item/completed']) {
        controller.handleNotification(
          notification(method, {
            threadId: 'thr_0000000000000001',
            turnId: 'turn_0000000000000001',
            item,
          }),
        );
      }
    }
    controller.handleNotification(
      notification('turn/completed', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_0000000000000001', status: 'completed' },
      }),
    );

    const snapshot = controller.getSnapshot();
    expect(
      snapshot.turns[0]?.activities?.filter(
        (entry) => entry.type === 'workspaceRead',
      ),
    ).toHaveLength(3);
    expect(snapshot.turns[0]).toMatchObject({
      status: 'completed',
      workspaceList: { callId: 'call_list' },
      workspaceRead: {
        callId: 'call_read_2',
        result: { status: 'completed' },
      },
    });
    expect(isConversationStateSnapshot(snapshot)).toBe(true);
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('projects one durable workspace list count without exposing entry names', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await controller.startTurn('List the workspace root.');

    const call = {
      type: 'toolCall',
      id: 'item_0000000000000010',
      callId: 'call_list',
      name: 'workspace/list',
      path: '.',
    };
    for (const method of ['item/started', 'item/completed']) {
      controller.handleNotification(
        notification(method, {
          threadId: 'thr_0000000000000001',
          turnId: 'turn_0000000000000001',
          item: call,
        }),
      );
    }
    const content = JSON.stringify({
      entries: [
        { name: 'private-plan.txt', kind: 'file' },
        { name: 'secret', kind: 'directory' },
      ],
    });
    const result = {
      type: 'toolResult',
      id: 'item_0000000000000011',
      callId: 'call_list',
      name: 'workspace/list',
      result: {
        type: 'success',
        content,
        bytes: new TextEncoder().encode(content).byteLength,
      },
    };
    for (const method of ['item/started', 'item/completed']) {
      controller.handleNotification(
        notification(method, {
          threadId: 'thr_0000000000000001',
          turnId: 'turn_0000000000000001',
          item: result,
        }),
      );
    }
    controller.handleNotification(
      notification('turn/completed', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_0000000000000001', status: 'completed' },
      }),
    );

    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({
      phase: 'ready',
      turns: [
        {
          workspaceList: {
            path: '.',
            callStatus: 'completed',
            result: {
              status: 'completed',
              outcome: { type: 'success', entries: 2 },
            },
          },
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-plan.txt');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('projects one durable workspace search summary without exposing matches', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await controller.startTurn('Search the workspace.');

    const call = {
      type: 'toolCall',
      id: 'item_0000000000000020',
      callId: 'call_search',
      name: 'workspace/search',
      path: 'src',
      query: 'private marker',
    };
    for (const method of ['item/started', 'item/completed']) {
      controller.handleNotification(
        notification(method, {
          threadId: 'thr_0000000000000001',
          turnId: 'turn_0000000000000001',
          item: call,
        }),
      );
    }
    const content = JSON.stringify({
      matches: Array.from({ length: 200 }, (_, index) => ({
        path: `src/private-${index}.txt`,
        line: index + 1,
      })),
      truncated: true,
    });
    const result = {
      type: 'toolResult',
      id: 'item_0000000000000021',
      callId: 'call_search',
      name: 'workspace/search',
      result: {
        type: 'success',
        content,
        bytes: new TextEncoder().encode(content).byteLength,
      },
    };
    for (const method of ['item/started', 'item/completed']) {
      controller.handleNotification(
        notification(method, {
          threadId: 'thr_0000000000000001',
          turnId: 'turn_0000000000000001',
          item: result,
        }),
      );
    }
    controller.handleNotification(
      notification('turn/completed', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_0000000000000001', status: 'completed' },
      }),
    );

    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({
      phase: 'ready',
      turns: [
        {
          workspaceSearch: {
            path: 'src',
            query: 'private marker',
            callStatus: 'completed',
            result: {
              status: 'completed',
              outcome: {
                type: 'success',
                matches: 200,
                truncated: true,
              },
            },
          },
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-0.txt');
    expect(JSON.stringify(snapshot)).not.toContain('"line"');
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('fails closed on malformed workspace list content', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await controller.startTurn('List safely.');
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'toolResult',
          id: 'item_bad',
          callId: 'call_list',
          name: 'workspace/list',
          result: {
            type: 'success',
            content: '{"entries":"not-an-array"}',
            bytes: 26,
          },
        },
      }),
    );
    expect(onProtocolFailure).toHaveBeenCalledOnce();
  });

  it('fails closed on malformed workspace search content', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await controller.startTurn('Search safely.');
    const content = JSON.stringify({ matches: [], truncated: true });
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'toolResult',
          id: 'item_bad_search',
          callId: 'call_search',
          name: 'workspace/search',
          result: {
            type: 'success',
            content,
            bytes: new TextEncoder().encode(content).byteLength,
          },
        },
      }),
    );
    expect(onProtocolFailure).toHaveBeenCalledOnce();
  });

  it('keeps a workspace read uncertain on transport loss and rejects mismatched results', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await controller.startTurn('Read pending.txt.');
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'toolCall',
          id: 'item_0000000000000001',
          callId: 'call_pending',
          name: 'workspace/read',
          path: 'pending.txt',
        },
      }),
    );
    controller.handleNotification(
      notification('item/started', {
        threadId: 'thr_0000000000000001',
        turnId: 'turn_0000000000000001',
        item: {
          type: 'toolResult',
          id: 'item_0000000000000002',
          callId: 'another_call',
          name: 'workspace/read',
          result: { type: 'error', kind: 'notFound' },
        },
      }),
    );
    expect(onProtocolFailure).toHaveBeenCalledOnce();

    controller.transportClosed();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      turns: [
        {
          status: 'inProgress',
          workspaceRead: { path: 'pending.txt' },
        },
      ],
    });
  });

  it('rejects invalid actions and fails closed on cross-Turn lifecycle', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(async () => ({})),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);

    await expect(controller.startTurn('   ')).resolves.toEqual({
      accepted: false,
      reason: 'invalidInput',
    });
    await controller.startTurn('One turn.');
    await expect(controller.startTurn('Overlapping turn.')).resolves.toEqual({
      accepted: false,
      reason: 'turnActive',
    });
    controller.handleNotification(
      notification('turn/started', {
        threadId: 'thr_0000000000000001',
        turn: { id: 'turn_other', status: 'inProgress' },
      }),
    );
    expect(onProtocolFailure).toHaveBeenCalledOnce();
  });

  it('projects a live command result summary without sharing arguments or output', async () => {
    const rpc: ConversationRpc = {
      findLatestActiveThread: vi.fn(async () => null),
      resumeThread: vi.fn(),
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_0000000000000001', status: 'inProgress' },
      })),
      interruptTurn: vi.fn(),
    };
    const { controller, onProtocolFailure } = createHarness(rpc);
    await controller.startTurn('Ask before running.');
    const correlate = {
      threadId: 'thr_0000000000000001',
      turnId: 'turn_0000000000000001',
    };
    const call = {
      type: 'toolCall',
      id: 'item_command',
      callId: 'call_command',
      name: 'shell/exec',
      path: '.',
      command: '/usr/bin/printf',
      arguments: ['private-value'],
    };
    const request = {
      type: 'commandApprovalRequest',
      id: 'item_request',
      approvalId: 'approval_command',
      callId: 'call_command',
      command: '/usr/bin/printf',
      arguments: ['private-value'],
      cwd: '.',
      environmentPolicy: 'minimalV1',
      sandboxed: true,
      sandboxPolicy: 'filesystemReadOnlyV1',
      networkPolicy: 'networkDeniedV1',
    };
    const decision = {
      type: 'commandApprovalDecision',
      id: 'item_decision',
      approvalId: 'approval_command',
      decision: 'approved',
    };
    for (const item of [call, request, decision]) {
      controller.handleNotification(
        notification('item/started', { ...correlate, item }),
      );
      controller.handleNotification(
        notification('item/completed', { ...correlate, item }),
      );
    }
    const attempt = {
      type: 'commandExecutionAttempt',
      id: 'item_attempt',
      approvalId: 'approval_command',
      callId: 'call_command',
    };
    controller.handleNotification(
      notification('item/started', { ...correlate, item: attempt }),
    );
    expect(
      controller.getSnapshot().turns[0]?.commandApproval?.executionAttempt,
    ).toEqual({ id: 'item_attempt', status: 'inProgress' });
    controller.handleNotification(
      notification('turn/completed', {
        threadId: correlate.threadId,
        turn: { id: correlate.turnId, status: 'completed' },
      }),
    );
    expect(onProtocolFailure).toHaveBeenCalledOnce();
    controller.handleNotification(
      notification('item/completed', { ...correlate, item: attempt }),
    );
    const result = {
      type: 'toolResult',
      id: 'item_result',
      callId: 'call_command',
      name: 'shell/exec',
      result: {
        type: 'process',
        stdout: 'private-command-output',
        stderr: 'private-command-error',
        stdoutBytes: 22,
        stderrBytes: 21,
        stdoutTruncated: false,
        stderrTruncated: true,
        encoding: 'utf8Lossy',
        durationMs: 7,
        outcome: { type: 'signal', signal: 15 },
        sandboxPolicy: 'filesystemReadOnlyV1',
        networkPolicy: 'networkDeniedV1',
      },
    };
    controller.handleNotification(
      notification('item/started', { ...correlate, item: result }),
    );
    expect(
      controller.getSnapshot().turns[0]?.commandApproval?.executionResult,
    ).toMatchObject({
      id: 'item_result',
      status: 'inProgress',
      outcome: {
        type: 'process',
        stdoutBytes: 22,
        stderrBytes: 21,
        stderrTruncated: true,
        durationMs: 7,
        outcome: { type: 'signal', signal: 15 },
      },
    });
    controller.handleNotification(
      notification('turn/completed', {
        threadId: correlate.threadId,
        turn: { id: correlate.turnId, status: 'completed' },
      }),
    );
    expect(onProtocolFailure).toHaveBeenCalledTimes(2);
    controller.handleNotification(
      notification('item/completed', { ...correlate, item: result }),
    );
    controller.handleNotification(
      notification('turn/completed', {
        threadId: correlate.threadId,
        turn: {
          id: correlate.turnId,
          status: 'failed',
          error: { kind: 'server', retryable: false },
        },
      }),
    );

    const snapshot = controller.getSnapshot();
    expect(snapshot.turns[0]?.commandApproval).toMatchObject({
      command: '/usr/bin/printf',
      argumentCount: 1,
      decision: { value: 'approved', status: 'completed' },
      executionAttempt: { id: 'item_attempt', status: 'completed' },
      executionResult: {
        id: 'item_result',
        status: 'completed',
        outcome: {
          type: 'process',
          stdoutBytes: 22,
          stderrBytes: 21,
          stdoutTruncated: false,
          stderrTruncated: true,
          encoding: 'utf8Lossy',
          durationMs: 7,
          outcome: { type: 'signal', signal: 15 },
          sandboxPolicy: 'filesystemReadOnlyV1',
          networkPolicy: 'networkDeniedV1',
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-value');
    expect(JSON.stringify(snapshot)).not.toContain('private-command-output');
    expect(JSON.stringify(snapshot)).not.toContain('private-command-error');
    expect(onProtocolFailure).toHaveBeenCalledTimes(2);
  });
});
