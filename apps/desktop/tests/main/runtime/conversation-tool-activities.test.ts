import assert from 'node:assert/strict';
import test from 'node:test';

import { projectTurnActivities } from '../../../src/main/runtime/conversation-tool-activities.ts';
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
