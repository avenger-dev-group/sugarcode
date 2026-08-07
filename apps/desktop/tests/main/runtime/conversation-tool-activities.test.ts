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
