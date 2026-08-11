import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeMcpApprovalController } from '../../../src/main/runtime/mcp-approval-controller.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type { RuntimeCommand, RuntimeEvent } from '../../../src/runtime/protocol.ts';
import { isMcpApprovalStateSnapshot } from '../../../src/shared/mcp.ts';

test('runtime MCP approval keeps the existing UI contract and resolves by stable coordinates', async () => {
  const commands: RuntimeCommand[] = [];
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const runtime = {
    subscribe: (next: (event: RuntimeEvent) => void) => {
      listener = next;
      return (): void => undefined;
    },
    send: (command: RuntimeCommand) => commands.push(command),
  } as unknown as RuntimeSupervisor;
  const controller = new RuntimeMcpApprovalController(runtime);
  controller.openWorkspace('workspace-fixture', '/fixture/project');
  controller.markSurfaceReady();
  listener?.({
    type: 'mcp.approvalRequested',
    sequence: 1,
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: '019fd4ee-6482-7e10-943a-1ef2ea409dcc',
    turnId: '019fd4ee-6482-7e10-943a-1ef2ea409dce',
    approvalId: 'approval-fixture',
    operationId: 'operation-fixture',
    serverId: 'fixture',
    name: 'mcp__fixture__echo',
    argumentsJson: '{"value":"hello"}',
    argumentsBytes: 17,
    argumentsSha256: 'a'.repeat(64),
    inventorySha256: 'b'.repeat(64),
  });
  const pending = controller.getSnapshot();
  assert.equal(isMcpApprovalStateSnapshot(pending), true);
  assert.equal(pending.request?.projectTitle, 'project');
  assert.equal(pending.request?.queueCount, 1);

  assert.deepEqual(await controller.approve('approval-fixture'), {
    accepted: true,
    reason: 'accepted',
  });
  assert.equal(commands[0]?.type, 'approval.resolve');
  listener?.({
    type: 'mcp.approvalResolved',
    sequence: 2,
    requestId: 'request-approval',
    workspaceId: 'workspace-fixture',
    threadId: '019fd4ee-6482-7e10-943a-1ef2ea409dcc',
    turnId: '019fd4ee-6482-7e10-943a-1ef2ea409dce',
    approvalId: 'approval-fixture',
    operationId: 'operation-fixture',
    decision: 'approved',
  });
  assert.equal(controller.getSnapshot().status, 'idle');
});

test('recovered MCP approval remains pending until the UI surface is ready', async () => {
  const commands: RuntimeCommand[] = [];
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const runtime = {
    subscribe: (next: (event: RuntimeEvent) => void) => {
      listener = next;
      return (): void => undefined;
    },
    send: (command: RuntimeCommand) => commands.push(command),
  } as unknown as RuntimeSupervisor;
  const controller = new RuntimeMcpApprovalController(runtime);
  const event: RuntimeEvent = {
    type: 'mcp.approvalRequested',
    sequence: 1,
    requestId: 'request-recovered',
    workspaceId: 'workspace-recovered',
    threadId: 'thread-recovered',
    turnId: 'turn-recovered',
    approvalId: 'approval-recovered',
    operationId: 'operation-recovered',
    serverId: 'fixture',
    name: 'mcp__fixture__echo',
    argumentsJson: '{}',
    argumentsBytes: 2,
    argumentsSha256: 'a'.repeat(64),
    inventorySha256: 'b'.repeat(64),
    recovered: true,
  };
  listener?.(event);
  listener?.({ ...event, sequence: 2 });
  assert.equal(commands.length, 0);
  assert.equal(controller.getSnapshot().request?.queueCount, 1);
  controller.openWorkspace('workspace-recovered', '/fixture/recovered');
  assert.equal(controller.markSurfaceReady().request?.projectTitle, 'recovered');
  assert.equal((await controller.deny('approval-recovered')).accepted, true);
  listener?.({
    type: 'mcp.approvalResolved',
    sequence: 3,
    requestId: 'request-recovered-decision',
    workspaceId: 'workspace-recovered',
    threadId: 'thread-recovered',
    turnId: 'turn-recovered',
    approvalId: 'approval-recovered',
    operationId: 'operation-recovered',
    decision: 'denied',
  });
});

test('MCP approval follows the shared thread and workspace Full Access policy', () => {
  const commands: RuntimeCommand[] = [];
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const runtime = {
    subscribe: (next: (event: RuntimeEvent) => void) => {
      listener = next;
      return (): void => undefined;
    },
    send: (command: RuntimeCommand) => commands.push(command),
  } as unknown as RuntimeSupervisor;
  const controller = new RuntimeMcpApprovalController(
    runtime,
    (workspaceId, threadId) =>
      workspaceId === 'workspace-trusted' && threadId === 'thread-trusted',
  );

  listener?.({
    type: 'mcp.approvalRequested',
    sequence: 1,
    requestId: 'request-trusted',
    workspaceId: 'workspace-trusted',
    threadId: 'thread-trusted',
    turnId: 'turn-trusted',
    approvalId: 'approval-trusted',
    operationId: 'operation-trusted',
    serverId: 'fixture',
    name: 'mcp__fixture__echo',
    argumentsJson: '{}',
    argumentsBytes: 2,
    argumentsSha256: 'a'.repeat(64),
    inventorySha256: 'b'.repeat(64),
  });
  const automaticDecision = commands.at(-1);
  assert.equal(automaticDecision?.type, 'approval.resolve');
  if (automaticDecision?.type !== 'approval.resolve') {
    throw new Error('Automatic MCP approval decision was not sent.');
  }
  assert.equal(automaticDecision.approvalId, 'approval-trusted');
  assert.equal(automaticDecision.decision, 'approved');

  listener?.({
    type: 'mcp.approvalResolved',
    sequence: 2,
    requestId: automaticDecision.requestId,
    workspaceId: 'workspace-trusted',
    threadId: 'thread-trusted',
    turnId: 'turn-trusted',
    approvalId: 'approval-trusted',
    operationId: 'operation-trusted',
    decision: 'approved',
  });
  const decisionCount = commands.length;
  controller.markSurfaceReady();
  listener?.({
    type: 'mcp.approvalRequested',
    sequence: 3,
    requestId: 'request-untrusted',
    workspaceId: 'workspace-other',
    threadId: 'thread-trusted',
    turnId: 'turn-other',
    approvalId: 'approval-untrusted',
    operationId: 'operation-untrusted',
    serverId: 'fixture',
    name: 'mcp__fixture__echo',
    argumentsJson: '{}',
    argumentsBytes: 2,
    argumentsSha256: 'a'.repeat(64),
    inventorySha256: 'b'.repeat(64),
  });
  assert.equal(commands.length, decisionCount);
  assert.equal(controller.getSnapshot().status, 'pending');
  controller.surfaceUnavailable();
});

test('MCP approval timeout allows the call by default', async () => {
  const commands: RuntimeCommand[] = [];
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const runtime = {
    subscribe: (next: (event: RuntimeEvent) => void) => {
      listener = next;
      return (): void => undefined;
    },
    send: (command: RuntimeCommand) => commands.push(command),
  } as unknown as RuntimeSupervisor;
  const controller = new RuntimeMcpApprovalController(
    runtime,
    () => false,
    5,
  );
  controller.markSurfaceReady();
  listener?.({
    type: 'mcp.approvalRequested',
    sequence: 1,
    requestId: 'request-timeout',
    workspaceId: 'workspace-timeout',
    threadId: 'thread-timeout',
    turnId: 'turn-timeout',
    approvalId: 'approval-timeout',
    operationId: 'operation-timeout',
    serverId: 'fixture',
    name: 'mcp__fixture__echo',
    argumentsJson: '{}',
    argumentsBytes: 2,
    argumentsSha256: 'a'.repeat(64),
    inventorySha256: 'b'.repeat(64),
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const automaticDecision = commands.at(-1);
  assert.equal(automaticDecision?.type, 'approval.resolve');
  if (automaticDecision?.type !== 'approval.resolve') {
    throw new Error('Timed-out MCP approval was not resolved.');
  }
  assert.equal(automaticDecision.decision, 'approved');
  assert.equal(automaticDecision.source, 'system');
});
