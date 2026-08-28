import assert from 'node:assert/strict';
import test from 'node:test';

import * as conversation from '../../src/shared/conversation.ts';

const {
  isConversationStateSnapshot,
  isConversationAttachmentPreviewRequest,
  isConversationAttachmentPreviewResult,
  isConversationReviseTurnRequest,
  isConversationUserInputResponse,
  isValidConversationTitle,
} = conversation;

test('conversation compatibility barrel preserves its public runtime exports', () => {
  assert.deepEqual(Object.keys(conversation).sort(), [
    'CONVERSATION_ATTACHMENT_PREVIEW_CHANNEL',
    'CONVERSATION_GOAL_MUTATE_CHANNEL',
    'CONVERSATION_QUEUE_DELETE_CHANNEL',
    'CONVERSATION_QUEUE_RESUME_CHANNEL',
    'CONVERSATION_QUEUE_STEER_CHANNEL',
    'CONVERSATION_QUEUE_UPDATE_CHANNEL',
    'CONVERSATION_REVISE_CHANNEL',
    'CONVERSATION_SEND_CHANNEL',
    'CONVERSATION_STATE_CHANGED_CHANNEL',
    'CONVERSATION_STATE_GET_CHANNEL',
    'CONVERSATION_STOP_CHANNEL',
    'CONVERSATION_THREAD_DELETE_CHANNEL',
    'CONVERSATION_THREAD_DELTA_CHANNEL',
    'CONVERSATION_THREAD_NEW_CHANNEL',
    'CONVERSATION_THREAD_PROJECTION_CHANGED_CHANNEL',
    'CONVERSATION_THREAD_PROJECTION_GET_CHANNEL',
    'CONVERSATION_THREAD_SEARCH_CHANNEL',
    'CONVERSATION_THREAD_SELECT_CHANNEL',
    'CONVERSATION_USER_INPUT_RESPONSE_CHANNEL',
    'MAX_CONVERSATION_ATTACHMENTS',
    'MAX_CONVERSATION_ATTACHMENT_BASE64_LENGTH',
    'MAX_CONVERSATION_ATTACHMENT_BYTES',
    'MAX_CONVERSATION_ATTACHMENT_PREVIEW_URL_LENGTH',
    'MAX_CONVERSATION_INPUT_BYTES',
    'MAX_CONVERSATION_TITLE_BYTES',
    'MAX_CONVERSATION_VIDEO_BYTES',
    'MAX_FILE_CHANGE_DIFF_BYTES',
    'MAX_FILE_CHANGE_DIFF_LINES',
    'MAX_GOAL_EVIDENCE_ITEMS',
    'MAX_GOAL_OBJECTIVE_CHARACTERS',
    'MAX_GOAL_PROGRESS_CHARACTERS',
    'MAX_THREAD_SEARCH_BYTES',
    'MAX_USER_INPUT_ANSWER_BYTES',
    'MAX_USER_INPUT_OPTIONS',
    'MAX_USER_INPUT_QUESTIONS',
    'isConversationActionResult',
    'isConversationAttachmentPreviewRequest',
    'isConversationAttachmentPreviewResult',
    'isConversationGoalMutation',
    'isConversationQueuedMessageMutationRequest',
    'isConversationQueuedMessageUpdateRequest',
    'isConversationReviseTurnRequest',
    'isConversationSendRequest',
    'isConversationStateSnapshot',
    'isConversationSteerQueuedMessageRequest',
    'isConversationThreadProjectionDelta',
    'isConversationThreadProjectionSnapshot',
    'isConversationUserInputResponse',
    'isGoalBudget',
    'isGoalEvidence',
    'isGoalObjective',
    'isGoalSnapshot',
    'isGoalUpdate',
    'isValidConversationInput',
    'isValidConversationTitle',
    'isValidFileChangeDiff',
    'isValidFileChangePath',
    'isValidSha256',
    'isValidThreadSearchInput',
  ]);
  assert.equal(
    conversation.MAX_CONVERSATION_ATTACHMENT_BYTES,
    25 * 1024 * 1024,
  );
  assert.equal(
    conversation.MAX_CONVERSATION_ATTACHMENT_BASE64_LENGTH,
    34_952_536,
  );
});

test('conversation requests accept lightweight local video references without inline bytes', () => {
  assert.equal(
    conversation.isConversationSendRequest({
      input: 'Analyze this video',
      attachments: [{
        fileName: 'demo.mp4',
        mediaType: 'video/mp4',
        localPath: '/tmp/demo.mp4',
        sizeBytes: 512 * 1024 * 1024,
      }],
    }),
    true,
  );
  assert.equal(
    conversation.isConversationSendRequest({
      input: 'Read this file',
      attachments: [{
        fileName: 'secret.txt',
        mediaType: 'text/plain',
        localPath: '/tmp/secret.txt',
        sizeBytes: 10,
      }],
    }),
    false,
  );
});

test('conversation results distinguish attachment import failures', () => {
  assert.equal(
    conversation.isConversationActionResult({
      accepted: false,
      reason: 'attachmentUnavailable',
    }),
    true,
  );
  assert.equal(
    conversation.isConversationActionResult({
      accepted: false,
      reason: 'attachmentUnavailable',
      attachmentFailure: 'unsupportedFormat',
    }),
    true,
  );
  assert.equal(
    conversation.isConversationActionResult({
      accepted: false,
      reason: 'unavailable',
      attachmentFailure: 'unsupportedFormat',
    }),
    false,
  );
});

test('attachment previews require scoped asset identifiers and bounded image data', () => {
  const assetId = `ast_${'a'.repeat(64)}`;
  assert.equal(
    isConversationAttachmentPreviewRequest({
      threadId: THREAD_WEB,
      assetId,
    }),
    true,
  );
  assert.equal(
    isConversationAttachmentPreviewRequest({
      threadId: THREAD_WEB,
      assetId: '../escape',
    }),
    false,
  );
  assert.equal(
    isConversationAttachmentPreviewResult({
      available: true,
      assetId,
      previewUrl: 'data:image/png;base64,cG5n',
    }),
    true,
  );
  assert.equal(
    isConversationAttachmentPreviewResult({
      available: true,
      assetId,
      previewUrl: 'data:text/html;base64,PHNjcmlwdD4=',
    }),
    false,
  );
});

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

test('conversation snapshots validate optional durable knowledge citations', () => {
  const knowledgeActivity = {
    type: 'knowledge',
    activity: {
      id: 'knowledge-call',
      callId: 'knowledge-call-id',
      operation: 'search',
      query: '原子切换',
      callStatus: 'completed',
      result: {
        id: 'knowledge-result',
        status: 'completed',
        outcome: {
          type: 'success',
          mode: 'hybrid',
          matches: 1,
          knowledgeBases: [
            {
              id: `kb_${'1'.repeat(32)}`,
              name: '产品规范',
            },
          ],
          citations: [
            {
              citation: 'K1',
              knowledgeBaseId: `kb_${'1'.repeat(32)}`,
              knowledgeBaseName: '产品规范',
              documentId: `kd_${'2'.repeat(32)}`,
              fileName: 'retrieval.md',
              relativePath: 'spec/retrieval.md',
              heading: '模型切换',
              pageNumber: 3,
              content: '新索引完成后原子切换。',
            },
          ],
        },
      },
    },
  } as const;
  const withActivity = {
    ...snapshot('completed'),
    phase: 'ready',
    workspaceId: 'workspace-fixture',
    threadId: THREAD_WEB,
    turns: [
      {
        id: TURN_REVIEW,
        status: 'completed',
        messages: [],
        activities: [knowledgeActivity],
      },
    ],
  } as const;

  assert.equal(isConversationStateSnapshot(withActivity), true);
  assert.equal(
    isConversationStateSnapshot({
      ...withActivity,
      turns: [
        {
          ...withActivity.turns[0],
          activities: [
            {
              ...knowledgeActivity,
              activity: {
                ...knowledgeActivity.activity,
                result: {
                  ...knowledgeActivity.activity.result,
                  outcome: {
                    ...knowledgeActivity.activity.result.outcome,
                    citations: [
                      {
                        ...knowledgeActivity.activity.result.outcome
                          .citations[0],
                        documentId: '../../outside',
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    }),
    false,
  );
});

test('conversation snapshots and responses preserve bounded user questions', () => {
  const userInputRequest = {
    id: 'input-fixture',
    questions: [
      {
        id: 'scope',
        header: '实现范围',
        question: '本次需要覆盖到哪一层？',
        options: [
          {
            label: '完整链路（推荐）',
            description: '包含 Agent、协议和界面。',
          },
          { label: '仅界面', description: '只处理显示和交互。' },
        ],
      },
    ],
  };
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      phase: 'inProgress',
      threadId: THREAD_WEB,
      activeTurnId: TURN_REVIEW,
      turns: [
        {
          id: TURN_REVIEW,
          status: 'inProgress',
          messages: [],
          userInputRequest,
        },
      ],
    }),
    true,
  );
  assert.equal(
    isConversationUserInputResponse({
      threadId: THREAD_WEB,
      turnId: TURN_REVIEW,
      inputRequestId: userInputRequest.id,
      submission: {
        kind: 'submitted',
        decisions: [
          {
            questionId: 'scope',
            kind: 'answered',
            source: 'option',
            answer: '完整链路（推荐）',
          },
        ],
      },
    }),
    true,
  );
  assert.equal(
    isConversationUserInputResponse({
      threadId: THREAD_WEB,
      turnId: TURN_REVIEW,
      inputRequestId: userInputRequest.id,
      submission: {
        kind: 'cancelled',
        decisions: [{ questionId: 'scope', kind: 'skipped' }],
      },
    }),
    true,
  );
  assert.equal(
    isConversationUserInputResponse({
      threadId: THREAD_WEB,
      turnId: TURN_REVIEW,
      inputRequestId: userInputRequest.id,
      submission: { kind: 'submitted', decisions: [] },
    }),
    false,
  );
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('completed'),
      phase: 'ready',
      threadId: THREAD_WEB,
      turns: [
        {
          id: TURN_REVIEW,
          status: 'completed',
          messages: [],
          userInputRequest,
        },
      ],
    }),
    false,
  );
});

test('conversation snapshots retain a classified interruption reason after runtime restart', () => {
  assert.equal(
    isConversationStateSnapshot({
      ...snapshot('interrupted'),
      phase: 'ready',
      threadId: THREAD_WEB,
      turns: [
        {
          id: TURN_REVIEW,
          status: 'interrupted',
          messages: [],
          error: { kind: 'incomplete', retryable: true },
        },
      ],
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
