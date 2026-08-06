import assert from 'node:assert/strict';
import test from 'node:test';

import { toThreadNavigationStatus } from '../../../src/renderer/components/thread/navigation-status.ts';

const status = (
  overrides: Partial<Parameters<typeof toThreadNavigationStatus>[0]> = {},
) =>
  toThreadNavigationStatus({
    approvalRequired: false,
    pending: false,
    running: false,
    ...overrides,
  });

test('navigation status distinguishes running and completed background tasks', () => {
  assert.equal(status({ running: true }), 'running');
  assert.equal(status({ terminalStatus: 'completed' }), 'completed');
  assert.equal(status({ terminalStatus: 'failed' }), 'failed');
  assert.equal(status({ terminalStatus: 'interrupted' }), 'interrupted');
  assert.equal(status(), 'idle');
});

test('approval takes precedence over running and completed state', () => {
  assert.equal(
    status({
      approvalRequired: true,
      running: true,
      terminalStatus: 'completed',
    }),
    'approvalRequired',
  );
});

test('opening takes precedence over a projected running state', () => {
  assert.equal(status({ pending: true, running: true }), 'opening');
});
