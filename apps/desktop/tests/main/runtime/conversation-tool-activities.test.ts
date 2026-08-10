import assert from 'node:assert/strict';
import test from 'node:test';

import { projectTurnActivities } from '../../../src/main/runtime/conversation-tool-activities.ts';
import type { RuntimeTurnItemRecord } from '../../../src/runtime/protocol.ts';

test('workspace_read projection preserves every requested path', () => {
  const paths = Array.from({ length: 10 }, (_, index) => `file-${index}.txt`);
  const items: readonly RuntimeTurnItemRecord[] = [{
    id: 'item-read',
    turnId: 'turn-fixture',
    sequence: 1,
    kind: 'turn.toolCall',
    payload: {
      itemId: 'item-read',
      callId: 'call-read',
      name: 'workspace_read',
      arguments: { paths },
    },
  }];

  const activities = projectTurnActivities(items);

  assert.deepEqual(
    activities.map((activity) =>
      activity.type === 'workspaceRead' ? activity.activity.path : undefined
    ),
    paths,
  );
});

test('load_skill projects a durable activity without the invocation marker', () => {
  const items: readonly RuntimeTurnItemRecord[] = [
    {
      id: 'item-skill-call',
      turnId: 'turn-fixture',
      sequence: 1,
      kind: 'turn.toolCall',
      payload: {
        itemId: 'item-skill-call',
        callId: 'call-skill',
        name: 'load_skill',
        arguments: { name: '$frontend-design' },
      },
    },
    {
      id: 'item-skill-result',
      turnId: 'turn-fixture',
      sequence: 2,
      kind: 'turn.toolResult',
      payload: {
        itemId: 'item-skill-result',
        callId: 'call-skill',
        result: { ok: true, name: 'frontend-design' },
      },
    },
  ];

  assert.deepEqual(projectTurnActivities(items), [
    {
      type: 'skill',
      activity: {
        id: 'item-skill-call',
        callId: 'call-skill',
        name: 'frontend-design',
        callStatus: 'completed',
        result: {
          id: 'item-skill-result:result:item-skill-call',
          status: 'completed',
          outcome: { type: 'success' },
        },
      },
    },
  ]);
});
