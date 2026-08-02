import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCommandApprovalRequest } from '../../../../src/main/app-server/command-approval/protocol.ts';

test('host-inherited command environment policy is accepted', () => {
  const approvalId = 'approval/thread/turn/call';
  const request = parseCommandApprovalRequest(
    approvalId,
    {
      approvalId,
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      description: 'Check the installed Node version.',
      command: '/usr/bin/env',
      arguments: ['node', '--version'],
      cwd: '.',
      approvalScope: 'command',
      environmentPolicy: 'hostInheritedV1',
      sandboxed: true,
      sandboxPolicy: 'filesystemReadOnlyV1',
      networkPolicy: 'networkDeniedV1',
    },
    'darwin',
  );

  assert.equal(request?.environmentPolicy, 'hostInheritedV1');
});
