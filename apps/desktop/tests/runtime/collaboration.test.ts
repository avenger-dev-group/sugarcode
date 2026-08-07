import assert from 'node:assert/strict';
import test from 'node:test';

import type { BaseTool } from '@google/adk';

import {
  CollaborationCoordinator,
  type AgentTaskExecutionContext,
} from '../../src/runtime/collaboration.ts';
import type { RuntimeAgentTask } from '../../src/runtime/protocol.ts';

const turn = {
  requestId: 'request-collaboration',
  workspaceId: 'workspace-collaboration',
  threadId: 'thread-collaboration',
  turnId: 'turn-collaboration',
};

const callTool = async (
  tools: readonly BaseTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool.runAsync({ args, toolContext: {} as never });
};

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

test('CollaborationCoordinator schedules a persisted DAG, delivers amendments, waits and interrupts', async () => {
  const coordinator = new CollaborationCoordinator(2);
  const published: RuntimeAgentTask[] = [];
  const created: RuntimeAgentTask[] = [];
  const updated: RuntimeAgentTask[] = [];
  let releaseWorker: (() => void) | undefined;
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const executions: AgentTaskExecutionContext[] = [];
  const signal = new AbortController();
  const tools = coordinator.toolsForTurn(
    turn,
    {
      createTasks: (tasks) => created.push(...tasks),
      updateTask: (task) => updated.push(task),
      publishTask: (task) => published.push(task),
      executeTask: async (context) => {
        executions.push(context);
        if (context.task.clientTaskKey === 'write') {
          context.publishProgress('runningTool', 'Running `workspace_apply_patch`.');
          await workerGate;
          const amendments = context.takeAmendments();
          return {
            status: 'completed',
            summaryMarkdown: `write done: ${amendments.join(', ')}`,
            durationMs: 10,
          };
        }
        if (context.task.clientTaskKey === 'audit') {
          assert.equal(context.dependencyResults[0]?.status, 'completed');
          return {
            status: 'completed',
            summaryMarkdown: 'audit passed',
            durationMs: 5,
          };
        }
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 'interrupted',
          summaryMarkdown: 'slow stopped',
          durationMs: 1,
        };
      },
    },
    signal.signal,
  );

  const dispatched = await callTool(tools, 'collaboration_dispatch', {
    tasks: [
      {
        clientTaskKey: 'write',
        title: 'Implement change',
        role: 'worker',
        access: 'workspaceWrite',
        dependsOn: [],
        taskMarkdown: 'Implement the requested change.',
      },
      {
        clientTaskKey: 'audit',
        title: 'Audit change',
        role: 'auditor',
        access: 'readOnly',
        dependsOn: ['write'],
        taskMarkdown: 'Audit the implementation.',
      },
    ],
  }) as { accepted: string[] };
  assert.deepEqual(dispatched.accepted, ['write', 'audit']);
  assert.equal(created.length, 2);
  await nextTurn();
  assert.equal(executions[0]?.task.clientTaskKey, 'write');
  assert.equal(
    published.find((task) => task.progress)?.progress?.summaryMarkdown,
    'Running `workspace_apply_patch`.',
  );

  await callTool(tools, 'collaboration_send', {
    clientTaskKey: 'write',
    amendmentMarkdown: 'Also update the regression test.',
  });
  await callTool(tools, 'collaboration_amend', {
    clientTaskKey: 'write',
    amendmentMarkdown: 'Keep the public protocol provider-neutral.',
  });
  const waiting = callTool(tools, 'collaboration_wait', {
    clientTaskKeys: [],
  });
  releaseWorker?.();
  const result = await waiting as {
    tasks: Array<{ clientTaskKey: string; status: string; summaryMarkdown: string }>;
  };
  assert.deepEqual(
    result.tasks.map((task) => [task.clientTaskKey, task.status]),
    [['write', 'completed'], ['audit', 'completed']],
  );
  assert.match(
    result.tasks.find((task) => task.clientTaskKey === 'write')?.summaryMarkdown ?? '',
    /regression test/u,
  );
  assert.match(
    result.tasks.find((task) => task.clientTaskKey === 'write')?.summaryMarkdown ?? '',
    /provider-neutral/u,
  );

  await callTool(tools, 'collaboration_dispatch', {
    tasks: [{
      clientTaskKey: 'slow',
      title: 'Slow exploration',
      role: 'explorer',
      access: 'readOnly',
      dependsOn: [],
      taskMarkdown: 'Explore until interrupted.',
    }],
  });
  await nextTurn();
  assert.deepEqual(
    await callTool(tools, 'collaboration_interrupt', {
      clientTaskKey: 'slow',
    }),
    { accepted: true },
  );
  const interrupted = await callTool(tools, 'collaboration_wait', {
    clientTaskKeys: ['slow'],
  }) as { tasks: Array<{ status: string }> };
  assert.equal(interrupted.tasks[0]?.status, 'cancelled');
  assert.ok(updated.some((task) => task.status === 'running'));
  assert.ok(published.some((task) => task.status === 'completed'));
});

test('CollaborationCoordinator adds a runtime auditor and still rejects cycles', async () => {
  const coordinator = new CollaborationCoordinator();
  const created: RuntimeAgentTask[] = [];
  const tools = coordinator.toolsForTurn(
    turn,
    {
      createTasks: (tasks) => created.push(...tasks),
      updateTask: () => undefined,
      publishTask: () => undefined,
      executeTask: async () => ({
        status: 'completed',
        summaryMarkdown: '',
        durationMs: 0,
      }),
    },
    new AbortController().signal,
  );
  const dispatched = await callTool(tools, 'collaboration_dispatch', {
    tasks: [{
      clientTaskKey: 'write',
      title: 'Write',
      role: 'worker',
      access: 'workspaceWrite',
      dependsOn: [],
      taskMarkdown: 'Write files.',
    }],
  }) as { accepted: string[] };
  assert.deepEqual(dispatched.accepted, ['write', 'runtime-audit']);
  assert.equal(created[1]?.role, 'auditor');
  assert.equal(created[1]?.access, 'readOnly');
  assert.deepEqual(created[1]?.dependsOn, ['write']);
  await assert.rejects(
    callTool(tools, 'collaboration_dispatch', {
      tasks: [
        {
          clientTaskKey: 'left',
          title: 'Left',
          role: 'explorer',
          access: 'readOnly',
          dependsOn: ['right'],
          taskMarkdown: 'Explore left.',
        },
        {
          clientTaskKey: 'right',
          title: 'Right',
          role: 'explorer',
          access: 'readOnly',
          dependsOn: ['left'],
          taskMarkdown: 'Explore right.',
        },
      ],
    }),
    /cycle/u,
  );
});
