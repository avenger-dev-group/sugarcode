import assert from 'node:assert/strict';
import test from 'node:test';

import {
  interruptPendingUserInputActivities,
  projectTurnActivities,
} from '../../../src/main/runtime/conversation-tool-activities.ts';
import type { RuntimeTurnItemRecord } from '../../../src/runtime/protocol.ts';

test('workspace_read projection preserves every requested path', () => {
  const paths = Array.from({ length: 10 }, (_, index) => `file-${index}.txt`);
  const items: readonly RuntimeTurnItemRecord[] = [{
    id: 'item-read',
    turnId: 'turn-fixture',
    sequence: 1,
    kind: 'turn.toolCall',
    payload: {
      itemId: 'item-read',
      callId: 'call-read',
      name: 'workspace_read',
      arguments: { paths },
    },
  }];

  const activities = projectTurnActivities(items);

  assert.deepEqual(
    activities.map((activity) =>
      activity.type === 'workspaceRead' ? activity.activity.path : undefined
    ),
    paths,
  );
});

test('knowledge search projects selected bases, mode, hit count, and citation metadata', () => {
  const knowledgeBaseId = `kb_${'1'.repeat(32)}`;
  const documentId = `kd_${'2'.repeat(32)}`;
  const items: readonly RuntimeTurnItemRecord[] = [
    {
      id: 'item-knowledge-call',
      turnId: 'turn-fixture',
      sequence: 1,
      kind: 'turn.toolCall',
      payload: {
        itemId: 'item-knowledge-call',
        callId: 'call-knowledge',
        name: 'knowledge_search',
        arguments: { query: '原子切换' },
      },
    },
    {
      id: 'item-knowledge-result',
      turnId: 'turn-fixture',
      sequence: 2,
      kind: 'turn.toolResult',
      payload: {
        itemId: 'item-knowledge-result',
        callId: 'call-knowledge',
        result: {
          query: '原子切换',
          mode: 'hybrid',
          selectedKnowledgeBases: [{ id: knowledgeBaseId, name: '产品规范' }],
          hits: [{
            citation: 'K1',
            knowledgeBaseId,
            knowledgeBaseName: '产品规范',
            documentId,
            fileName: 'retrieval.md',
            relativePath: 'spec/retrieval.md',
            heading: '模型切换',
            pageNumber: 3,
            contentKind: 'text',
            content: '新索引完成后原子切换。',
            score: 0.9,
          }],
        },
      },
    },
  ];

  assert.deepEqual(projectTurnActivities(items), [{
    type: 'knowledge',
    activity: {
      id: 'item-knowledge-call',
      callId: 'call-knowledge',
      operation: 'search',
      query: '原子切换',
      callStatus: 'completed',
      result: {
        id: 'item-knowledge-result:result:item-knowledge-call',
        status: 'completed',
        outcome: {
          type: 'success',
          mode: 'hybrid',
          matches: 1,
          knowledgeBases: [{ id: knowledgeBaseId, name: '产品规范' }],
          citations: [{
            citation: 'K1',
            knowledgeBaseId,
            knowledgeBaseName: '产品规范',
            documentId,
            fileName: 'retrieval.md',
            relativePath: 'spec/retrieval.md',
            heading: '模型切换',
            pageNumber: 3,
            contentKind: 'text',
            content: '新索引完成后原子切换。',
          }],
        },
      },
    },
  }]);
});

test('load_skill projects a durable activity without the invocation marker', () => {
  const content = '---\nname: frontend-design\n---\n\nDesign carefully.\n';
  const items: readonly RuntimeTurnItemRecord[] = [
    {
      id: 'item-skill-call',
      turnId: 'turn-fixture',
      sequence: 1,
      kind: 'turn.toolCall',
      payload: {
        itemId: 'item-skill-call',
        callId: 'call-skill',
        name: 'load_skill',
        arguments: {
          name: '$frontend-design',
          purpose: '优化登录页的视觉层级和交互反馈。',
        },
      },
    },
    {
      id: 'item-skill-result',
      turnId: 'turn-fixture',
      sequence: 2,
      kind: 'turn.toolResult',
      payload: {
        itemId: 'item-skill-result',
        callId: 'call-skill',
        result: {
          ok: true,
          name: 'frontend-design',
          purpose: '优化登录页的视觉层级和交互反馈。',
          description: 'Design polished interfaces.',
          content,
          sha256: 'a'.repeat(64),
        },
      },
    },
  ];

  assert.deepEqual(projectTurnActivities(items), [
    {
      type: 'skill',
      activity: {
        id: 'item-skill-call',
        callId: 'call-skill',
        name: 'frontend-design',
        purpose: '优化登录页的视觉层级和交互反馈。',
        callStatus: 'completed',
        result: {
          id: 'item-skill-result:result:item-skill-call',
          status: 'completed',
          outcome: {
            type: 'success',
            purpose: '优化登录页的视觉层级和交互反馈。',
            description: 'Design polished interfaces.',
            content,
            sha256: 'a'.repeat(64),
          },
        },
      },
    },
  ]);
});

test('load_skill replaces a recovered transient failure for the same Skill', () => {
  const items: readonly RuntimeTurnItemRecord[] = [
    {
      id: 'item-skill-call-failed',
      turnId: 'turn-fixture',
      sequence: 1,
      kind: 'turn.toolCall',
      payload: {
        itemId: 'item-skill-call-failed',
        callId: 'call-skill-failed',
        name: 'load_skill',
        arguments: { name: '$frontend-design' },
      },
    },
    {
      id: 'item-skill-result-failed',
      turnId: 'turn-fixture',
      sequence: 2,
      kind: 'turn.toolResult',
      payload: {
        itemId: 'item-skill-result-failed',
        callId: 'call-skill-failed',
        result: { ok: false, error: 'skillNotFound' },
      },
    },
    {
      id: 'item-skill-call-retry',
      turnId: 'turn-fixture',
      sequence: 3,
      kind: 'turn.toolCall',
      payload: {
        itemId: 'item-skill-call-retry',
        callId: 'call-skill-retry',
        name: 'load_skill',
        arguments: { name: 'frontend-design' },
      },
    },
    {
      id: 'item-skill-result-retry',
      turnId: 'turn-fixture',
      sequence: 4,
      kind: 'turn.toolResult',
      payload: {
        itemId: 'item-skill-result-retry',
        callId: 'call-skill-retry',
        result: { ok: true, name: 'frontend-design', content: 'Use restraint.' },
      },
    },
  ];

  assert.deepEqual(projectTurnActivities(items), [
    {
      type: 'skill',
      activity: {
        id: 'item-skill-call-retry',
        callId: 'call-skill-retry',
        name: 'frontend-design',
        callStatus: 'completed',
        result: {
          id: 'item-skill-result-retry:result:item-skill-call-retry',
          status: 'completed',
          outcome: { type: 'success', content: 'Use restraint.' },
        },
      },
    },
  ]);
});

test('user-input projection pairs durable requests and structured decisions', () => {
  const questions = [{
    id: 'scope',
    header: '实现范围',
    question: '本次需要覆盖到哪一层？',
    options: [
      { label: '完整链路（推荐）', description: '包含全部层。' },
      { label: '仅界面', description: '只处理界面。' },
    ],
  }, {
    id: 'rollout',
    header: '发布方式',
    question: '需要如何发布？',
    options: [
      { label: '分阶段（推荐）', description: '逐步发布。' },
      { label: '一次发布', description: '立即发布。' },
    ],
  }];
  const items: readonly RuntimeTurnItemRecord[] = [
    {
      id: 'item-input-request',
      turnId: 'turn-fixture',
      sequence: 1,
      kind: 'turn.userInputRequested',
      payload: { inputRequestId: 'input-fixture', questions },
    },
    {
      id: 'item-input-result',
      turnId: 'turn-fixture',
      sequence: 2,
      kind: 'turn.userInputResolved',
      payload: {
        inputRequestId: 'input-fixture',
        submission: {
          kind: 'submitted',
          decisions: [
            {
              questionId: 'scope',
              kind: 'answered',
              source: 'option',
              answer: '完整链路（推荐）',
            },
            { questionId: 'rollout', kind: 'skipped' },
          ],
        },
      },
    },
  ];

  assert.deepEqual(projectTurnActivities(items), [{
    type: 'userInput',
    activity: {
      id: 'input-fixture',
      questions,
      state: 'submitted',
      decisions: [
        {
          questionId: 'scope',
          kind: 'answered',
          source: 'option',
          answer: '完整链路（推荐）',
        },
        { questionId: 'rollout', kind: 'skipped' },
      ],
    },
  }]);
});

test('user-input projection collapses a persisted plan draft emitted before a question', () => {
  const questions = [{
    id: 'scope',
    header: '实现范围',
    question: '本次需要覆盖到哪一层？',
    options: [
      { label: '完整链路（推荐）', description: '包含全部层。' },
      { label: '仅界面', description: '只处理界面。' },
    ],
  }];
  const items: readonly RuntimeTurnItemRecord[] = [
    {
      id: 'item-plan-draft',
      turnId: 'turn-fixture',
      sequence: 1,
      kind: 'turn.textCompleted',
      payload: {
        itemId: 'pre-question-plan',
        phase: 'commentary',
        text: '# 完整计划\n\n## 一、现状分析\n\n这里是不应公开的草稿。',
      },
    },
    {
      id: 'item-question-call',
      turnId: 'turn-fixture',
      sequence: 2,
      kind: 'turn.toolCall',
      payload: {
        itemId: 'question-call',
        callId: 'call-question',
        name: 'request_user_input',
        arguments: { questions },
      },
    },
    {
      id: 'item-input-request',
      turnId: 'turn-fixture',
      sequence: 3,
      kind: 'turn.userInputRequested',
      payload: { inputRequestId: 'input-fixture', questions },
    },
  ];

  const activities = projectTurnActivities(items);

  assert.deepEqual(activities[0], {
    type: 'commentary',
    activity: {
      id: 'pre-question-plan',
      text: '已完成当前阶段的分析，发现 1 个需要确认的决策点。',
      status: 'completed',
    },
  });
  assert.equal(
    activities.some(
      (activity) =>
        activity.type === 'commentary' &&
        activity.activity.text.includes('完整计划'),
    ),
    false,
  );
  assert.equal(activities[1]?.type, 'userInput');
});

test('user-input projection restores legacy answers and interrupts orphaned requests', () => {
  const request: RuntimeTurnItemRecord = {
    id: 'item-input-request',
    turnId: 'turn-fixture',
    sequence: 1,
    kind: 'turn.userInputRequested',
    payload: {
      inputRequestId: 'input-fixture',
      questions: [{
        id: 'scope',
        header: '实现范围',
        question: '本次需要覆盖到哪一层？',
        options: [
          { label: '完整链路（推荐）', description: '包含全部层。' },
          { label: '仅界面', description: '只处理界面。' },
        ],
      }],
    },
  };
  const legacyResolution: RuntimeTurnItemRecord = {
    id: 'item-input-result',
    turnId: 'turn-fixture',
    sequence: 2,
    kind: 'turn.userInputResolved',
    payload: {
      inputRequestId: 'input-fixture',
      answers: [{ questionId: 'scope', answer: '完整链路（推荐）' }],
    },
  };

  const restored = projectTurnActivities([request, legacyResolution]);
  const restoredActivity = restored[0];
  assert.equal(restoredActivity?.type, 'userInput');
  if (restoredActivity?.type === 'userInput') {
    assert.deepEqual(restoredActivity.activity.decisions, [{
      questionId: 'scope',
      kind: 'answered',
      source: 'option',
      answer: '完整链路（推荐）',
    }]);
  }

  const interrupted = interruptPendingUserInputActivities(
    projectTurnActivities([request]),
  );
  assert.equal(
    interrupted[0]?.type === 'userInput'
      ? interrupted[0].activity.state
      : undefined,
    'interrupted',
  );
});
