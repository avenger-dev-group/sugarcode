import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processActivityLabel,
  shouldAutoExpandActivityGroup,
} from '../../../src/renderer/components/thread/activity-disclosure.ts';

test('activity groups label every terminal Turn state', () => {
  assert.equal(processActivityLabel('completed', false), 'Processed');
  assert.equal(processActivityLabel('interrupted', false), 'Process stopped');
  assert.equal(processActivityLabel('failed', false), 'Process failed');
});

test('active and attention-required activity groups start expanded', () => {
  assert.equal(shouldAutoExpandActivityGroup('inProgress', false), true);
  assert.equal(shouldAutoExpandActivityGroup('completed', true), true);
  assert.equal(shouldAutoExpandActivityGroup('completed', false), false);
});

test('attention label takes precedence over the Turn state', () => {
  assert.equal(processActivityLabel('inProgress', true), 'Action required');
  assert.equal(processActivityLabel('failed', true), 'Action required');
});
