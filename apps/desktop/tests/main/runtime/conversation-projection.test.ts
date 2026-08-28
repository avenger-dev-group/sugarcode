import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectThread,
  runtimeError,
} from '../../../src/main/runtime/conversation-projection.ts';
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

test('durable Goal objectives project as visible user messages without exposing hidden context', () => {
  const snapshot: RuntimeThreadSnapshot = {
    thread: {
      id: 'thread-goal',
      workspaceId: 'workspace-1',
      title: 'Goal fixture',
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      parentThreadId: null,
    },
    turns: [{
      id: 'turn-goal',
      requestId: 'request-goal',
      status: 'completed',
      providerWireApi: 'openaiResponses',
      model: 'fixture-model',
      errorJson: null,
      startedAt: 1,
      completedAt: 2,
    }],
    items: [
      {
        id: 'turn-goal:goal-objective',
        turnId: 'turn-goal',
        sequence: -1,
        kind: 'turn.goalObjective',
        payload: { content: [{ type: 'text', text: '完成迁移并验证' }] },
      },
      {
        id: 'turn-goal:goal',
        turnId: 'turn-goal',
        sequence: 0,
        kind: 'turn.goalContext',
        payload: {
          content: [{ type: 'text', text: 'hidden scheduler context' }],
        },
      },
    ],
    agentTasks: [],
    queue: { paused: false, messages: [] },
  };

  const [turn] = projectThread(snapshot);
  assert.equal(turn?.origin, 'goal');
  assert.deepEqual(turn?.messages, [{
    id: 'turn-goal:goal-objective',
    role: 'user',
    text: '完成迁移并验证',
    status: 'completed',
  }]);

  const legacySnapshot: RuntimeThreadSnapshot = {
    ...snapshot,
    items: snapshot.items
      .filter((item) => item.kind !== 'turn.goalObjective')
      .map((item) => ({
        ...item,
        payload: { ...item.payload, goalId: 'goal-legacy' },
      })),
    goal: {
      id: 'goal-legacy',
      threadId: 'thread-goal',
      objective: '兼容显示历史目标',
      status: 'completed',
      revision: 2,
      model: {
        profileId: 'fixture',
        request: { reasoningEffort: 'high', serviceTier: 'auto' },
      },
      budget: {},
      activationUsage: { turns: 1, activeDurationMs: 1, tokens: 1 },
      lifetimeUsage: { turns: 1, activeDurationMs: 1, tokens: 1 },
      createdAt: 1,
      updatedAt: 2,
    },
  };
  assert.equal(
    projectThread(legacySnapshot)[0]?.messages[0]?.text,
    '兼容显示历史目标',
  );
});

test('runtime projection preserves safe protocol diagnostics', () => {
  const projected = runtimeError({
    kind: 'protocol',
    retryable: false,
    message: 'Model history contains an unsupported content-bearing Part.',
    protocol: {
      stage: 'outputNormalization',
      code: 'invalidEventShape',
      eventType: 'history.encode',
      shapeSha256: 'a'.repeat(64),
    },
  });

  assert.deepEqual(projected, {
    kind: 'protocol',
    retryable: false,
    protocol: {
      stage: 'outputNormalization',
      code: 'invalidEventShape',
      eventType: 'history.encode',
      shapeSha256: 'a'.repeat(64),
    },
  });
});
