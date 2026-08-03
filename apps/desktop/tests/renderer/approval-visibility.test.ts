import assert from 'node:assert/strict';
import test from 'node:test';

import { isApprovalVisibleForThread } from '../../src/renderer/utils/approval-visibility.ts';

test('approval surfaces open only for their active Thread', () => {
  assert.equal(isApprovalVisibleForThread('thr_web', 'thr_web'), true);
  assert.equal(isApprovalVisibleForThread('thr_web', 'thr_admin'), false);
  assert.equal(isApprovalVisibleForThread('thr_web', null), false);
  assert.equal(isApprovalVisibleForThread(undefined, 'thr_web'), false);
});
