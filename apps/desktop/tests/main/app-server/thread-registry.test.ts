import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(`../../../src/${specifier.slice(2)}.ts`, import.meta.url)
          .href,
      };
    }
    if (
      specifier.startsWith('.') &&
      !specifier.split('/').at(-1)?.includes('.') &&
      context.parentURL
    ) {
      return {
        shortCircuit: true,
        url: new URL(`${specifier}.ts`, context.parentURL).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { ThreadRegistry } = await import(
  '../../../src/main/app-server/thread-registry.ts'
);
const { ThreadRuntime } = await import(
  '../../../src/main/app-server/conversation/controller/thread-runtime.ts'
);

const THREAD_WEB = '00000000-0000-7000-8000-000000000001';
const THREAD_ADMIN = '00000000-0000-7000-8000-000000000002';
const WORKSPACE_WEB = 'a'.repeat(64);
const WORKSPACE_ADMIN = 'b'.repeat(64);

test('session cache is corrected by the first protocol Thread binding', () => {
  const registry = new ThreadRegistry();
  registry.registerWorkspaceOwner(
    WORKSPACE_ADMIN,
    'project:admin',
    'sessionCache',
  );
  registry.registerWorkspaceOwner(
    WORKSPACE_WEB,
    'project:web',
    'protocol',
  );
  registry.hydrateSessionCache([
    {
      threadId: THREAD_WEB,
      ownerKey: 'project:admin',
      workspaceId: WORKSPACE_ADMIN,
      title: 'Web task',
    },
  ]);

  registry.replaceWorkspaceIndex(WORKSPACE_WEB, [
    { id: THREAD_WEB, workspaceId: WORKSPACE_WEB, title: 'Web task' },
  ]);

  assert.deepEqual(registry.getOwnerView('project:admin').threadIds, []);
  assert.deepEqual(registry.getOwnerView('project:web').threadIds, [THREAD_WEB]);
  assert.equal(registry.getWorkspaceId(THREAD_WEB), WORKSPACE_WEB);
});

test('a protocol-confirmed Thread cannot change Workspace binding', () => {
  const registry = new ThreadRegistry();
  registry.registerActiveThread({
    id: THREAD_WEB,
    workspaceId: WORKSPACE_WEB,
  });

  assert.throws(
    () =>
      registry.registerActiveThread({
        id: THREAD_WEB,
        workspaceId: WORKSPACE_ADMIN,
      }),
    /binding changed/u,
  );
});

test('Workspace index replacement and titles are isolated by binding', () => {
  const registry = new ThreadRegistry();
  registry.registerWorkspaceOwner(WORKSPACE_WEB, 'project:web', 'protocol');
  registry.registerWorkspaceOwner(
    WORKSPACE_ADMIN,
    'project:admin',
    'protocol',
  );
  registry.replaceWorkspaceIndex(WORKSPACE_WEB, [
    { id: THREAD_WEB, workspaceId: WORKSPACE_WEB },
  ]);
  registry.replaceWorkspaceIndex(WORKSPACE_ADMIN, [
    { id: THREAD_ADMIN, workspaceId: WORKSPACE_ADMIN },
  ]);

  registry.updateTitle(WORKSPACE_WEB, THREAD_WEB, '确认当前项目');

  assert.deepEqual(registry.getWorkspaceView(WORKSPACE_WEB), {
    threadIds: [THREAD_WEB],
    threadTitles: { [THREAD_WEB]: '确认当前项目' },
  });
  assert.deepEqual(registry.getWorkspaceView(WORKSPACE_ADMIN), {
    threadIds: [THREAD_ADMIN],
    threadTitles: {},
  });
});

test('an authoritative Workspace list removes stale session-cache membership', () => {
  const registry = new ThreadRegistry();
  registry.registerWorkspaceOwner(
    WORKSPACE_WEB,
    'project:web',
    'sessionCache',
  );
  registry.hydrateSessionCache([
    {
      threadId: THREAD_WEB,
      ownerKey: 'project:web',
      workspaceId: WORKSPACE_WEB,
    },
  ]);

  registry.replaceWorkspaceIndex(WORKSPACE_WEB, []);

  assert.deepEqual(registry.getOwnerView('project:web').threadIds, []);
  assert.equal(registry.getOwnerKey(THREAD_WEB), null);
});

test('an owner-only cache entry is pruned when its first Workspace list is empty', () => {
  const registry = new ThreadRegistry();
  registry.hydrateSessionCache([
    { threadId: THREAD_WEB, ownerKey: 'project:web' },
  ]);

  registry.replaceWorkspaceIndex(WORKSPACE_WEB, []);
  registry.registerWorkspaceOwner(WORKSPACE_WEB, 'project:web', 'protocol');

  assert.deepEqual(registry.getOwnerView('project:web').threadIds, []);
  assert.equal(registry.getOwnerKey(THREAD_WEB), null);
});

test('Runtime, unread and reload state share the Thread Registry entry', () => {
  const registry = new ThreadRegistry();
  registry.registerActiveThread({
    id: THREAD_WEB,
    workspaceId: WORKSPACE_WEB,
  });
  const runtime = new ThreadRuntime({
    workspaceId: WORKSPACE_WEB,
    threadId: THREAD_WEB,
    phase: 'inProgress',
    activeTurnId: '00000000-0001-7000-8000-000000000001',
    turns: [],
    notice: undefined,
    attachmentPreviews: new Map(),
  });

  registry.setRuntime(THREAD_WEB, runtime);
  registry.markUnread(THREAD_WEB, 'completed');
  registry.markReloadRequired(THREAD_WEB);

  assert.equal(registry.getRuntime(THREAD_WEB), runtime);
  assert.deepEqual(registry.getRunningThreadIds(), [THREAD_WEB]);
  assert.deepEqual(registry.getUnreadStatuses(), {
    [THREAD_WEB]: 'completed',
  });
  assert.deepEqual(registry.getReloadRequiredThreadIds(), [THREAD_WEB]);
});
