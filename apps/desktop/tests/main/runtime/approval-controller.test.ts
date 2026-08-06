import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeApprovalController } from '../../../src/main/runtime/approval-controller.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type { RuntimeCommand, RuntimeEvent } from '../../../src/runtime/protocol.ts';
import { isCommandApprovalStateSnapshot } from '../../../src/shared/command-approval.ts';

class FixtureRuntime {
  readonly sent: Exclude<RuntimeCommand, { type: 'initialize' }>[] = [];
  private listener: ((event: RuntimeEvent) => void) | undefined;

  subscribe = (listener: (event: RuntimeEvent) => void): (() => void) => {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  };

  send = (command: Exclude<RuntimeCommand, { type: 'initialize' }>): void => {
    this.sent.push(command);
  };

  emit(event: RuntimeEvent): void {
    this.listener?.(event);
  }
}

test('runtime approvals preserve the existing approval UI contract', async () => {
  const fixture = new FixtureRuntime();
  const controller = new RuntimeApprovalController(
    fixture as unknown as RuntimeSupervisor,
  );
  controller.openWorkspace('workspace-1', '/fixture/project');
  controller.markSurfaceReady();
  fixture.emit({
    type: 'approval.requested',
    sequence: 1,
    requestId: 'request-turn',
    workspaceId: 'workspace-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    approvalId: 'approval-1',
    operationId: 'operation-1',
    toolName: 'workspace_apply_patch',
    argumentsSummary: 'workspace_apply_patch (128 bytes)',
  });
  const pending = controller.getSnapshot();
  assert.equal(isCommandApprovalStateSnapshot(pending), true);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.request?.cwd, '/fixture/project');

  assert.equal((await controller.approve('approval-1', 'thread')).accepted, true);
  const decision = fixture.sent.at(-1);
  assert.equal(decision?.type, 'approval.resolve');
  if (decision?.type !== 'approval.resolve') {
    throw new Error('Approval decision was not sent.');
  }
  assert.equal(decision.decision, 'approved');
  fixture.emit({
    type: 'approval.resolved',
    sequence: 2,
    requestId: decision.requestId,
    workspaceId: decision.workspaceId,
    threadId: decision.threadId,
    turnId: decision.turnId,
    approvalId: decision.approvalId,
    operationId: 'operation-1',
    decision: 'approved',
  });
  const idle = controller.getSnapshot();
  assert.equal(isCommandApprovalStateSnapshot(idle), true);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.modeThreadId, 'thread-1');
});
