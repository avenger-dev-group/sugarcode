import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalController } from '../../../src/main/terminal/controller.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type {
  RuntimeCommand,
  RuntimeEvent,
} from '../../../src/runtime/protocol.ts';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

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

test('terminal controller preserves the renderer contract over the v3 runtime', async () => {
  const runtime = new FixtureRuntime();
  const controller = new TerminalController({
    runtime: runtime as unknown as RuntimeSupervisor,
    getWorkspace: () => ({
      generation: 7,
      workspaceId: 'workspace-runtime',
      path: '/fixture/project',
      name: 'project',
    }),
    isApprovalPending: () => false,
    createSessionId: () => SESSION_ID,
  });

  assert.deepEqual(await controller.create({ generation: 7, columns: 80, rows: 24 }), {
    accepted: true,
    reason: 'accepted',
  });
  const create = runtime.sent.at(-1);
  assert.equal(create?.type, 'terminal.create');

  runtime.emit({
    type: 'terminal.started',
    sequence: 1,
    requestId: create?.requestId ?? 'request-create',
    workspaceId: 'workspace-runtime',
    generation: 7,
    sessionId: SESSION_ID,
    shell: '/bin/zsh',
  });
  runtime.emit({
    type: 'terminal.output',
    sequence: 2,
    requestId: create?.requestId ?? 'request-create',
    workspaceId: 'workspace-runtime',
    generation: 7,
    sessionId: SESSION_ID,
    outputSequence: 1,
    data: 'fixture output\r\n',
  });

  const running = controller.getSnapshot({
    generation: 7,
    sessionId: SESSION_ID,
    acknowledgeThrough: 0,
  });
  assert.equal(running.status, 'running');
  assert.equal(running.shell, '/bin/zsh');
  assert.deepEqual(running.output, [{ sequence: 1, data: 'fixture output\r\n' }]);

  assert.equal(controller.input({
    generation: 7,
    sessionId: SESSION_ID,
    data: 'pwd\n',
  }).accepted, true);
  const input = runtime.sent.at(-1);
  assert.equal(input?.type, 'terminal.input');
  runtime.emit({
    type: 'terminal.inputAccepted',
    sequence: 3,
    requestId: input?.requestId ?? 'request-input',
    workspaceId: 'workspace-runtime',
    generation: 7,
    sessionId: SESSION_ID,
    inputBytes: 4,
  });
  const largeInput = 'x'.repeat(65_536);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(controller.input({
      generation: 7,
      sessionId: SESSION_ID,
      data: largeInput,
    }).accepted, true);
  }
  assert.equal(controller.input({
    generation: 7,
    sessionId: SESSION_ID,
    data: largeInput,
  }).reason, 'busy');
  assert.equal(controller.getSnapshot({
    generation: 7,
    sessionId: SESSION_ID,
    acknowledgeThrough: 0,
  }).status, 'paused');
  const largeCommands = runtime.sent.filter(
    (command) => command.type === 'terminal.input' && command.data === largeInput,
  );
  for (const [index, command] of largeCommands.slice(0, 2).entries()) {
    runtime.emit({
      type: 'terminal.inputAccepted',
      sequence: 4 + index,
      requestId: command.requestId,
      workspaceId: 'workspace-runtime',
      generation: 7,
      sessionId: SESSION_ID,
      inputBytes: 65_536,
    });
  }
  assert.equal(controller.getSnapshot({
    generation: 7,
    sessionId: SESSION_ID,
    acknowledgeThrough: 0,
  }).status, 'running');
  assert.equal(controller.resize({
    generation: 7,
    sessionId: SESSION_ID,
    columns: 120,
    rows: 40,
  }).accepted, true);
  assert.equal(runtime.sent.at(-1)?.type, 'terminal.resize');

  controller.pauseForApproval();
  assert.equal(controller.input({
    generation: 7,
    sessionId: SESSION_ID,
    data: 'blocked\n',
  }).reason, 'busy');
  controller.resumeAfterApproval();

  assert.equal(controller.terminate({
    generation: 7,
    sessionId: SESSION_ID,
  }).accepted, true);
  assert.equal(runtime.sent.at(-1)?.type, 'terminal.terminate');
  runtime.emit({
    type: 'terminal.exited',
    sequence: 6,
    requestId: create?.requestId ?? 'request-create',
    workspaceId: 'workspace-runtime',
    generation: 7,
    sessionId: SESSION_ID,
    exitCode: 0,
    reason: 'requested',
  });

  const exited = controller.getSnapshot({
    generation: 7,
    sessionId: SESSION_ID,
    acknowledgeThrough: 1,
  });
  assert.equal(exited.status, 'exited');
  if (exited.status === 'exited') {
    assert.equal(exited.reason, 'requested');
  }
  controller.shutdown();
});

test('terminal controller surfaces utility-process loss as the existing failure state', async () => {
  const runtime = new FixtureRuntime();
  const controller = new TerminalController({
    runtime: runtime as unknown as RuntimeSupervisor,
    getWorkspace: () => ({
      generation: 2,
      workspaceId: 'workspace-runtime',
      path: '/fixture',
      name: 'fixture',
    }),
    isApprovalPending: () => false,
    createSessionId: () => SESSION_ID,
  });

  await controller.create({ generation: 2, columns: 80, rows: 24 });
  runtime.emit({
    type: 'terminal.error',
    sequence: 1,
    requestId: 'request-create',
    workspaceId: 'workspace-runtime',
    generation: 2,
    sessionId: SESSION_ID,
    error: 'terminalCrashed',
    fatal: true,
  });

  assert.equal(controller.getFailureDiagnostic(), 'terminalCrashed');
  assert.equal(controller.getSnapshot({
    generation: 2,
    sessionId: SESSION_ID,
    acknowledgeThrough: 0,
  }).status, 'failed');
  assert.equal(runtime.sent.at(-1)?.type, 'terminal.close');
  controller.shutdown();
});

test('terminal controller rejects a launch when the foreground Workspace identity changes during validation', async () => {
  const runtime = new FixtureRuntime();
  let workspaceReadCount = 0;
  const controller = new TerminalController({
    runtime: runtime as unknown as RuntimeSupervisor,
    getWorkspace: () => {
      workspaceReadCount += 1;
      return workspaceReadCount === 1
        ? {
            generation: 4,
            workspaceId: 'workspace-a',
            path: '/fixture/a',
            name: 'a',
          }
        : {
            generation: 4,
            workspaceId: 'workspace-b',
            path: '/fixture/b',
            name: 'b',
          };
    },
    isApprovalPending: () => false,
    createSessionId: () => SESSION_ID,
  });

  assert.deepEqual(
    await controller.create({ generation: 4, columns: 80, rows: 24 }),
    { accepted: false, reason: 'stale' },
  );
  assert.deepEqual(runtime.sent, []);
  controller.shutdown();
});
