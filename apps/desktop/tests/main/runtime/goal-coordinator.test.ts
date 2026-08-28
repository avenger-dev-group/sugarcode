import assert from 'node:assert/strict';
import test from 'node:test';

import { GoalCoordinator } from '../../../src/main/runtime/goal-coordinator.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type { GoalSnapshot } from '../../../src/shared/goals.ts';

const goal: GoalSnapshot = {
  id: 'goal-1',
  threadId: 'thread-1',
  objective: 'Finish safely',
  status: 'active',
  revision: 1,
  model: {
    profileId: 'default',
    request: { reasoningEffort: 'high', serviceTier: 'auto' },
  },
  budget: {},
  activationUsage: { turns: 0, activeDurationMs: 0, tokens: 0 },
  lifetimeUsage: { turns: 0, activeDurationMs: 0, tokens: 0 },
  createdAt: 1,
  updatedAt: 1,
};

test('Goal coordinator starts only after the user queue is drained', () => {
  const started: string[] = [];
  const coordinator = new GoalCoordinator(
    {} as RuntimeSupervisor,
    (snapshot) => started.push(snapshot.id),
  );
  coordinator.apply(goal.threadId, goal);
  assert.equal(coordinator.schedule(goal.threadId, 'queueDispatched', false), false);
  assert.equal(coordinator.schedule(goal.threadId, 'queueBlocked', false), false);
  assert.equal(coordinator.schedule(goal.threadId, 'queueDrained', true), false);
  assert.equal(coordinator.schedule(goal.threadId, 'queueDrained', false), true);
  assert.deepEqual(started, ['goal-1']);
});

test('Goal coordinator never schedules paused, completed, or claimed Goals', () => {
  const started: string[] = [];
  const coordinator = new GoalCoordinator(
    {} as RuntimeSupervisor,
    (snapshot) => started.push(snapshot.id),
  );
  for (const snapshot of [
    { ...goal, status: 'paused' as const, pauseReason: 'user' as const },
    { ...goal, status: 'completed' as const },
    { ...goal, activeTurnId: 'turn-1' },
  ]) {
    coordinator.apply(goal.threadId, snapshot);
    assert.equal(coordinator.schedule(goal.threadId, 'queueDrained', false), false);
  }
  assert.deepEqual(started, []);
});
