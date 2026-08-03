import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import type { ConversationRpc } from '../../../../src/main/app-server/conversation/rpc-client.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(
          `../../../../src/${specifier.slice(2)}.ts`,
          import.meta.url,
        ).href,
      };
    }
    if (
      specifier.startsWith('.') &&
      !specifier.split('/').at(-1)?.includes('.') &&
      context.parentURL
    ) {
      return {
        shortCircuit: true,
        url: new URL(
          specifier === './generated'
            ? `${specifier}/index.ts`
            : `${specifier}.ts`,
          context.parentURL,
        ).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { ConversationController } = await import(
  '../../../../src/main/app-server/conversation/controller/conversation-controller.ts'
);

test('background lifecycle stays in its Thread projection and becomes unread', async () => {
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => 'thr_a',
    listActiveThreads: async () => ({
      data: [
        { id: 'thr_a', title: 'Thread A' },
        { id: 'thr_b', title: 'Thread B' },
      ],
      nextCursor: null,
    }),
    resumeThread: async (threadId) => ({ threadId, turns: [] }),
    startThread: async () => ({ thread: { id: 'thr_new' } }),
    importAsset: async () => ({
      asset: {
        assetId: 'asset_test',
        mediaType: 'text/plain',
        originalName: 'test.txt',
        sizeBytes: 1,
        kind: 'text',
        sha256: '0'.repeat(64),
      },
    }),
    startTurn: async () => ({
      turn: { id: 'turn_a', status: 'inProgress' },
    }),
    interruptTurn: async () => ({}),
  };
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure: () => assert.fail('unexpected protocol failure'),
  });

  assert.equal(await controller.restoreForConnection('thr_a'), true);
  controller.connectionReady();
  assert.equal(
    (await controller.startTurn({ input: 'Run A' })).accepted,
    true,
  );
  assert.equal((await controller.selectThread('thr_b')).accepted, true);

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/completed',
    params: {
      threadId: 'thr_a',
      turn: { id: 'turn_a', status: 'completed' },
    },
  });

  const background = controller.getSnapshot();
  assert.equal(background.threadId, 'thr_b');
  assert.equal(background.phase, 'ready');
  assert.deepEqual(background.navigator.runningThreadIds, []);
  assert.deepEqual(background.navigator.unreadThreadIds, ['thr_a']);

  assert.equal((await controller.selectThread('thr_a')).accepted, true);
  const selected = controller.getSnapshot();
  assert.equal(selected.threadId, 'thr_a');
  assert.equal(selected.turns[0]?.status, 'completed');
  assert.deepEqual(selected.navigator.unreadThreadIds, []);
});
