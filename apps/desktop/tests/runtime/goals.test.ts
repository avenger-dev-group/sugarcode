import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUpdateGoalTool,
  GoalTurnSession,
  goalTurnRuntimeContent,
} from '../../src/runtime/execution/goals.ts';
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

test('Goal Turn guidance treats the objective as the authorization boundary', () => {
  const content = goalTurnRuntimeContent(goal())[0]?.text ?? '';
  assert.match(content, /original Goal objective defines the full authorized scope/u);
  assert.match(content, /Do not implement changes unless the objective also asks/u);
  assert.match(content, /call update_goal with complete even when adjacent optional work/u);
  assert.match(content, /Do not use in_progress merely to propose optional follow-up work/u);
});

test('in-progress checkpoints accept verification evidence without retry loops', async () => {
  const session = new GoalTurnSession(goal());
  const tool = createUpdateGoalTool(session);
  const update = {
    status: 'in_progress' as const,
    summary: 'Analysis report completed',
    nextStep: 'Continue the already-authorized implementation',
    evidence: [{
      kind: 'artifact' as const,
      label: 'Analysis report',
      result: 'docs/analysis.md',
    }],
  };
  assert.deepEqual(
    await tool.runAsync({ args: update, toolContext: {} as never }),
    {
      ok: true,
      status: 'in_progress',
      message: 'The Goal checkpoint is staged and will commit with this Turn.',
    },
  );
  assert.deepEqual(session.stagedUpdate(), update);
});
