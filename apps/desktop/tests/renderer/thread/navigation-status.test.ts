import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isThreadDeleteDisabled,
  resolveDisplayedThreadId,
  toThreadNavigationStatus,
} from '../../../src/renderer/components/thread/navigation-status.ts';

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

test('pending selection is displayed before its workspace becomes active', () => {
  assert.equal(
    resolveDisplayedThreadId({
      active: false,
      pendingThreadId: 'thread-b',
      selectedThreadId: 'thread-a',
      threadIds: ['thread-b'],
    }),
    'thread-b',
  );
  assert.equal(
    resolveDisplayedThreadId({
      active: false,
      pendingThreadId: 'thread-b',
      selectedThreadId: 'thread-a',
      threadIds: ['thread-a'],
    }),
    null,
  );
});

test('saved Thread deletion is blocked only by a real conflicting operation', () => {
  assert.equal(
    isThreadDeleteDisabled({
      workspaceBusy: false,
      lifecycleMutationPending: false,
      running: false,
    }),
    false,
  );
  assert.equal(
    isThreadDeleteDisabled({
      workspaceBusy: true,
      lifecycleMutationPending: false,
      running: false,
    }),
    true,
  );
  assert.equal(
    isThreadDeleteDisabled({
      workspaceBusy: false,
      lifecycleMutationPending: true,
      running: false,
    }),
    true,
  );
  assert.equal(
    isThreadDeleteDisabled({
      workspaceBusy: false,
      lifecycleMutationPending: false,
      running: true,
    }),
    true,
  );
});
