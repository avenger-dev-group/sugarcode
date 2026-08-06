import { randomUUID } from 'node:crypto';
import type { Dialog } from 'electron';

import type { WorkspaceLaunchContext } from '@/main/workspace/controller';
import type { RuntimeSupervisor } from '@/main/runtime/supervisor';
import {
  TERMINAL_OUTPUT_CHUNK_MAX_BYTES,
  type TerminalActionReason,
  type TerminalActionResult,
  type TerminalCreateRequest,
  type TerminalExitReason,
  type TerminalFailure,
  type TerminalInputRequest,
  type TerminalOutputChunk,
  type TerminalResizeRequest,
  type TerminalSessionRequest,
  type TerminalSnapshotRequest,
  type TerminalStateSignal,
  type TerminalStateSnapshot,
} from '../../shared/terminal.ts';
import type { RuntimeEvent } from '@/runtime/protocol';

const OUTPUT_HIGH_WATER_BYTES = 768 * 1_024;
const OUTPUT_LOW_WATER_BYTES = 384 * 1_024;
const OUTPUT_HARD_LIMIT_BYTES = 1_024 * 1_024;
const INPUT_QUEUE_MAX_BYTES = 256 * 1_024;
const GRACEFUL_CLOSE_TIMEOUT_MS = 2_750;

type DialogBoundary = Pick<Dialog, 'showMessageBox'>;
type Listener = (signal: TerminalStateSignal) => void;

type TerminalControllerOptions = Readonly<{
  dialog: DialogBoundary;
  runtime: RuntimeSupervisor;
  getMainWindow: () => Electron.BrowserWindow | null;
  getWorkspace: () => WorkspaceLaunchContext | null;
  getRuntimeWorkspaceId: () => string | null;
  isApprovalPending: () => boolean;
  createSessionId?: () => string;
}>;

type ActiveTerminal = {
  generation: number;
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  status: 'starting' | 'running' | 'paused' | 'exited' | 'failed';
  shell?: string;
  expectedOutputSequence: number;
  acknowledgedThrough: number;
  output: TerminalOutputChunk[];
  outputBytes: number;
  pendingInputBytes: number;
  pendingInputs: Map<string, number>;
  approvalPaused: boolean;
  outputPaused: boolean;
  inputPaused: boolean;
  exit?: Readonly<{
    exitCode: number;
    signal?: string;
    reason: TerminalExitReason;
  }>;
  error?: TerminalFailure;
};

const actionResult = (reason: TerminalActionReason): TerminalActionResult => ({
  accepted: reason === 'accepted',
  reason,
});

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

export class TerminalController {
  private readonly options: TerminalControllerOptions;
  private readonly listeners = new Set<Listener>();
  private readonly createSessionId: () => string;
  private readonly unsubscribeRuntime: () => void;
  private revision = 0;
  private operationActive = false;
  private active: ActiveTerminal | null = null;
  private notificationScheduled = false;
  private shuttingDown = false;
  private generation = 0;
  private closeResolver: (() => void) | null = null;

  constructor(options: TerminalControllerOptions) {
    this.options = options;
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.unsubscribeRuntime = options.runtime.subscribe(this.handleRuntimeEvent);
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getFailureDiagnostic = (): string | null =>
    this.active?.status === 'failed' ? this.active.error ?? 'bridgeCrashed' : null;

  getSnapshot = (request: TerminalSnapshotRequest): TerminalStateSnapshot => {
    const active = this.active;
    if (
      !active ||
      request.generation !== active.generation ||
      (request.sessionId !== undefined && request.sessionId !== active.sessionId)
    ) {
      return this.closedSnapshot();
    }
    this.acknowledgeOutput(active, request.acknowledgeThrough);
    return this.sessionSnapshot(active);
  };

  create = async (request: TerminalCreateRequest): Promise<TerminalActionResult> => {
    if (this.operationActive || this.liveActive()) {
      return actionResult('busy');
    }
    const workspace = this.options.getWorkspace();
    const workspaceId = this.options.getRuntimeWorkspaceId();
    if (!workspace || !workspaceId) {
      return actionResult('unavailable');
    }
    if (request.generation !== workspace.generation) {
      return actionResult('stale');
    }
    if (this.options.isApprovalPending() || this.shuttingDown) {
      return actionResult('busy');
    }
    const mainWindow = this.options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return actionResult('unavailable');
    }
    this.operationActive = true;
    try {
      const confirmation = await this.options.dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Open real shell', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Open a real local shell?',
        message: `Open an interactive shell in ${workspace.name}?`,
        detail:
          'This is a real shell running under your user account. It can read and write any files your account can access, use the network, and run arbitrary local programs. SugarCode does not sandbox or approve terminal commands.',
      });
      if (confirmation.response !== 0) {
        return actionResult('cancelled');
      }
      const confirmed = this.options.getWorkspace();
      const confirmedId = this.options.getRuntimeWorkspaceId();
      if (
        !confirmed ||
        confirmed.generation !== request.generation ||
        confirmedId !== workspaceId
      ) {
        return actionResult('stale');
      }
      if (this.options.isApprovalPending() || this.shuttingDown) {
        return actionResult('busy');
      }
      this.clearExitedSession();
      const active: ActiveTerminal = {
        generation: confirmed.generation,
        sessionId: this.createSessionId(),
        workspaceId,
        workspaceName: confirmed.name,
        status: 'starting',
        expectedOutputSequence: 1,
        acknowledgedThrough: 0,
        output: [],
        outputBytes: 0,
        pendingInputBytes: 0,
        pendingInputs: new Map(),
        approvalPaused: false,
        outputPaused: false,
        inputPaused: false,
      };
      this.active = active;
      this.generation = active.generation;
      this.publish();
      try {
        this.options.runtime.send({
          type: 'terminal.create',
          requestId: randomUUID(),
          workspaceId,
          generation: active.generation,
          sessionId: active.sessionId,
          columns: request.columns,
          rows: request.rows,
        });
      } catch {
        this.fail(active, 'spawnFailed');
        return actionResult('failed');
      }
      return actionResult('accepted');
    } finally {
      this.operationActive = false;
    }
  };

  input = (request: TerminalInputRequest): TerminalActionResult => {
    const active = this.matchLiveSession(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    if (
      active.status !== 'running' ||
      active.approvalPaused ||
      active.outputPaused ||
      active.inputPaused
    ) {
      return actionResult('busy');
    }
    const requestId = randomUUID();
    const inputBytes = byteLength(request.data);
    if (active.pendingInputBytes + inputBytes > INPUT_QUEUE_MAX_BYTES) {
      active.inputPaused = true;
      this.updatePauseState(active);
      return actionResult('busy');
    }
    active.pendingInputs.set(requestId, inputBytes);
    active.pendingInputBytes += inputBytes;
    const result = this.send(active, {
      type: 'terminal.input',
      requestId,
      workspaceId: active.workspaceId,
      generation: active.generation,
      sessionId: active.sessionId,
      data: request.data,
    });
    if (!result.accepted) {
      active.pendingInputs.delete(requestId);
      active.pendingInputBytes = Math.max(
        0,
        active.pendingInputBytes - inputBytes,
      );
    }
    return result;
  };

  resize = (request: TerminalResizeRequest): TerminalActionResult => {
    const active = this.matchLiveSession(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    return this.send(active, {
      type: 'terminal.resize',
      requestId: randomUUID(),
      workspaceId: active.workspaceId,
      generation: active.generation,
      sessionId: active.sessionId,
      columns: request.columns,
      rows: request.rows,
    });
  };

  terminate = (request: TerminalSessionRequest): TerminalActionResult => {
    const active = this.matchLiveSession(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    return this.requestTermination(active);
  };

  pauseForApproval = (): void => {
    const active = this.liveActive();
    if (active && !active.approvalPaused) {
      active.approvalPaused = true;
      this.updatePauseState(active);
    }
  };

  resumeAfterApproval = (): void => {
    const active = this.liveActive();
    if (active?.approvalPaused) {
      active.approvalPaused = false;
      this.updatePauseState(active);
    }
  };

  closeForWorkspaceChange = (): Promise<void> => this.closeOwnedSession(false);

  rendererUnavailable = (): void => {
    void this.closeOwnedSession(true);
  };

  shutdown = (): void => {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.unsubscribeRuntime();
    const active = this.active;
    if (active) {
      this.sendClose(active);
    }
    this.active = null;
    this.closeResolver?.();
    this.closeResolver = null;
    this.publish();
  };

  private handleRuntimeEvent = (event: RuntimeEvent): void => {
    if (
      event.type !== 'terminal.started' &&
      event.type !== 'terminal.inputAccepted' &&
      event.type !== 'terminal.output' &&
      event.type !== 'terminal.error' &&
      event.type !== 'terminal.exited'
    ) {
      return;
    }
    const active = this.active;
    if (
      !active ||
      event.workspaceId !== active.workspaceId ||
      event.generation !== active.generation ||
      event.sessionId !== active.sessionId
    ) {
      return;
    }
    if (event.type === 'terminal.inputAccepted') {
      const inputBytes = active.pendingInputs.get(event.requestId);
      if (inputBytes === undefined || inputBytes !== event.inputBytes) {
        this.fail(active, 'protocolInvalid');
        return;
      }
      active.pendingInputs.delete(event.requestId);
      active.pendingInputBytes = Math.max(
        0,
        active.pendingInputBytes - inputBytes,
      );
      if (
        active.inputPaused &&
        active.pendingInputBytes <= INPUT_QUEUE_MAX_BYTES / 2
      ) {
        active.inputPaused = false;
        this.updatePauseState(active);
      }
      return;
    }
    if (event.type === 'terminal.started') {
      if (active.status !== 'starting') {
        this.fail(active, 'protocolInvalid');
        return;
      }
      active.shell = event.shell;
      active.status = this.isPaused(active) ? 'paused' : 'running';
      this.publish();
      return;
    }
    if (event.type === 'terminal.output') {
      if (
        active.status === 'starting' ||
        event.outputSequence !== active.expectedOutputSequence
      ) {
        this.fail(active, 'protocolInvalid');
        return;
      }
      active.expectedOutputSequence += 1;
      const bytes = byteLength(event.data);
      if (
        bytes > TERMINAL_OUTPUT_CHUNK_MAX_BYTES ||
        active.outputBytes + bytes > OUTPUT_HARD_LIMIT_BYTES
      ) {
        this.fail(active, 'outputOverload');
        return;
      }
      active.output.push({ sequence: event.outputSequence, data: event.data });
      active.outputBytes += bytes;
      if (active.outputBytes >= OUTPUT_HIGH_WATER_BYTES && !active.outputPaused) {
        active.outputPaused = true;
        this.sendFlow(active, true);
        this.updatePauseState(active);
      } else {
        this.schedulePublish();
      }
      return;
    }
    if (event.type === 'terminal.error') {
      if (event.fatal) {
        this.fail(active, event.error);
      }
      return;
    }
    active.exit = {
      exitCode: event.exitCode,
      ...(event.signal ? { signal: event.signal } : {}),
      reason: event.reason,
    };
    active.status = 'exited';
    active.approvalPaused = false;
    active.outputPaused = false;
    active.inputPaused = false;
    active.pendingInputs.clear();
    active.pendingInputBytes = 0;
    this.closeResolver?.();
    this.closeResolver = null;
    this.publish();
  };

  private send = (
    active: ActiveTerminal,
    command: Parameters<RuntimeSupervisor['send']>[0],
  ): TerminalActionResult => {
    try {
      this.options.runtime.send(command);
      return actionResult('accepted');
    } catch {
      this.fail(active, 'bridgeCrashed');
      return actionResult('failed');
    }
  };

  private requestTermination = (active: ActiveTerminal): TerminalActionResult =>
    this.send(active, {
      type: 'terminal.terminate',
      requestId: randomUUID(),
      workspaceId: active.workspaceId,
      generation: active.generation,
      sessionId: active.sessionId,
    });

  private sendFlow = (active: ActiveTerminal, paused: boolean): void => {
    try {
      this.options.runtime.send({
        type: 'terminal.flow',
        requestId: randomUUID(),
        workspaceId: active.workspaceId,
        generation: active.generation,
        sessionId: active.sessionId,
        paused,
      });
    } catch {
      this.fail(active, 'bridgeCrashed');
    }
  };

  private sendClose = (active: ActiveTerminal): void => {
    try {
      this.options.runtime.send({
        type: 'terminal.close',
        requestId: randomUUID(),
        workspaceId: active.workspaceId,
        generation: active.generation,
        sessionId: active.sessionId,
      });
    } catch {
      // Runtime shutdown also drops native process containment.
    }
  };

  private acknowledgeOutput = (active: ActiveTerminal, through: number): void => {
    const maximum = active.expectedOutputSequence - 1;
    if (through <= active.acknowledgedThrough || through > maximum) {
      return;
    }
    active.acknowledgedThrough = through;
    while (active.output[0]?.sequence <= through) {
      const removed = active.output.shift();
      if (removed) {
        active.outputBytes -= byteLength(removed.data);
      }
    }
    if (active.outputPaused && active.outputBytes <= OUTPUT_LOW_WATER_BYTES) {
      active.outputPaused = false;
      this.sendFlow(active, false);
      this.updatePauseState(active);
    }
  };

  private closeOwnedSession = async (immediate: boolean): Promise<void> => {
    const active = this.active;
    if (!active) {
      this.publish();
      return;
    }
    if (active.status === 'running' || active.status === 'paused' || active.status === 'starting') {
      if (!immediate) {
        const exited = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, GRACEFUL_CLOSE_TIMEOUT_MS);
          this.closeResolver = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        const result = this.requestTermination(active);
        if (!result.accepted) {
          this.closeResolver?.();
        }
        await exited;
        this.closeResolver = null;
      }
      this.sendClose(active);
    }
    if (this.active === active) {
      this.active = null;
      this.publish();
    }
  };

  private fail = (active: ActiveTerminal, error: TerminalFailure): void => {
    if (this.active !== active || active.status === 'failed') {
      return;
    }
    active.status = 'failed';
    active.error = error;
    active.inputPaused = false;
    active.pendingInputs.clear();
    active.pendingInputBytes = 0;
    this.sendClose(active);
    this.closeResolver?.();
    this.closeResolver = null;
    this.publish();
  };

  private updatePauseState = (active: ActiveTerminal): void => {
    if (active.status === 'running' || active.status === 'paused') {
      active.status = this.isPaused(active) ? 'paused' : 'running';
      this.publish();
    }
  };

  private isPaused = (active: ActiveTerminal): boolean =>
    active.approvalPaused || active.outputPaused || active.inputPaused;

  private liveActive = (): ActiveTerminal | null =>
    this.active && ['starting', 'running', 'paused'].includes(this.active.status)
      ? this.active
      : null;

  private matchLiveSession = (request: TerminalSessionRequest): ActiveTerminal | null => {
    const active = this.liveActive();
    return active &&
      active.generation === request.generation &&
      active.sessionId === request.sessionId
      ? active
      : null;
  };

  private isStale = (request: TerminalSessionRequest): boolean =>
    request.generation !== (this.active?.generation ?? this.generation) ||
    (this.active !== null && request.sessionId !== this.active.sessionId);

  private clearExitedSession = (): void => {
    if (this.active && ['exited', 'failed'].includes(this.active.status)) {
      this.active = null;
    }
  };

  private sessionSnapshot = (active: ActiveTerminal): TerminalStateSnapshot => {
    const base = {
      revision: this.revision,
      generation: active.generation,
      sessionId: active.sessionId,
      workspaceName: active.workspaceName,
      ...(active.shell ? { shell: active.shell } : {}),
      acknowledgedThrough: active.acknowledgedThrough,
      output: [...active.output],
    };
    if (active.status === 'exited' && active.exit) {
      return { ...base, status: 'exited', ...active.exit };
    }
    if (active.status === 'failed' && active.error) {
      return { ...base, status: 'failed', error: active.error };
    }
    if (
      active.status === 'starting' ||
      active.status === 'running' ||
      active.status === 'paused'
    ) {
      return { ...base, status: active.status };
    }
    return { ...base, status: 'failed', error: 'protocolInvalid' };
  };

  private closedSnapshot = (): TerminalStateSnapshot => ({
    revision: this.revision,
    generation: this.options.getWorkspace()?.generation ?? this.generation,
    status: 'closed',
    acknowledgedThrough: 0,
    output: [],
  });

  private publish = (): void => {
    this.notificationScheduled = false;
    this.revision += 1;
    const active = this.active;
    const signal: TerminalStateSignal = {
      revision: this.revision,
      generation: active?.generation ?? this.generation,
      status: active?.status ?? 'closed',
      ...(active ? { sessionId: active.sessionId } : {}),
    };
    for (const listener of this.listeners) {
      listener(signal);
    }
  };

  private schedulePublish = (): void => {
    if (this.notificationScheduled) {
      return;
    }
    this.notificationScheduled = true;
    setImmediate(this.publish);
  };
}
