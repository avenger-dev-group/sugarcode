import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCommandApprovalModeScope,
  evaluateAutomaticCommandApproval,
} from '../../../../src/main/app-server/command-approval/mode-policy.ts';

test('ask mode never auto-approves', () => {
  const scope = createCommandApprovalModeScope('ask');
  const result = evaluateAutomaticCommandApproval(scope, 'thread-a');

  assert.equal(result.approveAutomatically, false);
  assert.deepEqual(result.scope, scope);
});

test('a pre-thread selection binds to the first requesting thread', () => {
  const pending = createCommandApprovalModeScope('thread');
  const first = evaluateAutomaticCommandApproval(pending, 'thread-a');

  assert.equal(first.approveAutomatically, true);
  assert.deepEqual(first.scope, {
    mode: 'thread',
    threadId: 'thread-a',
    bindNextThread: false,
  });
});

test('thread mode cannot cross into another thread', () => {
  const scoped = createCommandApprovalModeScope('thread', 'thread-a');
  const same = evaluateAutomaticCommandApproval(scoped, 'thread-a');
  const other = evaluateAutomaticCommandApproval(scoped, 'thread-b');

  assert.equal(same.approveAutomatically, true);
  assert.equal(other.approveAutomatically, false);
  assert.deepEqual(other.scope, createCommandApprovalModeScope('ask'));
});

test('workspace mode follows the request workspace rather than the selected project', () => {
  const scoped = createCommandApprovalModeScope(
    'workspace',
    'thread-a',
    'workspace-a',
  );

  assert.equal(
    evaluateAutomaticCommandApproval(scoped, 'thread-a', 'workspace-a')
      .approveAutomatically,
    true,
  );
  assert.equal(
    evaluateAutomaticCommandApproval(scoped, 'thread-b', 'workspace-a')
      .approveAutomatically,
    true,
  );
  assert.equal(
    evaluateAutomaticCommandApproval(scoped, 'thread-c', 'workspace-b')
      .approveAutomatically,
    false,
  );
});
