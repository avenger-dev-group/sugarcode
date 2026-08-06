import { FunctionTool } from '@google/adk';
import { Type, type Schema } from '@google/genai';
import { randomUUID } from 'node:crypto';

import type {
  RuntimeAgentTask,
  RuntimeAgentTaskStatus,
} from './protocol.ts';

const MAX_TASKS = 12;
const MAX_AUDITORS = 2;
const MAX_TASK_MARKDOWN_BYTES = 64 * 1024;
const MAX_AMENDMENT_BYTES = 16 * 1024;
const MAX_TOTAL_AMENDMENT_BYTES = 64 * 1024;

export const COLLABORATION_AGENT_INSTRUCTION = `# Multi-Agent coordination

For complex work that materially benefits from independent exploration, implementation, or review, use the collaboration tools to create a bounded task DAG. Dispatch only genuinely independent work. Every workspace-writing wave must include a read-only auditor depending on every writer in that wave. Use collaboration_send or collaboration_amend to deliver new information, collaboration_wait to collect results before answering, and collaboration_interrupt when a task is no longer useful. Subagents cannot create more subagents.`;

type AgentTaskRole = RuntimeAgentTask['role'];
type AgentTaskAccess = RuntimeAgentTask['access'];

type DispatchTask = Readonly<{
  clientTaskKey: string;
  title: string;
  role: AgentTaskRole;
  access: AgentTaskAccess;
  dependsOn: readonly string[];
  taskMarkdown: string;
}>;

export type AgentTaskExecution = Readonly<{
  status: 'completed' | 'failed' | 'interrupted';
  summaryMarkdown: string;
  durationMs: number;
}>;

export type AgentTaskExecutionContext = Readonly<{
  task: RuntimeAgentTask;
  dependencyResults: readonly RuntimeAgentTask[];
  signal: AbortSignal;
  takeAmendments: () => readonly string[];
  setWaitingApproval: (waiting: boolean) => void;
}>;

export type CollaborationTurn = Readonly<{
  requestId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
}>;

type CollaborationCallbacks = Readonly<{
  createTasks: (tasks: readonly RuntimeAgentTask[]) => void;
  updateTask: (task: RuntimeAgentTask) => void;
  publishTask: (task: RuntimeAgentTask) => void;
  executeTask: (context: AgentTaskExecutionContext) => Promise<AgentTaskExecution>;
}>;

type TaskRecord = {
  snapshot: RuntimeAgentTask;
  deliveredAmendments: number;
  launchStarted: boolean;
  controller?: AbortController;
};

type Orchestration = {
  id: string;
  turn: CollaborationTurn;
  callbacks: CollaborationCallbacks;
  tasks: Map<string, TaskRecord>;
  waiters: Set<() => void>;
};

type Release = () => void;

const abortError = (): Error => {
  const error = new Error('The Agent task was interrupted.');
  error.name = 'AbortError';
  return error;
};

class AsyncSemaphore {
  private available: number;
  private readonly queue: Array<{
    resolve: (release: Release) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  acquire = (signal: AbortSignal): Promise<Release> => {
    if (signal.aborted) {
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        abort: (): void => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(abortError());
        },
      };
      this.queue.push(entry);
      signal.addEventListener('abort', entry.abort, { once: true });
      this.drain();
    });
  };

  private drain = (): void => {
    while (this.available > 0 && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry || entry.signal.aborted) {
        continue;
      }
      this.available -= 1;
      entry.signal.removeEventListener('abort', entry.abort);
      let released = false;
      entry.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.available += 1;
        this.drain();
      });
    }
  };
}

class WorkspaceAccessGate {
  private readers = 0;
  private writer = false;
  private readonly queue: Array<{
    access: AgentTaskAccess;
    resolve: (release: Release) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  acquire = (access: AgentTaskAccess, signal: AbortSignal): Promise<Release> => {
    if (signal.aborted) {
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        access,
        resolve,
        reject,
        signal,
        abort: (): void => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(abortError());
        },
      };
      this.queue.push(entry);
      signal.addEventListener('abort', entry.abort, { once: true });
      this.drain();
    });
  };

  private drain = (): void => {
    if (this.writer || this.queue.length === 0) {
      return;
    }
    const first = this.queue[0];
    if (first?.access === 'workspaceWrite') {
      if (this.readers > 0) {
        return;
      }
      this.queue.shift();
      if (first.signal.aborted) {
        this.drain();
        return;
      }
      this.writer = true;
      first.signal.removeEventListener('abort', first.abort);
      let released = false;
      first.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.writer = false;
        this.drain();
      });
      return;
    }
    while (this.queue[0]?.access === 'readOnly' && !this.writer) {
      const reader = this.queue.shift();
      if (!reader || reader.signal.aborted) {
        continue;
      }
      this.readers += 1;
      reader.signal.removeEventListener('abort', reader.abort);
      let released = false;
      reader.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.readers -= 1;
        this.drain();
      });
    }
  };
}

const taskSchema = {
  type: Type.OBJECT,
  properties: {
    clientTaskKey: { type: Type.STRING },
    title: { type: Type.STRING },
    role: { type: Type.STRING, enum: ['explorer', 'worker', 'auditor'] },
    access: { type: Type.STRING, enum: ['readOnly', 'workspaceWrite'] },
    dependsOn: { type: Type.ARRAY, items: { type: Type.STRING } },
    taskMarkdown: { type: Type.STRING },
  },
  required: [
    'clientTaskKey',
    'title',
    'role',
    'access',
    'dependsOn',
    'taskMarkdown',
  ],
} satisfies Schema;

const dispatchSchema = {
  type: Type.OBJECT,
  properties: {
    tasks: {
      type: Type.ARRAY,
      minItems: '1',
      maxItems: String(MAX_TASKS),
      items: taskSchema,
    },
  },
  required: ['tasks'],
} satisfies Schema;

const amendSchema = {
  type: Type.OBJECT,
  properties: {
    clientTaskKey: { type: Type.STRING },
    amendmentMarkdown: { type: Type.STRING },
  },
  required: ['clientTaskKey', 'amendmentMarkdown'],
} satisfies Schema;

const waitSchema = {
  type: Type.OBJECT,
  properties: {
    clientTaskKeys: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['clientTaskKeys'],
} satisfies Schema;

const interruptSchema = {
  type: Type.OBJECT,
  properties: { clientTaskKey: { type: Type.STRING } },
  required: ['clientTaskKey'],
} satisfies Schema;

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Collaboration arguments must be an object.');
  }
  return value as Record<string, unknown>;
};

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('Collaboration task dependencies must be string arrays.');
  }
  return value;
};

const parseDispatch = (value: unknown): DispatchTask[] => {
  const input = record(value);
  if (!Array.isArray(input.tasks)) {
    throw new Error('collaboration_dispatch requires tasks.');
  }
  return input.tasks.map((candidate): DispatchTask => {
    const task = record(candidate);
    if (
      typeof task.clientTaskKey !== 'string' ||
      typeof task.title !== 'string' ||
      !['explorer', 'worker', 'auditor'].includes(String(task.role)) ||
      !['readOnly', 'workspaceWrite'].includes(String(task.access)) ||
      typeof task.taskMarkdown !== 'string'
    ) {
      throw new Error('A collaboration task has invalid fields.');
    }
    return {
      clientTaskKey: task.clientTaskKey,
      title: task.title,
      role: task.role as AgentTaskRole,
      access: task.access as AgentTaskAccess,
      dependsOn: stringArray(task.dependsOn),
      taskMarkdown: task.taskMarkdown,
    };
  });
};

const terminal = (status: RuntimeAgentTaskStatus): boolean =>
  ['completed', 'failed', 'interrupted', 'cancelled'].includes(status);

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

export class CollaborationCoordinator {
  private readonly orchestrations = new Map<string, Orchestration>();
  private readonly slots: AsyncSemaphore;
  private readonly workspaceGates = new Map<string, WorkspaceAccessGate>();

  constructor(maxConcurrency = 4) {
    this.slots = new AsyncSemaphore(maxConcurrency);
  }

  toolsForTurn = (
    turn: CollaborationTurn,
    callbacks: CollaborationCallbacks,
    signal: AbortSignal,
  ): readonly FunctionTool<Schema>[] => [
    new FunctionTool({
      name: 'collaboration_dispatch',
      description:
        "Create or extend this Turn's bounded subagent DAG. Workspace-writing tasks require a read-only auditor that depends on every writer in the dispatch.",
      parameters: dispatchSchema,
      execute: async (input) => this.dispatch(turn, callbacks, parseDispatch(input)),
    }),
    new FunctionTool({
      name: 'collaboration_send',
      description:
        'Send an immutable Markdown message to a queued or running task. It is delivered at the next model request boundary.',
      parameters: amendSchema,
      execute: async (input) => {
        const argumentsValue = record(input);
        if (
          typeof argumentsValue.clientTaskKey !== 'string' ||
          typeof argumentsValue.amendmentMarkdown !== 'string'
        ) {
          throw new Error('collaboration_send arguments are invalid.');
        }
        return this.amend(
          turn.turnId,
          argumentsValue.clientTaskKey,
          argumentsValue.amendmentMarkdown,
        );
      },
    }),
    new FunctionTool({
      name: 'collaboration_amend',
      description:
        'Send an immutable Markdown amendment to a queued or running task. It is delivered at the next model request boundary.',
      parameters: amendSchema,
      execute: async (input) => {
        const argumentsValue = record(input);
        if (
          typeof argumentsValue.clientTaskKey !== 'string' ||
          typeof argumentsValue.amendmentMarkdown !== 'string'
        ) {
          throw new Error('collaboration_amend arguments are invalid.');
        }
        return this.amend(
          turn.turnId,
          argumentsValue.clientTaskKey,
          argumentsValue.amendmentMarkdown,
        );
      },
    }),
    new FunctionTool({
      name: 'collaboration_wait',
      description:
        'Wait for selected tasks, or the complete DAG when clientTaskKeys is empty, and return terminal statuses and summaries.',
      parameters: waitSchema,
      execute: async (input) => {
        const argumentsValue = record(input);
        return this.wait(
          turn.turnId,
          stringArray(argumentsValue.clientTaskKeys),
          signal,
        );
      },
    }),
    new FunctionTool({
      name: 'collaboration_interrupt',
      description: 'Cancel one queued or running task in this Turn.',
      parameters: interruptSchema,
      execute: async (input) => {
        const argumentsValue = record(input);
        if (typeof argumentsValue.clientTaskKey !== 'string') {
          throw new Error('collaboration_interrupt arguments are invalid.');
        }
        return this.interrupt(turn.turnId, argumentsValue.clientTaskKey);
      },
    }),
  ];

  waitForTurn = async (turnId: string, signal: AbortSignal): Promise<void> => {
    if (!this.orchestrations.has(turnId)) {
      return;
    }
    await this.wait(turnId, [], signal);
  };

  cancelTurn = (turnId: string): void => {
    const orchestration = this.orchestrations.get(turnId);
    if (!orchestration) {
      return;
    }
    for (const task of orchestration.tasks.values()) {
      if (terminal(task.snapshot.status)) {
        continue;
      }
      task.controller?.abort();
      this.transition(
        orchestration,
        task,
        'interrupted',
        'Interrupted with the parent Turn.',
        0,
      );
    }
  };

  releaseTurn = (turnId: string): void => {
    this.orchestrations.delete(turnId);
  };

  private dispatch = (
    turn: CollaborationTurn,
    callbacks: CollaborationCallbacks,
    tasks: readonly DispatchTask[],
  ): Readonly<{ orchestrationId: string; accepted: readonly string[] }> => {
    const existing = this.orchestrations.get(turn.turnId);
    const orchestration = existing ?? {
      id: `orch/${turn.threadId}/${turn.turnId}`,
      turn,
      callbacks,
      tasks: new Map<string, TaskRecord>(),
      waiters: new Set<() => void>(),
    };
    if (
      existing &&
      (existing.turn.workspaceId !== turn.workspaceId ||
        existing.turn.threadId !== turn.threadId)
    ) {
      throw new Error('A Turn cannot cross collaboration ownership.');
    }
    this.validateDispatch(orchestration, tasks);
    const created = tasks.map((task): TaskRecord => ({
      snapshot: {
        orchestrationId: orchestration.id,
        taskId: randomUUID(),
        clientTaskKey: task.clientTaskKey,
        childThreadId: randomUUID(),
        title: task.title,
        role: task.role,
        access: task.access,
        dependsOn: [...task.dependsOn],
        taskMarkdown: task.taskMarkdown,
        status: 'queued',
        amendments: [],
      },
      deliveredAmendments: 0,
      launchStarted: false,
    }));
    callbacks.createTasks(created.map((task) => task.snapshot));
    if (!existing) {
      this.orchestrations.set(turn.turnId, orchestration);
    }
    for (const task of created) {
      orchestration.tasks.set(task.snapshot.clientTaskKey, task);
      callbacks.publishTask(task.snapshot);
    }
    this.schedule(orchestration);
    return {
      orchestrationId: orchestration.id,
      accepted: created.map((task) => task.snapshot.clientTaskKey),
    };
  };

  private amend = (
    turnId: string,
    clientTaskKey: string,
    amendmentMarkdown: string,
  ): Readonly<{ accepted: true }> => {
    const { orchestration, task } = this.requireTask(turnId, clientTaskKey);
    const total = task.snapshot.amendments.reduce(
      (bytes, amendment) => bytes + utf8Bytes(amendment.markdown),
      0,
    );
    if (
      terminal(task.snapshot.status) ||
      amendmentMarkdown.length === 0 ||
      utf8Bytes(amendmentMarkdown) > MAX_AMENDMENT_BYTES ||
      total + utf8Bytes(amendmentMarkdown) > MAX_TOTAL_AMENDMENT_BYTES
    ) {
      throw new Error('The Agent task cannot accept this amendment.');
    }
    task.snapshot = {
      ...task.snapshot,
      amendments: [
        ...task.snapshot.amendments,
        { id: randomUUID(), markdown: amendmentMarkdown },
      ],
    };
    this.persistAndPublish(orchestration, task);
    return { accepted: true };
  };

  private wait = async (
    turnId: string,
    clientTaskKeys: readonly string[],
    signal: AbortSignal,
  ): Promise<Readonly<{ orchestrationId: string; tasks: readonly unknown[] }>> => {
    const orchestration = this.orchestrations.get(turnId);
    if (!orchestration) {
      throw new Error('This Turn has no collaboration DAG.');
    }
    const selected = (): TaskRecord[] => {
      const keys = clientTaskKeys.length > 0
        ? clientTaskKeys
        : [...orchestration.tasks.keys()];
      return keys.map((key) => {
        const task = orchestration.tasks.get(key);
        if (!task) {
          throw new Error(`Unknown Agent task: ${key}.`);
        }
        return task;
      });
    };
    while (!selected().every((task) => terminal(task.snapshot.status))) {
      await this.waitForChange(orchestration, signal);
    }
    return {
      orchestrationId: orchestration.id,
      tasks: selected().map((task) => ({
        clientTaskKey: task.snapshot.clientTaskKey,
        status: task.snapshot.status,
        summaryMarkdown: task.snapshot.result?.summaryMarkdown ?? '',
        durationMs: task.snapshot.result?.durationMs ?? 0,
      })),
    };
  };

  private interrupt = (
    turnId: string,
    clientTaskKey: string,
  ): Readonly<{ accepted: boolean; alreadyTerminal?: true }> => {
    const { orchestration, task } = this.requireTask(turnId, clientTaskKey);
    if (terminal(task.snapshot.status)) {
      return { accepted: false, alreadyTerminal: true };
    }
    task.controller?.abort();
    this.transition(orchestration, task, 'cancelled', 'Cancelled by the parent Agent.', 0);
    this.schedule(orchestration);
    return { accepted: true };
  };

  private schedule = (orchestration: Orchestration): void => {
    const statuses = new Map(
      [...orchestration.tasks].map(([key, task]) => [key, task.snapshot.status]),
    );
    for (const task of orchestration.tasks.values()) {
      if (task.snapshot.status !== 'queued' || task.launchStarted) {
        continue;
      }
      const dependencyStatuses = task.snapshot.dependsOn.map(
        (dependency) => statuses.get(dependency) ?? 'failed',
      );
      const blocked = task.snapshot.role !== 'auditor' && dependencyStatuses.some(
        (status) => terminal(status) && status !== 'completed',
      );
      const ready = task.snapshot.role === 'auditor'
        ? dependencyStatuses.every(terminal)
        : dependencyStatuses.every((status) => status === 'completed');
      if (blocked) {
        this.transition(
          orchestration,
          task,
          'cancelled',
          'Cancelled because a dependency did not complete successfully.',
          0,
        );
      } else if (ready) {
        task.launchStarted = true;
        void this.runTask(orchestration, task);
      }
    }
  };

  private runTask = async (
    orchestration: Orchestration,
    task: TaskRecord,
  ): Promise<void> => {
    const controller = new AbortController();
    task.controller = controller;
    let releaseSlot: Release | undefined;
    let releaseWorkspace: Release | undefined;
    try {
      releaseSlot = await this.slots.acquire(controller.signal);
      const gate = this.workspaceGates.get(orchestration.turn.workspaceId) ??
        new WorkspaceAccessGate();
      this.workspaceGates.set(orchestration.turn.workspaceId, gate);
      releaseWorkspace = await gate.acquire(task.snapshot.access, controller.signal);
      if (terminal(task.snapshot.status)) {
        return;
      }
      this.setStatus(orchestration, task, 'running');
      const dependencyResults = task.snapshot.dependsOn.map((dependency) =>
        orchestration.tasks.get(dependency)?.snapshot,
      ).filter((dependency): dependency is RuntimeAgentTask => Boolean(dependency));
      const result = await orchestration.callbacks.executeTask({
        task: task.snapshot,
        dependencyResults,
        signal: controller.signal,
        takeAmendments: () => {
          const pending = task.snapshot.amendments
            .slice(task.deliveredAmendments)
            .map((amendment) => amendment.markdown);
          task.deliveredAmendments = task.snapshot.amendments.length;
          return pending;
        },
        setWaitingApproval: (waiting) => {
          if (terminal(task.snapshot.status)) {
            return;
          }
          this.setStatus(orchestration, task, waiting ? 'waitingApproval' : 'running');
        },
      });
      if (!terminal(task.snapshot.status)) {
        this.transition(
          orchestration,
          task,
          result.status,
          result.summaryMarkdown,
          result.durationMs,
        );
      }
    } catch (error) {
      if (!terminal(task.snapshot.status)) {
        this.transition(
          orchestration,
          task,
          controller.signal.aborted ? 'interrupted' : 'failed',
          controller.signal.aborted
            ? 'Agent task interrupted.'
            : error instanceof Error
              ? error.message
              : 'Agent task failed.',
          0,
        );
      }
    } finally {
      releaseWorkspace?.();
      releaseSlot?.();
      task.controller = undefined;
      this.schedule(orchestration);
      this.notify(orchestration);
    }
  };

  private setStatus = (
    orchestration: Orchestration,
    task: TaskRecord,
    status: RuntimeAgentTaskStatus,
  ): void => {
    if (task.snapshot.status === status) {
      return;
    }
    task.snapshot = { ...task.snapshot, status };
    this.persistAndPublish(orchestration, task);
  };

  private transition = (
    orchestration: Orchestration,
    task: TaskRecord,
    status: Extract<
      RuntimeAgentTaskStatus,
      'completed' | 'failed' | 'interrupted' | 'cancelled'
    >,
    summaryMarkdown: string,
    durationMs: number,
  ): void => {
    task.snapshot = {
      ...task.snapshot,
      status,
      result: {
        id: randomUUID(),
        summaryMarkdown: summaryMarkdown.slice(0, 16 * 1024),
        durationMs: Math.max(0, Math.trunc(durationMs)),
      },
    };
    this.persistAndPublish(orchestration, task);
  };

  private persistAndPublish = (
    orchestration: Orchestration,
    task: TaskRecord,
  ): void => {
    orchestration.callbacks.updateTask(task.snapshot);
    orchestration.callbacks.publishTask(task.snapshot);
    this.notify(orchestration);
  };

  private notify = (orchestration: Orchestration): void => {
    const waiters = [...orchestration.waiters];
    orchestration.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  };

  private waitForChange = (
    orchestration: Orchestration,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) {
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const changed = (): void => {
        signal.removeEventListener('abort', aborted);
        resolve();
      };
      const aborted = (): void => {
        orchestration.waiters.delete(changed);
        reject(abortError());
      };
      orchestration.waiters.add(changed);
      signal.addEventListener('abort', aborted, { once: true });
    });
  };

  private requireTask = (
    turnId: string,
    clientTaskKey: string,
  ): { orchestration: Orchestration; task: TaskRecord } => {
    const orchestration = this.orchestrations.get(turnId);
    const task = orchestration?.tasks.get(clientTaskKey);
    if (!orchestration || !task) {
      throw new Error(`Unknown Agent task: ${clientTaskKey}.`);
    }
    return { orchestration, task };
  };

  private validateDispatch = (
    orchestration: Orchestration,
    tasks: readonly DispatchTask[],
  ): void => {
    if (
      tasks.length === 0 ||
      orchestration.tasks.size + tasks.length > MAX_TASKS
    ) {
      throw new Error(`A collaboration DAG supports at most ${MAX_TASKS} tasks.`);
    }
    const keys = new Set(orchestration.tasks.keys());
    for (const task of tasks) {
      if (
        task.clientTaskKey.length === 0 ||
        utf8Bytes(task.clientTaskKey) > 128 ||
        task.title.length === 0 ||
        utf8Bytes(task.title) > 256 ||
        task.taskMarkdown.length === 0 ||
        utf8Bytes(task.taskMarkdown) > MAX_TASK_MARKDOWN_BYTES ||
        keys.has(task.clientTaskKey) ||
        (task.role === 'auditor' && task.access !== 'readOnly')
      ) {
        throw new Error('The collaboration task shape is invalid.');
      }
      keys.add(task.clientTaskKey);
    }
    const auditors = [...orchestration.tasks.values()].filter(
      (task) => task.snapshot.role === 'auditor',
    ).length + tasks.filter((task) => task.role === 'auditor').length;
    if (auditors > MAX_AUDITORS) {
      throw new Error(`A collaboration DAG supports at most ${MAX_AUDITORS} auditors.`);
    }
    const writes = tasks
      .filter((task) => task.access === 'workspaceWrite')
      .map((task) => task.clientTaskKey);
    if (
      writes.length > 0 &&
      !tasks.some(
        (task) =>
          task.role === 'auditor' &&
          task.access === 'readOnly' &&
          writes.every((write) => task.dependsOn.includes(write)),
      )
    ) {
      throw new Error('Workspace-writing tasks require a dependent read-only auditor.');
    }
    const graph = new Map<string, readonly string[]>(
      [...orchestration.tasks].map(([key, task]) => [key, task.snapshot.dependsOn]),
    );
    for (const task of tasks) {
      graph.set(task.clientTaskKey, task.dependsOn);
    }
    if ([...graph.values()].flat().some((dependency) => !graph.has(dependency))) {
      throw new Error('Every Agent task dependency must exist in the same DAG.');
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycle = (key: string): boolean => {
      if (visited.has(key)) {
        return false;
      }
      if (visiting.has(key)) {
        return true;
      }
      visiting.add(key);
      if ((graph.get(key) ?? []).some(cycle)) {
        return true;
      }
      visiting.delete(key);
      visited.add(key);
      return false;
    };
    if ([...graph.keys()].some(cycle)) {
      throw new Error('The Agent task dependency graph contains a cycle.');
    }
  };
}
