import type {
  McpConfiguredServer,
  McpSessionActionResult,
  McpSessionStateSnapshot,
  McpSessionStatus,
} from '@/shared/mcp';

type RestartBlock =
  | 'turnActive'
  | 'approvalPending'
  | 'busy'
  | 'unavailable'
  | null;

type McpSessionControllerOptions = Readonly<{
  getRestartBlock: () => RestartBlock;
  restart: (
    serverIds: readonly string[],
  ) => Promise<McpSessionActionResult>;
}>;

const result = (
  reason: McpSessionActionResult['reason'],
): McpSessionActionResult => ({
  accepted: reason === 'accepted',
  reason,
});

const sortIds = (ids: Iterable<string>): string[] =>
  [...ids].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );

export class McpSessionController {
  private readonly options: McpSessionControllerOptions;
  private readonly listeners = new Set<
    (snapshot: McpSessionStateSnapshot) => void
  >();
  private revision = 0;
  private status: McpSessionStatus = 'loading';
  private servers: readonly McpConfiguredServer[] = [];
  private selectedServerIds: string[] = [];
  private activeServerIds: string[] = [];
  private actionNotice: string | undefined;

  constructor(options: McpSessionControllerOptions) {
    this.options = options;
  }

  getSnapshot = (): McpSessionStateSnapshot => ({
    revision: this.revision,
    status: this.status,
    servers: this.servers.map((server) => ({ ...server })),
    selectedServerIds: [...this.selectedServerIds],
    activeServerIds: [...this.activeServerIds],
    ...(this.actionNotice ? { actionNotice: this.actionNotice } : {}),
  });

  subscribe = (
    listener: (snapshot: McpSessionStateSnapshot) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  initialize = (servers: readonly McpConfiguredServer[]): void => {
    this.servers = servers.map((server) => ({ ...server }));
    this.selectedServerIds = [];
    this.activeServerIds = [];
    this.actionNotice = undefined;
    this.publish('disabled');
  };

  unavailable = (notice: string): void => {
    this.selectedServerIds = [];
    this.activeServerIds = [];
    this.actionNotice = notice;
    this.publish('unavailable');
  };

  getActiveServerIds = (): readonly string[] => this.activeServerIds;

  synchronizeActive = (serverIds: readonly string[]): void => {
    const configured = new Set(this.servers.map((server) => server.id));
    const active = sortIds(serverIds.filter((id) => configured.has(id)));
    this.selectedServerIds = active;
    this.activeServerIds = active;
    this.actionNotice = undefined;
    this.publish(active.length > 0 ? 'enabled' : 'disabled');
  };

  toggle = (serverId: unknown): McpSessionActionResult => {
    if (typeof serverId !== 'string') {
      return result('invalid');
    }
    if (
      this.status === 'loading' ||
      this.status === 'enabling' ||
      this.status === 'disabling' ||
      this.status === 'rollingBack'
    ) {
      return result('busy');
    }
    if (this.status === 'unavailable') {
      return result('unavailable');
    }
    const block = this.options.getRestartBlock();
    if (block) {
      return result(block);
    }
    const server = this.servers.find((candidate) => candidate.id === serverId);
    if (!server) {
      return result('invalid');
    }
    const selected = new Set(this.selectedServerIds);
    if (selected.has(serverId)) {
      selected.delete(serverId);
    } else {
      selected.add(serverId);
    }
    const candidateIds = sortIds(selected);
    if (!this.isCompatible(candidateIds)) {
      return result('incompatibleSelection');
    }
    this.selectedServerIds = candidateIds;
    this.actionNotice = undefined;
    this.publish(this.activeServerIds.length > 0 ? 'enabled' : 'disabled');
    return result('accepted');
  };

  enable = async (): Promise<McpSessionActionResult> => {
    if (this.selectedServerIds.length === 0) {
      return result('invalid');
    }
    return this.applySelection(this.selectedServerIds, 'enabling');
  };

  disable = async (): Promise<McpSessionActionResult> => {
    if (this.activeServerIds.length === 0) {
      return result('accepted');
    }
    return this.applySelection([], 'disabling');
  };

  private applySelection = async (
    nextServerIds: readonly string[],
    pendingStatus: 'enabling' | 'disabling',
  ): Promise<McpSessionActionResult> => {
    if (
      this.status === 'loading' ||
      this.status === 'enabling' ||
      this.status === 'disabling' ||
      this.status === 'rollingBack'
    ) {
      return result('busy');
    }
    if (this.status === 'unavailable') {
      return result('unavailable');
    }
    const block = this.options.getRestartBlock();
    if (block) {
      return result(block);
    }
    const previous = [...this.activeServerIds];
    this.actionNotice = undefined;
    this.publish(pendingStatus);
    const attempt = await this.options.restart(nextServerIds);
    if (attempt.accepted) {
      this.activeServerIds = [...nextServerIds];
      this.selectedServerIds = [...nextServerIds];
      this.publish(nextServerIds.length > 0 ? 'enabled' : 'disabled');
      return result('accepted');
    }
    this.actionNotice =
      attempt.reason === 'connectionFailed'
        ? '无法连接所选的本地 MCP 服务，请确认服务已启动后重试。'
        : '所选 MCP 服务未能启用，正在恢复之前的连接。';
    this.publish('rollingBack');
    const rollback = await this.options.restart(previous);
    if (rollback.accepted) {
      this.activeServerIds = previous;
      this.selectedServerIds = [...nextServerIds];
      this.publish(previous.length > 0 ? 'enabled' : 'disabled');
      return result(attempt.reason);
    }
    this.activeServerIds = [];
    this.selectedServerIds = [];
    this.actionNotice =
      '本地智能体和之前的 MCP 连接均未能恢复。';
    this.publish('unavailable');
    return result('unavailable');
  };

  private isCompatible = (ids: readonly string[]): boolean => {
    const servers = ids
      .map((id) => this.servers.find((server) => server.id === id))
      .filter((server): server is McpConfiguredServer => Boolean(server));
    if (servers.length !== ids.length) {
      return false;
    }
    const httpCount = servers.filter(
      (server) => server.transport === 'loopbackStreamableHttp',
    ).length;
    return httpCount === 0 ? servers.length <= 2 : servers.length === 1;
  };

  private publish = (status: McpSessionStatus): void => {
    this.status = status;
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  };
}
