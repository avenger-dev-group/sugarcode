import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Dialog } from 'electron';

import type { ResolvedCli } from '@/main/app-server/cli/resolution';
import type { WorkspaceLaunchContext } from '@/main/app-server/workspace/controller';
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
} from '@/shared/terminal';

const BRIDGE_PROTOCOL_VERSION = 1;
const BRIDGE_EVENT_MAX_BYTES = 65_536;
const OUTPUT_HIGH_WATER_BYTES = 768 * 1_024;
const OUTPUT_LOW_WATER_BYTES = 384 * 1_024;
const OUTPUT_HARD_LIMIT_BYTES = 1_024 * 1_024;
const INPUT_QUEUE_MAX_BYTES = 256 * 1_024;
const STDERR_TAIL_MAX_BYTES = 8 * 1_024;
const GRACEFUL_CLOSE_TIMEOUT_MS = 2_750;

type DialogBoundary = Pick<Dialog, 'showMessageBox'>;
type Listener = (signal: TerminalStateSignal) => void;
type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

type TerminalControllerOptions = Readonly<{
  dialog: DialogBoundary;
  getMainWindow: () => Electron.BrowserWindow | null;
  getWorkspace: () => WorkspaceLaunchContext | null;
  getResolvedCli: () => ResolvedCli | null;
  getCliEnvironment: () => NodeJS.ProcessEnv;
  isApprovalPending: () => boolean;
  spawnProcess?: SpawnProcess;
  createSessionId?: () => string;
}>;

type ActiveTerminal = {
  generation: number;
  sessionId: string;
  workspaceName: string;
  child: ChildProcessWithoutNullStreams | null;
  status: 'starting' | 'running' | 'paused' | 'exited' | 'failed';
  shell?: string;
  processGroupId?: number;
  bridgeSequence: number;
  expectedOutputSequence: number;
  acknowledgedThrough: number;
  output: TerminalOutputChunk[];
  outputBytes: number;
  pendingInputBytes: number;
  stdoutBuffer: Buffer;
  stderrTail: Buffer;
  approvalPaused: boolean;
  outputPaused: boolean;
  inputPaused: boolean;
  exit?: Readonly<{
    exitCode: number;
    signal?: string;
    reason: TerminalExitReason;
  }>;
  error?: TerminalFailure;
  exitEventSeen: boolean;
  closingForOwner: boolean;
};

type BridgeReadyEvent = Readonly<{
  type: 'ready';
  version: number;
  shell: string;
  encoding: 'utf-8-replacement';
  processGroupId: number | null;
}>;

type BridgeOutputEvent = Readonly<{
  type: 'output';
  sequence: number;
  data: string;
}>;

type BridgeErrorEvent = Readonly<{
  type: 'error';
  code: string;
  message: string;
  fatal: boolean;
}>;

type BridgeExitEvent = Readonly<{
  type: 'exit';
  exitCode: number;
  signal?: string;
  reason: TerminalExitReason;
}>;

type BridgeEvent =
  | BridgeReadyEvent
  | BridgeOutputEvent
  | BridgeErrorEvent
  | BridgeExitEvent;

const actionResult = (
  reason: TerminalActionReason,
): TerminalActionResult => ({
  accepted: reason === 'accepted',
  reason,
});

const byteLength = (value: string): number =>
  Buffer.byteLength(value, 'utf8');

export class TerminalController {
  private readonly listeners = new Set<Listener>();
  private readonly spawnProcess: SpawnProcess;
  private readonly createSessionId: () => string;
  private revision = 0;
  private operationActive = false;
  private active: ActiveTerminal | null = null;
  private notificationScheduled = false;
  private shuttingDown = false;
  private generation = 0;

  constructor(private readonly options: TerminalControllerOptions) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.createSessionId = options.createSessionId ?? randomUUID;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getFailureDiagnostic = (): string | null => {
    const active = this.active;
    if (!active || active.status !== 'failed') {
      return null;
    }
    const stderr = active.stderrTail.toString('utf8').trim();
    return stderr.length > 0
      ? `${active.error ?? 'bridgeCrashed'}: ${stderr}`
      : (active.error ?? 'bridgeCrashed');
  };

  getSnapshot = (
    request: TerminalSnapshotRequest,
  ): TerminalStateSnapshot => {
    const active = this.active;
    if (
      !active ||
      request.generation !== active.generation ||
      (request.sessionId !== undefined &&
        request.sessionId !== active.sessionId)
    ) {
      return this.closedSnapshot();
    }
    this.acknowledgeOutput(active, request.acknowledgeThrough);
    return this.sessionSnapshot(active);
  };

  create = async (
    request: TerminalCreateRequest,
  ): Promise<TerminalActionResult> => {
    if (this.operationActive || this.liveChild()) {
      return actionResult('busy');
    }
    const workspace = this.options.getWorkspace();
    if (!workspace) {
      return actionResult('unavailable');
    }
    if (request.generation !== workspace.generation) {
      return actionResult('stale');
    }
    if (this.options.isApprovalPending() || this.shuttingDown) {
      return actionResult('busy');
    }
    const mainWindow = this.options.getMainWindow();
    const cli = this.options.getResolvedCli();
    if (!mainWindow || mainWindow.isDestroyed() || !cli) {
      return actionResult('unavailable');
    }

    this.operationActive = true;
    try {
      const confirmation = await this.options.dialog.showMessageBox(
        mainWindow,
        {
          type: 'warning',
          buttons: ['Open real shell', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          title: 'Open a real local shell?',
          message: `Open an interactive shell in ${workspace.name}?`,
          detail:
            'This is a real shell running under your user account. It can read and write any files your account can access, use the network, and run arbitrary local programs. SugarCode does not sandbox or approve terminal commands.',
        },
      );
      if (confirmation.response !== 0) {
        return actionResult('cancelled');
      }
      const confirmedWorkspace = this.options.getWorkspace();
      if (
        !confirmedWorkspace ||
        confirmedWorkspace.generation !== request.generation
      ) {
        return actionResult('stale');
      }
      if (this.options.isApprovalPending() || this.shuttingDown) {
        return actionResult('busy');
      }
      this.clearExitedSession();
      return this.spawnTerminal(confirmedWorkspace, cli, request);
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
    if (!this.writeBridgeCommand(active, {
      type: 'input',
      data: request.data,
    })) {
      return actionResult('busy');
    }
    return actionResult('accepted');
  };

  resize = (request: TerminalResizeRequest): TerminalActionResult => {
    const active = this.matchLiveSession(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    if (
      !this.writeBridgeCommand(active, {
        type: 'resize',
        columns: request.columns,
        rows: request.rows,
      })
    ) {
      return actionResult('busy');
    }
    return actionResult('accepted');
  };

  terminate = (
    request: TerminalSessionRequest,
  ): TerminalActionResult => {
    const active = this.matchLiveSession(request);
    if (!active) {
      return actionResult(this.isStale(request) ? 'stale' : 'unavailable');
    }
    this.requestBridgeTermination(active);
    return actionResult('accepted');
  };

  pauseForApproval = (): void => {
    const active = this.liveActive();
    if (!active || active.approvalPaused) {
      return;
    }
    active.approvalPaused = true;
    this.updatePauseState(active);
  };

  resumeAfterApproval = (): void => {
    const active = this.liveActive();
    if (!active || !active.approvalPaused) {
      return;
    }
    active.approvalPaused = false;
    this.updatePauseState(active);
  };

  closeForWorkspaceChange = (): Promise<void> =>
    this.closeOwnedSession(false);

  rendererUnavailable = (): void => {
    void this.closeOwnedSession(true);
  };

  shutdown = (): void => {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    const active = this.liveActive();
    if (active) {
      active.closingForOwner = true;
      this.killProcessTree(active);
    }
    this.active = null;
    this.publish();
  };

  private spawnTerminal = (
    workspace: WorkspaceLaunchContext,
    cli: ResolvedCli,
    request: TerminalCreateRequest,
  ): TerminalActionResult => {
    const active: ActiveTerminal = {
      generation: workspace.generation,
      sessionId: this.createSessionId(),
      workspaceName: workspace.name,
      child: null,
      status: 'starting',
      bridgeSequence: 0,
      expectedOutputSequence: 1,
      acknowledgedThrough: 0,
      output: [],
      outputBytes: 0,
      pendingInputBytes: 0,
      stdoutBuffer: Buffer.alloc(0),
      stderrTail: Buffer.alloc(0),
      approvalPaused: false,
      outputPaused: false,
      inputPaused: false,
      exitEventSeen: false,
      closingForOwner: false,
    };
    this.generation = workspace.generation;
    this.active = active;
    this.publish();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(
        cli.executablePath,
        [
          '__desktop-terminal',
          '--workspace',
          workspace.path,
          '--columns',
          String(request.columns),
          '--rows',
          String(request.rows),
        ],
        {
          cwd: cli.workingDirectory,
          env: this.options.getCliEnvironment(),
          windowsHide: true,
        },
      );
    } catch {
      this.fail(active, 'spawnFailed');
      return actionResult('failed');
    }
    active.child = child;
    child.stdin.on('error', () => {
      if (this.active === active && !active.closingForOwner) {
        this.fail(active, 'bridgeCrashed');
      }
    });
    child.stdout.on('data', (chunk: Buffer | string) => {
      this.consumeStdout(active, Buffer.from(chunk));
    });
    child.stdout.once('end', () => {
      if (active.stdoutBuffer.length > 0 && this.active === active) {
        this.fail(active, 'protocolInvalid');
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.captureStderr(active, Buffer.from(chunk));
    });
    child.once('error', () => {
      if (this.active === active) {
        this.fail(active, 'spawnFailed');
      }
    });
    child.once('close', () => {
      this.handleChildClose(active);
    });
    return actionResult('accepted');
  };

  private consumeStdout = (active: ActiveTerminal, chunk: Buffer): void => {
    if (this.active !== active || active.status === 'failed') {
      return;
    }
    active.stdoutBuffer = Buffer.concat([active.stdoutBuffer, chunk]);
    let newline = active.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = active.stdoutBuffer.subarray(0, newline);
      active.stdoutBuffer = active.stdoutBuffer.subarray(newline + 1);
      if (line.length === 0 || line.length > BRIDGE_EVENT_MAX_BYTES) {
        this.fail(active, 'protocolInvalid');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString('utf8'));
      } catch {
        this.fail(active, 'protocolInvalid');
        return;
      }
      const event = parseBridgeEvent(parsed);
      if (!event || !this.acceptBridgeEvent(active, event)) {
        this.fail(active, 'protocolInvalid');
        return;
      }
      newline = active.stdoutBuffer.indexOf(0x0a);
    }
    if (active.stdoutBuffer.length > BRIDGE_EVENT_MAX_BYTES) {
      this.fail(active, 'protocolInvalid');
    }
  };

  private acceptBridgeEvent = (
    active: ActiveTerminal,
    event: BridgeEvent,
  ): boolean => {
    if (event.type === 'ready') {
      if (
        active.status !== 'starting' ||
        event.version !== BRIDGE_PROTOCOL_VERSION
      ) {
        return false;
      }
      active.shell = event.shell;
      active.processGroupId = event.processGroupId ?? undefined;
      active.status = this.isPaused(active) ? 'paused' : 'running';
      this.publish();
      return true;
    }
    if (event.type === 'output') {
      if (
        active.status === 'starting' ||
        event.sequence !== active.expectedOutputSequence
      ) {
        return false;
      }
      active.expectedOutputSequence += 1;
      const bytes = byteLength(event.data);
      if (
        bytes > TERMINAL_OUTPUT_CHUNK_MAX_BYTES ||
        active.outputBytes + bytes > OUTPUT_HARD_LIMIT_BYTES
      ) {
        this.fail(active, 'outputOverload');
        return true;
      }
      active.output.push({
        sequence: event.sequence,
        data: event.data,
      });
      active.outputBytes += bytes;
      if (
        active.outputBytes >= OUTPUT_HIGH_WATER_BYTES &&
        !active.outputPaused
      ) {
        active.outputPaused = true;
        active.child?.stdout.pause();
        this.updatePauseState(active);
      } else {
        this.schedulePublish();
      }
      return true;
    }
    if (event.type === 'error') {
      if (event.fatal) {
        this.fail(active, 'bridgeCrashed');
      } else {
        this.schedulePublish();
      }
      return true;
    }
    if (active.exitEventSeen || active.status === 'starting') {
      return false;
    }
    active.exitEventSeen = true;
    active.exit = {
      exitCode: event.exitCode,
      ...(event.signal ? { signal: event.signal } : {}),
      reason: event.reason,
    };
    active.status = 'exited';
    active.approvalPaused = false;
    active.outputPaused = false;
    active.inputPaused = false;
    this.publish();
    return true;
  };

  private acknowledgeOutput = (
    active: ActiveTerminal,
    acknowledgeThrough: number,
  ): void => {
    const maximum = active.expectedOutputSequence - 1;
    if (
      acknowledgeThrough <= active.acknowledgedThrough ||
      acknowledgeThrough > maximum
    ) {
      return;
    }
    active.acknowledgedThrough = acknowledgeThrough;
    while (
      active.output.length > 0 &&
      active.output[0].sequence <= acknowledgeThrough
    ) {
      const [removed] = active.output.splice(0, 1);
      active.outputBytes -= byteLength(removed.data);
    }
    if (
      active.outputPaused &&
      active.outputBytes <= OUTPUT_LOW_WATER_BYTES
    ) {
      active.outputPaused = false;
      active.child?.stdout.resume();
      this.updatePauseState(active);
    }
  };

  private writeBridgeCommand = (
    active: ActiveTerminal,
    command: Readonly<Record<string, unknown>>,
  ): boolean => {
    const child = active.child;
    if (!child || child.exitCode !== null || child.killed) {
      return false;
    }
    active.bridgeSequence += 1;
    const encoded = `${JSON.stringify({
      ...command,
      sequence: active.bridgeSequence,
    })}\n`;
    const bytes = byteLength(encoded);
    if (active.pendingInputBytes + bytes > INPUT_QUEUE_MAX_BYTES) {
      active.bridgeSequence -= 1;
      active.inputPaused = true;
      this.updatePauseState(active);
      return false;
    }
    active.pendingInputBytes += bytes;
    const accepted = child.stdin.write(encoded, 'utf8', () => {
      if (this.active !== active) {
        return;
      }
      active.pendingInputBytes = Math.max(
        0,
        active.pendingInputBytes - bytes,
      );
      if (
        active.inputPaused &&
        active.pendingInputBytes <= INPUT_QUEUE_MAX_BYTES / 2
      ) {
        active.inputPaused = false;
        this.updatePauseState(active);
      }
    });
    if (!accepted) {
      active.inputPaused = true;
      this.updatePauseState(active);
    }
    return true;
  };

  private requestBridgeTermination = (active: ActiveTerminal): void => {
    if (!this.writeBridgeCommand(active, { type: 'terminate' })) {
      this.killProcessTree(active);
    }
  };

  private closeOwnedSession = async (
    rendererLost: boolean,
  ): Promise<void> => {
    const active = this.liveActive();
    if (!active) {
      this.active = null;
      this.publish();
      return;
    }
    active.closingForOwner = true;
    if (rendererLost) {
      this.killProcessTree(active);
    } else {
      this.requestBridgeTermination(active);
    }
    await this.waitForClose(active);
    if (this.active === active) {
      this.killProcessTree(active);
      this.active = null;
      this.publish();
    }
  };

  private waitForClose = (active: ActiveTerminal): Promise<void> => {
    const child = active.child;
    if (!child || child.exitCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(finish, GRACEFUL_CLOSE_TIMEOUT_MS);
      child.once('close', finish);
    });
  };

  private killProcessTree = (active: ActiveTerminal): void => {
    if (
      process.platform !== 'win32' &&
      active.processGroupId !== undefined
    ) {
      try {
        process.kill(-active.processGroupId, 'SIGKILL');
      } catch {
        // The bridge's Rust containment may already have reaped the tree.
      }
    }
    const child = active.child;
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
  };

  private handleChildClose = (active: ActiveTerminal): void => {
    active.child = null;
    if (this.active !== active) {
      return;
    }
    if (active.closingForOwner || this.shuttingDown) {
      this.active = null;
      this.publish();
      return;
    }
    if (!active.exitEventSeen && active.status !== 'failed') {
      this.fail(active, 'bridgeCrashed', false);
    }
  };

  private fail = (
    active: ActiveTerminal,
    error: TerminalFailure,
    kill = true,
  ): void => {
    if (this.active !== active || active.status === 'failed') {
      return;
    }
    active.status = 'failed';
    active.error = error;
    if (kill) {
      this.killProcessTree(active);
    }
    this.publish();
  };

  private updatePauseState = (active: ActiveTerminal): void => {
    if (active.status !== 'running' && active.status !== 'paused') {
      return;
    }
    active.status = this.isPaused(active) ? 'paused' : 'running';
    this.publish();
  };

  private isPaused = (active: ActiveTerminal): boolean =>
    active.approvalPaused || active.outputPaused || active.inputPaused;

  private captureStderr = (
    active: ActiveTerminal,
    chunk: Buffer,
  ): void => {
    const combined = Buffer.concat([active.stderrTail, chunk]);
    active.stderrTail =
      combined.length <= STDERR_TAIL_MAX_BYTES
        ? combined
        : combined.subarray(combined.length - STDERR_TAIL_MAX_BYTES);
  };

  private sessionSnapshot = (
    active: ActiveTerminal,
  ): TerminalStateSnapshot => {
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
      return {
        ...base,
        status: 'exited',
        exitCode: active.exit.exitCode,
        ...(active.exit.signal ? { signal: active.exit.signal } : {}),
        reason: active.exit.reason,
      };
    }
    if (active.status === 'failed' && active.error) {
      return {
        ...base,
        status: 'failed',
        error: active.error,
      };
    }
    if (
      active.status === 'starting' ||
      active.status === 'running' ||
      active.status === 'paused'
    ) {
      return {
        ...base,
        status: active.status,
      };
    }
    return {
      ...base,
      status: 'failed',
      error: active.error ?? 'bridgeCrashed',
    };
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
      generation:
        active?.generation ??
        this.options.getWorkspace()?.generation ??
        this.generation,
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
    setImmediate(() => {
      if (this.notificationScheduled) {
        this.publish();
      }
    });
  };

  private matchLiveSession = (
    request: TerminalSessionRequest,
  ): ActiveTerminal | null => {
    const active = this.liveActive();
    return active &&
      active.generation === request.generation &&
      active.sessionId === request.sessionId
      ? active
      : null;
  };

  private liveActive = (): ActiveTerminal | null =>
    this.active?.status === 'starting' ||
    this.active?.status === 'running' ||
    this.active?.status === 'paused'
      ? this.active
      : null;

  private liveChild = (): boolean => this.liveActive() !== null;

  private isStale = (request: TerminalSessionRequest): boolean =>
    request.generation !==
    (this.options.getWorkspace()?.generation ?? this.generation);

  private clearExitedSession = (): void => {
    if (
      this.active?.status === 'exited' ||
      this.active?.status === 'failed'
    ) {
      this.active = null;
    }
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isBoundedString = (
  value: unknown,
  maximumBytes: number,
): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  byteLength(value) <= maximumBytes;

const parseBridgeEvent = (value: unknown): BridgeEvent | null => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  if (value.type === 'ready') {
    return hasOnlyKeys(value, [
      'type',
      'version',
      'shell',
      'encoding',
      'processGroupId',
    ]) &&
      value.version === BRIDGE_PROTOCOL_VERSION &&
      isBoundedString(value.shell, 1_024) &&
      value.encoding === 'utf-8-replacement' &&
      (value.processGroupId === null ||
        (isCount(value.processGroupId) && value.processGroupId > 1))
      ? {
          type: 'ready',
          version: BRIDGE_PROTOCOL_VERSION,
          shell: value.shell,
          encoding: value.encoding,
          processGroupId:
            typeof value.processGroupId === 'number'
              ? value.processGroupId
              : null,
        }
      : null;
  }
  if (value.type === 'output') {
    return hasOnlyKeys(value, ['type', 'sequence', 'data']) &&
      isCount(value.sequence) &&
      value.sequence > 0 &&
      typeof value.data === 'string' &&
      byteLength(value.data) <= TERMINAL_OUTPUT_CHUNK_MAX_BYTES
      ? {
          type: 'output',
          sequence: value.sequence,
          data: value.data,
        }
      : null;
  }
  if (value.type === 'error') {
    return hasOnlyKeys(value, [
      'type',
      'code',
      'message',
      'fatal',
    ]) &&
      isBoundedString(value.code, 128) &&
      isBoundedString(value.message, 2_048) &&
      typeof value.fatal === 'boolean'
      ? {
          type: 'error',
          code: value.code,
          message: value.message,
          fatal: value.fatal,
        }
      : null;
  }
  if (value.type === 'exit') {
    return hasOnlyKeys(
      value,
      ['type', 'exitCode', 'reason'],
      ['signal'],
    ) &&
      isCount(value.exitCode) &&
      (value.signal === undefined ||
        isBoundedString(value.signal, 128)) &&
      ['natural', 'requested', 'ownerLost', 'protocolError', 'ioError'].includes(
        value.reason as string,
      )
      ? {
          type: 'exit',
          exitCode: value.exitCode,
          ...(typeof value.signal === 'string'
            ? { signal: value.signal }
            : {}),
          reason: value.reason as TerminalExitReason,
        }
      : null;
  }
  return null;
};
