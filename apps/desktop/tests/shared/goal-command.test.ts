import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGoalCommand } from '../../src/shared/goal-command.ts';
import {
  isConversationGoalMutation,
  isGoalObjective,
} from '../../src/shared/conversation.ts';

test('Goal commands are parsed independently from ordinary composer commands', () => {
  assert.deepEqual(parseGoalCommand('/goal'), { action: 'view' });
  assert.deepEqual(parseGoalCommand('/goal 完成迁移'), {
    action: 'create',
    objective: '完成迁移',
  });
  assert.deepEqual(parseGoalCommand('/goal edit 新目标'), {
    action: 'edit',
    objective: '新目标',
  });
  assert.deepEqual(parseGoalCommand('/goal pause'), { action: 'pause' });
  assert.deepEqual(parseGoalCommand('完成迁移\n\n/goal '), {
    action: 'create',
    objective: '完成迁移',
  });
  assert.equal(parseGoalCommand('说明文字中提到 /goal 但不是命令'), null);
  assert.equal(parseGoalCommand('/goal 完成迁移\n/test'), null);
  assert.equal(parseGoalCommand('/test'), null);
});

test('Goal objectives count Unicode code points and mutations require CAS identity', () => {
  assert.equal(isGoalObjective('😀'.repeat(4_000)), true);
  assert.equal(isGoalObjective('😀'.repeat(4_001)), false);
  assert.equal(
    isConversationGoalMutation({
      action: 'pause',
      threadId: 'thread-1',
      goalId: 'goal-1',
      expectedRevision: 2,
    }),
    true,
  );
  assert.equal(
    isConversationGoalMutation({
      action: 'pause',
      threadId: 'thread-1',
      goalId: 'goal-1',
      expectedRevision: 0,
    }),
    false,
  );
});
