import assert from 'node:assert/strict';
import test from 'node:test';

import { isConversationStateSnapshot } from '../../src/shared/conversation.ts';

const THREAD_WEB = '00000000-0001-7000-8000-000000000001';
const THREAD_ADMIN = '00000000-0001-7000-8000-000000000002';
const TURN_REVIEW = '00000000-0001-7000-8000-000000000003';

const snapshot = (unreadStatus: string) => ({
  revision: 1,
  phase: 'idle',
  turns: [] as const,
  navigator: {
    status: 'ready',
    activeThreadIds: [] as const,
    activeThreadTitles: {},
    activeTruncated: false,
    runningThreadIds: [THREAD_WEB],
    unreadThreadStatuses: {
      [THREAD_ADMIN]: unreadStatus,
    },
    search: {
      query: '',
      status: 'idle',
      threadIds: [] as const,
      threadTitles: {},
      truncated: false,
    },
  },
});

test('conversation snapshots accept global navigation statuses outside the foreground workspace', () => {
  assert.equal(isConversationStateSnapshot(snapshot('completed')), true);
  assert.equal(isConversationStateSnapshot(snapshot('failed')), true);
  assert.equal(isConversationStateSnapshot(snapshot('interrupted')), true);
});

test('conversation snapshots reject non-terminal unread states', () => {
  assert.equal(isConversationStateSnapshot(snapshot('inProgress')), false);
});

test('reload-required navigation accepts unique UUIDv7 Thread IDs', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      navigator: {
        ...snapshot('completed').navigator,
        reloadRequiredThreadIds: [THREAD_WEB, THREAD_ADMIN],
      },
    }),
    true,
  );
});

test('reload-required navigation rejects duplicate or invalid Thread IDs', () => {
  for (const reloadRequiredThreadIds of [
    [THREAD_WEB, THREAD_WEB],
    ['thread-web'],
  ]) {
    assert.equal(
      isConversationStateSnapshot({
        ...snapshot('completed'),
        navigator: {
          ...snapshot('completed').navigator,
          reloadRequiredThreadIds,
        },
      }),
      false,
    );
  }
});

test('advanced search truncation may occur before the match limit', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      phase: 'ready',
      threadId: THREAD_WEB,
      turns: [
        {
          id: 'turn-search',
          status: 'completed',
          messages: [],
          workspaceSearch: {
            id: 'search-call',
            callId: 'call-search',
            path: '.',
            query: 'component',
            callStatus: 'completed',
            result: {
              id: 'search-result',
              status: 'completed',
              outcome: { type: 'success', matches: 1, truncated: true },
            },
          },
        },
      ],
    }),
    true,
  );
});

const fullAccessCommandTurn = (
  status: 'inProgress' | 'completed',
  resultStatus: 'inProgress' | 'completed',
) => ({
  id: TURN_REVIEW,
  status,
  messages: [] as const,
  commandApproval: {
    callItemId: 'call-item-eslint',
    id: 'approval-request-eslint',
    callId: 'call-eslint',
    approvalId: 'approval-eslint',
    command: 'npx eslint . 2>&1 | tail -60',
    argumentCount: 0,
    fullAccess: true,
    requestStatus: 'completed',
    decision: {
      id: 'approval-decision-eslint',
      status: 'completed',
      value: 'approved',
    },
    executionAttempt: {
      id: 'execution-attempt-eslint',
      status: 'completed',
    },
    executionResult: {
      id: 'execution-result-eslint',
      status: resultStatus,
      outcome: {
        type: 'process',
        stdoutBytes: 5_990,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        encoding: 'utf8Lossy',
        durationMs: 2_745,
        outcome: { type: 'exitCode', code: 0 },
      },
    },
  },
});

test('conversation snapshots accept an active Full Access shell result without sandbox receipts', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      phase: 'inProgress',
      threadId: THREAD_WEB,
      activeTurnId: TURN_REVIEW,
      turns: [fullAccessCommandTurn('inProgress', 'inProgress')],
    }),
    true,
  );
});

test('conversation snapshots accept a completed Full Access shell result without sandbox receipts', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      phase: 'ready',
      threadId: THREAD_WEB,
      turns: [fullAccessCommandTurn('completed', 'completed')],
    }),
    true,
  );
});

test('conversation snapshots reject a process result with only one sandbox receipt', () => {
  const turn = fullAccessCommandTurn('completed', 'completed');
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      phase: 'ready',
      threadId: THREAD_WEB,
      turns: [
        {
          ...turn,
          commandApproval: {
            ...turn.commandApproval,
            executionResult: {
              ...turn.commandApproval.executionResult,
              outcome: {
                ...turn.commandApproval.executionResult.outcome,
                sandboxPolicy: 'filesystemReadOnlyV1',
              },
            },
          },
        },
      ],
    }),
    false,
  );
});
