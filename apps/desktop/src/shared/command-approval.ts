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
  description: string;
  command: string;
  cwd: string;
  fullAccess: boolean;
  platformShell?: string;
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
  request?: CommandApprovalViewModel;
}>;

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
      'description',
      'command',
      'cwd',
      'fullAccess',
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
  typeof value.description === 'string' &&
  value.description.length > 0 &&
  typeof value.command === 'string' &&
  value.command.length > 0 &&
  typeof value.cwd === 'string' &&
  value.cwd.length > 0 &&
  typeof value.fullAccess === 'boolean' &&
  (value.platformShell === undefined ||
    (typeof value.platformShell === 'string' && value.platformShell.length > 0)) &&
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
      ['request', 'modeThreadId'],
    ) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status as CommandApprovalStatus) ||
    typeof value.mode !== 'string' ||
    !MODES.has(value.mode as CommandApprovalMode) ||
    (Object.hasOwn(value, 'modeThreadId') &&
      (value.mode !== 'thread' ||
        typeof value.modeThreadId !== 'string' ||
        value.modeThreadId.length === 0))
  ) {
    return false;
  }
  return value.status === 'pending'
    ? Object.hasOwn(value, 'request') && isViewModel(value.request)
    : !Object.hasOwn(value, 'request');
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
