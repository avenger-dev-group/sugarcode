import electron, { type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  isRuntimeEvent,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommand,
  type RuntimeEvent,
} from '../../runtime/protocol.ts';

const MAX_LOG_LENGTH = 4_096;
const MAX_RESTART_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

type RuntimeChild = Pick<
  UtilityProcess,
  'kill' | 'on' | 'once' | 'postMessage' | 'stderr'
>;

type RuntimeSupervisorOptions = Readonly<{
  runtimePath: string;
  dataDirectory: string;
  nativeModulePath: string;
  spawn?: (runtimePath: string) => RuntimeChild;
}>;

type RuntimeEventListener = (event: RuntimeEvent) => void;
type RuntimeEventType = RuntimeEvent['type'];

export type RuntimeLifecycleSnapshot = Readonly<{
  revision: number;
  status: 'idle' | 'connecting' | 'ready' | 'failed' | 'closed';
  failure?: 'spawnFailed' | 'protocolInvalid' | 'crashed';
  detail?: string;
}>;

type RuntimeLifecycleListener = (snapshot: RuntimeLifecycleSnapshot) => void;

export class RuntimeSupervisor {
  private readonly options: RuntimeSupervisorOptions;
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly lifecycleListeners = new Set<RuntimeLifecycleListener>();
  private readonly queuedCommands: RuntimeCommand[] = [];
  private readonly workspaceCommands = new Map<
    string,
    Extract<RuntimeCommand, { type: 'workspace.open' }>
  >();
  private readonly activeTurns = new Map<
    string,
    Extract<RuntimeCommand, { type: 'turn.start' | 'turn.revise' }>
  >();
  private readonly activeTerminals = new Map<
    string,
    Extract<RuntimeCommand, { type: 'terminal.create' }>
  >();
  private readonly pendingMcpSessionCommands = new Map<
    string,
    Extract<RuntimeCommand, { type: 'mcp.sessionSet' }>
  >();
  private readonly pendingToolApprovals = new Map<
    string,
    Extract<RuntimeEvent, { type: 'approval.requested' | 'mcp.approvalRequested' }>
  >();
  private activeMcpSession: Extract<
    RuntimeCommand,
    { type: 'mcp.sessionSet' }
  > | null = null;
  private child: RuntimeChild | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private sequence = 0;
  private ready = false;
  private stopped = false;
  private lifecycle: RuntimeLifecycleSnapshot = {
    revision: 0,
    status: 'idle',
  };

  constructor(options: RuntimeSupervisorOptions) {
    this.options = options;
  }

  subscribe = (listener: RuntimeEventListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getLifecycleSnapshot = (): RuntimeLifecycleSnapshot => this.lifecycle;

  subscribeLifecycle = (listener: RuntimeLifecycleListener): (() => void) => {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  };

  start = (): void => {
    if (this.child || this.stopped || this.restartTimer) {
      return;
    }
    this.publishLifecycle('connecting');
    this.spawn();
  };

  send = (command: Exclude<RuntimeCommand, { type: 'initialize' }>): void => {
    if (this.stopped) {
      throw new Error('The TypeScript runtime has been shut down.');
    }
    if (command.type === 'shutdown') {
      this.shutdown(command.requestId);
      return;
    }
    if (command.type === 'workspace.open') {
      this.workspaceCommands.set(command.workspaceId, command);
      if (!this.ready || !this.child) {
        this.start();
        return;
      }
      this.post(command);
      return;
    }
    if (!this.ready || !this.child) {
      this.queuedCommands.push(command);
      this.start();
      return;
    }
    this.post(command);
  };

  request = <TType extends RuntimeEventType>(
    command: Exclude<RuntimeCommand, { type: 'initialize' | 'shutdown' }>,
    expectedType: TType,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Extract<RuntimeEvent, { type: TType }>> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
      };
      const unsubscribe = this.subscribe((event) => {
        if (event.requestId !== command.requestId) {
          return;
        }
        if (event.type === expectedType) {
          finish();
          resolve(event as Extract<RuntimeEvent, { type: TType }>);
        } else if (event.type === 'runtime.log' && event.level === 'error') {
          finish();
          reject(new Error(event.message));
        }
      });
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`Runtime request ${command.type} timed out.`));
      }, timeoutMs);
      try {
        this.send(command);
      } catch (error) {
        finish();
        reject(error);
      }
    });

  shutdown = (requestId: string = randomUUID()): void => {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.ready = false;
    this.publishLifecycle('closed');
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.queuedCommands.length = 0;
    this.workspaceCommands.clear();
    if (this.child) {
      this.child.postMessage({ type: 'shutdown', requestId } satisfies RuntimeCommand);
      this.child.kill();
      this.child = null;
    }
    this.activeTurns.clear();
    this.activeTerminals.clear();
    this.pendingMcpSessionCommands.clear();
    this.pendingToolApprovals.clear();
    this.activeMcpSession = null;
  };

  private spawn = (): void => {
    let child: RuntimeChild;
    try {
      child = this.options.spawn
        ? this.options.spawn(this.options.runtimePath)
        : electron.utilityProcess.fork(this.options.runtimePath, [], {
            serviceName: 'SugarCode Agent Runtime',
            stdio: ['ignore', 'ignore', 'pipe'],
          });
    } catch (error) {
      this.publishLifecycle(
        'failed',
        'spawnFailed',
        error instanceof Error ? error.message : 'Runtime process spawn failed.',
      );
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.ready = false;
    child.on('message', this.handleMessage);
    child.once('spawn', () => {
      child.postMessage({
        type: 'initialize',
        requestId: randomUUID(),
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        dataDirectory: this.options.dataDirectory,
        nativeModulePath: this.options.nativeModulePath,
      } satisfies RuntimeCommand);
    });
    child.once('exit', (code) => this.handleExit(child, code));
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const message = String(chunk).trim().slice(0, MAX_LOG_LENGTH);
      if (message) {
        this.emit({
          type: 'runtime.log',
          sequence: 0,
          requestId: 'runtime-stderr',
          level: 'warn',
          message,
        });
      }
    });
  };

  private handleMessage = (value: unknown): void => {
    if (!isRuntimeEvent(value)) {
      this.ready = false;
      this.publishLifecycle(
        'failed',
        'protocolInvalid',
        'The utility runtime returned an invalid event.',
      );
      this.emit({
        type: 'runtime.log',
        sequence: 0,
        requestId: 'invalid-runtime-event',
        level: 'error',
        message: 'Rejected an invalid event from the TypeScript runtime.',
      });
      this.child?.kill();
      return;
    }
    if (value.type === 'runtime.ready') {
      this.ready = true;
      this.restartAttempt = 0;
      this.publishLifecycle('ready');
    } else if (value.type === 'turn.started') {
      const command = this.queuedCommands.find(
        (candidate) =>
          candidate.type === 'turn.start' && candidate.turnId === value.turnId,
      );
      if (command?.type === 'turn.start') {
        this.activeTurns.set(command.turnId, command);
      }
    } else if (value.type === 'turn.completed') {
      this.activeTurns.delete(value.turnId);
    } else if (value.type === 'terminal.exited' ||
      (value.type === 'terminal.error' && value.fatal)) {
      this.activeTerminals.delete(value.sessionId);
    } else if (value.type === 'mcp.sessionAction') {
      const command = this.pendingMcpSessionCommands.get(value.requestId);
      this.pendingMcpSessionCommands.delete(value.requestId);
      if (command && value.action.accepted) {
        this.activeMcpSession = {
          ...command,
          serverIds: [...value.activeServerIds],
        };
      }
    } else if (
      value.type === 'approval.requested' ||
      value.type === 'mcp.approvalRequested'
    ) {
      this.pendingToolApprovals.set(value.approvalId, value);
    } else if (
      value.type === 'approval.resolved' ||
      value.type === 'mcp.approvalResolved'
    ) {
      this.pendingToolApprovals.delete(value.approvalId);
    }
    this.emit(value);
    if (value.type === 'runtime.ready') {
      for (const command of this.workspaceCommands.values()) {
        this.post(command);
      }
      if (this.activeMcpSession) {
        this.post({
          ...this.activeMcpSession,
          requestId: randomUUID(),
        });
      }
      const commands = this.queuedCommands.splice(0);
      for (const command of commands) {
        this.post(command);
      }
    }
  };

  private post = (command: RuntimeCommand): void => {
    if (command.type === 'turn.start' || command.type === 'turn.revise') {
      this.activeTurns.set(command.turnId, command);
    } else if (command.type === 'terminal.create') {
      this.activeTerminals.set(command.sessionId, command);
    } else if (command.type === 'terminal.close') {
      this.activeTerminals.delete(command.sessionId);
    } else if (command.type === 'mcp.sessionSet') {
      this.pendingMcpSessionCommands.set(command.requestId, command);
    }
    this.child?.postMessage(command);
  };

  private handleExit = (child: RuntimeChild, code: number): void => {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.ready = false;
    this.pendingMcpSessionCommands.clear();
    for (const turn of this.activeTurns.values()) {
      this.emit({
        type: 'turn.completed',
        sequence: 0,
        requestId: turn.requestId,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: 'interrupted',
        error: {
          kind: 'connection',
          retryable: true,
          message: `The TypeScript runtime exited with code ${code}.`,
        },
      });
    }
    this.activeTurns.clear();
    for (const terminal of this.activeTerminals.values()) {
      this.emit({
        type: 'terminal.error',
        sequence: 0,
        requestId: terminal.requestId,
        workspaceId: terminal.workspaceId,
        generation: terminal.generation,
        sessionId: terminal.sessionId,
        error: 'terminalCrashed',
        fatal: true,
      });
    }
    this.activeTerminals.clear();
    if (this.stopped) {
      return;
    }
    this.publishLifecycle(
      'connecting',
      'crashed',
      `The TypeScript runtime exited with code ${code}.`,
    );
    this.scheduleRestart();
  };

  private scheduleRestart = (): void => {
    if (this.stopped || this.restartTimer) {
      return;
    }
    const delay = Math.min(
      250 * 2 ** this.restartAttempt,
      MAX_RESTART_DELAY_MS,
    );
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) {
        this.publishLifecycle('connecting');
        this.spawn();
      }
    }, delay);
  };

  private publishLifecycle = (
    status: RuntimeLifecycleSnapshot['status'],
    failure?: RuntimeLifecycleSnapshot['failure'],
    detail?: string,
  ): void => {
    this.lifecycle = {
      revision: this.lifecycle.revision + 1,
      status,
      ...(failure ? { failure } : {}),
      ...(detail ? { detail } : {}),
    };
    for (const listener of this.lifecycleListeners) {
      listener(this.lifecycle);
    }
  };

  private emit = (event: RuntimeEvent): void => {
    this.sequence += 1;
    const normalized = { ...event, sequence: this.sequence } as RuntimeEvent;
    for (const listener of this.listeners) {
      listener(normalized);
    }
  };
}
