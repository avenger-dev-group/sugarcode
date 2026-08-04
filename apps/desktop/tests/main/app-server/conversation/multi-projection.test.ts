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
const WORKSPACE_A = 'a'.repeat(64);
const WORKSPACE_WEB = 'b'.repeat(64);
const WORKSPACE_ADMIN = 'c'.repeat(64);
const WORKSPACE_CHAT = 'd'.repeat(64);

test('workspace switching can wait for an accepted Turn to finish starting', async () => {
  let releaseTurnStart = (): void => undefined;
  const turnStartBarrier = new Promise<void>((resolve) => {
    releaseTurnStart = resolve;
  });
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => null,
    listActiveThreads: async () => ({ data: [], nextCursor: null }),
    resumeThread: async (threadId) => ({
      threadId,
      workspaceId: WORKSPACE_WEB,
      turns: [],
    }),
    startThread: async () => ({
      thread: { id: THREAD_WEB, workspaceId: WORKSPACE_WEB },
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
    startTurn: async () => {
      await turnStartBarrier;
      return { turn: { id: TURN_WEB, status: 'inProgress' } };
    },
    interruptTurn: async () => ({}),
  };
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure: () => assert.fail('unexpected protocol failure'),
  });

  assert.equal(await controller.restoreForConnection(WORKSPACE_WEB), true);
  controller.connectionReady();
  const starting = controller.startTurn({ input: 'Review web' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getSnapshot().phase, 'starting');

  let switchReady = false;
  const waiting = controller.waitForTurnStartSettlement().then(() => {
    switchReady = true;
  });
  await Promise.resolve();
  assert.equal(switchReady, false);

  releaseTurnStart();
  assert.equal((await starting).accepted, true);
  await waiting;
  assert.equal(switchReady, true);
  assert.equal(controller.getSnapshot().phase, 'inProgress');
});

test('new Thread and Turn lifecycle may arrive before their RPC responses', async () => {
  let protocolFailures = 0;
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => null,
    listActiveThreads: async () => ({ data: [], nextCursor: null }),
    resumeThread: async (threadId) => ({
      threadId,
      workspaceId: WORKSPACE_WEB,
      turns: [],
    }),
    startThread: async () => {
      controller.handleNotification({
        kind: 'notification',
        method: 'thread/started',
        params: {
          thread: { id: THREAD_WEB, workspaceId: WORKSPACE_WEB },
        },
      });
      return {
        thread: { id: THREAD_WEB, workspaceId: WORKSPACE_WEB },
      };
    },
    importAsset: async () => {
      throw new Error('not used');
    },
    startTurn: async () => {
      controller.handleNotification({
        kind: 'notification',
        method: 'turn/started',
        params: {
          workspaceId: WORKSPACE_WEB,
          threadId: THREAD_WEB,
          turn: { id: TURN_WEB, status: 'inProgress' },
        },
      });
      return { turn: { id: TURN_WEB, status: 'inProgress' } };
    },
    generateThreadTitle: async (threadId) => {
      controller.handleNotification({
        kind: 'notification',
        method: 'thread/title/updated',
        params: {
          workspaceId: WORKSPACE_WEB,
          threadId,
          title: '安全启动会话',
        },
      });
    },
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
  assert.equal(
    (await controller.startTurn({ input: 'Start safely' })).accepted,
    true,
  );
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.threadId, THREAD_WEB);
  assert.equal(snapshot.activeTurnId, TURN_WEB);
  assert.equal(snapshot.phase, 'inProgress');
  assert.equal(
    snapshot.navigator.activeThreadTitles[THREAD_WEB],
    '安全启动会话',
  );
  assert.equal(protocolFailures, 0);
});

test('workspace loading never publishes the previous Thread index under the new binding', async () => {
  let listCalls = 0;
  let releaseAdminList = (): void => undefined;
  const adminListBarrier = new Promise<void>((resolve) => {
    releaseAdminList = resolve;
  });
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => null,
    listActiveThreads: async () => {
      listCalls += 1;
      if (listCalls === 1) {
        return {
          data: [{ id: THREAD_WEB, workspaceId: WORKSPACE_WEB }],
          nextCursor: null,
        };
      }
      await adminListBarrier;
      return { data: [], nextCursor: null };
    },
    resumeThread: async (threadId) => ({
      threadId,
      workspaceId: WORKSPACE_WEB,
      turns: [],
    }),
    startThread: async () => ({
      thread: { id: THREAD_WEB, workspaceId: WORKSPACE_WEB },
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
  const bindings = new Map<string, string>();
  controller.subscribeScoped((workspaceId, snapshot) => {
    if (snapshot.navigator.status !== 'ready') {
      return;
    }
    for (const threadId of snapshot.navigator.activeThreadIds) {
      bindings.set(threadId, workspaceId);
    }
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
  assert.equal(bindings.get(THREAD_WEB), WORKSPACE_WEB);

  const switching = controller.switchWorkspace(WORKSPACE_ADMIN);
  await Promise.resolve();
  const loading = controller.getSnapshot();
  assert.equal(loading.navigator.status, 'loading');
  assert.deepEqual(loading.navigator.activeThreadIds, []);
  assert.equal(bindings.get(THREAD_WEB), WORKSPACE_WEB);

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/warning',
    params: {
      workspaceId: WORKSPACE_WEB,
      threadId: THREAD_WEB,
      turnId: TURN_WEB,
      code: 'providerManagedContinuationFallback',
    },
  });

  releaseAdminList();
  assert.equal(await switching, true);
  assert.equal(controller.getSnapshot().phase, 'idle');
});

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
      workspaceId: WORKSPACE_A,
      threadId: THREAD_A,
      turn: { id: TURN_A, status: 'completed' },
    },
  });

  const background = controller.getSnapshot();
  assert.equal(background.threadId, THREAD_B);
  assert.equal(background.phase, 'ready');
  assert.deepEqual(background.navigator.runningThreadIds, []);
  assert.deepEqual(background.navigator.unreadThreadStatuses, {
    [THREAD_A]: 'completed',
  });

  assert.equal((await controller.selectThread(THREAD_A)).accepted, true);
  const selected = controller.getSnapshot();
  assert.equal(selected.threadId, THREAD_A);
  assert.equal(selected.turns[0]?.status, 'completed');
  assert.deepEqual(selected.navigator.unreadThreadStatuses, {});
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
      workspaceId: WORKSPACE_WEB,
      threadId: THREAD_WEB,
      turnId: TURN_WEB,
      code: 'providerManagedContinuationFallback',
    },
  });

  const afterBackgroundUpdate = controller.getSnapshot();
  assert.equal(afterBackgroundUpdate.threadId, undefined);
  assert.equal(afterBackgroundUpdate.phase, 'idle');
  assert.deepEqual(afterBackgroundUpdate.turns, []);
  assert.deepEqual(
    afterBackgroundUpdate.navigator.runningThreadIds,
    [THREAD_WEB],
  );

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/completed',
    params: {
      workspaceId: WORKSPACE_WEB,
      threadId: THREAD_WEB,
      turn: { id: TURN_WEB, status: 'completed' },
    },
  });

  const afterBackgroundCompletion = controller.getSnapshot();
  assert.equal(afterBackgroundCompletion.threadId, undefined);
  assert.equal(afterBackgroundCompletion.phase, 'idle');
  assert.deepEqual(afterBackgroundCompletion.turns, []);
  assert.deepEqual(
    afterBackgroundCompletion.navigator.unreadThreadStatuses,
    { [THREAD_WEB]: 'completed' },
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
  assert.deepEqual(
    controller.getSnapshot().navigator.runningThreadIds,
    [THREAD_WEB, THREAD_NEW],
  );

  for (const scope of ['web', 'admin'] as const) {
    controller.handleNotification({
      kind: 'notification',
      method: 'turn/completed',
      params: {
        workspaceId: workspaceIds[scope],
        threadId: threadIds[scope],
        turn:
          scope === 'web'
            ? { id: turnIds[scope], status: 'completed' }
            : {
                id: turnIds[scope],
                status: 'failed',
                error: { kind: 'timeout', retryable: true },
              },
      },
    });
  }

  assert.deepEqual(controller.getSnapshot().navigator.runningThreadIds, []);
  assert.deepEqual(
    controller.getSnapshot().navigator.unreadThreadStatuses,
    {
      [THREAD_WEB]: 'completed',
      [THREAD_NEW]: 'failed',
    },
  );

  assert.equal((await controller.startTurn({ input: '你好' })).accepted, true);
  assert.equal(controller.getSnapshot().threadId, THREAD_CHAT);
  assert.equal(controller.getSnapshot().turns[0]?.id, TURN_CHAT);
  assert.deepEqual(
    controller.getSnapshot().navigator.runningThreadIds,
    [THREAD_CHAT],
  );
  assert.deepEqual(
    controller.getSnapshot().navigator.unreadThreadStatuses,
    {
      [THREAD_WEB]: 'completed',
      [THREAD_NEW]: 'failed',
    },
  );

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
  assert.equal(controller.getSnapshot().turns[0]?.status, 'failed');
  assert.deepEqual(
    controller.getSnapshot().navigator.unreadThreadStatuses,
    {},
  );
  assert.equal(protocolFailures, 0);
});

test('a routable lifecycle projection error quarantines only its Thread and forces resume', async () => {
  let protocolFailures = 0;
  let quarantinedThreadId: string | null = null;
  let resumeACalls = 0;
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => THREAD_A,
    listActiveThreads: async () => ({
      data: [
        { id: THREAD_A, workspaceId: WORKSPACE_A, title: 'Thread A' },
        { id: THREAD_B, workspaceId: WORKSPACE_A, title: 'Thread B' },
      ],
      nextCursor: null,
    }),
    resumeThread: async (threadId) => {
      if (threadId === THREAD_A) {
        resumeACalls += 1;
      }
      return {
        threadId,
        workspaceId: WORKSPACE_A,
        turns:
          threadId === THREAD_A && resumeACalls > 1
            ? [{ id: TURN_A, status: 'completed' as const, items: [] }]
            : [],
      };
    },
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
    onProtocolFailure: () => {
      protocolFailures += 1;
    },
    onThreadProjectionFailure: (threadId) => {
      quarantinedThreadId = threadId;
    },
  });

  assert.equal(
    await controller.restoreForConnection(WORKSPACE_A, THREAD_A),
    true,
  );
  controller.connectionReady();
  assert.equal((await controller.startTurn({ input: 'Run A' })).accepted, true);
  assert.equal((await controller.selectThread(THREAD_B)).accepted, true);

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/warning',
    params: {
      workspaceId: WORKSPACE_A,
      threadId: THREAD_A,
      turnId: TURN_ADMIN,
      code: 'providerManagedContinuationFallback',
    },
  });

  const isolated = controller.getSnapshot();
  assert.equal(isolated.threadId, THREAD_B);
  assert.equal(quarantinedThreadId, THREAD_A);
  assert.equal(protocolFailures, 0);
  assert.deepEqual(isolated.navigator.runningThreadIds, []);
  assert.deepEqual(isolated.navigator.unreadThreadStatuses, {});
  assert.deepEqual(isolated.navigator.reloadRequiredThreadIds, [THREAD_A]);

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/completed',
    params: {
      workspaceId: WORKSPACE_A,
      threadId: THREAD_A,
      turn: { id: TURN_A, status: 'completed' },
    },
  });
  assert.equal(protocolFailures, 0);
  assert.deepEqual(
    controller.getSnapshot().navigator.reloadRequiredThreadIds,
    [THREAD_A],
  );

  assert.equal((await controller.selectThread(THREAD_A)).accepted, true);
  const restored = controller.getSnapshot();
  assert.equal(resumeACalls, 2);
  assert.equal(restored.threadId, THREAD_A);
  assert.equal(restored.turns[0]?.status, 'completed');
  assert.deepEqual(restored.navigator.reloadRequiredThreadIds, []);
});

test('a Workspace binding change remains a global protocol failure', async () => {
  let protocolFailures = 0;
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => THREAD_A,
    listActiveThreads: async () => ({
      data: [{ id: THREAD_A, workspaceId: WORKSPACE_A }],
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
    importAsset: async () => {
      throw new Error('not used');
    },
    startTurn: async () => ({
      turn: { id: TURN_A, status: 'inProgress' },
    }),
    interruptTurn: async () => ({}),
  };
  const controller = new ConversationController({
    getRpc: () => rpc,
    onProtocolFailure: () => {
      protocolFailures += 1;
    },
  });

  assert.equal(
    await controller.restoreForConnection(WORKSPACE_A, THREAD_A),
    true,
  );
  controller.connectionReady();
  controller.handleNotification({
    kind: 'notification',
    method: 'turn/warning',
    params: {
      workspaceId: WORKSPACE_ADMIN,
      threadId: THREAD_A,
      turnId: TURN_A,
      code: 'providerManagedContinuationFallback',
    },
  });

  assert.equal(protocolFailures, 1);
  assert.deepEqual(
    controller.getSnapshot().navigator.reloadRequiredThreadIds,
    [],
  );
});

test('sidecar reconnect requires durable resume for background active Threads', async () => {
  const resumeCalls = new Map<string, number>();
  const rpc: ConversationRpc = {
    findLatestActiveThread: async () => THREAD_A,
    listActiveThreads: async () => ({
      data: [
        { id: THREAD_A, workspaceId: WORKSPACE_A },
        { id: THREAD_B, workspaceId: WORKSPACE_A },
      ],
      nextCursor: null,
    }),
    resumeThread: async (threadId) => {
      const calls = (resumeCalls.get(threadId) ?? 0) + 1;
      resumeCalls.set(threadId, calls);
      return {
        threadId,
        workspaceId: WORKSPACE_A,
        turns:
          threadId === THREAD_A && calls > 1
            ? [{ id: TURN_A, status: 'interrupted' as const, items: [] }]
            : [],
      };
    },
    startThread: async () => ({
      thread: { id: THREAD_NEW, workspaceId: WORKSPACE_A },
    }),
    importAsset: async () => {
      throw new Error('not used');
    },
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
  assert.equal((await controller.startTurn({ input: 'Run A' })).accepted, true);
  assert.equal((await controller.selectThread(THREAD_B)).accepted, true);

  controller.transportClosed();
  assert.deepEqual(controller.getSnapshot().navigator.runningThreadIds, []);
  assert.deepEqual(
    controller.getSnapshot().navigator.reloadRequiredThreadIds,
    [THREAD_A],
  );

  assert.equal(
    await controller.restoreForConnection(WORKSPACE_A, THREAD_B),
    true,
  );
  controller.connectionReady();
  assert.equal((await controller.selectThread(THREAD_A)).accepted, true);
  assert.equal(controller.getSnapshot().turns[0]?.status, 'interrupted');
  assert.deepEqual(
    controller.getSnapshot().navigator.reloadRequiredThreadIds,
    [],
  );
});

test('an unknown notification remains a global protocol failure', async () => {
  let protocolFailures = 0;
  const controller = new ConversationController({
    getRpc: () => null,
    onProtocolFailure: () => {
      protocolFailures += 1;
    },
  });

  controller.handleNotification({
    kind: 'notification',
    method: 'turn/unknown',
    params: {},
  });

  assert.equal(protocolFailures, 1);
});
