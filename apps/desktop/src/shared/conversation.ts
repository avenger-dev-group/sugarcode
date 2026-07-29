export const CONVERSATION_STATE_GET_CHANNEL = 'conversation-state:get';
export const CONVERSATION_STATE_CHANGED_CHANNEL = 'conversation-state:changed';
export const CONVERSATION_SEND_CHANNEL = 'conversation:send';
export const CONVERSATION_STOP_CHANNEL = 'conversation:stop';

export const MAX_CONVERSATION_INPUT_BYTES = 64 * 1024;

export type ConversationPhase =
  | 'idle'
  | 'starting'
  | 'inProgress'
  | 'stopping'
  | 'ready'
  | 'unavailable';

export type ConversationTurnStatus =
  | 'inProgress'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type ConversationMessageStatus = 'inProgress' | 'completed';

export type ConversationMessage = Readonly<{
  id: string;
  role: 'user' | 'agent';
  text: string;
  status: ConversationMessageStatus;
}>;

export type ConversationWorkspaceReadOutcome =
  | Readonly<{
      type: 'success';
      bytes: number;
    }>
  | Readonly<{
      type: 'error';
      kind: string;
    }>;

export type ConversationWorkspaceReadActivity = Readonly<{
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationMessageStatus;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationWorkspaceReadOutcome;
  }>;
}>;

export type ConversationWorkspaceListOutcome =
  | Readonly<{
      type: 'success';
      entries: number;
    }>
  | Readonly<{
      type: 'error';
      kind: string;
    }>;

export type ConversationWorkspaceListActivity = Readonly<{
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationMessageStatus;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationWorkspaceListOutcome;
  }>;
}>;

export type ConversationWorkspaceSearchOutcome =
  | Readonly<{
      type: 'success';
      matches: number;
      truncated: boolean;
    }>
  | Readonly<{
      type: 'error';
      kind: string;
    }>;

export type ConversationWorkspaceSearchActivity = Readonly<{
  id: string;
  callId: string;
  path: string;
  query: string;
  callStatus: ConversationMessageStatus;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationWorkspaceSearchOutcome;
  }>;
}>;

export type ConversationCommandApprovalDecision =
  | 'approved'
  | 'denied'
  | 'timedOut'
  | 'unsupported'
  | 'cancelled'
  | 'clientDisconnected';

export type ConversationCommandApprovalActivity = Readonly<{
  callItemId: string;
  id: string;
  callId: string;
  approvalId: string;
  command: string;
  argumentCount: number;
  requestStatus: ConversationMessageStatus;
  decision?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    value: ConversationCommandApprovalDecision;
  }>;
}>;

export type ConversationTurnError = Readonly<{
  kind:
    | 'authentication'
    | 'invalidRequest'
    | 'rateLimited'
    | 'timeout'
    | 'transport'
    | 'disconnected'
    | 'server'
    | 'protocol'
    | 'incomplete'
    | 'filtered'
    | 'unsupportedOutput'
    | 'outputTooLarge'
    | 'stateUnavailable';
  retryable: boolean;
}>;

export type ConversationTurn = Readonly<{
  id: string;
  status: ConversationTurnStatus;
  messages: readonly ConversationMessage[];
  workspaceRead?: ConversationWorkspaceReadActivity;
  workspaceList?: ConversationWorkspaceListActivity;
  workspaceSearch?: ConversationWorkspaceSearchActivity;
  commandApproval?: ConversationCommandApprovalActivity;
  error?: ConversationTurnError;
}>;

export type ConversationNotice = Readonly<{
  kind: 'requestFailed' | 'connectionLost';
  summary: string;
}>;

export type ConversationStateSnapshot = Readonly<{
  revision: number;
  phase: ConversationPhase;
  threadId?: string;
  activeTurnId?: string;
  turns: readonly ConversationTurn[];
  notice?: ConversationNotice;
}>;

export type ConversationActionResult = Readonly<{
  accepted: boolean;
  reason:
    | 'accepted'
    | 'invalidInput'
    | 'turnActive'
    | 'unavailable'
    | 'noActiveTurn';
}>;

export type ConversationStateListener = (
  snapshot: ConversationStateSnapshot,
) => void;

export type ConversationApi = Readonly<{
  getConversationState: () => Promise<ConversationStateSnapshot>;
  onConversationStateChanged: (
    listener: ConversationStateListener,
  ) => () => void;
  sendConversationMessage: (
    input: string,
  ) => Promise<ConversationActionResult>;
  stopConversationTurn: () => Promise<ConversationActionResult>;
}>;

const PHASES = new Set<ConversationPhase>([
  'idle',
  'starting',
  'inProgress',
  'stopping',
  'ready',
  'unavailable',
]);

const TURN_STATUSES = new Set<ConversationTurnStatus>([
  'inProgress',
  'completed',
  'failed',
  'interrupted',
]);

const MESSAGE_STATUSES = new Set<ConversationMessageStatus>([
  'inProgress',
  'completed',
]);

const ERROR_KINDS = new Set<ConversationTurnError['kind']>([
  'authentication',
  'invalidRequest',
  'rateLimited',
  'timeout',
  'transport',
  'disconnected',
  'server',
  'protocol',
  'incomplete',
  'filtered',
  'unsupportedOutput',
  'outputTooLarge',
  'stateUnavailable',
]);

const COMMAND_APPROVAL_DECISIONS = new Set<ConversationCommandApprovalDecision>([
  'approved',
  'denied',
  'timedOut',
  'unsupported',
  'cancelled',
  'clientDisconnected',
]);

const ACTION_REASONS = new Set<ConversationActionResult['reason']>([
  'accepted',
  'invalidInput',
  'turnActive',
  'unavailable',
  'noActiveTurn',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isTurnError = (value: unknown): value is ConversationTurnError =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  ERROR_KINDS.has(value.kind as ConversationTurnError['kind']) &&
  typeof value.retryable === 'boolean';

const isMessage = (value: unknown): value is ConversationMessage =>
  isRecord(value) &&
  isId(value.id) &&
  (value.role === 'user' || value.role === 'agent') &&
  typeof value.text === 'string' &&
  typeof value.status === 'string' &&
  MESSAGE_STATUSES.has(value.status as ConversationMessageStatus);

const isWorkspaceReadOutcome = (
  value: unknown,
): value is ConversationWorkspaceReadOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.bytes === 'number' &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

const isWorkspaceReadActivity = (
  value: unknown,
): value is ConversationWorkspaceReadActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.result.status as ConversationMessageStatus,
    ) &&
    isWorkspaceReadOutcome(value.result.outcome)
  );
};

const isWorkspaceListOutcome = (
  value: unknown,
): value is ConversationWorkspaceListOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.entries === 'number' &&
      Number.isSafeInteger(value.entries) &&
      value.entries >= 0 &&
      value.entries <= 1_000
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

const isWorkspaceListActivity = (
  value: unknown,
): value is ConversationWorkspaceListActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.result.status as ConversationMessageStatus,
    ) &&
    isWorkspaceListOutcome(value.result.outcome)
  );
};

const isWorkspaceSearchOutcome = (
  value: unknown,
): value is ConversationWorkspaceSearchOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.matches === 'number' &&
      Number.isSafeInteger(value.matches) &&
      value.matches >= 0 &&
      value.matches <= 200 &&
      typeof value.truncated === 'boolean' &&
      (!value.truncated || value.matches === 200)
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

const isWorkspaceSearchActivity = (
  value: unknown,
): value is ConversationWorkspaceSearchActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.query !== 'string' ||
    value.query.length === 0 ||
    new TextEncoder().encode(value.query).byteLength > 256 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.result.status as ConversationMessageStatus,
    ) &&
    isWorkspaceSearchOutcome(value.result.outcome)
  );
};

const isCommandApprovalActivity = (
  value: unknown,
): value is ConversationCommandApprovalActivity => {
  if (
    !isRecord(value) ||
    !isId(value.callItemId) ||
    !isId(value.id) ||
    value.callItemId === value.id ||
    !isId(value.callId) ||
    !isId(value.approvalId) ||
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    new TextEncoder().encode(value.command).byteLength > 1_024 ||
    Array.from(value.command).some((character) => /\p{Cc}/u.test(character)) ||
    typeof value.argumentCount !== 'number' ||
    !Number.isSafeInteger(value.argumentCount) ||
    value.argumentCount < 0 ||
    value.argumentCount > 64 ||
    typeof value.requestStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.requestStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'decision')) {
    return true;
  }
  return (
    value.requestStatus === 'completed' &&
    isRecord(value.decision) &&
    isId(value.decision.id) &&
    value.decision.id !== value.id &&
    value.decision.id !== value.callItemId &&
    typeof value.decision.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.decision.status as ConversationMessageStatus,
    ) &&
    typeof value.decision.value === 'string' &&
    COMMAND_APPROVAL_DECISIONS.has(
      value.decision.value as ConversationCommandApprovalDecision,
    )
  );
};

const isTurn = (value: unknown): value is ConversationTurn => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.status !== 'string' ||
    !TURN_STATUSES.has(value.status as ConversationTurnStatus) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage) ||
    (Object.hasOwn(value, 'workspaceRead') &&
      !isWorkspaceReadActivity(value.workspaceRead)) ||
    (Object.hasOwn(value, 'workspaceList') &&
      !isWorkspaceListActivity(value.workspaceList)) ||
    (Object.hasOwn(value, 'workspaceSearch') &&
      !isWorkspaceSearchActivity(value.workspaceSearch)) ||
    (Object.hasOwn(value, 'commandApproval') &&
      !isCommandApprovalActivity(value.commandApproval)) ||
    [
      Object.hasOwn(value, 'workspaceRead'),
      Object.hasOwn(value, 'workspaceList'),
      Object.hasOwn(value, 'workspaceSearch'),
      Object.hasOwn(value, 'commandApproval'),
    ].filter(Boolean).length > 1
  ) {
    return false;
  }

  if (
    value.status !== 'inProgress' &&
    value.messages.some((message) => message.status !== 'completed')
  ) {
    return false;
  }

  const workspaceRead = value.workspaceRead as
    | ConversationWorkspaceReadActivity
    | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceRead &&
    (workspaceRead.callStatus !== 'completed' ||
      (workspaceRead.result &&
        workspaceRead.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceRead.result?.status !== 'completed'))
  ) {
    return false;
  }

  const workspaceList = value.workspaceList as
    | ConversationWorkspaceListActivity
    | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceList &&
    (workspaceList.callStatus !== 'completed' ||
      (workspaceList.result &&
        workspaceList.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceList.result?.status !== 'completed'))
  ) {
    return false;
  }

  const workspaceSearch = value.workspaceSearch as
    | ConversationWorkspaceSearchActivity
    | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceSearch &&
    (workspaceSearch.callStatus !== 'completed' ||
      (workspaceSearch.result &&
        workspaceSearch.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceSearch.result?.status !== 'completed'))
  ) {
    return false;
  }

  const commandApproval = value.commandApproval as
    | ConversationCommandApprovalActivity
    | undefined;
  if (
    value.status !== 'inProgress' &&
    commandApproval &&
    (commandApproval.requestStatus !== 'completed' ||
      (commandApproval.decision &&
        commandApproval.decision.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        commandApproval.decision?.status !== 'completed'))
  ) {
    return false;
  }

  const hasError = Object.hasOwn(value, 'error');
  return value.status === 'failed'
    ? hasError && isTurnError(value.error)
    : !hasError;
};

const isNotice = (value: unknown): value is ConversationNotice =>
  isRecord(value) &&
  (value.kind === 'requestFailed' || value.kind === 'connectionLost') &&
  typeof value.summary === 'string' &&
  value.summary.length > 0;

export const isConversationStateSnapshot = (
  value: unknown,
): value is ConversationStateSnapshot => {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.phase !== 'string' ||
    !PHASES.has(value.phase as ConversationPhase) ||
    !Array.isArray(value.turns) ||
    !value.turns.every(isTurn) ||
    (Object.hasOwn(value, 'threadId') && !isId(value.threadId)) ||
    (Object.hasOwn(value, 'activeTurnId') && !isId(value.activeTurnId)) ||
    (Object.hasOwn(value, 'notice') && !isNotice(value.notice))
  ) {
    return false;
  }

  const activeTurns = value.turns.filter(
    (turn) => turn.status === 'inProgress',
  );
  const activeTurnId = value.activeTurnId as string | undefined;
  const phaseHasActiveTurn =
    value.phase === 'inProgress' || value.phase === 'stopping';
  if (phaseHasActiveTurn) {
    return (
      activeTurns.length === 1 &&
      activeTurnId === activeTurns[0]?.id &&
      isId(value.threadId)
    );
  }
  if (value.phase === 'unavailable' && activeTurns.length === 1) {
    return (
      activeTurnId === activeTurns[0]?.id &&
      isId(value.threadId)
    );
  }
  return activeTurns.length === 0 && activeTurnId === undefined;
};

export const isConversationActionResult = (
  value: unknown,
): value is ConversationActionResult =>
  isRecord(value) &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  ACTION_REASONS.has(value.reason as ConversationActionResult['reason']) &&
  value.accepted === (value.reason === 'accepted');

export const isValidConversationInput = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).byteLength <= MAX_CONVERSATION_INPUT_BYTES;
