import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeConversationController } from '../../../src/main/runtime/conversation-controller.ts';
import { createUuidV7 } from '../../../src/main/runtime/id.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type { RuntimeCommand, RuntimeEvent } from '../../../src/runtime/protocol.ts';
import { isConversationStateSnapshot } from '../../../src/shared/conversation.ts';

const WORKSPACE_ID = 'workspace-runtime';
const THREAD_ID = '0198f140-0000-7000-8000-000000000001';

class FixtureRuntime {
  readonly sent: Exclude<RuntimeCommand, { type: 'initialize' }>[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  subscribe = (listener: (event: RuntimeEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  send = (command: Exclude<RuntimeCommand, { type: 'initialize' }>): void => {
    this.sent.push(command);
  };

  request = async (command: Exclude<RuntimeCommand, { type: 'initialize' | 'shutdown' }>) => {
    this.sent.push(command);
    if (command.type === 'thread.list') {
      return {
        type: 'thread.listResult',
        requestId: command.requestId,
        sequence: 1,
        workspaceId: command.workspaceId,
        query: command.query ?? '',
        threads: [],
      } as RuntimeEvent;
    }
    if (command.type === 'thread.create') {
      return {
        type: 'thread.mutated',
        requestId: command.requestId,
        sequence: 2,
        workspaceId: command.workspaceId,
        operation: 'create',
        threadId: THREAD_ID,
        snapshot: {
          thread: {
            id: THREAD_ID,
            workspaceId: command.workspaceId,
            title: command.title ?? null,
            createdAt: 1,
            updatedAt: 1,
            archivedAt: null,
            parentThreadId: null,
          },
          turns: [],
          items: [],
        },
      } as RuntimeEvent;
    }
    if (command.type === 'asset.import') {
      const sha256 = 'a'.repeat(64);
      return {
        type: 'asset.imported',
        requestId: command.requestId,
        sequence: 2,
        asset: {
          assetId: `ast_${sha256}`,
          sha256,
          mediaType: 'text/plain',
          originalName: command.fileName,
          sizeBytes: 7,
          kind: 'text',
        },
      } as RuntimeEvent;
    }
    throw new Error(`Unexpected fixture request ${command.type}.`);
  };

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

test('UUIDv7 generator creates canonical time-ordered identifiers', () => {
  const id = createUuidV7(1_754_000_000_000, new Uint8Array(10).fill(0xab));
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test('runtime conversation controller preserves the Renderer snapshot contract', async () => {
  const fixture = new FixtureRuntime();
  const controller = new RuntimeConversationController(
    fixture as unknown as RuntimeSupervisor,
  );
  assert.equal(await controller.switchWorkspace(WORKSPACE_ID), true);
  assert.equal(
    (await controller.startTurn({
      input: 'Implement the runtime slice',
      attachments: [{
        fileName: 'fixture.txt',
        mediaType: 'text/plain',
        data: 'Zml4dHVyZQ==',
      }],
      modelProfileId: 'profile-1',
    })).accepted,
    true,
  );
  const started = fixture.sent.find((command) => command.type === 'turn.start');
  assert.equal(started?.type, 'turn.start');
  if (started?.type !== 'turn.start') {
    throw new Error('Turn was not sent.');
  }
  assert.equal(started.content[1]?.type, 'asset');
  const model = {
    profileId: 'profile-1',
    providerFamily: 'openai' as const,
    wireApi: 'openaiResponses' as const,
    modelId: 'gpt-5',
    displayName: 'GPT-5',
    contextWindowTokens: 128_000,
    effectiveCapabilities: {
      toolCalls: true,
      strictTools: true,
      parallelTools: true,
      imageInput: true,
      pdfInput: false,
    },
  };
  fixture.emit({
    type: 'turn.started',
    requestId: started.requestId,
    sequence: 3,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    model,
  });
  fixture.emit({
    type: 'turn.textDelta',
    requestId: started.requestId,
    sequence: 4,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    itemId: `${started.turnId}:agent`,
    phase: 'final',
    delta: 'Done',
  });
  fixture.emit({
    type: 'turn.completed',
    requestId: started.requestId,
    sequence: 5,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    status: 'completed',
  });

  const snapshot = controller.getSnapshot();
  assert.equal(isConversationStateSnapshot(snapshot), true);
  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.threadId, THREAD_ID);
  assert.equal(snapshot.turns[0]?.model?.profileId, 'profile-1');
  assert.equal(snapshot.turns[0]?.messages[1]?.text, 'Done');
  assert.equal(
    snapshot.turns[0]?.messages[0]?.attachments?.[0]?.originalName,
    'fixture.txt',
  );
});
