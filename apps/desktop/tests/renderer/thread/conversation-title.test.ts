import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import type {
  ThreadNavigatorViewModel,
  ThreadViewModel,
} from '../../../src/renderer/components/thread/types.ts';
import type { WorkspaceStateSnapshot } from '../../../src/shared/workspace.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(
          `../../../src/${specifier.slice(2)}.ts`,
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
        url: new URL(`${specifier}.ts`, context.parentURL).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { resolveConversationTitle } = await import(
  '../../../src/renderer/components/thread/conversation-title.ts'
);

const CURRENT_THREAD_ID = '00000000-0000-7000-8000-000000000001';
const TARGET_THREAD_ID = '00000000-0000-7000-8000-000000000002';

const thread: ThreadViewModel = {
  phase: 'unavailable',
  workspaceIdentity: null,
  threadIdentity: CURRENT_THREAD_ID,
      turns: [],
      queue: { paused: false, messages: [] },
      isEmpty: true,
};

const navigator: ThreadNavigatorViewModel = {
  status: 'loading',
  threadIds: [],
  threadTitles: {},
  runningThreadIds: [],
  inputRequiredThreadIds: [],
  unreadThreadStatuses: {},
  selectedThreadId: null,
  pendingThreadId: TARGET_THREAD_ID,
  pendingMutation: null,
  truncated: false,
  statusLabel: 'Loading Thread',
};

test('a switching Chat shows the target title before its transcript loads', () => {
  const workspace: WorkspaceStateSnapshot = {
    revision: 1,
    generation: 1,
    status: 'selecting',
    kind: 'chat',
    chatThreadIds: [TARGET_THREAD_ID],
    chatTitles: { [TARGET_THREAD_ID]: '目标会话' },
  };

  assert.equal(
    resolveConversationTitle(thread, navigator, workspace),
    '目标会话',
  );
});

test('a switching project task uses the persisted project title', () => {
  const workspace: WorkspaceStateSnapshot = {
    revision: 1,
    generation: 1,
    status: 'selecting',
    kind: 'project',
    projects: [
      {
        id: 'project-admin',
        name: 'admin',
        threadIds: [TARGET_THREAD_ID],
        threadTitles: { [TARGET_THREAD_ID]: 'Admin task' },
        lastOpenedAtMs: 1,
      },
    ],
  };

  assert.equal(
    resolveConversationTitle(thread, navigator, workspace),
    'Admin task',
  );
});

test('an empty conversation has no heading in every workspace mode', () => {
  const workspaces: readonly WorkspaceStateSnapshot[] = [
    {
      revision: 1,
      generation: 0,
      status: 'unselected',
    },
    {
      revision: 2,
      generation: 1,
      status: 'ready',
      kind: 'chat',
    },
    {
      revision: 3,
      generation: 1,
      status: 'ready',
      kind: 'project',
      name: 'sugarcode',
    },
  ];

  for (const workspace of workspaces) {
    assert.equal(
      resolveConversationTitle(
        { ...thread, threadIdentity: null },
        { ...navigator, pendingThreadId: null },
        workspace,
      ),
      null,
    );
  }
});

test('an existing conversation shows its title directly', () => {
  assert.equal(
    resolveConversationTitle(
      thread,
      { ...navigator, pendingThreadId: null },
      {
        revision: 1,
        generation: 1,
        status: 'ready',
        kind: 'chat',
        chatThreadIds: [CURRENT_THREAD_ID],
        chatTitles: { [CURRENT_THREAD_ID]: '已有会话' },
      },
    ),
    '已有会话',
  );
});

test('an untitled durable conversation displays the new conversation label', () => {
  assert.equal(
    resolveConversationTitle(
      thread,
      { ...navigator, pendingThreadId: null },
      {
        revision: 1,
        generation: 1,
        status: 'ready',
        kind: 'chat',
        chatThreadIds: [CURRENT_THREAD_ID],
        chatTitles: {},
      },
    ),
    '新对话',
  );
});
