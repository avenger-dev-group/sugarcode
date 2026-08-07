import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRuntimeCommand,
  isRuntimeEvent,
} from '../../src/runtime/protocol.ts';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

test('private runtime v2 validates stable text Item lifecycle events', () => {
  const coordinates = {
    sequence: 1,
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    itemId: 'message-fixture',
  };
  assert.equal(isRuntimeEvent({
    ...coordinates,
    type: 'turn.textStarted',
    phase: 'provisional',
  }), true);
  assert.equal(isRuntimeEvent({
    ...coordinates,
    type: 'turn.textDelta',
    phase: 'provisional',
    delta: 'Working',
  }), true);
  assert.equal(isRuntimeEvent({
    ...coordinates,
    type: 'turn.textCompleted',
    phase: 'final',
    text: 'Done',
  }), true);
  assert.equal(isRuntimeEvent({
    ...coordinates,
    type: 'turn.textCompleted',
    phase: 'provisional',
    text: 'Not authoritative',
  }), false);
});

test('private runtime validates complete non-negative usage samples', () => {
  const coordinates = {
    type: 'turn.usage' as const,
    sequence: 1,
    requestId: 'request-usage',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
  };
  assert.equal(isRuntimeEvent({
    ...coordinates,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  }), true);
  assert.equal(isRuntimeEvent({
    ...coordinates,
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 1,
      cachedInputTokens: 4,
      totalTokens: 12,
    },
  }), true);
  const invalidUsages: unknown[] = [
    { inputTokens: 10, outputTokens: 2 },
    { inputTokens: 10, outputTokens: -1, totalTokens: 12 },
    { inputTokens: 10, outputTokens: 2, totalTokens: Number.NaN },
    {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      reasoningTokens: undefined,
    },
    { inputTokens: 10, outputTokens: 2, totalTokens: 12, provider: 'openai' },
  ];
  for (const usage of invalidUsages) {
    assert.equal(isRuntimeEvent({ ...coordinates, usage }), false);
  }
});

test('private Workspace protocol stays provider-neutral and bounds browser payloads', () => {
  assert.equal(isRuntimeCommand({
    type: 'workspace.list',
    requestId: 'request-list',
    workspaceId: 'workspace-fixture',
    path: 'src',
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'workspace.inspect',
    requestId: 'request-inspect',
    workspaceId: 'workspace-fixture',
    path: 'x'.repeat(1_025),
  }), false);
  assert.equal(isRuntimeEvent({
    type: 'workspace.listResult',
    sequence: 1,
    requestId: 'request-list',
    workspaceId: 'workspace-fixture',
    path: '',
    entries: [{ name: 'src', path: 'src', kind: 'directory' }],
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'workspace.inspected',
    sequence: 2,
    requestId: 'request-inspect',
    workspaceId: 'workspace-fixture',
    document: {
      status: 'error',
      path: 'fixture.txt',
      kind: 'providerSpecificFailure',
    },
  }), false);
});

test('private terminal protocol requires UUID sessions and UTF-8 byte bounds', () => {
  assert.equal(isRuntimeCommand({
    type: 'terminal.input',
    requestId: 'request-input',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    data: '中'.repeat(21_845),
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'terminal.input',
    requestId: 'request-input',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    data: '中'.repeat(21_846),
  }), false);
  assert.equal(isRuntimeCommand({
    type: 'terminal.terminate',
    requestId: 'request-terminate',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: 'not-a-session-id',
  }), false);

  assert.equal(isRuntimeEvent({
    type: 'terminal.output',
    sequence: 1,
    requestId: 'request-terminal',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    outputSequence: 1,
    data: '中'.repeat(10_922),
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'terminal.output',
    sequence: 1,
    requestId: 'request-terminal',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    outputSequence: 1,
    data: '中'.repeat(10_923),
  }), false);
  assert.equal(isRuntimeEvent({
    type: 'terminal.inputAccepted',
    sequence: 2,
    requestId: 'request-input',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: SESSION_ID,
    inputBytes: 65_536,
  }), true);
  assert.equal(isRuntimeEvent({
    type: 'operation.output',
    sequence: 3,
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    operationId: 'operation-fixture',
    stream: 'stdout',
    delta: '中'.repeat(10_923),
  }), false);
});

test('private MCP protocol keeps configuration and approval events provider-neutral', () => {
  assert.equal(isRuntimeCommand({
    type: 'mcp.configSave',
    requestId: 'request-config',
    request: {
      expectedRevision: '0'.repeat(64),
      servers: [{
        id: 'fixture',
        transport: 'loopbackStreamableHttp',
        endpoint: 'http://127.0.0.1:8788/mcp',
      }],
    },
  }), true);
  assert.equal(isRuntimeCommand({
    type: 'mcp.sessionSet',
    requestId: 'request-session',
    serverIds: ['fixture', 'fixture'],
  }), false);
  const recoveredApproval = {
    type: 'mcp.approvalRequested',
    sequence: 4,
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
    recovered: true,
  } as const;
  assert.equal(isRuntimeEvent(recoveredApproval), true);
  assert.equal(isRuntimeEvent({ ...recoveredApproval, recovered: false }), false);
});

test('private Agent task events carry a complete provider-neutral DAG snapshot', () => {
  const event = {
    type: 'agent.task',
    sequence: 5,
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    task: {
      orchestrationId: 'orch/thread-fixture/turn-fixture',
      taskId: 'task-fixture',
      clientTaskKey: 'implementation',
      childThreadId: SESSION_ID,
      title: 'Implement',
      role: 'worker',
      access: 'workspaceWrite',
      dependsOn: [] as string[],
      taskMarkdown: 'Implement the change.',
      status: 'waitingApproval',
      amendments: [{ id: 'amendment-fixture', markdown: 'Add tests.' }],
      progress: {
        stage: 'runningTool',
        summaryMarkdown: 'Running `workspace_apply_patch`.',
        updatedAt: 123,
      },
    },
  };
  assert.equal(isRuntimeEvent(event), true);
  assert.equal(
    isRuntimeEvent({
      ...event,
      task: { ...event.task, status: 'waiting' },
    }),
    false,
  );
});
