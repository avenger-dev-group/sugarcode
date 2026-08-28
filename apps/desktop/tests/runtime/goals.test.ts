import assert from 'node:assert/strict';
import test from 'node:test';

import { GoalTurnSession, goalTurnRuntimeContent } from '../../src/runtime/goals.ts';
import type { GoalSnapshot } from '../../src/shared/goals.ts';

const goal = (revision = 1): GoalSnapshot => ({
  id: 'goal-1',
  threadId: 'thread-1',
  objective: 'Ship Goal mode',
  status: 'active',
  revision,
  model: {
    profileId: 'default',
    request: { reasoningEffort: 'high', serviceTier: 'auto' },
  },
  budget: {},
  activationUsage: { turns: 0, activeDurationMs: 0, tokens: 0 },
  lifetimeUsage: { turns: 0, activeDurationMs: 0, tokens: 0 },
  createdAt: 1,
  updatedAt: 1,
});

test('Goal Turn requires a structured checkpoint before final', () => {
  const session = new GoalTurnSession(goal());
  assert.match(session.finalIssue() ?? '', /update_goal/u);
  session.stage({
    status: 'in_progress',
    summary: 'Persistence complete',
    nextStep: 'Wire the renderer',
  });
  assert.equal(session.finalIssue(), undefined);
});

test('an active edit prevents an old Goal Turn from completing the new revision', () => {
  const session = new GoalTurnSession(goal());
  session.stage({
    status: 'complete',
    summary: 'Old objective complete',
    evidence: [{ kind: 'command', label: 'tests', result: 'passed' }],
  });
  session.refresh({ ...goal(2), objective: 'Revised objective' });
  assert.match(session.finalIssue() ?? '', /changed during this Turn/u);
});

test('reconciliation context requires workspace inspection before replay', () => {
  const content = goalTurnRuntimeContent(goal(), true)[0]?.text ?? '';
  assert.match(content, /Inspect the actual workspace state/u);
  assert.doesNotMatch(content, /Goal Turn started by user message/u);
});

test('Goal Turn guidance asks for visible, verifiable checkpoints', () => {
  const content = goalTurnRuntimeContent(goal())[0]?.text ?? '';
  assert.match(content, /one coherent, independently verifiable checkpoint/u);
  assert.match(content, /in_progress after the checkpoint/u);
});
