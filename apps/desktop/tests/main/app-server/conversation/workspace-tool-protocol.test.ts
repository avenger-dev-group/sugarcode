import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(`../../../../src/${specifier.slice(2)}.ts`, import.meta.url)
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

const { parseConversationLifecycle, parseThreadResumeResponse } = await import(
  '../../../../src/main/app-server/conversation/protocol.ts'
);
const { recoverConversation } = await import(
  '../../../../src/main/app-server/conversation/recovery.ts'
);

const WORKSPACE_ID = 'a'.repeat(64);
const THREAD_ID = '00000000-0000-7000-8000-000000000017';
const TURN_ID = '00000000-0001-7000-8000-000000000036';

const lifecycleItem = (
  method: 'item/started' | 'item/completed',
  item: Record<string, unknown>,
) =>
  parseConversationLifecycle({
    kind: 'notification',
    method,
    params: {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item,
    },
  });

test('recursive workspace/list calls and results remain supported lifecycle Items', () => {
  const call = lifecycleItem('item/started', {
    type: 'toolCall',
    id: '00000000-0002-7000-8000-000000000001',
    callId: 'list-1',
    name: 'workspace/list',
    arguments: { path: '.', recursive: true },
  });
  assert.equal(call?.type, 'itemStarted');
  assert.equal(
    call?.type === 'itemStarted' ? call.params.item.type : undefined,
    'workspaceListCall',
  );

  const content = JSON.stringify({
    entries: [{ path: 'src/index.ts', name: 'index.ts', kind: 'file' }],
    scanned: 1,
    truncated: false,
  });
  const result = lifecycleItem('item/completed', {
    type: 'toolResult',
    id: '00000000-0002-7000-8000-000000000002',
    callId: 'list-1',
    name: 'workspace/list',
    result: {
      type: 'success',
      content,
      bytes: new TextEncoder().encode(content).byteLength,
    },
  });
  assert.deepEqual(
    result?.type === 'itemCompleted' ? result.params.item : undefined,
    {
      type: 'workspaceListResult',
      id: '00000000-0002-7000-8000-000000000002',
      callId: 'list-1',
      outcome: { type: 'success', entries: 1 },
    },
  );
});

test('advanced workspace/search calls and path-mode results remain supported lifecycle Items', () => {
  const call = lifecycleItem('item/started', {
    type: 'toolCall',
    id: '00000000-0003-7000-8000-000000000001',
    callId: 'search-1',
    name: 'workspace/search',
    arguments: {
      path: '.',
      query: 'component',
      mode: 'path',
      regex: false,
      caseSensitive: false,
      filePattern: '*.tsx',
    },
  });
  assert.equal(call?.type, 'itemStarted');
  assert.equal(
    call?.type === 'itemStarted' ? call.params.item.type : undefined,
    'workspaceSearchCall',
  );

  const content = JSON.stringify({
    matches: [
      {
        path: 'src/components/review.tsx',
        line: null,
        excerpt: null,
        kind: 'file',
      },
    ],
    scanned: 20_001,
    truncated: true,
  });
  const result = lifecycleItem('item/completed', {
    type: 'toolResult',
    id: '00000000-0003-7000-8000-000000000002',
    callId: 'search-1',
    name: 'workspace/search',
    result: {
      type: 'success',
      content,
      bytes: new TextEncoder().encode(content).byteLength,
    },
  });
  assert.deepEqual(
    result?.type === 'itemCompleted' ? result.params.item : undefined,
    {
      type: 'workspaceSearchResult',
      id: '00000000-0003-7000-8000-000000000002',
      callId: 'search-1',
      outcome: { type: 'success', matches: 1, truncated: true },
    },
  );
});

test('unknown workspace tool arguments still fail closed', () => {
  assert.throws(
    () =>
      lifecycleItem('item/started', {
        type: 'toolCall',
        id: '00000000-0004-7000-8000-000000000001',
        callId: 'list-invalid',
        name: 'workspace/list',
        arguments: { path: '.', recursive: true, unsafe: true },
      }),
    /Invalid workspace\/list ToolCall Item/u,
  );
});

test('a Thread quarantined on a recursive list can be restored after upgrade', () => {
  const content = JSON.stringify({
    entries: [{ path: 'src', name: 'src', kind: 'directory' }],
    scanned: 1,
    truncated: false,
  });
  const snapshot = parseThreadResumeResponse({
    thread: { id: THREAD_ID, workspaceId: WORKSPACE_ID },
    turns: [
      {
        id: TURN_ID,
        status: 'completed',
        items: [
          {
            type: 'toolCall',
            id: '00000000-0005-7000-8000-000000000001',
            callId: 'list-recovered',
            name: 'workspace/list',
            arguments: { path: '.', recursive: true },
          },
          {
            type: 'toolResult',
            id: '00000000-0005-7000-8000-000000000002',
            callId: 'list-recovered',
            name: 'workspace/list',
            result: {
              type: 'success',
              content,
              bytes: new TextEncoder().encode(content).byteLength,
            },
          },
        ],
      },
    ],
  });

  const recovered = recoverConversation(THREAD_ID, snapshot);
  assert.deepEqual(recovered.turns[0]?.workspaceList?.result?.outcome, {
    type: 'success',
    entries: 1,
  });
});
