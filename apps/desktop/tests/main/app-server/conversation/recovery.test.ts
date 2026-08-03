import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverConversation } from '../../../../src/main/app-server/conversation/recovery.ts';
import type { ResumeSnapshot } from '../../../../src/main/app-server/conversation/protocol.ts';

test('an interrupted batch may contain multiple declared command calls', () => {
  const snapshot: ResumeSnapshot = {
    threadId: '00000000-0000-7000-8000-000000000017',
    workspaceId: 'workspace-test',
    turns: [
      {
        id: '00000000-0001-7000-8000-000000000036',
        status: 'interrupted',
        items: [
          {
            type: 'commandCall',
            id: 'item_call_1',
            callId: 'call_1',
            command: '/usr/bin/git',
            arguments: ['status', '--short'],
          },
          {
            type: 'commandCall',
            id: 'item_call_2',
            callId: 'call_2',
            command: '/usr/bin/git',
            arguments: ['log', '--oneline', '-10'],
          },
          {
            type: 'commandApprovalRequest',
            id: 'item_approval_1',
            approvalId: 'approval_1',
            callId: 'call_1',
            command: '/usr/bin/git',
            arguments: ['status', '--short'],
          },
        ],
      },
    ],
  };

  const recovered = recoverConversation(snapshot.threadId, snapshot);

  assert.equal(recovered.turns[0]?.status, 'interrupted');
  assert.deepEqual(recovered.turns[0]?.commandApproval, {
    callItemId: 'item_call_1',
    id: 'item_approval_1',
    callId: 'call_1',
    approvalId: 'approval_1',
    command: '/usr/bin/git',
    argumentCount: 2,
    requestStatus: 'completed',
  });
});

test('a completed turn cannot leave a declared command call unresolved', () => {
  const snapshot: ResumeSnapshot = {
    threadId: '00000000-0000-7000-8000-000000000017',
    workspaceId: 'workspace-test',
    turns: [
      {
        id: '00000000-0001-7000-8000-000000000036',
        status: 'completed',
        items: [
          {
            type: 'commandCall',
            id: 'item_call_1',
            callId: 'call_1',
            command: '/usr/bin/git',
            arguments: ['status', '--short'],
          },
        ],
      },
    ],
  };

  assert.throws(
    () => recoverConversation(snapshot.threadId, snapshot),
    /terminal command call without durable closure/u,
  );
});
