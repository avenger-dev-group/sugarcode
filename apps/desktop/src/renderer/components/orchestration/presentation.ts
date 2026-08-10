import type { AgentTaskViewModel } from './types';

export const formatAgentTaskDuration = (durationMs: number): string => {
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
};

export type AgentTaskWave = Readonly<{
  index: number;
  tasks: readonly AgentTaskViewModel[];
}>;

export const agentTaskWaves = (
  tasks: readonly AgentTaskViewModel[],
): readonly AgentTaskWave[] => {
  const tasksByKey = new Map(tasks.map((task) => [task.clientTaskKey, task]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthFor = (task: AgentTaskViewModel): number => {
    const cached = depths.get(task.clientTaskKey);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(task.clientTaskKey)) {
      return 0;
    }
    visiting.add(task.clientTaskKey);
    const dependencies = task.dependsOn
      .map((key) => tasksByKey.get(key))
      .filter((dependency): dependency is AgentTaskViewModel =>
        Boolean(dependency),
      );
    const depth =
      dependencies.length === 0
        ? 0
        : Math.max(...dependencies.map((dependency) => depthFor(dependency))) +
          1;
    visiting.delete(task.clientTaskKey);
    depths.set(task.clientTaskKey, depth);
    return depth;
  };

  const waves = new Map<number, AgentTaskViewModel[]>();
  for (const task of tasks) {
    const depth = depthFor(task);
    waves.set(depth, [...(waves.get(depth) ?? []), task]);
  }
  return [...waves.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, waveTasks]) => ({ index, tasks: waveTasks }));
};

export const queuedAgentTaskReason = (
  task: AgentTaskViewModel,
  tasks: readonly AgentTaskViewModel[],
): string => {
  const tasksByKey = new Map(
    tasks.map((candidate) => [candidate.clientTaskKey, candidate]),
  );
  const pendingDependencies = task.dependsOn.filter((key) => {
    const dependency = tasksByKey.get(key);
    return dependency?.status !== 'completed';
  }).length;
  if (pendingDependencies > 0) {
    return `Waiting for ${pendingDependencies} ${
      pendingDependencies === 1 ? 'dependency' : 'dependencies'
    }`;
  }
  return task.access === 'workspaceWrite'
    ? 'Waiting for write access or capacity'
    : 'Waiting for workspace access or capacity';
};

const dockTaskPriority = (task: AgentTaskViewModel): number => {
  switch (task.status) {
    case 'waitingApproval':
    case 'failed':
    case 'interrupted':
      return 0;
    case 'running':
      return 1;
    case 'queued':
      return 2;
    case 'completed':
    case 'cancelled':
      return 3;
  }
};

export const activeAgentTaskDockTasks = (
  tasks: readonly AgentTaskViewModel[],
): readonly AgentTaskViewModel[] =>
  tasks
    .filter(
      (task) => task.status !== 'completed' && task.status !== 'cancelled',
    )
    .map((task, index) => ({ index, task }))
    .sort(
      (left, right) =>
        dockTaskPriority(left.task) - dockTaskPriority(right.task) ||
        left.index - right.index,
    )
    .map(({ task }) => task);
