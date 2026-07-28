import type {
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartResponse,
} from '@sugarcode/app-server-protocol';

import { describe, expect, it, vi } from 'vitest';

import { ConversationController } from '../conversation-controller';
import type { ConversationRpc } from '../conversation-rpc';

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
  it('buffers lifecycle delivered beside the accepted response and projects durable text', async () => {
    const turnResponse = deferred<TurnStartResponse>();
    const rpc: ConversationRpc = {
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
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(
        async (): Promise<TurnStartResponse> => ({
          turn: { id: 'turn_0000000000000001', status: 'inProgress' },
        }),
      ),
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

  it('rejects invalid actions and fails closed on cross-Turn lifecycle', async () => {
    const rpc: ConversationRpc = {
      startThread: vi.fn(async () => ({
        thread: { id: 'thr_0000000000000001' },
      })),
      startTurn: vi.fn(
        async (): Promise<TurnStartResponse> => ({
          turn: { id: 'turn_0000000000000001', status: 'inProgress' },
        }),
      ),
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
});
