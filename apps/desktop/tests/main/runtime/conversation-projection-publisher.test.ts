import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationProjectionPublisher } from '../../../src/main/runtime/conversation/projection/publisher.ts';
import type {
  ConversationStateSnapshot,
  ConversationThreadProjectionSnapshot,
  ConversationTurn,
} from '../../../src/shared/conversation.ts';

const WORKSPACE_ID = 'workspace-1';
const THREAD_ID = 'thread-1';
const TURN_ID = 'turn-1';

const completedTurn = (): ConversationTurn => ({
  id: TURN_ID,
  status: 'completed',
  messages: [
    {
      id: 'message-1',
      role: 'agent',
      text: 'Done.',
      status: 'completed',
    },
  ],
});

const stateSnapshot = (revision: number): ConversationStateSnapshot => ({
  revision,
  workspaceId: WORKSPACE_ID,
  phase: 'idle',
  turns: [],
  navigator: {
    status: 'ready',
    activeThreadIds: [],
    activeThreadTitles: {},
    activeTruncated: false,
    runningThreadIds: [],
    inputRequiredThreadIds: [],
    search: {
      query: '',
      status: 'idle',
      threadIds: [],
      threadTitles: {},
      truncated: false,
    },
  },
});

test('invalid thread delta is quarantined without consuming its revision', () => {
  let invalidUsage = false;
  const faults: string[] = [];
  const revisions: number[] = [];
  const publisher = new ConversationProjectionPublisher({
    buildStateSnapshot: stateSnapshot,
    buildThreadSnapshot: (threadId, revision) => {
      const turn = completedTurn();
      return {
        revision,
        workspaceId: WORKSPACE_ID,
        threadId,
        phase: 'ready',
        turns: invalidUsage
          ? [
              {
                ...turn,
                usage: {
                  lastRequest: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  turnTotal: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  requestCount: 1,
                  contextWindowTokens: 3_000_000,
                  source: 'provider',
                },
              },
            ]
          : [turn],
        queue: { paused: false, messages: [] },
      } as ConversationThreadProjectionSnapshot;
    },
    onFault: (fault) => faults.push(fault.kind),
  });
  publisher.subscribeThreadDelta((delta) => revisions.push(delta.revision));

  assert.equal(publisher.publishThreadSnapshot(THREAD_ID, true, 'initial'), true);
  assert.equal(publisher.threadRevision(THREAD_ID), 1);

  invalidUsage = true;
  assert.equal(
    publisher.publishThreadDelta(THREAD_ID, TURN_ID, 'turn.usage'),
    false,
  );
  assert.equal(publisher.threadRevision(THREAD_ID), 1);
  assert.deepEqual(faults, ['invalidThreadDelta']);

  invalidUsage = false;
  assert.equal(
    publisher.publishThreadDelta(THREAD_ID, TURN_ID, 'turn.completed'),
    true,
  );
  assert.equal(publisher.threadRevision(THREAD_ID), 2);
  assert.deepEqual(revisions, [2]);
});

test('a failing projection listener does not block other listeners', () => {
  const faults: string[] = [];
  const delivered: number[] = [];
  const publisher = new ConversationProjectionPublisher({
    buildStateSnapshot: stateSnapshot,
    buildThreadSnapshot: (threadId, revision) => ({
      revision,
      workspaceId: WORKSPACE_ID,
      threadId,
      phase: 'ready',
      turns: [completedTurn()],
      queue: { paused: false, messages: [] },
    }),
    onFault: (fault) => faults.push(fault.kind),
  });
  publisher.subscribeThreadDelta(() => {
    throw new Error('renderer bridge failed');
  });
  publisher.subscribeThreadDelta((delta) => delivered.push(delta.revision));

  assert.doesNotThrow(() =>
    publisher.publishThreadDelta(THREAD_ID, TURN_ID, 'turn.completed'),
  );
  assert.deepEqual(delivered, [1]);
  assert.deepEqual(faults, ['listenerFailed']);
});

test('a completed-Turn delta falls back to a full snapshot while another Turn is active', () => {
  const snapshots: ConversationThreadProjectionSnapshot[] = [];
  const needsRecovery: (boolean | undefined)[] = [];
  const publisher = new ConversationProjectionPublisher({
    buildStateSnapshot: stateSnapshot,
    buildThreadSnapshot: (threadId, revision) => ({
      revision,
      threadId,
      workspaceId: WORKSPACE_ID,
      phase: 'inProgress',
      activeTurnId: 'turn-2',
      turns: [completedTurn(), { id: 'turn-2', status: 'inProgress', messages: [] }],
    }),
    onFault: (fault) => needsRecovery.push(fault.needsRecovery),
  });
  publisher.subscribeThreadSnapshot((snapshot) => snapshots.push(snapshot));
  publisher.subscribeThreadDelta(() => assert.fail('invalid delta was published'));
  assert.equal(publisher.publishThreadDelta(THREAD_ID, TURN_ID, 'turn.completed'), true);
  assert.equal(snapshots[0]?.revision, 1);
  assert.deepEqual(needsRecovery, [false]);
});

test('invalid state and thread snapshots do not advance revisions', () => {
  let valid = false;
  const publisher = new ConversationProjectionPublisher({
    buildStateSnapshot: (revision) => ({
      ...stateSnapshot(revision),
      ...(valid ? {} : { phase: 'inProgress' as const }),
    }),
    buildThreadSnapshot: (threadId, revision) => ({
      revision,
      threadId,
      workspaceId: WORKSPACE_ID,
      phase: valid ? 'ready' : 'inProgress',
      turns: [completedTurn()],
    }),
    onFault: () => undefined,
  });
  assert.equal(publisher.publishState('test'), false);
  assert.equal(publisher.publishThreadSnapshot(THREAD_ID, true, 'test'), false);
  assert.equal(publisher.revision, 0);
  assert.equal(publisher.threadRevision(THREAD_ID), 0);
  valid = true;
  assert.equal(publisher.publishState('test'), true);
  assert.equal(publisher.publishThreadSnapshot(THREAD_ID, true, 'test'), true);
  assert.equal(publisher.revision, 1);
  assert.equal(publisher.threadRevision(THREAD_ID), 1);
});
