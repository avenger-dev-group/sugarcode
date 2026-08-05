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

test('a failed batch recovers approved Full Access shell history with unstarted sibling tools', () => {
  const snapshot: ResumeSnapshot = {
    threadId: '00000000-0000-7000-8000-000000000018',
    workspaceId: 'workspace-test',
    turns: [
      {
        id: '00000000-0001-7000-8000-000000000037',
        status: 'failed',
        items: [
          {
            type: 'commandCall',
            id: 'item_call_1',
            callId: 'call_1',
            command: 'git ls-files | head -50',
            arguments: [],
          },
          {
            type: 'commandCall',
            id: 'item_call_2',
            callId: 'call_2',
            command: 'git log --oneline -15',
            arguments: [],
          },
          {
            type: 'workspaceReadCall',
            id: 'item_read_1',
            callId: 'read_1',
            path: 'src/env.d.ts',
          },
          {
            type: 'commandApprovalRequest',
            id: 'item_approval_1',
            approvalId: 'approval_1',
            callId: 'call_1',
            command: 'git ls-files | head -50',
            arguments: [],
            sandboxed: false,
          },
          {
            type: 'commandApprovalDecision',
            id: 'item_decision_1',
            approvalId: 'approval_1',
            decision: 'approved',
          },
        ],
        error: { kind: 'stateUnavailable', retryable: false },
      },
    ],
  };

  const recovered = recoverConversation(snapshot.threadId, snapshot);
  const turn = recovered.turns[0];

  assert.equal(turn?.status, 'failed');
  assert.equal(turn?.error?.kind, 'stateUnavailable');
  assert.equal(turn?.workspaceRead?.result, undefined);
  assert.equal(turn?.commandApproval?.fullAccess, true);
  assert.equal(turn?.commandApproval?.decision?.value, 'approved');
  assert.equal(turn?.commandApproval?.executionAttempt, undefined);
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
