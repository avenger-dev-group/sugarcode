import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import type { RuntimeConnectionController } from '../../../src/main/runtime/connection-controller.ts';
import type { RuntimeConversationController } from '../../../src/main/runtime/conversation-controller.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type { ConversationStateSnapshot } from '../../../src/shared/conversation.ts';
import type { RuntimeCommand, RuntimeEvent } from '../../../src/runtime/protocol.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const { ThreadRegistry } = await import(
  '../../../src/main/navigation/thread-registry.ts'
);
const { RuntimeWorkspaceAdapter } = await import(
  '../../../src/main/runtime/workspace-adapter.ts'
);

const THREAD_ID = '019fd4ee-6482-7e10-943a-1ef2ea409dcc';

class FixtureRuntime {
  readonly commands: Exclude<RuntimeCommand, { type: 'initialize' | 'shutdown' }>[] = [];
  deleteResult = true;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  subscribe = (listener: (event: RuntimeEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  request = async (
    command: Exclude<RuntimeCommand, { type: 'initialize' | 'shutdown' }>,
  ): Promise<RuntimeEvent> => {
    this.commands.push(command);
    const event: RuntimeEvent = command.type === 'workspace.open'
      ? {
          type: 'workspace.opened',
          sequence: 1,
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          canonicalRoot: command.canonicalRoot,
        }
      : command.type === 'workspace.list'
        ? {
            type: 'workspace.listResult',
            sequence: 2,
            requestId: command.requestId,
            workspaceId: command.workspaceId,
            path: command.path,
            entries: [{ name: 'src', path: 'src', kind: 'directory' }],
          }
        : command.type === 'workspace.inspect'
          ? {
              type: 'workspace.inspected',
              sequence: 3,
              requestId: command.requestId,
              workspaceId: command.workspaceId,
              document: {
                status: 'complete',
                path: command.path,
                content: 'fixture',
                bytes: 7,
                lines: 1,
                hasUtf8Bom: false,
              },
            }
          : command.type === 'thread.delete'
            ? {
                type: 'thread.mutated',
                sequence: 4,
                requestId: command.requestId,
                workspaceId: command.workspaceId,
                operation: 'delete',
                threadId: command.threadId,
                deleted: this.deleteResult,
              }
            : (() => {
                throw new Error(`Unexpected command ${command.type}.`);
              })();
    this.emit(event);
    return event;
  };

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FixtureConversation {
  readonly switched: string[] = [];
  readonly selected: string[] = [];
  private readonly listeners = new Set<(snapshot: ConversationStateSnapshot) => void>();

  subscribe = (
    listener: (snapshot: ConversationStateSnapshot) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  switchWorkspace = async (workspaceId: string): Promise<boolean> => {
    this.switched.push(workspaceId);
    const snapshot: ConversationStateSnapshot = {
      revision: this.switched.length,
      workspaceId,
      phase: 'idle',
      turns: [],
      navigator: {
        status: 'ready',
        activeThreadIds: [THREAD_ID],
        activeThreadTitles: { [THREAD_ID]: 'Runtime task' },
        activeTruncated: false,
        runningThreadIds: [],
        search: {
          query: '',
          status: 'idle',
          threadIds: [],
          threadTitles: {},
          truncated: false,
        },
      },
    };
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return true;
  };

  selectThread = async (threadId: unknown) => {
    this.selected.push(String(threadId));
    return { accepted: true, reason: 'accepted' as const };
  };

  deleteThread = async () => ({
    accepted: false,
    reason: 'unknownThread' as const,
  });
}

test('RuntimeWorkspaceAdapter binds, browses, restores, and routes inactive deletion through utility runtime', async () => {
  const runtime = new FixtureRuntime();
  const conversation = new FixtureConversation();
  const registry = new ThreadRegistry();
  const opened: Array<readonly [string, string]> = [];
  const connection = {
    subscribe: (): (() => void) => () => undefined,
  } as unknown as RuntimeConnectionController;
  const adapter = new RuntimeWorkspaceAdapter({
    runtime: runtime as unknown as RuntimeSupervisor,
    connection,
    conversation: conversation as unknown as RuntimeConversationController,
    threadRegistry: registry,
    getWorkspaceSwitchBlock: () => null,
    onWorkspaceOpened: (workspaceId, root) => opened.push([workspaceId, root]),
  });

  assert.equal(
    await adapter.switchWorkspace('/fixture/project', 'project', THREAD_ID),
    true,
  );
  const workspaceId = adapter.getWorkspaceBindingId();
  assert.ok(workspaceId);
  registry.registerWorkspaceOwner(workspaceId, 'project:fixture', 'runtime');
  assert.deepEqual(registry.getOwnerView('project:fixture'), {
    threadIds: [THREAD_ID],
    threadTitles: { [THREAD_ID]: 'Runtime task' },
  });
  assert.deepEqual(conversation.selected, [THREAD_ID]);
  assert.deepEqual(await adapter.listWorkspace(''), {
    path: '',
    entries: [{ name: 'src', path: 'src', kind: 'directory' }],
  });
  assert.equal((await adapter.inspectWorkspace('README.md')).status, 'complete');
  assert.equal(
    await adapter.deleteThread('inactive-workspace', THREAD_ID),
    'deleted',
  );
  runtime.deleteResult = false;
  assert.equal(
    await adapter.deleteThread('inactive-workspace', THREAD_ID),
    'missing',
  );

  runtime.emit({
    type: 'workspace.opened',
    sequence: 9,
    requestId: 'restart-replay',
    workspaceId,
    canonicalRoot: '/fixture/project',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(conversation.switched.length, 2);
  assert.deepEqual(opened, [
    [workspaceId, '/fixture/project'],
    [workspaceId, '/fixture/project'],
  ]);
});
