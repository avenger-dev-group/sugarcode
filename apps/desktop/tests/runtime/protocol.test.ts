import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRuntimeCommand,
  isRuntimeEvent,
} from '../../src/runtime/protocol.ts';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

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
