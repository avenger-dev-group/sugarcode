import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isConversationStateSnapshot,
  isConversationReviseTurnRequest,
  isConversationUserInputResponse,
  isValidConversationTitle,
} from '../../src/shared/conversation.ts';

test('conversation revision requests are bounded and identify their target Turn', () => {
  assert.equal(
    isConversationReviseTurnRequest({
      threadId: THREAD_WEB,
      turnId: TURN_REVIEW,
      text: 'Revised request',
      modelProfileId: 'profile_1',
    }),
    true,
  );
  assert.equal(
    isConversationReviseTurnRequest({
      threadId: THREAD_WEB,
      turnId: '',
      text: 'Revised request',
    }),
    false,
  );
});

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

test('conversation snapshots accept only rename and delete Thread mutations', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      navigator: {
        ...snapshot('completed').navigator,
        pendingMutation: { kind: 'delete', threadId: THREAD_WEB },
      },
    }),
    true,
  );
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      navigator: {
        ...snapshot('completed').navigator,
        pendingMutation: { kind: 'archive', threadId: THREAD_WEB },
      },
    }),
    false,
  );
});

test('conversation titles are non-empty, control-free, and byte bounded', () => {
  assert.equal(isValidConversationTitle('修复会话标题'), true);
  assert.equal(isValidConversationTitle('   '), false);
  assert.equal(isValidConversationTitle('修复\n标题'), false);
  assert.equal(isValidConversationTitle('改'.repeat(86)), false);
});

test('conversation snapshots accept an optimistic Turn while runtime startup is pending', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      phase: 'starting',
      threadId: THREAD_WEB,
      activeTurnId: TURN_REVIEW,
      turns: [
        {
          id: TURN_REVIEW,
          status: 'inProgress',
          messages: [
            {
              id: `${TURN_REVIEW}:user`,
              role: 'user',
              text: 'Review the startup lifecycle',
              status: 'inProgress',
            },
          ],
        },
      ],
    }),
    true,
  );
});

test('conversation snapshots and responses preserve bounded user questions', () => {
  const userInputRequest = {
    id: 'input-fixture',
    questions: [{
      id: 'scope',
      header: '实现范围',
      question: '本次需要覆盖到哪一层？',
      options: [
        { label: '完整链路（推荐）', description: '包含 Agent、协议和界面。' },
        { label: '仅界面', description: '只处理显示和交互。' },
      ],
    }],
  };
  assert.equal(isConversationStateSnapshot({
    ...snapshot('completed'),
    phase: 'inProgress',
    threadId: THREAD_WEB,
    activeTurnId: TURN_REVIEW,
    turns: [{
      id: TURN_REVIEW,
      status: 'inProgress',
      messages: [],
      userInputRequest,
    }],
  }), true);
  assert.equal(isConversationUserInputResponse({
    threadId: THREAD_WEB,
    turnId: TURN_REVIEW,
    inputRequestId: userInputRequest.id,
    answers: [{ questionId: 'scope', answer: '完整链路（推荐）' }],
  }), true);
  assert.equal(isConversationStateSnapshot({
    ...snapshot('completed'),
    phase: 'ready',
    threadId: THREAD_WEB,
    turns: [{
      id: TURN_REVIEW,
      status: 'completed',
      messages: [],
      userInputRequest,
    }],
  }), false);
});

test('conversation snapshots retain a classified interruption reason after runtime restart', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('interrupted'),
      phase: 'ready',
      threadId: THREAD_WEB,
      turns: [{
        id: TURN_REVIEW,
        status: 'interrupted',
        messages: [],
        error: { kind: 'incomplete', retryable: true },
      }],
    }),
    true,
  );
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

test('conversation snapshots preserve a successful workspace patch result', () => {
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
            command: 'workspace_apply_patch (324 bytes)',
            executionResult: {
              ...turn.commandApproval.executionResult,
              outcome: {
                type: 'workspacePatch',
                filesChanged: 2,
                files: [
                  {
                    path: 'src/a.ts',
                    kind: 'update',
                    beforeSha256: 'a'.repeat(64),
                    afterSha256: 'b'.repeat(64),
                    beforeBytes: 4,
                    afterBytes: 4,
                    diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n',
                    newlineStyle: 'lf',
                    finalNewline: true,
                  },
                  {
                    path: 'src/b.ts',
                    kind: 'create',
                    beforeSha256: 'c'.repeat(64),
                    afterSha256: 'd'.repeat(64),
                    beforeBytes: 0,
                    afterBytes: 2,
                  },
                ],
              },
            },
          },
        },
      ],
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
