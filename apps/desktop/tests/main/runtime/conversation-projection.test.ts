import assert from 'node:assert/strict';
import test from 'node:test';

import { projectThread } from '../../../src/main/runtime/conversation-projection.ts';
import type { RuntimeThreadSnapshot } from '../../../src/runtime/protocol.ts';

test('durable thread recovery preserves structured knowledge references', () => {
  const knowledgeBaseId = `kb_${'1'.repeat(32)}`;
  const snapshot: RuntimeThreadSnapshot = {
    thread: {
      id: 'thread-1',
      workspaceId: 'workspace-1',
      title: 'Fixture',
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      parentThreadId: null,
    },
    turns: [{
      id: 'turn-1',
      requestId: 'request-1',
      status: 'completed',
      providerWireApi: 'openaiResponses',
      model: 'fixture-model',
      errorJson: null,
      startedAt: 1,
      completedAt: 2,
    }],
    items: [{
      id: 'user-1',
      turnId: 'turn-1',
      sequence: 1,
      kind: 'turn.userMessage',
      payload: {
        content: [
          { type: 'text', text: '电话是多少？' },
          {
            type: 'knowledgeReferences',
            references: [{ knowledgeBaseId, name: '产品规范' }],
          },
        ],
      },
    }],
    agentTasks: [],
    queue: { paused: false, messages: [] },
  };

  assert.deepEqual(projectThread(snapshot)[0]?.messages[0]?.knowledgeReferences, [{
    knowledgeBaseId,
    name: '产品规范',
  }]);
});
