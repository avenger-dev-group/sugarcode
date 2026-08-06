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
