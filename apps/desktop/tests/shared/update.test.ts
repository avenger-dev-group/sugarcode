import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isUpdateActionResult,
  isUpdateStateSnapshot,
} from '../../src/shared/update.ts';

test('accepts strict update state snapshots', () => {
  assert.equal(
    isUpdateStateSnapshot({ revision: 2, status: 'ready', version: '3.1.0' }),
    true,
  );
  assert.equal(
    isUpdateStateSnapshot({ revision: 2, status: 'ready' }),
    false,
  );
  assert.equal(
    isUpdateStateSnapshot({ revision: 2, status: 'fallback', version: '3.1.0' }),
    false,
  );
  assert.equal(
    isUpdateStateSnapshot({ revision: 3, status: 'upToDate' }),
    true,
  );
});

test('requires action acceptance to match its reason', () => {
  assert.equal(
    isUpdateActionResult({ accepted: true, reason: 'accepted' }),
    true,
  );
  assert.equal(
    isUpdateActionResult({ accepted: true, reason: 'busy' }),
    false,
  );
});
