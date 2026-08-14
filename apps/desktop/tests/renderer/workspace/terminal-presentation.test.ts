import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldAutoStartTerminal,
  shouldPullTerminalSnapshot,
  terminalStatusLabel,
} from '../../../src/renderer/components/workspace/terminal/presentation.ts';

test('opening the terminal starts one shell attempt for the active Workspace', () => {
  const base = {
    busy: false,
    open: true,
    status: 'closed' as const,
    workspaceGeneration: 7,
    workspaceReady: true,
  };
  assert.equal(
    shouldAutoStartTerminal({ ...base, attemptedGeneration: null }),
    true,
  );
  assert.equal(
    shouldAutoStartTerminal({ ...base, attemptedGeneration: 7 }),
    false,
  );
  assert.equal(
    shouldAutoStartTerminal({ ...base, attemptedGeneration: 6 }),
    true,
  );
});

test('terminal autostart waits for an open panel and ready Workspace', () => {
  assert.equal(
    shouldAutoStartTerminal({
      attemptedGeneration: null,
      busy: false,
      open: false,
      status: 'closed',
      workspaceGeneration: 1,
      workspaceReady: true,
    }),
    false,
  );
  assert.equal(
    shouldAutoStartTerminal({
      attemptedGeneration: null,
      busy: false,
      open: true,
      status: 'closed',
      workspaceGeneration: 1,
      workspaceReady: false,
    }),
    false,
  );
});

test('hidden terminal output stays queued without renderer snapshot pulls', () => {
  assert.equal(shouldPullTerminalSnapshot({
    currentStatus: 'running',
    open: false,
    sessionChanged: false,
    signalStatus: 'running',
  }), false);
  assert.equal(shouldPullTerminalSnapshot({
    currentStatus: 'running',
    open: true,
    sessionChanged: false,
    signalStatus: 'running',
  }), true);
  assert.equal(shouldPullTerminalSnapshot({
    currentStatus: 'running',
    open: false,
    sessionChanged: false,
    signalStatus: 'paused',
  }), true);
});

test('terminal status labels stay concise and user-facing', () => {
  assert.equal(
    terminalStatusLabel({
      revision: 1,
      generation: 1,
      status: 'closed',
      acknowledgedThrough: 0,
      output: [],
    }),
    '未启动',
  );
  assert.equal(
    terminalStatusLabel({
      revision: 2,
      generation: 1,
      status: 'exited',
      sessionId: 'session',
      workspaceName: 'workspace',
      acknowledgedThrough: 0,
      output: [],
      exitCode: 0,
      reason: 'natural',
    }),
    '已退出 0',
  );
});
