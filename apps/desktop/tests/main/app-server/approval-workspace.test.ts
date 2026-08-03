import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(`../../../src/${specifier.slice(2)}.ts`, import.meta.url)
          .href,
      };
    }
    if (
      specifier.startsWith('.') &&
      !specifier.split('/').at(-1)?.includes('.') &&
      context.parentURL
    ) {
      return {
        shortCircuit: true,
        url: new URL(`${specifier}.ts`, context.parentURL).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { CommandApprovalController } = await import(
  '../../../src/main/app-server/command-approval/controller.ts'
);
const { McpApprovalController } = await import(
  '../../../src/main/app-server/mcp/approval-controller.ts'
);
const { parseCommandApprovalCompletion } = await import(
  '../../../src/main/app-server/command-approval/protocol.ts'
);
const { parseMcpApprovalCompletion } = await import(
  '../../../src/main/app-server/mcp/protocol.ts'
);

const WORKSPACE_WEB = 'a'.repeat(64);
const WORKSPACE_ADMIN = 'b'.repeat(64);
const THREAD_WEB = '00000000-0000-7000-8000-000000000001';
const TURN_WEB = '00000000-0001-7000-8000-000000000001';

const commandParams = (workspaceId: string) => ({
  approvalId: 'approval-command',
  workspaceId,
  threadId: THREAD_WEB,
  turnId: TURN_WEB,
  callId: 'call-command',
  description: 'Inspect the workspace.',
  command: '/usr/bin/pwd',
  arguments: [] as string[],
  cwd: '.',
  approvalScope: 'command',
  environmentPolicy: 'hostInheritedV1',
  sandboxed: true,
  sandboxPolicy: 'filesystemReadOnlyV1',
  networkPolicy: 'networkDeniedV1',
});

test('a background command approval uses its event Workspace for source and scope', async () => {
  let describedWorkspace: string | null = null;
  const decisions: string[] = [];
  const controller = new CommandApprovalController({
    platform: 'darwin',
    createPresentationId: () => 'presentation-command',
    writeDecision: async (_requestId, decision) => {
      decisions.push(decision);
    },
    onProtocolFailure: () => assert.fail('unexpected protocol failure'),
    onWriteFailure: () => assert.fail('unexpected write failure'),
    onSurfaceFailure: () => assert.fail('unexpected surface failure'),
    getThreadWorkspaceId: () => WORKSPACE_WEB,
    describeSource: (_threadId, workspaceId) => {
      describedWorkspace = workspaceId;
      return {
        projectTitle: workspaceId === WORKSPACE_WEB ? 'Web' : 'Admin',
        conversationTitle: 'Web task',
      };
    },
  });
  controller.markSurfaceReady();

  controller.handleServerRequest({
    kind: 'request',
    id: 'approval-command',
    method: 'item/commandExecution/requestApproval',
    params: commandParams(WORKSPACE_WEB),
  });

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, 'pending');
  assert.equal(snapshot.request?.projectTitle, 'Web');
  assert.equal(describedWorkspace, WORKSPACE_WEB);
  assert.deepEqual(decisions, []);
  await controller.deny('presentation-command');
  controller.shutdown();
});

test('approval Workspace binding changes are denied before global recovery', async () => {
  const commandDecisions: string[] = [];
  const mcpDecisions: string[] = [];
  let protocolFailures = 0;
  const command = new CommandApprovalController({
    platform: 'darwin',
    writeDecision: async (_requestId, decision) => {
      commandDecisions.push(decision);
    },
    onProtocolFailure: () => {
      protocolFailures += 1;
    },
    onWriteFailure: () => assert.fail('unexpected command write failure'),
    onSurfaceFailure: () => assert.fail('unexpected command surface failure'),
    getThreadWorkspaceId: () => WORKSPACE_WEB,
  });
  const mcp = new McpApprovalController({
    getActiveServerIds: () => ['tools'],
    writeDecision: async (_requestId, decision) => {
      mcpDecisions.push(decision);
    },
    onProtocolFailure: () => {
      protocolFailures += 1;
    },
    onWriteFailure: () => assert.fail('unexpected MCP write failure'),
    onSurfaceFailure: () => assert.fail('unexpected MCP surface failure'),
    getThreadWorkspaceId: () => WORKSPACE_WEB,
  });

  command.handleServerRequest({
    kind: 'request',
    id: 'approval-command',
    method: 'item/commandExecution/requestApproval',
    params: commandParams(WORKSPACE_ADMIN),
  });
  mcp.handleServerRequest({
    kind: 'request',
    id: 'approval-mcp',
    method: 'item/mcpToolCall/requestApproval',
    params: {
      approvalId: 'approval-mcp',
      workspaceId: WORKSPACE_ADMIN,
      threadId: THREAD_WEB,
      turnId: TURN_WEB,
      callId: 'call-mcp',
      name: 'mcp__tools__inspect',
      arguments: {},
      argumentsBytes: 2,
      argumentsSha256: '0'.repeat(64),
      inventorySha256: '1'.repeat(64),
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(commandDecisions, ['denied']);
  assert.deepEqual(mcpDecisions, ['denied']);
  assert.equal(protocolFailures, 2);
  command.shutdown();
  mcp.shutdown();
});

test('approval completion notifications retain their routed Workspace', () => {
  const command = parseCommandApprovalCompletion({
    kind: 'notification',
    method: 'item/completed',
    params: {
      workspaceId: WORKSPACE_WEB,
      threadId: THREAD_WEB,
      turnId: TURN_WEB,
      item: {
        type: 'commandApprovalDecision',
        id: 'item-command-decision',
        approvalId: 'approval-command',
        decision: 'denied',
      },
    },
  });
  const mcp = parseMcpApprovalCompletion({
    kind: 'notification',
    method: 'item/completed',
    params: {
      workspaceId: WORKSPACE_WEB,
      threadId: THREAD_WEB,
      turnId: TURN_WEB,
      item: {
        type: 'mcpToolCallApprovalDecision',
        id: 'item-mcp-decision',
        approvalId: 'approval-mcp',
        decision: 'denied',
      },
    },
  });

  assert.equal(command?.workspaceId, WORKSPACE_WEB);
  assert.equal(mcp?.workspaceId, WORKSPACE_WEB);
});
