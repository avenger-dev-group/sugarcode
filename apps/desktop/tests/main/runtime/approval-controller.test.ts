import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeApprovalController } from '../../../src/main/runtime/approval-controller.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type { RuntimeCommand, RuntimeEvent } from '../../../src/runtime/protocol.ts';
import { isCommandApprovalStateSnapshot } from '../../../src/shared/command-approval.ts';

class FixtureRuntime {
  readonly sent: Exclude<RuntimeCommand, { type: 'initialize' }>[] = [];
  throwOnSend = false;
  private listener: ((event: RuntimeEvent) => void) | undefined;

  subscribe = (listener: (event: RuntimeEvent) => void): (() => void) => {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  };

  send = (command: Exclude<RuntimeCommand, { type: 'initialize' }>): void => {
    if (this.throwOnSend) {
      throw new Error('The TypeScript runtime has been shut down.');
    }
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
    fullAccess: false,
  });
  const pending = controller.getSnapshot();
  assert.equal(isCommandApprovalStateSnapshot(pending), true);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.request?.cwd, '/fixture/project');
  assert.equal(pending.request?.workspaceId, 'workspace-1');
  assert.equal(pending.request?.operationKind, 'workspacePatch');
  assert.equal(
    pending.request?.description,
    'Agent 请求修改以下项目文件。批准后，这批更改会原子应用。',
  );

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

test('thread Full Access automatically approves later operations only in that thread', async () => {
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
    approvalId: 'approval-full',
    operationId: 'operation-full',
    toolName: 'shell_exec',
    argumentsSummary: 'Full Access: touch fixture.txt',
    fullAccess: true,
  });

  const pending = controller.getSnapshot();
  assert.equal(fixture.sent.length, 0);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.request?.fullAccess, true);
  assert.equal(
    pending.request?.description,
    'Allow this command to run with Full Access?',
  );

  assert.equal((await controller.approve('approval-full', 'thread')).accepted, true);
  assert.equal(controller.getSnapshot().mode, 'thread');
  assert.equal(controller.getSnapshot().modeThreadId, 'thread-1');
  fixture.emit({
    type: 'approval.resolved',
    sequence: 2,
    requestId: 'resolve-first',
    workspaceId: 'workspace-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    approvalId: 'approval-full',
    operationId: 'operation-full',
    decision: 'approved',
  });

  fixture.emit({
    type: 'approval.requested',
    sequence: 3,
    requestId: 'request-later',
    workspaceId: 'workspace-1',
    threadId: 'thread-1',
    turnId: 'turn-2',
    approvalId: 'approval-later',
    operationId: 'operation-later',
    toolName: 'workspace_apply_patch',
    argumentsSummary: 'workspace_apply_patch (32 bytes)',
    fullAccess: false,
  });
  const automaticDecision = fixture.sent.at(-1);
  assert.equal(automaticDecision?.type, 'approval.resolve');
  if (automaticDecision?.type !== 'approval.resolve') {
    throw new Error('Automatic approval decision was not sent.');
  }
  assert.equal(automaticDecision.approvalId, 'approval-later');
  assert.equal(automaticDecision.decision, 'approved');
  assert.equal(automaticDecision.source, 'policy');

  fixture.emit({
    type: 'approval.resolved',
    sequence: 4,
    requestId: automaticDecision.requestId,
    workspaceId: 'workspace-1',
    threadId: 'thread-1',
    turnId: 'turn-2',
    approvalId: 'approval-later',
    operationId: 'operation-later',
    decision: 'approved',
  });
  const decisionCount = fixture.sent.length;
  fixture.emit({
    type: 'approval.requested',
    sequence: 5,
    requestId: 'request-other-thread',
    workspaceId: 'workspace-1',
    threadId: 'thread-2',
    turnId: 'turn-3',
    approvalId: 'approval-other-thread',
    operationId: 'operation-other-thread',
    toolName: 'shell_exec',
    argumentsSummary: 'Full Access: pnpm test',
    fullAccess: true,
  });
  assert.equal(fixture.sent.length, decisionCount);
  assert.equal(controller.getSnapshot().status, 'pending');

  assert.equal(controller.setMode('ask').accepted, true);
  assert.equal(controller.getSnapshot().mode, 'ask');
  assert.equal(controller.getSnapshot().modeWorkspaceId, undefined);
  assert.equal(controller.isAutoApproved('workspace-1', 'thread-2'), false);
});

test('workspace Full Access automatically approves every thread only in that workspace', () => {
  const fixture = new FixtureRuntime();
  const controller = new RuntimeApprovalController(
    fixture as unknown as RuntimeSupervisor,
  );
  controller.openWorkspace('workspace-1', '/fixture/project-one');
  controller.openWorkspace('workspace-2', '/fixture/project-two');
  controller.markSurfaceReady();

  assert.equal(controller.setMode('workspace').accepted, false);
  assert.equal(
    controller.setMode('workspace', undefined, 'workspace-1').accepted,
    true,
  );
  assert.equal(controller.getSnapshot().modeWorkspaceId, 'workspace-1');

  fixture.emit({
    type: 'approval.requested',
    sequence: 1,
    requestId: 'request-workspace-one',
    workspaceId: 'workspace-1',
    threadId: 'thread-2',
    turnId: 'turn-1',
    approvalId: 'approval-workspace-one',
    operationId: 'operation-workspace-one',
    toolName: 'shell_exec',
    argumentsSummary: 'Full Access: pnpm test',
    fullAccess: true,
  });
  const automaticDecision = fixture.sent.at(-1);
  assert.equal(automaticDecision?.type, 'approval.resolve');
  assert.equal(
    automaticDecision?.type === 'approval.resolve'
      ? automaticDecision.source
      : undefined,
    'policy',
  );
  fixture.emit({
    type: 'approval.resolved',
    sequence: 2,
    requestId: 'resolve-workspace-one',
    workspaceId: 'workspace-1',
    threadId: 'thread-2',
    turnId: 'turn-1',
    approvalId: 'approval-workspace-one',
    operationId: 'operation-workspace-one',
    decision: 'approved',
  });

  const decisionCount = fixture.sent.length;
  fixture.emit({
    type: 'approval.requested',
    sequence: 3,
    requestId: 'request-workspace-two',
    workspaceId: 'workspace-2',
    threadId: 'thread-3',
    turnId: 'turn-2',
    approvalId: 'approval-workspace-two',
    operationId: 'operation-workspace-two',
    toolName: 'workspace_apply_patch',
    argumentsSummary: 'workspace_apply_patch (32 bytes)',
    fullAccess: false,
  });
  assert.equal(fixture.sent.length, decisionCount);
  assert.equal(controller.getSnapshot().status, 'pending');
});

test('recovered runtime approval waits for the existing UI surface and deduplicates replay', () => {
  const fixture = new FixtureRuntime();
  const controller = new RuntimeApprovalController(
    fixture as unknown as RuntimeSupervisor,
  );
  const event: RuntimeEvent = {
    type: 'approval.requested',
    sequence: 1,
    requestId: 'request-recovered',
    workspaceId: 'workspace-recovered',
    threadId: 'thread-recovered',
    turnId: 'turn-recovered',
    approvalId: 'approval-recovered',
    operationId: 'operation-recovered',
    toolName: 'workspace_apply_patch',
    argumentsSummary: 'workspace_apply_patch (64 bytes)',
    fullAccess: false,
    recovered: true,
  };
  fixture.emit(event);
  fixture.emit({ ...event, sequence: 2 });
  assert.equal(fixture.sent.length, 0);
  assert.equal(controller.getSnapshot().request?.queueCount, 1);
  controller.openWorkspace('workspace-recovered', '/fixture/recovered');
  const pending = controller.markSurfaceReady();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.request?.cwd, '/fixture/recovered');
});

test('runtime approval timeout allows the operation and does not block shutdown cleanup', async () => {
  const fixture = new FixtureRuntime();
  const controller = new RuntimeApprovalController(
    fixture as unknown as RuntimeSupervisor,
    5,
  );
  controller.markSurfaceReady();
  fixture.emit({
    type: 'approval.requested',
    sequence: 1,
    requestId: 'request-timeout',
    workspaceId: 'workspace-timeout',
    threadId: 'thread-timeout',
    turnId: 'turn-timeout',
    approvalId: 'approval-timeout',
    operationId: 'operation-timeout',
    toolName: 'workspace_apply_patch',
    argumentsSummary: 'Update fixture.txt',
    fullAccess: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const automaticDecision = fixture.sent.at(-1);
  assert.equal(automaticDecision?.type, 'approval.resolve');
  if (automaticDecision?.type !== 'approval.resolve') {
    throw new Error('Timed-out approval was not resolved.');
  }
  assert.equal(automaticDecision.decision, 'approved');
  assert.equal(automaticDecision.source, 'system');
  assert.equal(
    controller.getSnapshot().request?.actionState,
    'localWindowElapsed',
  );

  const decisionsBeforeRecovery = fixture.sent.length;
  fixture.emit({
    type: 'approval.requested',
    sequence: 2,
    requestId: 'request-timeout-recovered',
    workspaceId: 'workspace-timeout',
    threadId: 'thread-timeout',
    turnId: 'turn-timeout',
    approvalId: 'approval-timeout',
    operationId: 'operation-timeout',
    toolName: 'workspace_apply_patch',
    argumentsSummary: 'Update fixture.txt',
    fullAccess: false,
    recovered: true,
  });
  assert.equal(fixture.sent.length, decisionsBeforeRecovery + 1);
  const replayedDecision = fixture.sent.at(-1);
  assert.equal(replayedDecision?.type, 'approval.resolve');
  assert.equal(
    replayedDecision?.type === 'approval.resolve'
      ? replayedDecision.decision
      : undefined,
    'approved',
  );

  fixture.emit({
    type: 'approval.requested',
    sequence: 3,
    requestId: 'request-shutdown',
    workspaceId: 'workspace-timeout',
    threadId: 'thread-timeout',
    turnId: 'turn-shutdown',
    approvalId: 'approval-shutdown',
    operationId: 'operation-shutdown',
    toolName: 'shell_exec',
    argumentsSummary: 'Full Access: pnpm test',
    fullAccess: true,
  });
  fixture.throwOnSend = true;
  assert.doesNotThrow(() => controller.surfaceUnavailable());
});
