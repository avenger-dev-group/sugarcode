import type {
  InitializeParams,
  InitializeResponse,
  WorkspaceInspectResponse,
  WorkspaceListResponse,
  WorkspaceGitCommitParams,
  WorkspaceGitCommitResponse,
  WorkspaceGitDiffParams,
  WorkspaceGitDiffResponse,
  WorkspaceGitMutationParams,
  WorkspaceGitMutationResponse,
  WorkspaceGitStatusResponse,
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
import {
  parseWorkspaceInspectResponse,
  parseWorkspaceListResponse,
} from '../transport/server-message';
import { CommandApprovalController } from '../command-approval/controller';
import { ConversationController } from '../conversation/controller';
import {
  ConversationRpcClient,
  type ConversationRpc,
} from '../conversation/rpc-client';
import { McpApprovalController } from '../mcp/approval-controller';
import { discoverMcpServers } from '../mcp/config-discovery';
import { McpSessionController } from '../mcp/session-controller';
import {
  parseWorkspaceGitCommitResponse,
  parseWorkspaceGitDiffResponse,
  parseWorkspaceGitMutationResponse,
  parseWorkspaceGitStatusResponse,
} from '../git/protocol';

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

export type ModelConfigRestartBlock =
  | 'turnActive'
  | 'approvalPending'
  | 'navigationPending'
  | 'reconnectPending'
  | 'unavailable';

export type WorkspaceRuntimeKind = 'project' | 'chat';

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
  'protocol-invalid':
    'SugarCode paused the local Agent after an internal compatibility error. Your conversation is saved.',
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
  private connectionGeneration = 0;
  private modelConfigTransaction = false;
  private workspaceTransaction = false;
  private gitTransaction = false;
  private workspacePath: string | null = null;
  private workspaceRuntimeKind: WorkspaceRuntimeKind = 'project';
  private workspaceBindingId: string | null = null;
  private preferredInitialThreadId: string | undefined;

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
      getActionBlocked: () =>
        this.modelConfigTransaction ||
        this.workspaceTransaction ||
        this.gitTransaction,
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
    let commandApprovalTaskId: string | null = null;
    let mcpApprovalTaskId: string | null = null;
    const updateAgentApprovalTasks = (): void => {
      this.conversation.setAgentApprovalTasks(
        new Set(
          [commandApprovalTaskId, mcpApprovalTaskId].filter(
            (taskId): taskId is string => taskId !== null,
          ),
        ),
      );
    };
    this.commandApprovals.subscribe((snapshot) => {
      commandApprovalTaskId =
        snapshot.status === 'pending'
          ? (snapshot.request?.sourceAgent?.taskId ?? null)
          : null;
      updateAgentApprovalTasks();
    });
    this.mcpApprovals.subscribe((snapshot) => {
      mcpApprovalTaskId =
        snapshot.status === 'pending'
          ? (snapshot.request?.sourceAgent?.taskId ?? null)
          : null;
      updateAgentApprovalTasks();
    });
  }

  getSnapshot = (): ConnectionStateSnapshot => this.snapshot;

  getResolvedCli = (): ResolvedCli | null => this.resolvedCli;

  getCliEnvironment = (): NodeJS.ProcessEnv =>
    createCliEnvironment(
      this.options.environment,
      this.options.platform,
    );

  configureInitialWorkspace = (
    workspacePath: string | null,
    preferredThreadId?: string,
    runtimeKind: WorkspaceRuntimeKind = 'project',
  ): boolean => {
    if (this.snapshot.status !== 'idle' || this.startPromise) {
      return false;
    }
    this.workspacePath = workspacePath;
    this.workspaceRuntimeKind = runtimeKind;
    this.commandApprovals.resetScope();
    this.preferredInitialThreadId = preferredThreadId;
    return true;
  };

  getWorkspaceSwitchBlock = (): ModelConfigRestartBlock | null =>
    this.getModelConfigRestartBlock();

  switchWorkspace = async (
    workspacePath: string | null,
    runtimeKind: WorkspaceRuntimeKind = 'project',
    preferredThreadId?: string,
  ): Promise<boolean> => {
    const target = getCliTarget(this.options.platform, this.options.arch);
    const lease = this.beginWorkspaceTransaction();
    if (
      typeof lease === 'string' ||
      !target ||
      !this.resolvedCli ||
      this.shuttingDown
    ) {
      return false;
    }
    const previousPath = this.workspacePath;
    const previousRuntimeKind = this.workspaceRuntimeKind;
    const previousThreadId = this.conversation.getSnapshot().threadId ?? undefined;
    this.commandApprovals.resetScope();
    try {
      if (!(await this.closeForRestart())) {
        return false;
      }
      this.workspacePath = workspacePath;
      this.workspaceRuntimeKind = runtimeKind;
      this.workspaceBindingId = null;
      this.mcpSession.initialize(this.mcpSession.getSnapshot().servers);
      this.transition('connecting');
      const connected = await this.connect(
        [],
        preferredThreadId,
        target.expectedPlatform,
      );
      if (connected) {
        return true;
      }
      this.workspacePath = previousPath;
      this.workspaceRuntimeKind = previousRuntimeKind;
      if (!this.shuttingDown) {
        await this.closeForRestart();
        this.transition('connecting');
        await this.connect(
          [],
          previousThreadId,
          target.expectedPlatform,
        );
      }
      return false;
    } finally {
      lease.release();
    }
  };

  listWorkspace = async (path: string): Promise<WorkspaceListResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace browser is unavailable.');
    }
    const result = await this.client.requestReady('workspace/list', { path });
    return parseWorkspaceListResponse(result, path);
  };

  inspectWorkspace = async (
    path: string,
  ): Promise<WorkspaceInspectResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace inspector is unavailable.');
    }
    const result = await this.client.requestReady('workspace/inspect', {
      path,
    });
    return parseWorkspaceInspectResponse(result, path);
  };

  gitStatus = async (): Promise<WorkspaceGitStatusResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitStatusResponse(
      await this.client.requestReady('workspace/git/status', {}),
    );
  };

  gitDiff = async (
    params: WorkspaceGitDiffParams,
  ): Promise<WorkspaceGitDiffResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitDiffResponse(
      await this.client.requestReady('workspace/git/diff', params),
      params.expectedRevision,
      params.path,
      params.source,
    );
  };

  gitStage = async (
    params: WorkspaceGitMutationParams,
  ): Promise<WorkspaceGitMutationResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitMutationResponse(
      await this.client.requestReady('workspace/git/stage', params),
      params.paths,
    );
  };

  gitUnstage = async (
    params: WorkspaceGitMutationParams,
  ): Promise<WorkspaceGitMutationResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitMutationResponse(
      await this.client.requestReady('workspace/git/unstage', params),
      params.paths,
    );
  };

  gitCommit = async (
    params: WorkspaceGitCommitParams,
  ): Promise<WorkspaceGitCommitResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitCommitResponse(
      await this.client.requestReady('workspace/git/commit', params),
    );
  };

  beginGitTransaction = ():
    | Readonly<{ release: () => void }>
    | 'turnActive'
    | 'approvalPending'
    | 'busy'
    | 'unavailable' => {
    const block = this.getGitTransactionBlock();
    if (block) {
      return block;
    }
    this.gitTransaction = true;
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.gitTransaction = false;
        }
      },
    };
  };

  private beginWorkspaceTransaction = ():
    | Readonly<{ release: () => void }>
    | ModelConfigRestartBlock => {
    const block = this.getModelConfigRestartBlock();
    if (block) {
      return block;
    }
    this.workspaceTransaction = true;
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.workspaceTransaction = false;
        }
      },
    };
  };

  beginConfigWrite = ():
    | Readonly<{ release: () => void }>
    | 'reconnectPending'
    | 'unavailable' => {
    if (
      this.modelConfigTransaction ||
      this.workspaceTransaction ||
      this.gitTransaction ||
      this.restarting
    ) {
      return 'reconnectPending';
    }
    if (!this.resolvedCli || this.shuttingDown) {
      return 'unavailable';
    }
    this.modelConfigTransaction = true;
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.modelConfigTransaction = false;
        }
      },
    };
  };

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
    this.connectionGeneration += 1;
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
    await this.connect(
      [],
      this.preferredInitialThreadId,
      target.expectedPlatform,
    );
  };

  private connect = async (
    mcpServerIds: readonly string[],
    preferredThreadId: string | undefined,
    expectedPlatform: ExpectedCliPlatform,
    restoreConversation = true,
  ): Promise<boolean> => {
    const cli = this.resolvedCli;
    if (!cli) {
      this.fail('development-cli-missing');
      return false;
    }
    this.resetProcessState();
    const generation = ++this.connectionGeneration;
    try {
      const spawnProcess = this.options.spawnProcess ?? spawn;
      this.child = spawnProcess(
        cli.executablePath,
        [
          'app-server',
          '--stdio',
          ...(this.workspacePath
            ? ['--workspace', this.workspacePath]
            : []),
          ...(this.workspacePath ? ['--allow-workspace-write'] : []),
          ...(this.workspacePath && this.workspaceRuntimeKind === 'chat'
            ? ['--unbound-threads']
            : []),
          ...mcpServerIds.flatMap((serverId) => [
            '--mcp-server',
            serverId,
          ]),
        ],
        {
          cwd: this.workspacePath ?? cli.workingDirectory,
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
    this.attachChild(child, generation);
    this.initializeAbortController = new AbortController();
    this.client = new JsonlClient({
      stdin: child.stdin,
      stdout: child.stdout,
      onServerRequest: (request) => {
        if (generation !== this.connectionGeneration) {
          return;
        }
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
        if (generation !== this.connectionGeneration) {
          return;
        }
        this.commandApprovals.handleNotification(notification);
        this.mcpApprovals.handleNotification(notification);
        this.conversation.handleNotification(notification);
      },
      onFatalError: () => {
        if (generation === this.connectionGeneration) {
          this.failAndTerminate('protocol-invalid');
        }
      },
      onTransportEnd: () => {
        if (
          generation === this.connectionGeneration &&
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
      if (generation !== this.connectionGeneration) {
        return false;
      }
      const mismatch = this.validateInitializeResponse(
        response,
        expectedPlatform,
        mcpServerIds.length > 0,
        this.workspacePath !== null,
      );
      if (mismatch) {
        this.failAndTerminate(mismatch);
        return false;
      }
      await this.client.initialized();
      if (generation !== this.connectionGeneration) {
        return false;
      }
      if (!this.shuttingDown && this.snapshot.status === 'connecting') {
        this.workspaceBindingId = response.workspace?.id ?? null;
        const restored = restoreConversation
          ? await this.conversation.restoreForConnection(preferredThreadId)
          : true;
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
        generation !== this.connectionGeneration ||
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
    expectsWorkspace: boolean,
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
    if (
      (response.capabilities.workspaceBrowser === true) !== expectsWorkspace ||
      (response.capabilities.workspaceGit === true) !== expectsWorkspace ||
      (response.workspace !== undefined) !== expectsWorkspace ||
      (response.workspace !== undefined &&
        !/^[0-9a-f]{64}$/.test(response.workspace.id))
    ) {
      return 'protocol-invalid';
    }
    return null;
  };

  private attachChild = (
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): void => {
    child.stderr.on('data', this.stderr.append);
    child.once('error', (error: Error) => {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.spawnError ??= error;
      if (!this.shuttingDown) {
        this.fail('spawn-failed');
      }
    });
    child.once('exit', (code, signal) => {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.exitCode = code;
      this.exitSignal = signal;
    });
    child.once('close', (code, signal) => {
      this.handleChildClose(child, generation, code, signal);
    });
  };

  private handleChildClose = (
    child: ChildProcessWithoutNullStreams,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (
      generation !== this.connectionGeneration ||
      this.child !== child ||
      this.terminalHandled
    ) {
      return;
    }
    this.terminalHandled = true;
    this.exitCode = code ?? this.exitCode;
    this.exitSignal = signal ?? this.exitSignal;
    this.client?.close();
    this.commandApprovals.transportClosed();
    this.mcpApprovals.transportClosed();
    if (this.restarting) {
      this.conversation.connectionRestarting();
    } else {
      this.conversation.transportClosed();
    }
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
    if (
      this.modelConfigTransaction ||
      this.workspaceTransaction ||
      this.gitTransaction
    ) {
      return 'busy';
    }
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

  private getGitTransactionBlock = ():
    | 'turnActive'
    | 'approvalPending'
    | 'busy'
    | 'unavailable'
    | null => {
    if (
      this.gitTransaction ||
      this.modelConfigTransaction ||
      this.workspaceTransaction ||
      this.restarting ||
      this.snapshot.status === 'connecting'
    ) {
      return 'busy';
    }
    if (
      this.snapshot.status !== 'ready' ||
      !this.client ||
      !this.workspaceBindingId ||
      this.shuttingDown
    ) {
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

  private getModelConfigRestartBlock = (): ModelConfigRestartBlock | null => {
    if (
      this.modelConfigTransaction ||
      this.workspaceTransaction ||
      this.gitTransaction ||
      this.restarting ||
      this.snapshot.status === 'connecting'
    ) {
      return 'reconnectPending';
    }
    if (!this.resolvedCli || this.shuttingDown) {
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
      return 'navigationPending';
    }
    if (
      this.commandApprovals.getSnapshot().status === 'pending' ||
      this.mcpApprovals.getSnapshot().status === 'pending'
    ) {
      return 'approvalPending';
    }
    return null;
  };

  private closeForRestart = async (): Promise<boolean> => {
    const child = this.child;
    this.restarting = true;
    this.connectionGeneration += 1;
    this.initializeAbortController?.abort();
    this.client?.close();
    this.commandApprovals.transportClosed();
    this.mcpApprovals.transportClosed();
    this.conversation.connectionRestarting();
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
    this.workspaceBindingId = null;
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
