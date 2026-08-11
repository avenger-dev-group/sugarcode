import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isCommandApprovalStateSnapshot,
  resolveCommandApprovalMode,
  type CommandApprovalStateSnapshot,
} from '../../src/shared/command-approval.ts';

test('approval modes resolve only inside their granted scope', () => {
  const threadMode: CommandApprovalStateSnapshot = {
    revision: 1,
    status: 'idle',
    mode: 'thread',
    modeThreadId: 'thread-1',
  };
  assert.equal(
    resolveCommandApprovalMode(threadMode, 'thread-1', 'workspace-1'),
    'thread',
  );
  assert.equal(
    resolveCommandApprovalMode(threadMode, 'thread-2', 'workspace-1'),
    'ask',
  );

  const workspaceMode: CommandApprovalStateSnapshot = {
    revision: 2,
    status: 'idle',
    mode: 'workspace',
    modeWorkspaceId: 'workspace-1',
  };
  assert.equal(
    resolveCommandApprovalMode(workspaceMode, 'thread-2', 'workspace-1'),
    'workspace',
  );
  assert.equal(
    resolveCommandApprovalMode(workspaceMode, 'thread-2', 'workspace-2'),
    'ask',
  );
});

test('approval snapshots require the identifier for their active scope', () => {
  assert.equal(
    isCommandApprovalStateSnapshot({
      revision: 1,
      status: 'idle',
      mode: 'thread',
    }),
    false,
  );
  assert.equal(
    isCommandApprovalStateSnapshot({
      revision: 1,
      status: 'idle',
      mode: 'workspace',
      modeWorkspaceId: 'workspace-1',
    }),
    true,
  );
  assert.equal(
    isCommandApprovalStateSnapshot({
      revision: 1,
      status: 'idle',
      mode: 'ask',
      modeWorkspaceId: 'workspace-1',
    }),
    false,
  );
});
