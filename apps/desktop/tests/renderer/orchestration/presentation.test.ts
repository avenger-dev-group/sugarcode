import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentTaskGroupForStatus,
  formatAgentTaskDuration,
} from '../../../src/renderer/components/orchestration/presentation.ts';

test('child Agent statuses map to the task inbox groups', () => {
  assert.equal(agentTaskGroupForStatus('waitingApproval'), 'attention');
  assert.equal(agentTaskGroupForStatus('failed'), 'attention');
  assert.equal(agentTaskGroupForStatus('interrupted'), 'attention');
  assert.equal(agentTaskGroupForStatus('running'), 'active');
  assert.equal(agentTaskGroupForStatus('queued'), 'queued');
  assert.equal(agentTaskGroupForStatus('completed'), 'finished');
  assert.equal(agentTaskGroupForStatus('cancelled'), 'finished');
});

test('child Agent durations stay compact in task cards and traces', () => {
  assert.equal(formatAgentTaskDuration(950), '950 ms');
  assert.equal(formatAgentTaskDuration(2_450), '2.5 s');
  assert.equal(formatAgentTaskDuration(156_320), '2m 36s');
});
