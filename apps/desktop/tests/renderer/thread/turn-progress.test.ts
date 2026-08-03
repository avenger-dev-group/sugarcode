import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatWaitDuration,
  MODEL_WAIT_NOTICE_SECONDS,
  toActiveTurnProgress,
} from '../../../src/renderer/components/thread/turn-progress.ts';

test('quiet active turns become an explicit model wait without timing out', () => {
  const progress = toActiveTurnProgress(
    '00000000-0001-7000-8000-000000000001',
    'metis-coder',
    'inProgress',
    MODEL_WAIT_NOTICE_SECONDS,
  );

  assert.equal(progress.state, 'waitingForModel');
  assert.match(progress.label, /metis-coder/);
  assert.equal(progress.elapsedLabel, '已等待 15s');
  assert.match(progress.detail ?? '', /不会被自动超时/);
});

test('progress labels distinguish stopping and unavailable ownership', () => {
  assert.equal(
    toActiveTurnProgress('turn_1', undefined, 'stopping', 100).state,
    'stopping',
  );
  assert.equal(
    toActiveTurnProgress('turn_1', undefined, 'unavailable', 100).state,
    'uncertain',
  );
});

test('wait duration remains compact', () => {
  assert.equal(formatWaitDuration(12), '12s');
  assert.equal(formatWaitDuration(60), '1m');
  assert.equal(formatWaitDuration(125), '2m 5s');
});
