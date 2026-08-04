import assert from 'node:assert/strict';
import test from 'node:test';

import { isThreadTitle } from '../../../../src/main/app-server/conversation/thread-title.ts';

test('thread titles reject empty, oversized, and control-character values', () => {
  assert.equal(isThreadTitle('修复登录'), true);
  assert.equal(isThreadTitle(''), false);
  assert.equal(isThreadTitle('修复\u0000登录'), false);
  assert.equal(isThreadTitle('改'.repeat(86)), false);
});
