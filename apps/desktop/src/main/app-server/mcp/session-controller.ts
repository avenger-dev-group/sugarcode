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
  restart: (serverIds: readonly string[]) => Promise<boolean>;
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
  private readonly listeners = new Set<
    (snapshot: McpSessionStateSnapshot) => void
  >();
  private revision = 0;
  private status: McpSessionStatus = 'loading';
  private servers: readonly McpConfiguredServer[] = [];
  private selectedServerIds: string[] = [];
  private activeServerIds: string[] = [];
  private actionNotice: string | undefined;

  constructor(private readonly options: McpSessionControllerOptions) {}

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
    if (await this.options.restart(nextServerIds)) {
      this.activeServerIds = [...nextServerIds];
      this.selectedServerIds = [...nextServerIds];
      this.publish(nextServerIds.length > 0 ? 'enabled' : 'disabled');
      return result('accepted');
    }
    this.actionNotice =
      'The selected MCP servers could not be enabled. Restoring the previous session.';
    this.publish('rollingBack');
    if (await this.options.restart(previous)) {
      this.activeServerIds = previous;
      this.selectedServerIds = previous;
      this.publish(previous.length > 0 ? 'enabled' : 'disabled');
      return result('unavailable');
    }
    this.activeServerIds = [];
    this.selectedServerIds = [];
    this.actionNotice =
      'The local Agent and its previous MCP session could not be restored.';
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
