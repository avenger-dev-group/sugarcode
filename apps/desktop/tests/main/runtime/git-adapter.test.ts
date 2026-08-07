import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeGitAdapter } from '../../../src/main/runtime/git-adapter.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type { RuntimeCommand, RuntimeEvent } from '../../../src/runtime/protocol.ts';

class FixtureRuntime {
  readonly requested: Exclude<RuntimeCommand, { type: 'initialize' }>[] = [];

  request = async (
    command: Exclude<RuntimeCommand, { type: 'initialize' }>,
  ): Promise<RuntimeEvent> => {
    this.requested.push(command);
    if (command.type !== 'git.status') {
      throw new Error('Unexpected fixture command.');
    }
    return {
      type: 'git.result',
      sequence: this.requested.length,
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      operation: 'status',
      result: { status: 'error', kind: 'notRepository' },
    };
  };
}

test('runtime Git adapter keeps a transaction bound to its starting Workspace', async () => {
  const runtime = new FixtureRuntime();
  const adapter = new RuntimeGitAdapter(runtime as unknown as RuntimeSupervisor);
  adapter.openWorkspace('workspace-a');
  const lease = adapter.beginGitTransaction();
  assert.notEqual(typeof lease, 'string');
  if (typeof lease === 'string') {
    return;
  }

  adapter.openWorkspace('workspace-b');
  await adapter.gitStatus();
  const transactionStatus = runtime.requested.at(-1);
  assert.equal(transactionStatus?.type, 'git.status');
  assert.equal(
    transactionStatus?.type === 'git.status' ? transactionStatus.workspaceId : null,
    'workspace-a',
  );

  lease.release();
  await adapter.gitStatus();
  const foregroundStatus = runtime.requested.at(-1);
  assert.equal(foregroundStatus?.type, 'git.status');
  assert.equal(
    foregroundStatus?.type === 'git.status' ? foregroundStatus.workspaceId : null,
    'workspace-b',
  );
});
