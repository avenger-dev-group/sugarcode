import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { RuntimeSupervisor } from '../../src/main/runtime/supervisor.ts';
import type {
  RuntimeCommand,
  RuntimeEvent,
} from '../../src/runtime/protocol.ts';

class FixtureChild extends EventEmitter {
  readonly messages: RuntimeCommand[] = [];
  readonly stderr = new PassThrough();
  killed = false;

  postMessage(message: RuntimeCommand): void {
    this.messages.push(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test('RuntimeSupervisor queues until ready and interrupts active Turns on crash', async () => {
  const children: FixtureChild[] = [];
  const events: RuntimeEvent[] = [];
  const supervisor = new RuntimeSupervisor({
    runtimePath: '/fixture/runtime.js',
    dataDirectory: '/fixture/.sugarcode/v3',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
    spawn: () => {
      const child = new FixtureChild();
      children.push(child);
      return child as never;
    },
  });
  supervisor.subscribe((event) => events.push(event));
  supervisor.start();
  supervisor.send({
    type: 'workspace.open',
    requestId: 'request-workspace',
    workspaceId: 'workspace-fixture',
    canonicalRoot: '/fixture/workspace',
  });
  supervisor.send({
    type: 'turn.start',
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Hello' }],
  });
  supervisor.send({
    type: 'terminal.create',
    requestId: 'request-terminal',
    workspaceId: 'workspace-fixture',
    generation: 1,
    sessionId: '44444444-4444-4444-8444-444444444444',
    columns: 80,
    rows: 24,
  });

  const first = children[0];
  first.emit('spawn');
  assert.equal(first.messages[0]?.type, 'initialize');
  assert.equal(
    first.messages[0]?.type === 'initialize'
      ? first.messages[0].nativeModulePath
      : undefined,
    '/fixture/sugarcode-desktop-native.node',
  );
  assert.equal(first.messages.length, 1);
  first.emit('message', {
    type: 'runtime.ready',
    sequence: 1,
    requestId: first.messages[0]?.requestId,
    protocolVersion: 1,
  });
  assert.equal(first.messages[1]?.type, 'workspace.open');
  assert.equal(first.messages[2]?.type, 'turn.start');
  assert.equal(first.messages[3]?.type, 'terminal.create');
  first.emit('exit', 17);

  assert.deepEqual(
    events.map((event) => event.type),
    ['runtime.ready', 'turn.completed', 'terminal.error'],
  );
  const interrupted = events[1];
  assert.equal(interrupted?.type, 'turn.completed');
  if (interrupted?.type === 'turn.completed') {
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.error?.retryable, true);
  }
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3],
  );
  const terminalFailure = events[2];
  assert.equal(terminalFailure?.type, 'terminal.error');
  if (terminalFailure?.type === 'terminal.error') {
    assert.equal(terminalFailure.error, 'bridgeCrashed');
    assert.equal(terminalFailure.fatal, true);
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(children.length, 2);
  const second = children[1];
  second?.emit('spawn');
  second?.emit('message', {
    type: 'runtime.ready',
    sequence: 1,
    requestId: second.messages[0]?.requestId,
    protocolVersion: 1,
  });
  assert.equal(second?.messages[1]?.type, 'workspace.open');
  supervisor.shutdown('request-shutdown');
  assert.equal(children[1]?.killed, true);
});

test('RuntimeSupervisor correlates provider-neutral request responses', async () => {
  const child = new FixtureChild();
  const supervisor = new RuntimeSupervisor({
    runtimePath: '/fixture/runtime.js',
    dataDirectory: '/fixture/.sugarcode/v3',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
    spawn: () => child as never,
  });
  supervisor.start();
  child.emit('spawn');
  child.emit('message', {
    type: 'runtime.ready',
    sequence: 1,
    requestId: child.messages[0]?.requestId,
    protocolVersion: 1,
  });
  const response = supervisor.request(
    { type: 'model.inspect', requestId: 'request-model-inspect' },
    'model.configInspection',
  );
  assert.equal(child.messages[1]?.type, 'model.inspect');
  child.emit('message', {
    type: 'model.configInspection',
    sequence: 2,
    requestId: 'request-model-inspect',
    inspection: {
      contractVersion: 1,
      revision: '0'.repeat(64),
      config: null,
      credentialStatuses: [],
    },
  });
  assert.equal((await response).inspection.config, null);
  supervisor.shutdown();
});
