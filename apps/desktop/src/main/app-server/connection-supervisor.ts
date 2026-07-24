import type {
  InitializeParams,
  InitializeResponse,
} from '@sugarcode/app-server-protocol';
import {
  PROTOCOL_VERSION,
  SUGARCODE_PRODUCT_VERSION,
} from '@sugarcode/app-server-protocol';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

import type {
  ConnectionDiagnostic,
  ConnectionDiagnosticCode,
  ConnectionStateListener,
  ConnectionStateSnapshot,
  ConnectionStatus,
} from '@/shared/connection';

import {
  createDevelopmentCliEnvironment,
  DevelopmentCliError,
  resolveDevelopmentCli,
  type DevelopmentCli,
} from './development-cli';
import { DiagnosticTailBuffer } from './diagnostics';
import {
  ConnectionClosedError,
  JsonlClient,
  RpcResponseError,
} from './jsonl-client';

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

type ConnectionSupervisorOptions = Readonly<{
  desktopAppPath: string;
  clientVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  resolveCli?: (
    desktopAppPath: string,
    platform: NodeJS.Platform,
  ) => Promise<DevelopmentCli>;
  spawnProcess?: SpawnProcess;
}>;

type ExpectedPlatform = Readonly<{
  family: string;
  os: string;
  arch: string;
}>;

const DIAGNOSTIC_SUMMARIES: Record<ConnectionDiagnosticCode, string> = {
  'development-cli-missing':
    'The development CLI is unavailable. Build it before starting SugarCode.',
  'development-cli-not-executable':
    'The development CLI cannot be executed on this host.',
  'spawn-failed': 'SugarCode could not start its local CLI.',
  'initialize-rejected': 'The local CLI rejected the initialization request.',
  'protocol-invalid': 'The local CLI returned an invalid protocol message.',
  'protocol-version-mismatch':
    'The Desktop and local CLI use different protocol versions.',
  'product-version-mismatch':
    'The Desktop and local CLI product versions do not match.',
  'platform-mismatch': 'The local CLI does not match this host platform.',
  'write-failed': 'SugarCode could not write to the local CLI.',
  'server-closed': 'The local CLI connection closed.',
  'server-crashed': 'The local CLI stopped unexpectedly.',
};

const getExpectedPlatform = (
  platform: NodeJS.Platform,
  arch: string,
): ExpectedPlatform | null => {
  const osByPlatform: Partial<Record<NodeJS.Platform, string>> = {
    darwin: 'macos',
    linux: 'linux',
    win32: 'windows',
  };
  const archByNode: Record<string, string> = {
    arm64: 'aarch64',
    x64: 'x86_64',
  };
  const os = osByPlatform[platform];
  const rustArch = archByNode[arch];
  if (!os || !rustArch) {
    return null;
  }
  return {
    family: platform === 'win32' ? 'windows' : 'unix',
    os,
    arch: rustArch,
  };
};

const createDiagnostic = (
  code: ConnectionDiagnosticCode,
): ConnectionDiagnostic => ({
  code,
  summary: DIAGNOSTIC_SUMMARIES[code],
});

export class ConnectionSupervisor {
  private readonly options: Required<
    Pick<ConnectionSupervisorOptions, 'platform' | 'arch' | 'environment'>
  > &
    Omit<ConnectionSupervisorOptions, 'platform' | 'arch' | 'environment'>;
  private readonly listeners = new Set<ConnectionStateListener>();
  private readonly stderr = new DiagnosticTailBuffer();
  private snapshot: ConnectionStateSnapshot = {
    revision: 0,
    status: 'idle',
  };
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: JsonlClient | null = null;
  private startPromise: Promise<void> | null = null;
  private initializeAbortController: AbortController | null = null;
  private shuttingDown = false;
  private spawnError: Error | null = null;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private terminalHandled = false;

  constructor(options: ConnectionSupervisorOptions) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      environment: options.environment ?? process.env,
    };
  }

  getSnapshot = (): ConnectionStateSnapshot => this.snapshot;

  subscribe = (listener: ConnectionStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start = (): Promise<void> => {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.snapshot.status !== 'idle') {
      return Promise.resolve();
    }
    this.transition('connecting');
    this.startPromise = this.connect();
    return this.startPromise;
  };

  shutdown = (): void => {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.initializeAbortController?.abort();
    this.client?.close();
    if (
      this.child &&
      this.child.exitCode === null &&
      !this.child.killed
    ) {
      this.child.kill();
    }
    this.transition('closed');
  };

  getDiagnosticTailForTesting = (): string => this.stderr.toString();

  private connect = async (): Promise<void> => {
    const expectedPlatform = getExpectedPlatform(
      this.options.platform,
      this.options.arch,
    );
    if (!expectedPlatform) {
      this.fail('platform-mismatch');
      return;
    }

    let cli: DevelopmentCli;
    try {
      cli = await (
        this.options.resolveCli ?? resolveDevelopmentCli
      )(this.options.desktopAppPath, this.options.platform);
    } catch (error) {
      this.fail(
        error instanceof DevelopmentCliError
          ? error.code
          : 'development-cli-missing',
      );
      return;
    }

    try {
      const spawnProcess = this.options.spawnProcess ?? spawn;
      this.child = spawnProcess(
        cli.executablePath,
        ['app-server', '--stdio'],
        {
          cwd: cli.repositoryRoot,
          detached: false,
          env: createDevelopmentCliEnvironment(
            this.options.environment,
            this.options.platform,
          ),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch {
      this.fail('spawn-failed');
      return;
    }

    this.attachChild(this.child);
    this.initializeAbortController = new AbortController();
    this.client = new JsonlClient({
      stdin: this.child.stdin,
      stdout: this.child.stdout,
      onServerRequest: () => {
        this.failAndTerminate('protocol-invalid');
      },
      onFatalError: () => {
        this.failAndTerminate('protocol-invalid');
      },
      onTransportEnd: () => {
        if (
          !this.shuttingDown &&
          this.child?.exitCode === null &&
          this.child?.signalCode === null
        ) {
          this.failAndTerminate('protocol-invalid');
        }
      },
    });

    const initializeParams: InitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: 'sugarcode-desktop',
        title: 'SugarCode Desktop',
        version: this.options.clientVersion,
      },
      capabilities: {},
    };

    try {
      const response = await this.client.initialize(
        initializeParams,
        this.initializeAbortController.signal,
      );
      const mismatch = this.validateInitializeResponse(
        response,
        expectedPlatform,
      );
      if (mismatch) {
        this.failAndTerminate(mismatch);
        return;
      }
      await this.client.initialized();
      if (!this.shuttingDown && this.snapshot.status === 'connecting') {
        this.transition('ready');
      }
    } catch (error) {
      if (
        this.shuttingDown ||
        this.snapshot.status === 'failed' ||
        this.snapshot.status === 'closed'
      ) {
        return;
      }
      if (error instanceof RpcResponseError) {
        this.failAndTerminate('initialize-rejected');
      } else if (error instanceof ConnectionClosedError) {
        this.failAndTerminate(
          this.spawnError ? 'spawn-failed' : 'server-crashed',
        );
      } else {
        this.failAndTerminate(
          this.child.stdin.destroyed || !this.child.stdin.writable
            ? 'write-failed'
            : 'protocol-invalid',
        );
      }
    }
  };

  private validateInitializeResponse = (
    response: InitializeResponse,
    expectedPlatform: ExpectedPlatform,
  ): ConnectionDiagnosticCode | null => {
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      return 'protocol-version-mismatch';
    }
    if (
      response.serverInfo.name !== 'sugarcode' ||
      response.serverInfo.version !== SUGARCODE_PRODUCT_VERSION
    ) {
      return 'product-version-mismatch';
    }
    if (
      response.platform.family !== expectedPlatform.family ||
      response.platform.os !== expectedPlatform.os ||
      response.platform.arch !== expectedPlatform.arch
    ) {
      return 'platform-mismatch';
    }
    return null;
  };

  private attachChild = (child: ChildProcessWithoutNullStreams): void => {
    child.stderr.on('data', this.stderr.append);
    child.once('error', (error: Error) => {
      this.spawnError ??= error;
      if (!this.shuttingDown) {
        this.fail('spawn-failed');
      }
    });
    child.once('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
    });
    child.once('close', (code, signal) => {
      this.handleChildClose(code, signal);
    });
  };

  private handleChildClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (this.terminalHandled) {
      return;
    }
    this.terminalHandled = true;
    this.exitCode = code ?? this.exitCode;
    this.exitSignal = signal ?? this.exitSignal;
    this.client?.close();
    this.child = null;
    this.client = null;

    if (this.shuttingDown || this.snapshot.status === 'closed') {
      this.transition('closed');
      return;
    }
    if (this.snapshot.status === 'failed') {
      return;
    }
    if (
      this.snapshot.status === 'ready' &&
      this.exitCode === 0 &&
      this.exitSignal === null
    ) {
      this.transition('closed', createDiagnostic('server-closed'));
      return;
    }
    this.fail('server-crashed');
  };

  private failAndTerminate = (code: ConnectionDiagnosticCode): void => {
    this.fail(code);
    this.client?.close();
    if (
      this.child &&
      this.child.exitCode === null &&
      !this.child.killed
    ) {
      this.child.kill();
    }
  };

  private fail = (code: ConnectionDiagnosticCode): void => {
    if (
      this.snapshot.status === 'failed' ||
      this.snapshot.status === 'closed'
    ) {
      return;
    }
    this.transition('failed', createDiagnostic(code));
  };

  private transition = (
    status: ConnectionStatus,
    diagnostic?: ConnectionDiagnostic,
  ): void => {
    if (
      this.snapshot.status === status &&
      this.snapshot.diagnostic?.code === diagnostic?.code
    ) {
      return;
    }
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      status,
      ...(diagnostic ? { diagnostic } : {}),
    };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };
}
