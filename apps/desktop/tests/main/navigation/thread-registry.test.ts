import assert from 'node:assert/strict';
import test from 'node:test';

import { ThreadRegistry } from '../../../src/main/navigation/thread-registry.ts';

const WORKSPACE_ID = 'a'.repeat(64);
const THREAD_ID = '019fd4ee-6482-7e10-943a-1ef2ea409dcc';

test('runtime state replaces cached navigation state for an owner', () => {
  const registry = new ThreadRegistry();
  registry.hydrateSessionCache([
    {
      threadId: THREAD_ID,
      ownerKey: 'project:alpha',
      title: 'Cached title',
    },
  ]);

  registry.registerWorkspaceOwner(
    WORKSPACE_ID,
    'project:alpha',
    'runtime',
  );
  registry.replaceRuntimeWorkspaceIndex(WORKSPACE_ID, [
    { id: THREAD_ID, workspaceId: WORKSPACE_ID, title: 'Runtime title' },
  ]);

  assert.equal(registry.getBindingSource(THREAD_ID), 'runtime');
  assert.equal(registry.getWorkspaceId(THREAD_ID), WORKSPACE_ID);
  assert.deepEqual(registry.getOwnerView('project:alpha'), {
    threadIds: [THREAD_ID],
    threadTitles: { [THREAD_ID]: 'Runtime title' },
  });
});

test('runtime index rejects cross-workspace thread bindings', () => {
  const registry = new ThreadRegistry();

  assert.throws(
    () =>
      registry.replaceRuntimeWorkspaceIndex(WORKSPACE_ID, [
        { id: THREAD_ID, workspaceId: 'b'.repeat(64) },
      ]),
    /crossed Workspace ownership/u,
  );
});

test('updating a title preserves Thread ownership and order', () => {
  const registry = new ThreadRegistry();
  registry.hydrateSessionCache([
    {
      threadId: THREAD_ID,
      ownerKey: 'project:alpha',
      title: 'Before rename',
    },
  ]);

  assert.equal(registry.updateTitle(THREAD_ID, 'After rename'), true);
  assert.deepEqual(registry.getOwnerView('project:alpha'), {
    threadIds: [THREAD_ID],
    threadTitles: { [THREAD_ID]: 'After rename' },
  });
  assert.equal(registry.updateTitle('missing-thread', 'Ignored'), false);
});

test('removing a thread clears owner navigation state', () => {
  const registry = new ThreadRegistry();
  registry.registerWorkspaceOwner(
    WORKSPACE_ID,
    'project:alpha',
    'runtime',
  );
  registry.replaceRuntimeWorkspaceIndex(WORKSPACE_ID, [
    { id: THREAD_ID, workspaceId: WORKSPACE_ID },
  ]);

  registry.removeThread(THREAD_ID);

  assert.deepEqual(registry.getOwnerView('project:alpha'), {
    threadIds: [],
    threadTitles: {},
  });
  assert.equal(registry.getWorkspaceId(THREAD_ID), null);
});

test('removing a project owner preserves runtime threads for a later rebind', () => {
  const registry = new ThreadRegistry();
  registry.registerWorkspaceOwner(
    WORKSPACE_ID,
    'project:alpha',
    'runtime',
  );
  registry.replaceRuntimeWorkspaceIndex(WORKSPACE_ID, [
    { id: THREAD_ID, workspaceId: WORKSPACE_ID, title: 'Retained task' },
  ]);

  registry.removeOwner('project:alpha');

  assert.deepEqual(registry.getOwnerView('project:alpha'), {
    threadIds: [],
    threadTitles: {},
  });
  assert.equal(registry.getOwnerKey(THREAD_ID), null);
  assert.equal(registry.getWorkspaceId(THREAD_ID), WORKSPACE_ID);

  registry.registerWorkspaceOwner(
    WORKSPACE_ID,
    'project:reopened',
    'runtime',
  );
  assert.deepEqual(registry.getOwnerView('project:reopened'), {
    threadIds: [THREAD_ID],
    threadTitles: { [THREAD_ID]: 'Retained task' },
  });
});
