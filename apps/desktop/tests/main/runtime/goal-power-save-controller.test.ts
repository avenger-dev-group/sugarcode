import assert from 'node:assert/strict';
import test from 'node:test';

import { GoalPowerSaveController } from '../../../src/main/runtime/goal-power-save-controller.ts';

test('Goal power blocker is idempotent and scoped to active Goal Turns', () => {
  const started: number[] = [];
  const stopped: number[] = [];
  const controller = new GoalPowerSaveController({
    start: () => {
      const id = started.length + 1;
      started.push(id);
      return id;
    },
    stop: (id) => stopped.push(id),
    isStarted: (id) => started.includes(id) && !stopped.includes(id),
  });
  controller.startTurn('turn-1');
  assert.deepEqual(started, []);
  controller.setEnabled(true);
  controller.startTurn('turn-2');
  assert.deepEqual(started, [1]);
  controller.finishTurn('turn-1');
  assert.deepEqual(stopped, []);
  controller.finishTurn('turn-2');
  assert.deepEqual(stopped, [1]);
  controller.dispose();
});
