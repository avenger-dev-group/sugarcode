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
  WorkspaceOpenResponse,
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
import { basename } from 'node:path';

import type {
  ConnectionDiagnostic,
  ConnectionDiagnosticCode,
  ConnectionStateListener,
  ConnectionStateSnapshot,
  ConnectionStatus,
} from '@/shared/connection';
import type { McpConfiguredServer } from '@/shared/mcp';
import type { ConversationStateSnapshot } from '@/shared/conversation';

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
  type ServerMessage,
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

const PROTOCOL_RECOVERY_WINDOW_MS = 60_000;

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
  private lastProtocolRecoveryAt = 0;
  private protocolRecoveryPromise: Promise<void> | null = null;
  private readonly approvalQueue: Array<
    Readonly<{
      kind: 'command' | 'mcp';
      request: Extract<ServerMessage, { kind: 'request' }>;
    }>
  > = [];
  private approvalInFlight: 'command' | 'mcp' | null = null;
  private readonly workspaceTitles = new Map<string, string>();
  private readonly threadTitles = new Map<string, string>();
  private readonly registeredWorkspaces = new Map<
    string,
    Readonly<{
      path: string;
      runtimeKind: WorkspaceRuntimeKind;
    }>
  >();

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
      onSurfaceReady: () => this.presentNextApproval(),
      getQueueCount: () => 1 + this.approvalQueue.length,
      describeSource: this.describeApprovalSource,
      getThreadWorkspaceId: (threadId) =>
        this.conversation.getThreadWorkspaceId(threadId),
    });
    this.conversation = new ConversationController({
      getRpc: () => this.conversationRpc,
      onProtocolFailure: () => this.failAndTerminate('protocol-invalid'),
      onThreadProjectionFailure: this.rejectThreadApprovals,
      getActionBlocked: () =>
        this.modelConfigTransaction ||
        this.workspaceTransaction ||
        this.gitTransaction,
    });
    this.conversation.subscribeScoped(this.rememberThreadTitles);
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
      onSurfaceReady: () => this.presentNextApproval(),
      getQueueCount: () => 1 + this.approvalQueue.length,
      describeSource: this.describeApprovalSource,
      getThreadWorkspaceId: (threadId) =>
        this.conversation.getThreadWorkspaceId(threadId),
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
      this.advanceApprovalQueue('command', snapshot.status);
    });
    this.mcpApprovals.subscribe((snapshot) => {
      mcpApprovalTaskId =
        snapshot.status === 'pending'
          ? (snapshot.request?.sourceAgent?.taskId ?? null)
          : null;
      updateAgentApprovalTasks();
      this.advanceApprovalQueue('mcp', snapshot.status);
    });
  }

  getSnapshot = (): ConnectionStateSnapshot => this.snapshot;

  getResolvedCli = (): ResolvedCli | null => this.resolvedCli;

  getWorkspaceBindingId = (): string | null => this.workspaceBindingId;

  getCliEnvironment = (): NodeJS.ProcessEnv =>
    createCliEnvironment(this.options.environment);

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

  getWorkspaceSwitchBlock = (): ModelConfigRestartBlock | null => {
    if (
      this.modelConfigTransaction ||
      this.workspaceTransaction ||
      this.gitTransaction ||
      this.restarting ||
      this.snapshot.status === 'connecting'
    ) {
      return 'reconnectPending';
    }
    if (!this.resolvedCli || !this.client || this.shuttingDown) {
      return 'unavailable';
    }
    const conversation = this.conversation.getSnapshot();
    if (
      conversation.navigator.pendingThreadId ||
      conversation.navigator.search.status === 'loading'
    ) {
      return 'navigationPending';
    }
    return null;
  };

  switchWorkspace = async (
    workspacePath: string | null,
    runtimeKind: WorkspaceRuntimeKind = 'project',
    preferredThreadId?: string,
  ): Promise<boolean> => {
    const lease = this.beginWorkspaceTransaction();
    if (
      typeof lease === 'string' ||
      !this.resolvedCli ||
      !this.client ||
      this.shuttingDown
    ) {
      return false;
    }
    const previousPath = this.workspacePath;
    const previousRuntimeKind = this.workspaceRuntimeKind;
    const previousWorkspaceId = this.workspaceBindingId;
    const previousThreadId = this.conversation.getSnapshot().threadId;
    try {
      await this.conversation.waitForTurnStartSettlement();
      if (!this.resolvedCli || !this.client || this.shuttingDown) {
        return false;
      }
      this.workspacePath = workspacePath;
      this.workspaceRuntimeKind = runtimeKind;
      const workspaceId = await this.openConfiguredWorkspace();
      if (!workspaceId) {
        throw new Error('Workspace is unavailable.');
      }
      this.workspaceBindingId = workspaceId;
      this.conversationRpc = new ConversationRpcClient(
        this.client,
        workspaceId,
      );
      if (
        !(await this.conversation.switchWorkspace(
          workspaceId,
          preferredThreadId,
        ))
      ) {
        throw new Error('Workspace projection could not be restored.');
      }
      return true;
    } catch {
      this.workspacePath = previousPath;
      this.workspaceRuntimeKind = previousRuntimeKind;
      const workspaceId = await this.openConfiguredWorkspace().catch(
        (): null => null,
      );
      if (workspaceId && this.client) {
        this.workspaceBindingId = workspaceId;
        this.conversationRpc = new ConversationRpcClient(
          this.client,
          workspaceId,
        );
        if (workspaceId === previousWorkspaceId) {
          await this.conversation.switchWorkspace(
            workspaceId,
            previousThreadId ?? undefined,
          );
        }
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
    const result = await this.client.requestReady('workspace/list', {
      workspaceId: this.workspaceBindingId,
      path,
    });
    return parseWorkspaceListResponse(result, path);
  };

  inspectWorkspace = async (
    path: string,
  ): Promise<WorkspaceInspectResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace inspector is unavailable.');
    }
    const result = await this.client.requestReady('workspace/inspect', {
      workspaceId: this.workspaceBindingId,
      path,
    });
    return parseWorkspaceInspectResponse(result, path);
  };

  gitStatus = async (): Promise<WorkspaceGitStatusResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitStatusResponse(
      await this.client.requestReady('workspace/git/status', {
        workspaceId: this.workspaceBindingId,
      }),
    );
  };

  gitDiff = async (
    params: Omit<WorkspaceGitDiffParams, 'workspaceId'>,
  ): Promise<WorkspaceGitDiffResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitDiffResponse(
      await this.client.requestReady('workspace/git/diff', {
        ...params,
        workspaceId: this.workspaceBindingId,
      }),
      params.expectedRevision,
      params.path,
      params.source,
    );
  };

  gitStage = async (
    params: Omit<WorkspaceGitMutationParams, 'workspaceId'>,
  ): Promise<WorkspaceGitMutationResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitMutationResponse(
      await this.client.requestReady('workspace/git/stage', {
        ...params,
        workspaceId: this.workspaceBindingId,
      }),
      params.paths,
    );
  };

  gitUnstage = async (
    params: Omit<WorkspaceGitMutationParams, 'workspaceId'>,
  ): Promise<WorkspaceGitMutationResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitMutationResponse(
      await this.client.requestReady('workspace/git/unstage', {
        ...params,
        workspaceId: this.workspaceBindingId,
      }),
      params.paths,
    );
  };

  gitCommit = async (
    params: Omit<WorkspaceGitCommitParams, 'workspaceId'>,
  ): Promise<WorkspaceGitCommitResponse> => {
    if (!this.client || !this.workspaceBindingId) {
      throw new ConnectionClosedError('Workspace Git is unavailable.');
    }
    return parseWorkspaceGitCommitResponse(
      await this.client.requestReady('workspace/git/commit', {
        ...params,
        workspaceId: this.workspaceBindingId,
      }),
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
    const block = this.getWorkspaceSwitchBlock();
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
    this.rejectQueuedApprovals();
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

  approvalSurfacesUnavailable = (): void => {
    this.commandApprovals.surfaceUnavailable();
    this.mcpApprovals.surfaceUnavailable();
    this.rejectQueuedApprovals();
  };

  private rejectQueuedApprovals = (): void => {
    const queued = this.approvalQueue.splice(0);
    const client = this.client;
    if (!client) {
      return;
    }
    for (const entry of queued) {
      void client.respond(entry.request.id, { decision: 'denied' }).catch(
        (): undefined => undefined,
      );
    }
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
    const environment = createCliEnvironment(this.options.environment);
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
          '--multi-workspace',
          ...mcpServerIds.flatMap((serverId) => [
            '--mcp-server',
            serverId,
          ]),
        ],
        {
          cwd: cli.workingDirectory,
          detached: false,
          env: createCliEnvironment(this.options.environment),
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
          this.enqueueApprovalRequest('command', request);
          return;
        }
        if (request.method === 'item/mcpToolCall/requestApproval') {
          this.enqueueApprovalRequest('mcp', request);
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
        this.removeResolvedQueuedApproval(notification);
        this.rememberStartedThread(notification);
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
        await this.reopenBackgroundWorkspaces();
        this.workspaceBindingId = await this.openConfiguredWorkspace();
        this.conversationRpc = this.workspaceBindingId
          ? new ConversationRpcClient(this.client, this.workspaceBindingId)
          : null;
        const restored = restoreConversation
          ? await this.conversation.restoreForConnection(
              this.workspaceBindingId as string,
              preferredThreadId,
            )
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
      response.capabilities.workspaceBrowser !== true ||
      response.capabilities.workspaceGit !== true ||
      response.workspace !== undefined
    ) {
      return 'protocol-invalid';
    }
    return null;
  };

  private enqueueApprovalRequest = (
    kind: 'command' | 'mcp',
    request: Extract<ServerMessage, { kind: 'request' }>,
  ): void => {
    this.approvalQueue.push({ kind, request });
    if (this.approvalInFlight === 'command') {
      this.commandApprovals.queueChanged();
    } else if (this.approvalInFlight === 'mcp') {
      this.mcpApprovals.queueChanged();
    }
    this.presentNextApproval();
  };

  private removeResolvedQueuedApproval = (
    notification: Extract<ServerMessage, { kind: 'notification' }>,
  ): void => {
    if (
      notification.method !== 'item/completed' &&
      notification.method !== 'turn/completed'
    ) {
      return;
    }
    const params = notification.params;
    if (typeof params !== 'object' || params === null) {
      return;
    }
    const record = params as Record<string, unknown>;
    const item =
      typeof record.item === 'object' && record.item !== null
        ? (record.item as Record<string, unknown>)
        : null;
    const approvalId =
      typeof item?.approvalId === 'string' ? item.approvalId : null;
    const threadId =
      typeof record.threadId === 'string' ? record.threadId : null;
    const turnId = typeof record.turnId === 'string' ? record.turnId : null;
    const before = this.approvalQueue.length;
    for (let index = this.approvalQueue.length - 1; index >= 0; index -= 1) {
      const queued = this.approvalQueue[index];
      const queuedParams = queued?.request.params;
      if (typeof queuedParams !== 'object' || queuedParams === null) {
        continue;
      }
      const request = queuedParams as Record<string, unknown>;
      const sameApproval =
        approvalId !== null && request.approvalId === approvalId;
      const sameCompletedTurn =
        notification.method === 'turn/completed' &&
        threadId !== null &&
        turnId !== null &&
        request.threadId === threadId &&
        request.turnId === turnId;
      if (sameApproval || sameCompletedTurn) {
        this.approvalQueue.splice(index, 1);
      }
    }
    if (this.approvalQueue.length !== before) {
      if (this.approvalInFlight === 'command') {
        this.commandApprovals.queueChanged();
      } else if (this.approvalInFlight === 'mcp') {
        this.mcpApprovals.queueChanged();
      }
    }
  };

  private describeApprovalSource = (
    threadId: string,
    workspaceId: string,
  ): Readonly<{
    projectTitle: string;
    conversationTitle: string;
  }> => {
    const navigator = this.conversation.getSnapshot().navigator;
    return {
      projectTitle:
        (workspaceId ? this.workspaceTitles.get(workspaceId) : undefined) ??
        (this.workspacePath ? basename(this.workspacePath) : 'SugarCode'),
      conversationTitle:
        this.threadTitles.get(threadId) ??
        navigator.activeThreadTitles[threadId] ??
        navigator.search.threadTitles[threadId] ??
        threadId,
    };
  };

  private rememberThreadTitles = (
    _workspaceId: string,
    snapshot: ConversationStateSnapshot,
  ): void => {
    if (snapshot.navigator.status === 'ready') {
      for (const threadId of snapshot.navigator.activeThreadIds) {
        const title = snapshot.navigator.activeThreadTitles[threadId];
        if (title) {
          this.threadTitles.set(threadId, title);
        }
      }
    }
  };

  private rememberStartedThread = (
    notification: Extract<ServerMessage, { kind: 'notification' }>,
  ): void => {
    if (
      notification.method !== 'thread/started' ||
      typeof notification.params !== 'object' ||
      notification.params === null
    ) {
      return;
    }
    const thread = (notification.params as Record<string, unknown>).thread;
    if (typeof thread !== 'object' || thread === null) {
      return;
    }
    const threadId = (thread as Record<string, unknown>).id;
    if (typeof threadId === 'string') {
      const title = (thread as Record<string, unknown>).title;
      if (typeof title === 'string' && title.length > 0) {
        this.threadTitles.set(threadId, title);
      }
    }
  };

  private rejectThreadApprovals = (threadId: string): void => {
    this.commandApprovals.rejectThread(threadId);
    this.mcpApprovals.rejectThread(threadId);
    for (let index = this.approvalQueue.length - 1; index >= 0; index -= 1) {
      const queued = this.approvalQueue[index];
      const params = queued?.request.params;
      if (
        typeof params !== 'object' ||
        params === null ||
        (params as Record<string, unknown>).threadId !== threadId
      ) {
        continue;
      }
      this.approvalQueue.splice(index, 1);
      if (this.client) {
        void this.client
          .respond(queued.request.id, { decision: 'denied' })
          .catch(() => this.failAndTerminate('write-failed'));
      }
    }
    this.commandApprovals.queueChanged();
    this.mcpApprovals.queueChanged();
  };

  private presentNextApproval = (): void => {
    if (this.approvalInFlight || this.approvalQueue.length === 0) {
      return;
    }
    const next = this.approvalQueue[0];
    if (!next) {
      return;
    }
    const ready =
      next.kind === 'command'
        ? this.commandApprovals.isSurfaceReady()
        : this.mcpApprovals.isSurfaceReady();
    if (!ready) {
      return;
    }
    this.approvalQueue.shift();
    this.approvalInFlight = next.kind;
    if (next.kind === 'command') {
      this.commandApprovals.handleServerRequest(next.request);
      if (this.commandApprovals.getSnapshot().status !== 'pending') {
        this.approvalInFlight = null;
        queueMicrotask(this.presentNextApproval);
      }
    } else {
      this.mcpApprovals.handleServerRequest(next.request);
      if (this.mcpApprovals.getSnapshot().status !== 'pending') {
        this.approvalInFlight = null;
        queueMicrotask(this.presentNextApproval);
      }
    }
  };

  private advanceApprovalQueue = (
    kind: 'command' | 'mcp',
    status: string,
  ): void => {
    if (
      this.approvalInFlight === kind &&
      status !== 'pending' &&
      status !== 'idle'
    ) {
      this.approvalInFlight = null;
      queueMicrotask(this.presentNextApproval);
    }
  };

  private openConfiguredWorkspace = async (): Promise<string | null> => {
    if (!this.client || !this.workspacePath) {
      return null;
    }
    const workspaceId = await this.openWorkspaceBinding(
      this.workspacePath,
      this.workspaceRuntimeKind,
    );
    this.registeredWorkspaces.set(
      this.workspaceRegistrationKey(
        this.workspacePath,
        this.workspaceRuntimeKind,
      ),
      {
        path: this.workspacePath,
        runtimeKind: this.workspaceRuntimeKind,
      },
    );
    return workspaceId;
  };

  private reopenBackgroundWorkspaces = async (): Promise<void> => {
    if (!this.client) {
      return;
    }
    const currentKey = this.workspacePath
      ? this.workspaceRegistrationKey(
          this.workspacePath,
          this.workspaceRuntimeKind,
        )
      : null;
    for (const [key, registration] of this.registeredWorkspaces) {
      if (key === currentKey) {
        continue;
      }
      try {
        await this.openWorkspaceBinding(
          registration.path,
          registration.runtimeKind,
        );
      } catch {
        this.registeredWorkspaces.delete(key);
      }
    }
  };

  private openWorkspaceBinding = async (
    workspacePath: string,
    runtimeKind: WorkspaceRuntimeKind,
  ): Promise<string> => {
    if (!this.client) {
      throw new ConnectionClosedError();
    }
    const value = await this.client.requestReady('workspace/open', {
      root: workspacePath,
      workspaceType:
        runtimeKind === 'chat' ? 'isolatedChat' : 'project',
      allowWorkspaceWrite: true,
      allowCommandWorkspaceWrite: false,
    });
    if (
      typeof value !== 'object' ||
      value === null ||
      !('workspaceId' in value) ||
      typeof value.workspaceId !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value.workspaceId)
    ) {
      throw new Error('Invalid workspace/open response.');
    }
    const workspaceId = (value as WorkspaceOpenResponse).workspaceId;
    this.workspaceTitles.set(workspaceId, basename(workspacePath));
    return workspaceId;
  };

  private workspaceRegistrationKey = (
    workspacePath: string,
    runtimeKind: WorkspaceRuntimeKind,
  ): string => `${runtimeKind}\u0000${workspacePath}`;

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
    this.approvalQueue.splice(0);
    this.approvalInFlight = null;
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
    if (
      code === 'protocol-invalid' &&
      this.snapshot.status === 'ready' &&
      !this.shuttingDown &&
      !this.restarting &&
      Date.now() - this.lastProtocolRecoveryAt >
        PROTOCOL_RECOVERY_WINDOW_MS
    ) {
      this.lastProtocolRecoveryAt = Date.now();
      this.protocolRecoveryPromise ??=
        this.recoverFromProtocolFailure().finally(() => {
          this.protocolRecoveryPromise = null;
        });
      return;
    }
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

  private recoverFromProtocolFailure = async (): Promise<void> => {
    const target = getCliTarget(this.options.platform, this.options.arch);
    if (!target || !this.resolvedCli || this.shuttingDown) {
      this.failAndTerminate('protocol-invalid');
      return;
    }
    const preferredThreadId = this.conversation.getSnapshot().threadId;
    const serverIds = this.mcpSession.getActiveServerIds();
    if (!(await this.closeForRestart()) || this.shuttingDown) {
      this.failAndTerminate('protocol-invalid');
      return;
    }
    this.transition('connecting');
    const connected = await this.connect(
      serverIds,
      preferredThreadId,
      target.expectedPlatform,
    );
    if (!connected && !this.shuttingDown) {
      this.failAndTerminate('protocol-invalid');
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
      conversation.phase === 'stopping' ||
      (conversation.navigator.runningThreadIds?.length ?? 0) > 0
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
      this.mcpApprovals.getSnapshot().status === 'pending' ||
      this.approvalInFlight !== null ||
      this.approvalQueue.length > 0
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
