import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeConversationController } from '../../../src/main/runtime/conversation-controller.ts';
import { createUuidV7 } from '../../../src/main/runtime/id.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type {
  RuntimeCommand,
  RuntimeEvent,
  RuntimeThreadSnapshot,
} from '../../../src/runtime/protocol.ts';
import {
  isConversationStateSnapshot,
  type ConversationStateSnapshot,
} from '../../../src/shared/conversation.ts';

const WORKSPACE_ID = 'workspace-runtime';
const SECOND_WORKSPACE_ID = 'workspace-runtime-second';
const THREAD_ID = '0198f140-0000-7000-8000-000000000001';
const SECOND_THREAD_ID = '0198f140-0000-7000-8000-000000000002';

class FixtureRuntime {
  readonly sent: Exclude<RuntimeCommand, { type: 'initialize' }>[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly beforeThreadCreated?: (workspaceId: string) => Promise<void>;
  private createdThreads = 0;

  constructor(
    beforeThreadCreated?: (workspaceId: string) => Promise<void>,
  ) {
    this.beforeThreadCreated = beforeThreadCreated;
  }

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
      const threadId = this.createdThreads === 0 ? THREAD_ID : SECOND_THREAD_ID;
      this.createdThreads += 1;
      await this.beforeThreadCreated?.(command.workspaceId);
      return {
        type: 'thread.mutated',
        requestId: command.requestId,
        sequence: 2,
        workspaceId: command.workspaceId,
        operation: 'create',
        threadId,
        snapshot: {
          thread: {
            id: threadId,
            workspaceId: command.workspaceId,
            title: command.title ?? null,
            createdAt: 1,
            updatedAt: 1,
            archivedAt: null,
            parentThreadId: null,
          },
          turns: [],
          items: [],
          agentTasks: [],
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
    if (command.type === 'thread.load') {
      return {
        type: 'thread.loaded',
        requestId: command.requestId,
        sequence: 2,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        snapshot: {
          thread: {
            id: command.threadId,
            workspaceId: command.workspaceId,
            title: command.threadId === THREAD_ID ? 'First task' : 'Second task',
            createdAt: 1,
            updatedAt: 1,
            archivedAt: null,
            parentThreadId: null,
          },
          turns: [],
          items: [],
          agentTasks: [],
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

class SnapshotFixtureRuntime {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly snapshot: RuntimeThreadSnapshot;

  constructor(snapshot: RuntimeThreadSnapshot) {
    this.snapshot = snapshot;
  }

  subscribe = (listener: (event: RuntimeEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  send = (): void => undefined;

  request = async (
    command: Exclude<RuntimeCommand, { type: 'initialize' | 'shutdown' }>,
  ): Promise<RuntimeEvent> => {
    if (command.type === 'thread.list') {
      return {
        type: 'thread.listResult',
        requestId: command.requestId,
        sequence: 1,
        workspaceId: command.workspaceId,
        query: command.query ?? '',
        threads: [this.snapshot.thread],
      };
    }
    if (command.type === 'thread.load') {
      return {
        type: 'thread.loaded',
        requestId: command.requestId,
        sequence: 2,
        workspaceId: command.workspaceId,
        snapshot: this.snapshot,
      };
    }
    throw new Error(`Unexpected snapshot fixture request ${command.type}.`);
  };
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
  const publishedSnapshots: ConversationStateSnapshot[] = [];
  controller.subscribe((snapshot) => publishedSnapshots.push(snapshot));
  assert.equal(await controller.switchWorkspace(WORKSPACE_ID), true);
  assert.deepEqual(controller.startNewThread(), {
    accepted: true,
    reason: 'accepted',
  });
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
  const startingSnapshot = controller.getSnapshot();
  assert.equal(isConversationStateSnapshot(startingSnapshot), true);
  assert.equal(startingSnapshot.phase, 'starting');
  assert.equal(startingSnapshot.threadId, THREAD_ID);
  assert.equal(startingSnapshot.activeTurnId, started.turnId);
  assert.equal(
    startingSnapshot.turns[0]?.messages[0]?.text,
    'Implement the runtime slice',
  );
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
  const streamingSnapshot = controller.getSnapshot();
  assert.equal(isConversationStateSnapshot(streamingSnapshot), true);
  assert.equal(streamingSnapshot.phase, 'inProgress');
  assert.equal(streamingSnapshot.turns[0]?.messages[1]?.text, 'Done');
  const streamingRevision = streamingSnapshot.revision;
  assert.deepEqual(await controller.selectThread(THREAD_ID), {
    accepted: true,
    reason: 'accepted',
  });
  const resynchronizedSnapshot = controller.getSnapshot();
  assert.equal(resynchronizedSnapshot.revision, streamingRevision + 1);
  assert.equal(resynchronizedSnapshot.activeTurnId, started.turnId);
  assert.equal(resynchronizedSnapshot.turns[0]?.messages[1]?.text, 'Done');
  fixture.emit({
    type: 'turn.textDelta',
    requestId: started.requestId,
    sequence: 5,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    itemId: `${started.turnId}:commentary:1`,
    phase: 'commentary',
    delta: 'The user wants ',
  });
  fixture.emit({
    type: 'turn.textDelta',
    requestId: started.requestId,
    sequence: 6,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    itemId: `${started.turnId}:commentary:1`,
    phase: 'commentary',
    delta: 'a project review.',
  });
  fixture.emit({
    type: 'turn.toolCall',
    requestId: started.requestId,
    sequence: 7,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    itemId: `${started.turnId}:read`,
    callId: 'call-read',
    name: 'workspace_read',
    arguments: { paths: ['package.json', 'src/main.ts'] },
  });
  fixture.emit({
    type: 'turn.toolCall',
    requestId: started.requestId,
    sequence: 8,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    itemId: `${started.turnId}:read`,
    callId: 'call-read',
    name: 'workspace_read',
    arguments: { paths: ['package.json', 'src/main.ts'] },
  });
  fixture.emit({
    type: 'turn.toolResult',
    requestId: started.requestId,
    sequence: 9,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    itemId: `${started.turnId}:read-result`,
    callId: 'call-read',
    result: {
      ok: true,
      files: [
        { path: 'package.json', ok: true, content: '{}', bytes: 2 },
        { path: 'src/main.ts', ok: false, error: 'notFound' },
      ],
    },
  });
  const agentTask = {
    orchestrationId: `orch/${THREAD_ID}/${started.turnId}`,
    taskId: 'task-runtime',
    clientTaskKey: 'audit',
    childThreadId: '33333333-3333-4333-8333-333333333333',
    title: 'Audit runtime',
    role: 'auditor' as const,
    access: 'readOnly' as const,
    dependsOn: [] as string[],
    taskMarkdown: 'Audit the runtime.',
    status: 'queued' as const,
    amendments: [] as Array<{ id: string; markdown: string }>,
    progress: {
      stage: 'waitingForModel' as const,
      summaryMarkdown: 'Waiting for the auditor model.',
      updatedAt: 12,
    },
  };
  fixture.emit({
    type: 'agent.task',
    requestId: started.requestId,
    sequence: 7,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    task: agentTask,
  });
  fixture.emit({
    type: 'agent.task',
    requestId: started.requestId,
    sequence: 8,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    task: {
      ...agentTask,
      status: 'completed',
      result: {
        id: 'result-runtime',
        summaryMarkdown: 'Audit passed.',
        durationMs: 12,
      },
    },
  });
  fixture.emit({
    type: 'approval.requested',
    requestId: started.requestId,
    sequence: 9,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    approvalId: 'approval-recovered',
    operationId: 'operation-recovered',
    toolName: 'workspace_apply_patch',
    argumentsSummary: 'workspace_apply_patch (64 bytes)',
    fullAccess: false,
    recovered: true,
  });
  fixture.emit({
    type: 'approval.requested',
    requestId: started.requestId,
    sequence: 10,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: started.turnId,
    approvalId: 'approval-recovered',
    operationId: 'operation-recovered',
    toolName: 'workspace_apply_patch',
    argumentsSummary: 'workspace_apply_patch (64 bytes)',
    fullAccess: false,
    recovered: true,
  });
  fixture.emit({
    type: 'turn.completed',
    requestId: started.requestId,
    sequence: 11,
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
  const orchestration = snapshot.turns[0]?.activities?.find(
    (activity) => activity.type === 'orchestration',
  );
  assert.equal(orchestration?.type, 'orchestration');
  if (orchestration?.type === 'orchestration') {
    assert.equal(orchestration.activity.tasks[0]?.status, 'completed');
    assert.equal(
      orchestration.activity.tasks[0]?.progress?.summaryMarkdown,
      'Waiting for the auditor model.',
    );
    assert.equal(
      orchestration.activity.tasks[0]?.result?.summaryMarkdown,
      'Audit passed.',
    );
  }
  assert.equal(
    snapshot.turns[0]?.activities?.filter(
      (activity) => activity.type === 'commandApproval',
    ).length,
    1,
  );
  const commentary = snapshot.turns[0]?.activities?.filter(
    (activity) => activity.type === 'commentary',
  );
  assert.equal(commentary?.length, 1);
  assert.equal(commentary?.[0]?.activity.text, 'The user wants a project review.');
  const reads = snapshot.turns[0]?.activities?.filter(
    (activity) => activity.type === 'workspaceRead',
  );
  assert.equal(reads?.length, 2);
  assert.deepEqual(
    reads?.map((activity) => activity.activity.result?.outcome),
    [
      { type: 'success', bytes: 2 },
      { type: 'error', kind: 'notFound' },
    ],
  );
  assert.equal(
    publishedSnapshots.every(isConversationStateSnapshot),
    true,
  );
});

test('runtime conversation controller restores interleaved tool activity from durable Turn items', async () => {
  const turnId = '0198f140-0000-7000-8000-000000000010';
  const basePayload = {
    requestId: 'request-restored',
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId,
  };
  const runtime = new SnapshotFixtureRuntime({
    thread: {
      id: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      title: 'Restored review',
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null,
      parentThreadId: null,
    },
    turns: [{
      id: turnId,
      requestId: 'request-restored',
      status: 'completed',
      providerWireApi: 'anthropicMessages',
      model: 'claude-sonnet',
      errorJson: null,
      startedAt: 1,
      completedAt: 2,
    }],
    items: [
      {
        id: 'user-item',
        turnId,
        sequence: 1,
        kind: 'turn.userMessage',
        payload: {
          ...basePayload,
          type: 'turn.userMessage',
          content: [{ type: 'text', text: '检查项目' }],
        },
      },
      {
        id: 'commentary-item',
        turnId,
        sequence: 2,
        kind: 'turn.textCompleted',
        payload: {
          ...basePayload,
          type: 'turn.textCompleted',
          itemId: 'commentary-1',
          phase: 'commentary',
          text: '我先查看关键文件。',
        },
      },
      {
        id: 'read-call-item',
        turnId,
        sequence: 3,
        kind: 'turn.toolCall',
        payload: {
          ...basePayload,
          type: 'turn.toolCall',
          itemId: 'read-call',
          callId: 'call-restored',
          name: 'workspace_read',
          arguments: { path: 'README.md' },
        },
      },
      {
        id: 'read-result-item',
        turnId,
        sequence: 4,
        kind: 'turn.toolResult',
        payload: {
          ...basePayload,
          type: 'turn.toolResult',
          itemId: 'read-result',
          callId: 'call-restored',
          result: { ok: true, content: '# SugarCode', bytes: 11 },
        },
      },
      {
        id: 'final-item',
        turnId,
        sequence: 5,
        kind: 'turn.textCompleted',
        payload: {
          ...basePayload,
          type: 'turn.textCompleted',
          itemId: 'final-1',
          phase: 'final',
          text: '检查完成。',
        },
      },
    ],
    agentTasks: [],
  });
  const controller = new RuntimeConversationController(
    runtime as unknown as RuntimeSupervisor,
  );

  assert.equal(await controller.switchWorkspace(WORKSPACE_ID), true);
  assert.equal((await controller.selectThread(THREAD_ID)).accepted, true);

  const restored = controller.getSnapshot().turns[0];
  assert.deepEqual(
    restored?.activities?.map((activity) => activity.type),
    ['commentary', 'workspaceRead'],
  );
  const read = restored?.activities?.[1];
  assert.equal(read?.type, 'workspaceRead');
  if (read?.type === 'workspaceRead') {
    assert.equal(read.activity.path, 'README.md');
    assert.deepEqual(read.activity.result?.outcome, {
      type: 'success',
      bytes: 11,
    });
  }
  assert.equal(restored?.messages[1]?.text, '检查完成。');
});

test('runtime conversation controller keeps active Turns running across Thread navigation', async () => {
  const fixture = new FixtureRuntime();
  const controller = new RuntimeConversationController(
    fixture as unknown as RuntimeSupervisor,
  );
  const publishedSnapshots: ConversationStateSnapshot[] = [];
  controller.subscribe((snapshot) => publishedSnapshots.push(snapshot));
  assert.equal(await controller.switchWorkspace(WORKSPACE_ID), true);

  assert.equal(controller.startNewThread().accepted, true);
  assert.equal((await controller.startTurn({ input: 'First task' })).accepted, true);
  const first = fixture.sent.find(
    (command): command is Extract<RuntimeCommand, { type: 'turn.start' }> =>
      command.type === 'turn.start',
  );
  assert.ok(first);
  fixture.emit({
    type: 'turn.started',
    requestId: first.requestId,
    sequence: 10,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: first.turnId,
    model: {
      profileId: 'profile-1',
      providerFamily: 'openai',
      wireApi: 'openaiResponses',
      modelId: 'fixture',
      displayName: 'Fixture',
      contextWindowTokens: 128_000,
      effectiveCapabilities: {
        toolCalls: true,
        strictTools: true,
        parallelTools: true,
        imageInput: true,
        pdfInput: false,
      },
    },
  });

  assert.deepEqual(controller.startNewThread(), {
    accepted: true,
    reason: 'accepted',
  });
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.deepEqual(controller.getSnapshot().navigator.runningThreadIds, [THREAD_ID]);

  assert.equal((await controller.startTurn({ input: 'Second task' })).accepted, true);
  const starts = fixture.sent.filter(
    (command): command is Extract<RuntimeCommand, { type: 'turn.start' }> =>
      command.type === 'turn.start',
  );
  const second = starts[1];
  assert.ok(second);
  assert.equal(second.threadId, SECOND_THREAD_ID);
  assert.deepEqual(controller.getSnapshot().navigator.runningThreadIds, [
    THREAD_ID,
    SECOND_THREAD_ID,
  ]);

  assert.deepEqual(await controller.selectThread(THREAD_ID), {
    accepted: true,
    reason: 'accepted',
  });
  assert.equal(controller.getSnapshot().activeTurnId, first.turnId);
  assert.equal(controller.getSnapshot().turns[0]?.messages[0]?.text, 'First task');

  fixture.emit({
    type: 'turn.completed',
    requestId: first.requestId,
    sequence: 11,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: first.turnId,
    status: 'completed',
  });
  assert.equal(controller.getSnapshot().phase, 'ready');
  assert.deepEqual(controller.getSnapshot().navigator.runningThreadIds, [
    SECOND_THREAD_ID,
  ]);
  fixture.emit({
    type: 'turn.completed',
    requestId: second.requestId,
    sequence: 12,
    workspaceId: WORKSPACE_ID,
    threadId: SECOND_THREAD_ID,
    turnId: second.turnId,
    status: 'completed',
  });
  assert.equal(
    controller.getSnapshot().navigator.unreadThreadStatuses?.[SECOND_THREAD_ID],
    'completed',
  );
  assert.equal((await controller.selectThread(SECOND_THREAD_ID)).accepted, true);
  assert.equal(
    controller.getSnapshot().navigator.unreadThreadStatuses?.[SECOND_THREAD_ID],
    undefined,
  );
  assert.equal(publishedSnapshots.every(isConversationStateSnapshot), true);
});

test('runtime conversation controller keeps active Turns isolated across workspaces', async () => {
  const fixture = new FixtureRuntime();
  const controller = new RuntimeConversationController(
    fixture as unknown as RuntimeSupervisor,
  );
  const model = {
    profileId: 'profile-1',
    providerFamily: 'openai' as const,
    wireApi: 'openaiResponses' as const,
    modelId: 'fixture',
    displayName: 'Fixture',
    contextWindowTokens: 128_000,
    effectiveCapabilities: {
      toolCalls: true,
      strictTools: true,
      parallelTools: true,
      imageInput: true,
      pdfInput: false,
    },
  };

  assert.equal(await controller.switchWorkspace(WORKSPACE_ID), true);
  assert.equal(controller.startNewThread().accepted, true);
  assert.equal((await controller.startTurn({ input: 'First workspace task' })).accepted, true);
  const first = fixture.sent.find(
    (command): command is Extract<RuntimeCommand, { type: 'turn.start' }> =>
      command.type === 'turn.start',
  );
  assert.ok(first);
  fixture.emit({
    type: 'turn.started',
    requestId: first.requestId,
    sequence: 20,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: first.turnId,
    model,
  });

  assert.equal(await controller.switchWorkspace(SECOND_WORKSPACE_ID), true);
  assert.equal(controller.getSnapshot().phase, 'idle');
  assert.deepEqual(controller.getSnapshot().navigator.runningThreadIds, [THREAD_ID]);
  assert.equal(controller.startNewThread().accepted, true);
  assert.equal((await controller.startTurn({ input: 'Second workspace task' })).accepted, true);
  const starts = fixture.sent.filter(
    (command): command is Extract<RuntimeCommand, { type: 'turn.start' }> =>
      command.type === 'turn.start',
  );
  const second = starts[1];
  assert.ok(second);
  assert.equal(second.workspaceId, SECOND_WORKSPACE_ID);
  fixture.emit({
    type: 'turn.started',
    requestId: second.requestId,
    sequence: 21,
    workspaceId: SECOND_WORKSPACE_ID,
    threadId: SECOND_THREAD_ID,
    turnId: second.turnId,
    model,
  });
  assert.deepEqual(controller.getSnapshot().navigator.runningThreadIds, [
    THREAD_ID,
    SECOND_THREAD_ID,
  ]);

  assert.equal(await controller.switchWorkspace(WORKSPACE_ID), true);
  assert.equal((await controller.selectThread(THREAD_ID)).accepted, true);
  assert.equal(controller.getSnapshot().activeTurnId, first.turnId);
  assert.equal(controller.getSnapshot().turns[0]?.messages[0]?.text, 'First workspace task');

  assert.equal(await controller.switchWorkspace(SECOND_WORKSPACE_ID), true);
  assert.equal((await controller.selectThread(SECOND_THREAD_ID)).accepted, true);
  fixture.emit({
    type: 'turn.textDelta',
    requestId: first.requestId,
    sequence: 22,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: first.turnId,
    itemId: `${first.turnId}:agent`,
    phase: 'final',
    delta: 'First workspace finished',
  });
  fixture.emit({
    type: 'turn.completed',
    requestId: first.requestId,
    sequence: 23,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    turnId: first.turnId,
    status: 'completed',
  });

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.threadId, SECOND_THREAD_ID);
  assert.equal(snapshot.turns[0]?.messages[0]?.text, 'Second workspace task');
  assert.deepEqual(snapshot.navigator.runningThreadIds, [SECOND_THREAD_ID]);
  assert.equal(snapshot.navigator.unreadThreadStatuses?.[THREAD_ID], 'completed');
  assert.equal(isConversationStateSnapshot(snapshot), true);
});

test('runtime conversation controller isolates concurrent Turn startup by workspace', async () => {
  const releaseCreate = new Map<string, () => void>();
  const fixture = new FixtureRuntime(
    (workspaceId) => new Promise<void>((resolve) => {
      releaseCreate.set(workspaceId, resolve);
    }),
  );
  const controller = new RuntimeConversationController(
    fixture as unknown as RuntimeSupervisor,
  );

  assert.equal(await controller.switchWorkspace(WORKSPACE_ID), true);
  assert.equal(controller.startNewThread().accepted, true);
  const firstStart = controller.startTurn({ input: 'First pending startup' });
  assert.equal(controller.getSnapshot().phase, 'starting');

  assert.equal(await controller.switchWorkspace(SECOND_WORKSPACE_ID), true);
  assert.equal(controller.startNewThread().accepted, true);
  const secondStart = controller.startTurn({ input: 'Second pending startup' });
  assert.equal(controller.getSnapshot().phase, 'starting');

  releaseCreate.get(WORKSPACE_ID)?.();
  releaseCreate.get(SECOND_WORKSPACE_ID)?.();
  assert.equal((await firstStart).accepted, true);
  assert.equal((await secondStart).accepted, true);

  const starts = fixture.sent.filter(
    (command): command is Extract<RuntimeCommand, { type: 'turn.start' }> =>
      command.type === 'turn.start',
  );
  assert.deepEqual(
    starts.map((command) => [command.workspaceId, command.threadId]),
    [
      [WORKSPACE_ID, THREAD_ID],
      [SECOND_WORKSPACE_ID, SECOND_THREAD_ID],
    ],
  );
  assert.deepEqual(controller.getSnapshot().navigator.runningThreadIds, [
    THREAD_ID,
    SECOND_THREAD_ID,
  ]);
});

test('runtime conversation controller ignores a stale Workspace list result', async () => {
  let resolveFirst: ((event: RuntimeEvent) => void) | undefined;
  const runtime = {
    subscribe: (): (() => void) => () => undefined,
    send: (): void => undefined,
    request: (
      command: Extract<RuntimeCommand, { type: 'thread.list' }>,
    ): Promise<RuntimeEvent> => {
      const result = (threadId: string): RuntimeEvent => ({
        type: 'thread.listResult',
        requestId: command.requestId,
        sequence: 1,
        workspaceId: command.workspaceId,
        query: '',
        threads: [{
          id: threadId,
          workspaceId: command.workspaceId,
          title: command.workspaceId,
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
          parentThreadId: null,
        }],
      });
      if (command.workspaceId === WORKSPACE_ID) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(result(SECOND_THREAD_ID));
    },
  };
  const controller = new RuntimeConversationController(
    runtime as unknown as RuntimeSupervisor,
  );

  const first = controller.switchWorkspace(WORKSPACE_ID);
  assert.equal(await controller.switchWorkspace(SECOND_WORKSPACE_ID), true);
  resolveFirst?.({
    type: 'thread.listResult',
    requestId: 'stale-list',
    sequence: 2,
    workspaceId: WORKSPACE_ID,
    query: '',
    threads: [{
      id: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      title: 'Stale task',
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null,
      parentThreadId: null,
    }],
  });
  assert.equal(await first, true);

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.workspaceId, SECOND_WORKSPACE_ID);
  assert.deepEqual(snapshot.navigator.activeThreadIds, [SECOND_THREAD_ID]);
});
