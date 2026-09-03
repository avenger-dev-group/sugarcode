import assert from 'node:assert/strict';
import test from 'node:test';

import {
  toolFailureRecoveryKey,
  toolResultFailed,
  toolResultRequiresFinalRecovery,
} from '../../src/runtime/tools/result.ts';

test('workspace instruction discovery is recoverable but unavailable rules are failures', () => {
  assert.equal(toolResultFailed({
    ok: false,
    error: 'workspaceInstructionsRequired',
  }), false);
  assert.equal(toolResultRequiresFinalRecovery('workspace_apply_patch', {
    ok: false,
    error: 'workspaceInstructionsRequired',
  }), false);
  assert.equal(toolResultFailed({
    ok: false,
    error: 'workspaceInstructionsUnavailable',
  }), true);
  assert.equal(toolResultRequiresFinalRecovery('workspace_apply_patch', {
    ok: false,
    error: 'workspaceInstructionsUnavailable',
  }), true);
});

test('tool result failure classification includes nested process outcomes', () => {
  assert.equal(
    toolResultFailed({
      status: 'completed',
      output: { outcome: { type: 'exitCode', code: 1 } },
    }),
    true,
  );
  assert.equal(
    toolResultFailed({
      status: 'completed',
      output: { outcome: { type: 'exitCode', code: 0 } },
    }),
    false,
  );
  assert.equal(
    toolResultFailed({
      status: 'completed',
      output: { outcome: { type: 'signal', signal: 9 } },
    }),
    true,
  );
  assert.equal(
    toolResultFailed({
      status: 'completed',
      output: { outcome: { type: 'timedOut' } },
    }),
    true,
  );
});

test('tool result failure classification preserves direct tool results', () => {
  assert.equal(toolResultFailed({ ok: false, error: 'notFound' }), true);
  assert.equal(toolResultFailed({ ok: true, content: 'fixture' }), false);
});

test('a missing workspace_read path is evidence rather than a final-recovery failure', () => {
  const partialRead = {
    ok: false,
    files: [
      { ok: true, path: 'README.md', content: '# Fixture' },
      { ok: false, path: '.dockerignore', error: 'notFound' },
      { ok: true, path: '.gitignore', content: 'dist' },
    ],
  };

  assert.equal(toolResultFailed(partialRead), true);
  assert.equal(
    toolResultRequiresFinalRecovery('workspace_read', partialRead),
    false,
  );
  assert.equal(
    toolResultRequiresFinalRecovery('workspace_read', {
      ok: false,
      files: [{ ok: false, path: '../secret', error: 'outsideWorkspace' }],
    }),
    true,
  );
  assert.equal(
    toolResultRequiresFinalRecovery('workspace_apply_patch', {
      ok: false,
      error: 'notFound',
    }),
    true,
  );
});

test('read-only shell discovery and workspace inspection share one recovery key', () => {
  assert.equal(
    toolFailureRecoveryKey('shell_exec', {
      mode: 'sandboxed',
      command: '/usr/bin/find',
      arguments: ['-name', 'AGENTS.md'],
    }),
    'workspaceInspection',
  );
  assert.equal(
    toolFailureRecoveryKey('workspace_list', { path: '.' }),
    'workspaceInspection',
  );
  assert.equal(
    toolFailureRecoveryKey('workspace_read', { path: 'AGENTS.md' }),
    'workspaceInspection',
  );
  assert.equal(
    toolFailureRecoveryKey('shell_exec', {
      mode: 'sandboxed',
      command: '/usr/bin/php',
      arguments: ['artisan', 'test'],
    }),
    'shell_exec',
  );
  assert.equal(
    toolFailureRecoveryKey('workspace_apply_patch', { patch: 'fixture' }),
    'workspace_apply_patch',
  );
});
