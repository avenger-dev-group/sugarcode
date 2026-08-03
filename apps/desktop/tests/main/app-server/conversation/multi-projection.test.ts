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

const THREAD_A = '00000000-0000-7000-8000-000000000001';
const THREAD_B = '00000000-0000-7000-8000-000000000002';
const THREAD_WEB = '00000000-0000-7000-8000-000000000003';
const THREAD_NEW = '00000000-0000-7000-8000-000000000004';
const THREAD_CHAT = '00000000-0000-7000-8000-000000000005';
const TURN_A = '00000000-0001-7000-8000-000000000001';
const TURN_WEB = '00000000-0001-7000-8000-000000000002';
const TURN_ADMIN = '00000000-0001-7000-8000-000000000003';
const TURN_CHAT = '00000000-0001-7000-8000-000000000004';
const WORKSPACE_A = 'workspace-a';
const WORKSPACE_WEB = 'workspace-web';
const WORKSPACE_ADMIN = 'workspace-admin';
const WORKSPACE_CHAT = 'workspace-chat';

test('background lifecycle stays in its Thread projection and becomes unread', async () => {
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => THREAD_A,
    listActiveThreads: async () => ({
      data: [
        { id: THREAD_A, workspaceId: WORKSPACE_A, title: 'Thread A' },
        { id: THREAD_B, workspaceId: WORKSPACE_A, title: 'Thread B' },
      ],
      nextCursor: null,
    }),
    resumeThread: async (threadId) => ({
      threadId,
      workspaceId: WORKSPACE_A,
      turns: [],
    }),
    startThread: async () => ({
      thread: { id: THREAD_NEW, workspaceId: WORKSPACE_A },
    }),
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
      turn: { id: TURN_A, status: 'inProgress' },
    }),
    interruptTurn: async () => ({}),
  };
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure: () => assert.fail('unexpected protocol failure'),
  });

  assert.equal(
    await controller.restoreForConnection(WORKSPACE_A, THREAD_A),
    true,
  );
  controller.connectionReady();
  assert.equal(
    (await controller.startTurn({ input: 'Run A' })).accepted,
    true,
  );
  assert.equal((await controller.selectThread(THREAD_B)).accepted, true);

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/completed',
    params: {
      threadId: THREAD_A,
      turn: { id: TURN_A, status: 'completed' },
    },
  }, WORKSPACE_A);

  const background = controller.getSnapshot();
  assert.equal(background.threadId, THREAD_B);
  assert.equal(background.phase, 'ready');
  assert.deepEqual(background.navigator.runningThreadIds, []);
  assert.deepEqual(background.navigator.unreadThreadIds, [THREAD_A]);

  assert.equal((await controller.selectThread(THREAD_A)).accepted, true);
  const selected = controller.getSnapshot();
  assert.equal(selected.threadId, THREAD_A);
  assert.equal(selected.turns[0]?.status, 'completed');
  assert.deepEqual(selected.navigator.unreadThreadIds, []);
});

test('background lifecycle cannot replace a blank foreground workspace', async () => {
  let activeWorkspace: 'web' | 'admin' = 'web';
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () =>
      activeWorkspace === 'web' ? THREAD_WEB : null,
    listActiveThreads: async () => ({
      data:
        activeWorkspace === 'web'
          ? [{ id: THREAD_WEB, workspaceId: WORKSPACE_WEB, title: 'Web task' }]
          : [],
      nextCursor: null,
    }),
    resumeThread: async (threadId) => ({
      threadId,
      workspaceId:
        activeWorkspace === 'web' ? WORKSPACE_WEB : WORKSPACE_ADMIN,
      turns: [],
    }),
    startThread: async () => ({
      thread: {
        id: THREAD_NEW,
        workspaceId:
          activeWorkspace === 'web' ? WORKSPACE_WEB : WORKSPACE_ADMIN,
      },
    }),
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
      turn: { id: TURN_WEB, status: 'inProgress' },
    }),
    interruptTurn: async () => ({}),
  };
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure: () => assert.fail('unexpected protocol failure'),
  });

  assert.equal(
    await controller.restoreForConnection(WORKSPACE_WEB, THREAD_WEB),
    true,
  );
  controller.connectionReady();
  assert.equal(
    (await controller.startTurn({ input: 'Review web' })).accepted,
    true,
  );

  activeWorkspace = 'admin';
  assert.equal(await controller.switchWorkspace(WORKSPACE_ADMIN), true);
  const blankAdmin = controller.getSnapshot();
  assert.equal(blankAdmin.threadId, undefined);
  assert.equal(blankAdmin.phase, 'idle');
  assert.deepEqual(blankAdmin.turns, []);

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/warning',
    params: {
      threadId: THREAD_WEB,
      turnId: TURN_WEB,
      code: 'providerManagedContinuationFallback',
    },
  }, WORKSPACE_WEB);

  const afterBackgroundUpdate = controller.getSnapshot();
  assert.equal(afterBackgroundUpdate.threadId, undefined);
  assert.equal(afterBackgroundUpdate.phase, 'idle');
  assert.deepEqual(afterBackgroundUpdate.turns, []);
  assert.deepEqual(
    afterBackgroundUpdate.navigator.runningThreadIds,
    [],
  );

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/completed',
    params: {
      threadId: THREAD_WEB,
      turn: { id: TURN_WEB, status: 'completed' },
    },
  }, WORKSPACE_WEB);

  const afterBackgroundCompletion = controller.getSnapshot();
  assert.equal(afterBackgroundCompletion.threadId, undefined);
  assert.equal(afterBackgroundCompletion.phase, 'idle');
  assert.deepEqual(afterBackgroundCompletion.turns, []);
  assert.deepEqual(
    afterBackgroundCompletion.navigator.unreadThreadIds,
    [],
  );
});

test('rapid web admin and blank chat sends keep three workspace projections isolated', async () => {
  type Scope = 'web' | 'admin' | 'chat';
  let activeWorkspace: Scope = 'web';
  let protocolFailures = 0;
  const workspaceIds: Record<Scope, string> = {
    web: WORKSPACE_WEB,
    admin: WORKSPACE_ADMIN,
    chat: WORKSPACE_CHAT,
  };
  const threadIds: Record<Scope, string> = {
    web: THREAD_WEB,
    admin: THREAD_NEW,
    chat: THREAD_CHAT,
  };
  const turnIds: Record<Scope, string> = {
    web: TURN_WEB,
    admin: TURN_ADMIN,
    chat: TURN_CHAT,
  };
  const started = new Set<Scope>();
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => null,
    listActiveThreads: async () => ({
      data: started.has(activeWorkspace)
        ? [{
            id: threadIds[activeWorkspace],
            workspaceId: workspaceIds[activeWorkspace],
          }]
        : [],
      nextCursor: null,
    }),
    resumeThread: async (threadId) => ({
      threadId,
      workspaceId: workspaceIds[activeWorkspace],
      turns: [],
    }),
    startThread: async () => {
      started.add(activeWorkspace);
      return {
        thread: {
          id: threadIds[activeWorkspace],
          workspaceId: workspaceIds[activeWorkspace],
        },
      };
    },
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
      turn: { id: turnIds[activeWorkspace], status: 'inProgress' },
    }),
    interruptTurn: async () => ({}),
  };
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure: () => {
      protocolFailures += 1;
    },
  });

  assert.equal(await controller.restoreForConnection(WORKSPACE_WEB), true);
  controller.connectionReady();
  assert.equal((await controller.startTurn({ input: 'web task' })).accepted, true);

  activeWorkspace = 'admin';
  assert.equal(await controller.switchWorkspace(WORKSPACE_ADMIN), true);
  assert.equal((await controller.startTurn({ input: 'admin task' })).accepted, true);

  activeWorkspace = 'chat';
  assert.equal(await controller.switchWorkspace(WORKSPACE_CHAT), true);
  assert.equal(controller.getSnapshot().threadId, undefined);

  for (const scope of ['web', 'admin'] as const) {
    controller.handleNotification({
      kind: 'notification',
      method: 'turn/completed',
      params: {
        threadId: threadIds[scope],
        turn: { id: turnIds[scope], status: 'completed' },
      },
    }, workspaceIds[scope]);
  }

  assert.equal((await controller.startTurn({ input: '你好' })).accepted, true);
  assert.equal(controller.getSnapshot().threadId, THREAD_CHAT);
  assert.equal(controller.getSnapshot().turns[0]?.id, TURN_CHAT);

  activeWorkspace = 'web';
  assert.equal(
    await controller.switchWorkspace(WORKSPACE_WEB, THREAD_WEB),
    true,
  );
  assert.equal(controller.getSnapshot().turns[0]?.status, 'completed');

  activeWorkspace = 'admin';
  assert.equal(
    await controller.switchWorkspace(WORKSPACE_ADMIN, THREAD_NEW),
    true,
  );
  assert.equal(controller.getSnapshot().turns[0]?.status, 'completed');
  assert.equal(protocolFailures, 0);
});
