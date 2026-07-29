import type {
  TurnStartResponse,
} from '@sugarcode/app-server-protocol';

import { describe, expect, it, vi } from 'vitest';

import { ConversationController } from '../controller';
import type { ConversationRpc } from '../rpc-client';

const BEFORE_SHA256 = 'a'.repeat(64);
const AFTER_SHA256 = 'b'.repeat(64);
const DIFF =
  '--- a/notes.txt\n' +
  '+++ b/notes.txt\n' +
  '@@ -1,1 +1,1 @@\n' +
  '-old\n' +
  '+new\n';

const notification = (method: string, params: unknown) =>
  ({ kind: 'notification', method, params }) as const;

const createHarness = async () => {
  const rpc: ConversationRpc = {
    findLatestActiveThread: vi.fn(async () => null),
    resumeThread: vi.fn(),
    startThread: vi.fn(async () => ({
      thread: { id: 'thr_file_change' },
    })),
    startTurn: vi.fn(
      async (): Promise<TurnStartResponse> => ({
        turn: { id: 'turn_file_change', status: 'inProgress' },
      }),
    ),
    interruptTurn: vi.fn(),
  };
  const onProtocolFailure = vi.fn();
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure,
  });
  controller.connectionReady();
  await controller.startTurn('Update notes.txt.');
  return { controller, onProtocolFailure };
};

const correlate = {
  threadId: 'thr_file_change',
  turnId: 'turn_file_change',
};

const call = {
  type: 'toolCall',
  id: 'item_call',
  callId: 'call_patch',
  name: 'workspace/apply-patch',
  path: 'notes.txt',
};

const change = {
  type: 'fileChange',
  id: 'item_change',
  callId: 'call_patch',
  path: 'notes.txt',
  kind: 'update',
  diff: DIFF,
  beforeSha256: BEFORE_SHA256,
  afterSha256: AFTER_SHA256,
  beforeBytes: 4,
  afterBytes: 4,
  newlineStyle: 'lf',
  finalNewline: true,
};

describe('workspace/apply-patch live conversation projection', () => {
  it('publishes one proposal and only treats a matched success result as applied', async () => {
    const { controller, onProtocolFailure } = await createHarness();
    for (const item of [call, change]) {
      for (const method of ['item/started', 'item/completed']) {
        controller.handleNotification(
          notification(method, { ...correlate, item }),
        );
      }
    }
    expect(controller.getSnapshot().turns[0]?.fileChange).toMatchObject({
      path: 'notes.txt',
      callStatus: 'completed',
      change: { status: 'completed', diff: DIFF },
    });
    expect(
      controller.getSnapshot().turns[0]?.fileChange?.result,
    ).toBeUndefined();

    const content = JSON.stringify({
      kind: 'update',
      path: 'notes.txt',
      beforeSha256: BEFORE_SHA256,
      afterSha256: AFTER_SHA256,
      beforeBytes: 4,
      afterBytes: 4,
    });
    const result = {
      type: 'toolResult',
      id: 'item_result',
      callId: 'call_patch',
      name: 'workspace/apply-patch',
      result: {
        type: 'success',
        content,
        bytes: new TextEncoder().encode(content).byteLength,
      },
    };
    for (const method of ['item/started', 'item/completed']) {
      controller.handleNotification(
        notification(method, { ...correlate, item: result }),
      );
    }
    controller.handleNotification(
      notification('turn/completed', {
        threadId: correlate.threadId,
        turn: { id: correlate.turnId, status: 'completed' },
      }),
    );

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      turns: [
        {
          fileChange: {
            result: {
              status: 'completed',
              outcome: {
                type: 'success',
                path: 'notes.txt',
                afterSha256: AFTER_SHA256,
              },
            },
          },
        },
      ],
    });
    expect(onProtocolFailure).not.toHaveBeenCalled();
  });

  it('fails closed when a durable success proof does not match its proposal', async () => {
    const { controller, onProtocolFailure } = await createHarness();
    for (const item of [call, change]) {
      for (const method of ['item/started', 'item/completed']) {
        controller.handleNotification(
          notification(method, { ...correlate, item }),
        );
      }
    }
    const content = JSON.stringify({
      kind: 'update',
      path: 'notes.txt',
      beforeSha256: BEFORE_SHA256,
      afterSha256: AFTER_SHA256,
      beforeBytes: 4,
      afterBytes: 5,
    });
    controller.handleNotification(
      notification('item/started', {
        ...correlate,
        item: {
          type: 'toolResult',
          id: 'item_result',
          callId: 'call_patch',
          name: 'workspace/apply-patch',
          result: {
            type: 'success',
            content,
            bytes: new TextEncoder().encode(content).byteLength,
          },
        },
      }),
    );

    expect(onProtocolFailure).toHaveBeenCalledOnce();
    expect(
      controller.getSnapshot().turns[0]?.fileChange?.result,
    ).toBeUndefined();
  });
});
