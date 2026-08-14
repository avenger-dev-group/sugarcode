export const COMMAND_APPROVAL_STATE_GET_CHANNEL =
  'command-approval-state:get';
export const COMMAND_APPROVAL_STATE_CHANGED_CHANNEL =
  'command-approval-state:changed';
export const COMMAND_APPROVAL_APPROVE_CHANNEL = 'command-approval:approve';
export const COMMAND_APPROVAL_DENY_CHANNEL = 'command-approval:deny';
export const COMMAND_APPROVAL_MODE_SET_CHANNEL = 'command-approval-mode:set';

export type CommandApprovalMode = 'ask' | 'thread' | 'workspace';

export type CommandApprovalStatus =
  | 'idle'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled';

export type CommandApprovalActionState =
  | 'awaitingUser'
  | 'submittingApproval'
  | 'submittingDenial'
  | 'localWindowElapsed';

export type CommandApprovalViewModel = Readonly<{
  presentationId: string;
  operationKind: 'workspacePatch' | 'shell' | 'projectEnvironment';
  description: string;
  command: string;
  cwd: string;
  fullAccess: boolean;
  platformShell?: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  queueCount: number;
  projectTitle: string;
  conversationTitle: string;
  sourceAgent?: Readonly<{
    taskId: string;
    role: 'explorer' | 'worker' | 'auditor';
  }>;
  localExpiresAtMs: number;
  actionState: CommandApprovalActionState;
}>;

export type CommandApprovalStateSnapshot = Readonly<{
  revision: number;
  status: CommandApprovalStatus;
  mode: CommandApprovalMode;
  modeThreadId?: string;
  modeWorkspaceId?: string;
  request?: CommandApprovalViewModel;
  requests?: readonly CommandApprovalViewModel[];
  threadModeIds?: readonly string[];
  workspaceModeIds?: readonly string[];
}>;

export const resolveCommandApprovalMode = (
  snapshot: CommandApprovalStateSnapshot,
  threadId: string | null,
  workspaceId: string | null,
): CommandApprovalMode => {
  if (
    workspaceId !== null &&
    snapshot.workspaceModeIds?.includes(workspaceId) === true
  ) {
    return 'workspace';
  }
  if (
    threadId !== null &&
    snapshot.threadModeIds?.includes(threadId) === true
  ) {
    return 'thread';
  }
  if (
    snapshot.mode === 'thread' &&
    snapshot.modeThreadId === threadId
  ) {
    return 'thread';
  }
  if (
    snapshot.mode === 'workspace' &&
    snapshot.modeWorkspaceId === workspaceId
  ) {
    return 'workspace';
  }
  return 'ask';
};

export type CommandApprovalActionResult = Readonly<{
  accepted: boolean;
  reason: 'accepted' | 'stale' | 'unavailable' | 'invalid';
}>;

export type CommandApprovalStateListener = (
  snapshot: CommandApprovalStateSnapshot,
) => void;

export type CommandApprovalApi = Readonly<{
  getCommandApprovalState: () => Promise<CommandApprovalStateSnapshot>;
  onCommandApprovalStateChanged: (
    listener: CommandApprovalStateListener,
  ) => () => void;
  approveCommand: (
    presentationId: string,
    mode: CommandApprovalMode,
  ) => Promise<CommandApprovalActionResult>;
  denyCommand: (
    presentationId: string,
  ) => Promise<CommandApprovalActionResult>;
  setCommandApprovalMode: (
    mode: CommandApprovalMode,
    threadId?: string,
    workspaceId?: string,
  ) => Promise<CommandApprovalActionResult>;
}>;

const MODES = new Set<CommandApprovalMode>(['ask', 'thread', 'workspace']);

const STATUSES = new Set<CommandApprovalStatus>([
  'idle',
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
]);

const ACTION_STATES = new Set<CommandApprovalActionState>([
  'awaitingUser',
  'submittingApproval',
  'submittingDenial',
  'localWindowElapsed',
]);

const ACTION_REASONS = new Set<CommandApprovalActionResult['reason']>([
  'accepted',
  'stale',
  'unavailable',
  'invalid',
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

const isViewModel = (value: unknown): value is CommandApprovalViewModel =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    [
      'presentationId',
      'operationKind',
      'description',
      'command',
      'cwd',
      'fullAccess',
      'workspaceId',
      'threadId',
      'turnId',
      'queueCount',
      'projectTitle',
      'conversationTitle',
      'localExpiresAtMs',
      'actionState',
    ],
    ['sourceAgent', 'platformShell'],
  ) &&
  typeof value.presentationId === 'string' &&
  value.presentationId.length > 0 &&
  (value.operationKind === 'workspacePatch' ||
    value.operationKind === 'shell' ||
    value.operationKind === 'projectEnvironment') &&
  typeof value.description === 'string' &&
  value.description.length > 0 &&
  typeof value.command === 'string' &&
  value.command.length > 0 &&
  typeof value.cwd === 'string' &&
  value.cwd.length > 0 &&
  typeof value.fullAccess === 'boolean' &&
  (value.platformShell === undefined ||
    (typeof value.platformShell === 'string' && value.platformShell.length > 0)) &&
  typeof value.workspaceId === 'string' &&
  value.workspaceId.length > 0 &&
  typeof value.threadId === 'string' &&
  value.threadId.length > 0 &&
  typeof value.turnId === 'string' &&
  value.turnId.length > 0 &&
  Number.isSafeInteger(value.queueCount) &&
  (value.queueCount as number) >= 1 &&
  typeof value.projectTitle === 'string' &&
  value.projectTitle.length > 0 &&
  typeof value.conversationTitle === 'string' &&
  value.conversationTitle.length > 0 &&
  typeof value.localExpiresAtMs === 'number' &&
  Number.isSafeInteger(value.localExpiresAtMs) &&
  value.localExpiresAtMs >= 0 &&
  typeof value.actionState === 'string' &&
  ACTION_STATES.has(value.actionState as CommandApprovalActionState) &&
  (value.sourceAgent === undefined ||
    (isRecord(value.sourceAgent) &&
      hasOnlyKeys(value.sourceAgent, ['taskId', 'role']) &&
      typeof value.sourceAgent.taskId === 'string' &&
      value.sourceAgent.taskId.length > 0 &&
      (value.sourceAgent.role === 'explorer' ||
        value.sourceAgent.role === 'worker' ||
        value.sourceAgent.role === 'auditor')));

export const isCommandApprovalStateSnapshot = (
  value: unknown,
): value is CommandApprovalStateSnapshot => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ['revision', 'status', 'mode'],
      [
        'request',
        'requests',
        'modeThreadId',
        'modeWorkspaceId',
        'threadModeIds',
        'workspaceModeIds',
      ],
    ) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status as CommandApprovalStatus) ||
    typeof value.mode !== 'string' ||
    !MODES.has(value.mode as CommandApprovalMode) ||
    (value.mode === 'thread') !== Object.hasOwn(value, 'modeThreadId') ||
    (Object.hasOwn(value, 'modeThreadId') &&
      (typeof value.modeThreadId !== 'string' ||
        value.modeThreadId.length === 0)) ||
    (value.mode === 'workspace') !== Object.hasOwn(value, 'modeWorkspaceId') ||
    (Object.hasOwn(value, 'modeWorkspaceId') &&
      (typeof value.modeWorkspaceId !== 'string' ||
        value.modeWorkspaceId.length === 0)) ||
    (value.threadModeIds !== undefined &&
      (!Array.isArray(value.threadModeIds) ||
        value.threadModeIds.some(
          (id) => typeof id !== 'string' || id.length === 0,
        ) ||
        new Set(value.threadModeIds).size !== value.threadModeIds.length)) ||
    (value.workspaceModeIds !== undefined &&
      (!Array.isArray(value.workspaceModeIds) ||
        value.workspaceModeIds.some(
          (id) => typeof id !== 'string' || id.length === 0,
        ) ||
        new Set(value.workspaceModeIds).size !== value.workspaceModeIds.length)) ||
    (value.requests !== undefined &&
      (!Array.isArray(value.requests) ||
        value.requests.some((request) => !isViewModel(request))))
  ) {
    return false;
  }
  const requests = value.requests as
    | readonly CommandApprovalViewModel[]
    | undefined;
  if (value.status === 'pending') {
    if (!Object.hasOwn(value, 'request') || !isViewModel(value.request)) {
      return false;
    }
    return (
      requests === undefined ||
      (requests.length > 0 &&
        requests[0]?.presentationId === value.request.presentationId)
    );
  }
  return (
    !Object.hasOwn(value, 'request') &&
    (requests === undefined || requests.length === 0)
  );
};

export const isCommandApprovalActionResult = (
  value: unknown,
): value is CommandApprovalActionResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ['accepted', 'reason']) &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  ACTION_REASONS.has(value.reason as CommandApprovalActionResult['reason']) &&
  value.accepted === (value.reason === 'accepted');
