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
import type { McpConfiguredServer } from '@/shared/mcp';

import {
  CliResolutionError,
  createCliEnvironment,
  resolveCli,
  type CliResolutionOptions,
  type ResolvedCli,
} from '../cli/resolution';
import {
  getCliTarget,
  type ExpectedCliPlatform,
} from '../cli/platform';
import { DiagnosticTailBuffer } from './diagnostics';
import {
  ConnectionClosedError,
  JsonlClient,
  RpcResponseError,
} from '../transport/jsonl-client';
import { CommandApprovalController } from '../command-approval/controller';
import { ConversationController } from '../conversation/controller';
import {
  ConversationRpcClient,
  type ConversationRpc,
} from '../conversation/rpc-client';
import { McpApprovalController } from '../mcp/approval-controller';
import { discoverMcpServers } from '../mcp/config-discovery';
import { McpSessionController } from '../mcp/session-controller';

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

type ConnectionSupervisorOptions = Readonly<{
  desktopAppPath: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  clientVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  resolveCli?: (options: CliResolutionOptions) => Promise<ResolvedCli>;
  spawnProcess?: SpawnProcess;
  discoverMcpServers?: (
    cli: ResolvedCli,
    environment: NodeJS.ProcessEnv,
  ) => Promise<readonly McpConfiguredServer[]>;
}>;

const DIAGNOSTIC_SUMMARIES: Record<ConnectionDiagnosticCode, string> = {
  'development-cli-missing':
    'The development CLI is unavailable. Build it before starting SugarCode.',
  'development-cli-not-executable':
    'The development CLI cannot be executed on this host.',
  'packaged-cli-missing':
    'The packaged CLI is unavailable in the application resources.',
  'packaged-cli-not-executable':
    'The packaged CLI cannot be executed on this host.',
  'spawn-failed': 'SugarCode could not start its local CLI.',
  'initialize-rejected': 'The local CLI rejected the initialization request.',
  'protocol-invalid': 'The local CLI returned an invalid protocol message.',
  'protocol-version-mismatch':
    'The Desktop and local CLI use different protocol versions.',
  'product-version-mismatch':
    'The Desktop and local CLI product versions do not match.',
  'platform-mismatch': 'The local CLI does not match this host platform.',
  'approval-ui-unavailable':
    'SugarCode closed a pending command because its approval window became unavailable.',
  'write-failed': 'SugarCode could not write to the local CLI.',
  'server-closed': 'The local CLI connection closed.',
  'server-crashed': 'The local CLI stopped unexpectedly.',
};

const createDiagnostic = (
  code: ConnectionDiagnosticCode,
): ConnectionDiagnostic => ({
  code,
  summary: DIAGNOSTIC_SUMMARIES[code],
});

export class ConnectionSupervisor {
  readonly commandApprovals: CommandApprovalController;
  readonly conversation: ConversationController;
  readonly mcpApprovals: McpApprovalController;
  readonly mcpSession: McpSessionController;
  private readonly options: Required<
    Pick<
      ConnectionSupervisorOptions,
      'platform' | 'arch' | 'environment' | 'isPackaged' | 'resourcesPath'
    >
  > &
    Omit<
      ConnectionSupervisorOptions,
      'platform' | 'arch' | 'environment' | 'isPackaged' | 'resourcesPath'
    >;
  private readonly listeners = new Set<ConnectionStateListener>();
  private readonly stderr = new DiagnosticTailBuffer();
  private snapshot: ConnectionStateSnapshot = {
    revision: 0,
    status: 'idle',
  };
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: JsonlClient | null = null;
  private conversationRpc: ConversationRpc | null = null;
  private startPromise: Promise<void> | null = null;
  private initializeAbortController: AbortController | null = null;
  private shuttingDown = false;
  private spawnError: Error | null = null;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private terminalHandled = false;
  private resolvedCli: ResolvedCli | null = null;
  private restarting = false;

  constructor(options: ConnectionSupervisorOptions) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      environment: options.environment ?? process.env,
      isPackaged: options.isPackaged ?? false,
      resourcesPath: options.resourcesPath ?? '',
    };
    this.commandApprovals = new CommandApprovalController({
      platform: this.options.platform,
      writeDecision: async (requestId, decision) => {
        if (!this.client) {
          throw new ConnectionClosedError();
        }
        await this.client.respond(requestId, { decision });
      },
      onProtocolFailure: () => this.failAndTerminate('protocol-invalid'),
      onWriteFailure: () => this.failAndTerminate('write-failed'),
      onSurfaceFailure: () =>
        this.failAndTerminate('approval-ui-unavailable'),
    });
    this.conversation = new ConversationController({
      getRpc: () => this.conversationRpc,
      onProtocolFailure: () => this.failAndTerminate('protocol-invalid'),
    });
    this.mcpSession = new McpSessionController({
      getRestartBlock: this.getMcpRestartBlock,
      restart: this.restartWithMcp,
    });
    this.mcpApprovals = new McpApprovalController({
      getActiveServerIds: () => this.mcpSession.getActiveServerIds(),
      writeDecision: async (requestId, decision) => {
        if (!this.client) {
          throw new ConnectionClosedError();
        }
        await this.client.respond(requestId, { decision });
      },
      onProtocolFailure: () => this.failAndTerminate('protocol-invalid'),
      onWriteFailure: () => this.failAndTerminate('write-failed'),
      onSurfaceFailure: () =>
        this.failAndTerminate('approval-ui-unavailable'),
    });
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
    this.startPromise = this.startInitialConnection();
    return this.startPromise;
  };

  shutdown = (): void => {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.commandApprovals.shutdown();
    this.mcpApprovals.shutdown();
    this.conversation.transportClosed();
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

  private startInitialConnection = async (): Promise<void> => {
    const target = getCliTarget(
      this.options.platform,
      this.options.arch,
    );
    if (!target) {
      this.fail('platform-mismatch');
      return;
    }
    if (this.options.clientVersion !== SUGARCODE_PRODUCT_VERSION) {
      this.fail('product-version-mismatch');
      return;
    }

    try {
      this.resolvedCli = await (this.options.resolveCli ?? resolveCli)({
        isPackaged: this.options.isPackaged,
        desktopAppPath: this.options.desktopAppPath,
        resourcesPath: this.options.resourcesPath,
        platform: this.options.platform,
      });
    } catch (error) {
      this.fail(
        error instanceof CliResolutionError
          ? error.code
          : this.options.isPackaged
            ? 'packaged-cli-missing'
            : 'development-cli-missing',
      );
      return;
    }
    const environment = createCliEnvironment(
      this.options.environment,
      this.options.platform,
    );
    try {
      const servers = this.options.discoverMcpServers
        ? await this.options.discoverMcpServers(this.resolvedCli, environment)
        : await discoverMcpServers({
            cli: this.resolvedCli,
            environment,
          });
      this.mcpSession.initialize(servers);
    } catch {
      this.mcpSession.unavailable(
        'Configured MCP servers could not be read safely.',
      );
    }
    await this.connect([], undefined, target.expectedPlatform);
  };

  private connect = async (
    mcpServerIds: readonly string[],
    preferredThreadId: string | undefined,
    expectedPlatform: ExpectedCliPlatform,
  ): Promise<boolean> => {
    const cli = this.resolvedCli;
    if (!cli) {
      this.fail('development-cli-missing');
      return false;
    }
    this.resetProcessState();
    try {
      const spawnProcess = this.options.spawnProcess ?? spawn;
      this.child = spawnProcess(
        cli.executablePath,
        [
          'app-server',
          '--stdio',
          ...mcpServerIds.flatMap((serverId) => [
            '--mcp-server',
            serverId,
          ]),
        ],
        {
          cwd: cli.workingDirectory,
          detached: false,
          env: createCliEnvironment(
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
      return false;
    }

    const child = this.child;
    this.attachChild(child);
    this.initializeAbortController = new AbortController();
    this.client = new JsonlClient({
      stdin: child.stdin,
      stdout: child.stdout,
      onServerRequest: (request) => {
        if (request.method === 'item/commandExecution/requestApproval') {
          this.commandApprovals.handleServerRequest(request);
          return;
        }
        if (request.method === 'item/mcpToolCall/requestApproval') {
          this.mcpApprovals.handleServerRequest(request);
          return;
        }
        {
          this.failAndTerminate('protocol-invalid');
        }
      },
      onNotification: (notification) => {
        this.commandApprovals.handleNotification(notification);
        this.mcpApprovals.handleNotification(notification);
        this.conversation.handleNotification(notification);
      },
      onFatalError: () => {
        this.failAndTerminate('protocol-invalid');
      },
      onTransportEnd: () => {
        if (
          !this.shuttingDown &&
          this.child === child &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          this.failAndTerminate('protocol-invalid');
        }
      },
    });
    this.conversationRpc = new ConversationRpcClient(this.client);

    const initializeParams: InitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: 'sugarcode-desktop',
        title: 'SugarCode Desktop',
        version: this.options.clientVersion,
      },
      capabilities: {
        commandApprovals: true,
        ...(mcpServerIds.length > 0
          ? { mcpToolCallApprovals: true }
          : {}),
      },
    };

    try {
      const response = await this.client.initialize(
        initializeParams,
        this.initializeAbortController.signal,
      );
      const mismatch = this.validateInitializeResponse(
        response,
        expectedPlatform,
        mcpServerIds.length > 0,
      );
      if (mismatch) {
        this.failAndTerminate(mismatch);
        return false;
      }
      await this.client.initialized();
      if (!this.shuttingDown && this.snapshot.status === 'connecting') {
        const restored = await this.conversation.restoreForConnection(
          preferredThreadId,
        );
        if (
          this.shuttingDown ||
          this.snapshot.status !== 'connecting'
        ) {
          return false;
        }
        if (restored) {
          this.conversation.connectionReady();
        }
        this.transition('ready');
        return true;
      }
      return false;
    } catch (error) {
      if (
        this.shuttingDown ||
        this.snapshot.status === 'failed' ||
        this.snapshot.status === 'closed'
      ) {
        return false;
      }
      if (error instanceof RpcResponseError) {
        this.failAndTerminate('initialize-rejected');
      } else if (error instanceof ConnectionClosedError) {
        this.failAndTerminate(
          this.spawnError ? 'spawn-failed' : 'server-crashed',
        );
      } else {
        this.failAndTerminate(
          child.stdin.destroyed || !child.stdin.writable
            ? 'write-failed'
            : 'protocol-invalid',
        );
      }
      return false;
    }
  };

  private validateInitializeResponse = (
    response: InitializeResponse,
    expectedPlatform: ExpectedCliPlatform,
    expectsMcp: boolean,
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
    if (
      (response.capabilities.mcpToolCallApprovals === true) !== expectsMcp
    ) {
      return 'protocol-invalid';
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
    this.commandApprovals.transportClosed();
    this.mcpApprovals.transportClosed();
    this.conversation.transportClosed();
    this.child = null;
    this.client = null;
    this.conversationRpc = null;

    if (this.restarting) {
      return;
    }
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
    this.conversation.transportClosed();
    this.client?.close();
    if (
      this.child &&
      this.child.exitCode === null &&
      !this.child.killed
    ) {
      this.child.kill();
    }
  };

  private getMcpRestartBlock = ():
    | 'turnActive'
    | 'approvalPending'
    | 'busy'
    | 'unavailable'
    | null => {
    if (this.snapshot.status !== 'ready' || !this.resolvedCli) {
      return 'unavailable';
    }
    const conversation = this.conversation.getSnapshot();
    if (
      conversation.phase === 'starting' ||
      conversation.phase === 'inProgress' ||
      conversation.phase === 'stopping'
    ) {
      return 'turnActive';
    }
    if (
      conversation.navigator.pendingThreadId ||
      conversation.navigator.search.status === 'loading'
    ) {
      return 'busy';
    }
    if (
      this.commandApprovals.getSnapshot().status === 'pending' ||
      this.mcpApprovals.getSnapshot().status === 'pending'
    ) {
      return 'approvalPending';
    }
    if (!this.mcpApprovals.isSurfaceReady()) {
      return 'unavailable';
    }
    return null;
  };

  private restartWithMcp = async (
    serverIds: readonly string[],
  ): Promise<boolean> => {
    const target = getCliTarget(this.options.platform, this.options.arch);
    if (!target || !this.resolvedCli || this.shuttingDown) {
      return false;
    }
    const preferredThreadId = this.conversation.getSnapshot().threadId;
    if (!(await this.closeForRestart())) {
      return false;
    }
    if (this.shuttingDown) {
      return false;
    }
    this.transition('connecting');
    return this.connect(
      serverIds,
      preferredThreadId,
      target.expectedPlatform,
    );
  };

  private closeForRestart = async (): Promise<boolean> => {
    const child = this.child;
    this.restarting = true;
    this.initializeAbortController?.abort();
    this.client?.close();
    if (!child) {
      this.restarting = false;
      return true;
    }
    const closed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
    const result = await closed;
    this.restarting = false;
    return result;
  };

  private resetProcessState = (): void => {
    this.spawnError = null;
    this.exitCode = null;
    this.exitSignal = null;
    this.terminalHandled = false;
    this.initializeAbortController = null;
    this.client = null;
    this.conversationRpc = null;
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
