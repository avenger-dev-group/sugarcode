export const MCP_SESSION_STATE_GET_CHANNEL = 'mcp-session-state:get';
export const MCP_SESSION_STATE_CHANGED_CHANNEL = 'mcp-session-state:changed';
export const MCP_SESSION_TOGGLE_CHANNEL = 'mcp-session:toggle';
export const MCP_SESSION_ENABLE_CHANNEL = 'mcp-session:enable';
export const MCP_SESSION_DISABLE_CHANNEL = 'mcp-session:disable';
export const MCP_APPROVAL_STATE_GET_CHANNEL = 'mcp-approval-state:get';
export const MCP_APPROVAL_STATE_CHANGED_CHANNEL = 'mcp-approval-state:changed';
export const MCP_APPROVAL_APPROVE_CHANNEL = 'mcp-approval:approve';
export const MCP_APPROVAL_DENY_CHANNEL = 'mcp-approval:deny';
export const MCP_CONFIG_GET_CHANNEL = 'mcp-config:get';
export const MCP_CONFIG_SAVE_CHANNEL = 'mcp-config:save';

export type McpServerTransport = 'stdio' | 'loopbackStreamableHttp';

export type McpConfiguredServer = Readonly<{
  id: string;
  transport: McpServerTransport;
}>;

export type McpStdioServerConfig = Readonly<{
  id: string;
  transport: 'stdio';
  executable: string;
  argv: readonly string[];
  cwd: string;
}>;

export type McpHttpServerConfig = Readonly<{
  id: string;
  transport: 'loopbackStreamableHttp';
  endpoint: string;
}>;

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig;

export type McpConfigInspection = Readonly<{
  contractVersion: 1;
  revision: string;
  servers: readonly McpServerConfig[];
}>;

export type McpConfigSaveRequest = Readonly<{
  expectedRevision: string;
  servers: readonly McpServerConfig[];
}>;

export type McpConfigActionResult = Readonly<{
  accepted: boolean;
  reason:
    | 'accepted'
    | 'invalid'
    | 'stale'
    | 'sessionActive'
    | 'turnActive'
    | 'approvalPending'
    | 'navigationPending'
    | 'reconnectPending'
    | 'busy'
    | 'unavailable';
  inspection?: McpConfigInspection;
}>;

export type McpSessionStatus =
  | 'loading'
  | 'disabled'
  | 'enabling'
  | 'enabled'
  | 'disabling'
  | 'rollingBack'
  | 'unavailable';

export type McpSessionStateSnapshot = Readonly<{
  revision: number;
  status: McpSessionStatus;
  servers: readonly McpConfiguredServer[];
  selectedServerIds: readonly string[];
  activeServerIds: readonly string[];
  actionNotice?: string;
}>;

export type McpSessionActionResult = Readonly<{
  accepted: boolean;
  reason:
    | 'accepted'
    | 'invalid'
    | 'incompatibleSelection'
    | 'turnActive'
    | 'approvalPending'
    | 'busy'
    | 'unavailable';
}>;

export type McpApprovalStatus =
  | 'idle'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled';

export type McpApprovalActionState =
  | 'awaitingUser'
  | 'submittingApproval'
  | 'submittingDenial'
  | 'localWindowElapsed';

export type McpApprovalViewModel = Readonly<{
  presentationId: string;
  threadId: string;
  turnId: string;
  queueCount: number;
  projectTitle: string;
  conversationTitle: string;
  serverId: string;
  name: string;
  argumentsJson: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  sourceAgent?: Readonly<{
    taskId: string;
    role: 'explorer' | 'worker' | 'auditor';
  }>;
  localExpiresAtMs: number;
  actionState: McpApprovalActionState;
}>;

export type McpApprovalStateSnapshot = Readonly<{
  revision: number;
  status: McpApprovalStatus;
  request?: McpApprovalViewModel;
  requests?: readonly McpApprovalViewModel[];
}>;

export type McpApprovalActionResult = Readonly<{
  accepted: boolean;
  reason: 'accepted' | 'stale' | 'unavailable' | 'invalid';
}>;

export type McpApi = Readonly<{
  getMcpConfig: () => Promise<McpConfigInspection>;
  saveMcpConfig: (
    request: McpConfigSaveRequest,
  ) => Promise<McpConfigActionResult>;
  getMcpSessionState: () => Promise<McpSessionStateSnapshot>;
  onMcpSessionStateChanged: (
    listener: (snapshot: McpSessionStateSnapshot) => void,
  ) => () => void;
  toggleMcpServer: (serverId: string) => Promise<McpSessionActionResult>;
  enableMcpSession: () => Promise<McpSessionActionResult>;
  disableMcpSession: () => Promise<McpSessionActionResult>;
  getMcpApprovalState: () => Promise<McpApprovalStateSnapshot>;
  onMcpApprovalStateChanged: (
    listener: (snapshot: McpApprovalStateSnapshot) => void,
  ) => () => void;
  approveMcpCall: (
    presentationId: string,
  ) => Promise<McpApprovalActionResult>;
  denyMcpCall: (
    presentationId: string,
  ) => Promise<McpApprovalActionResult>;
}>;

const SESSION_STATUSES = new Set<McpSessionStatus>([
  'loading',
  'disabled',
  'enabling',
  'enabled',
  'disabling',
  'rollingBack',
  'unavailable',
]);
const TRANSPORTS = new Set<McpServerTransport>([
  'stdio',
  'loopbackStreamableHttp',
]);
const SESSION_REASONS = new Set<McpSessionActionResult['reason']>([
  'accepted',
  'invalid',
  'incompatibleSelection',
  'turnActive',
  'approvalPending',
  'busy',
  'unavailable',
]);
const APPROVAL_STATUSES = new Set<McpApprovalStatus>([
  'idle',
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
]);
const APPROVAL_ACTION_STATES = new Set<McpApprovalActionState>([
  'awaitingUser',
  'submittingApproval',
  'submittingDenial',
  'localWindowElapsed',
]);
const APPROVAL_REASONS = new Set<McpApprovalActionResult['reason']>([
  'accepted',
  'stale',
  'unavailable',
  'invalid',
]);
const CONFIG_REASONS = new Set<McpConfigActionResult['reason']>([
  'accepted',
  'invalid',
  'stale',
  'sessionActive',
  'turnActive',
  'approvalPending',
  'navigationPending',
  'reconnectPending',
  'busy',
  'unavailable',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const isId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value) &&
  new TextEncoder().encode(value).byteLength <= 128;

const isMcpServerId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value) &&
  new TextEncoder().encode(value).byteLength <= 32;

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });

const isBoundedPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  byteLength(value) > 0 &&
  byteLength(value) <= 1_024 &&
  !hasControlCharacter(value) &&
  (value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    (/^\\\\[^?\\.]/u.test(value) && !value.startsWith('\\\\?\\')));

const isLoopbackEndpoint = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    byteLength(value) > 1_024 ||
    hasControlCharacter(value) ||
    /[\\?#]/u.test(value)
  ) {
    return false;
  }
  const match =
    /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/(.+)$/u.exec(
      value,
    );
  const port = Number(match?.[1]);
  return Boolean(match?.[2]) && port >= 1 && port <= 65_535;
};

const isMcpServerConfig = (value: unknown): value is McpServerConfig => {
  if (
    !isRecord(value) ||
    !isMcpServerId(value.id) ||
    typeof value.transport !== 'string'
  ) {
    return false;
  }
  if (value.transport === 'stdio') {
    return (
      hasOnlyKeys(value, ['id', 'transport', 'executable', 'argv', 'cwd']) &&
      isBoundedPath(value.executable) &&
      isStringArray(value.argv) &&
      value.argv.length <= 32 &&
      value.argv.every(
        (argument) =>
          byteLength(argument) <= 8_192 &&
          !hasControlCharacter(argument),
      ) &&
      value.argv.reduce(
        (total, argument) => total + byteLength(argument),
        0,
      ) <= 32_768 &&
      isBoundedPath(value.cwd)
    );
  }
  return (
    value.transport === 'loopbackStreamableHttp' &&
    hasOnlyKeys(value, ['id', 'transport', 'endpoint']) &&
    isLoopbackEndpoint(value.endpoint)
  );
};

export const isMcpConfigInspection = (
  value: unknown,
): value is McpConfigInspection => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['contractVersion', 'revision', 'servers']) ||
    value.contractVersion !== 1 ||
    !isSha256(value.revision) ||
    !Array.isArray(value.servers) ||
    value.servers.length > 2
  ) {
    return false;
  }
  const ids = new Set<string>();
  return value.servers.every((server) => {
    if (!isMcpServerConfig(server) || ids.has(server.id)) {
      return false;
    }
    ids.add(server.id);
    return true;
  });
};

export const isMcpConfigSaveRequest = (
  value: unknown,
): value is McpConfigSaveRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['expectedRevision', 'servers']) &&
  isSha256(value.expectedRevision) &&
  Array.isArray(value.servers) &&
  value.servers.length <= 2 &&
  value.servers.every(isMcpServerConfig) &&
  new Set(value.servers.map((server) => server.id)).size ===
    value.servers.length;

export const isMcpConfigActionResult = (
  value: unknown,
): value is McpConfigActionResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ['accepted', 'reason'], ['inspection']) &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  CONFIG_REASONS.has(value.reason as McpConfigActionResult['reason']) &&
  value.accepted === (value.reason === 'accepted') &&
  (value.inspection === undefined ||
    isMcpConfigInspection(value.inspection));

export const isMcpSessionStateSnapshot = (
  value: unknown,
): value is McpSessionStateSnapshot => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'revision',
        'status',
        'servers',
        'selectedServerIds',
        'activeServerIds',
      ],
      ['actionNotice'],
    ) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.status !== 'string' ||
    !SESSION_STATUSES.has(value.status as McpSessionStatus) ||
    !Array.isArray(value.servers) ||
    !isStringArray(value.selectedServerIds) ||
    !isStringArray(value.activeServerIds) ||
    (value.actionNotice !== undefined &&
      typeof value.actionNotice !== 'string')
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const server of value.servers) {
    if (
      !isRecord(server) ||
      !hasOnlyKeys(server, ['id', 'transport']) ||
      !isMcpServerId(server.id) ||
      typeof server.transport !== 'string' ||
      !TRANSPORTS.has(server.transport as McpServerTransport) ||
      ids.has(server.id)
    ) {
      return false;
    }
    ids.add(server.id);
  }
  return (
    value.selectedServerIds.every((id) => ids.has(id)) &&
    value.activeServerIds.every((id) => ids.has(id))
  );
};

export const isMcpSessionActionResult = (
  value: unknown,
): value is McpSessionActionResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ['accepted', 'reason']) &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  SESSION_REASONS.has(value.reason as McpSessionActionResult['reason']) &&
  value.accepted === (value.reason === 'accepted');

const isMcpApprovalViewModel = (
  request: unknown,
): request is McpApprovalViewModel =>
  isRecord(request) &&
    hasOnlyKeys(
      request,
      [
        'presentationId',
        'threadId',
        'turnId',
        'queueCount',
        'projectTitle',
        'conversationTitle',
        'serverId',
        'name',
        'argumentsJson',
        'argumentsBytes',
        'argumentsSha256',
        'inventorySha256',
        'localExpiresAtMs',
        'actionState',
      ],
      ['sourceAgent'],
    ) &&
    typeof request.presentationId === 'string' &&
    request.presentationId.length > 0 &&
    isId(request.threadId) &&
    isId(request.turnId) &&
    Number.isSafeInteger(request.queueCount) &&
    (request.queueCount as number) >= 1 &&
    typeof request.projectTitle === 'string' &&
    request.projectTitle.length > 0 &&
    typeof request.conversationTitle === 'string' &&
    request.conversationTitle.length > 0 &&
    isMcpServerId(request.serverId) &&
    typeof request.name === 'string' &&
    request.name.startsWith(`mcp__${request.serverId}__`) &&
    typeof request.argumentsJson === 'string' &&
    Number.isSafeInteger(request.argumentsBytes) &&
    (request.argumentsBytes as number) >= 2 &&
    (request.argumentsBytes as number) <= 32 * 1024 &&
    byteLength(request.argumentsJson) === request.argumentsBytes &&
    isSha256(request.argumentsSha256) &&
    isSha256(request.inventorySha256) &&
    Number.isSafeInteger(request.localExpiresAtMs) &&
    (request.localExpiresAtMs as number) >= 0 &&
    typeof request.actionState === 'string' &&
    APPROVAL_ACTION_STATES.has(
      request.actionState as McpApprovalActionState,
    ) &&
    (request.sourceAgent === undefined ||
      (isRecord(request.sourceAgent) &&
        hasOnlyKeys(request.sourceAgent, ['taskId', 'role']) &&
        isId(request.sourceAgent.taskId) &&
        (request.sourceAgent.role === 'explorer' ||
          request.sourceAgent.role === 'worker' ||
          request.sourceAgent.role === 'auditor')));

export const isMcpApprovalStateSnapshot = (
  value: unknown,
): value is McpApprovalStateSnapshot => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['revision', 'status'], ['request', 'requests']) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.status !== 'string' ||
    !APPROVAL_STATUSES.has(value.status as McpApprovalStatus) ||
    (value.requests !== undefined &&
      (!Array.isArray(value.requests) ||
        value.requests.some((request) => !isMcpApprovalViewModel(request))))
  ) {
    return false;
  }
  const requests = value.requests as readonly McpApprovalViewModel[] | undefined;
  if (value.status !== 'pending') {
    return (
      value.request === undefined &&
      (requests === undefined || requests.length === 0)
    );
  }
  return (
    isMcpApprovalViewModel(value.request) &&
    (requests === undefined ||
      (requests.length > 0 &&
        requests[0]?.presentationId === value.request.presentationId))
  );
};

export const isMcpApprovalActionResult = (
  value: unknown,
): value is McpApprovalActionResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ['accepted', 'reason']) &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  APPROVAL_REASONS.has(value.reason as McpApprovalActionResult['reason']) &&
  value.accepted === (value.reason === 'accepted');
