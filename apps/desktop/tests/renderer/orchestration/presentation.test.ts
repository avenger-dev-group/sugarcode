import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeAgentTaskDockTasks,
  agentTaskWaves,
  formatAgentTaskDuration,
  queuedAgentTaskReason,
} from '../../../src/renderer/components/orchestration/presentation.ts';
import type { AgentTaskViewModel } from '../../../src/renderer/components/orchestration/types.ts';

const task = (
  clientTaskKey: string,
  dependsOn: readonly string[] = [],
  overrides: Partial<AgentTaskViewModel> = {},
): AgentTaskViewModel => ({
  id: `activity-${clientTaskKey}`,
  taskId: `task-${clientTaskKey}`,
  clientTaskKey,
  childThreadId: `thread-${clientTaskKey}`,
  title: clientTaskKey,
  role: 'explorer',
  access: 'readOnly',
  dependsOn,
  taskMarkdown: `Run ${clientTaskKey}`,
  status: 'queued',
  amendments: [],
  ...overrides,
});

test('child Agent durations stay compact in task cards and traces', () => {
  assert.equal(formatAgentTaskDuration(950), '950 ms');
  assert.equal(formatAgentTaskDuration(2_450), '2.5 s');
  assert.equal(formatAgentTaskDuration(156_320), '2m 36s');
});

test('child Agent dependency depth becomes reviewable execution waves', () => {
  const tasks = [
    task('research'),
    task('tests'),
    task('implement', ['research', 'tests']),
    task('audit', ['implement']),
  ];

  assert.deepEqual(
    agentTaskWaves(tasks).map((wave) =>
      wave.tasks.map((candidate) => candidate.clientTaskKey),
    ),
    [['research', 'tests'], ['implement'], ['audit']],
  );
});

test('queued child Agents explain dependency, write lock, and capacity waits', () => {
  const completed = task('research', [], { status: 'completed' });
  const running = task('tests', [], { status: 'running' });
  const dependent = task('implement', ['research', 'tests'], {
    access: 'workspaceWrite',
  });

  assert.equal(
    queuedAgentTaskReason(dependent, [completed, running, dependent]),
    'Waiting for 1 dependency',
  );
  assert.equal(
    queuedAgentTaskReason(task('writer', [], { access: 'workspaceWrite' }), []),
    'Waiting for write access or capacity',
  );
  assert.equal(
    queuedAgentTaskReason(task('reader'), []),
    'Waiting for workspace access or capacity',
  );
});

test('Agent task dock keeps only live and attention-worthy work', () => {
  const tasks = [
    task('completed', [], { status: 'completed' }),
    task('queued'),
    task('running', [], { status: 'running' }),
    task('approval', [], { status: 'waitingApproval' }),
    task('failed', [], { status: 'failed' }),
    task('cancelled', [], { status: 'cancelled' }),
  ];

  assert.deepEqual(
    activeAgentTaskDockTasks(tasks).map((candidate) => candidate.clientTaskKey),
    ['approval', 'failed', 'running', 'queued'],
  );

  assert.deepEqual(
    activeAgentTaskDockTasks([
      task('completed', [], { status: 'completed' }),
      task('cancelled', [], { status: 'cancelled' }),
    ]),
    [],
  );
});
