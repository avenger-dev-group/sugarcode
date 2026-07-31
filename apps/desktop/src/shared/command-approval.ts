export const COMMAND_APPROVAL_STATE_GET_CHANNEL =
  'command-approval-state:get';
export const COMMAND_APPROVAL_STATE_CHANGED_CHANNEL =
  'command-approval-state:changed';
export const COMMAND_APPROVAL_APPROVE_CHANNEL = 'command-approval:approve';
export const COMMAND_APPROVAL_DENY_CHANNEL = 'command-approval:deny';

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
  command: string;
  arguments: readonly string[];
  cwd: string;
  approvalScope: 'command';
  environmentPolicy: 'minimalV1';
  sandboxed: true;
  sandboxPolicy: 'filesystemReadOnlyV1';
  networkPolicy: 'networkDeniedV1';
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
  ) => Promise<CommandApprovalActionResult>;
  denyCommand: (
    presentationId: string,
  ) => Promise<CommandApprovalActionResult>;
}>;

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
      'command',
      'arguments',
      'cwd',
      'approvalScope',
      'environmentPolicy',
      'sandboxed',
      'sandboxPolicy',
      'networkPolicy',
      'localExpiresAtMs',
      'actionState',
    ],
    ['sourceAgent'],
  ) &&
  typeof value.presentationId === 'string' &&
  value.presentationId.length > 0 &&
  typeof value.command === 'string' &&
  value.command.length > 0 &&
  Array.isArray(value.arguments) &&
  value.arguments.every((argument) => typeof argument === 'string') &&
  value.cwd === '.' &&
  value.approvalScope === 'command' &&
  value.environmentPolicy === 'minimalV1' &&
  value.sandboxed === true &&
  value.sandboxPolicy === 'filesystemReadOnlyV1' &&
  value.networkPolicy === 'networkDeniedV1' &&
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
    !hasOnlyKeys(value, ['revision', 'status'], ['request']) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status as CommandApprovalStatus)
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
