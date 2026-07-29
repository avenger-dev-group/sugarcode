export const CONVERSATION_STATE_GET_CHANNEL = 'conversation-state:get';
export const CONVERSATION_STATE_CHANGED_CHANNEL = 'conversation-state:changed';
export const CONVERSATION_SEND_CHANNEL = 'conversation:send';
export const CONVERSATION_STOP_CHANNEL = 'conversation:stop';
export const CONVERSATION_THREAD_SEARCH_CHANNEL =
  'conversation-thread:search';
export const CONVERSATION_THREAD_SELECT_CHANNEL =
  'conversation-thread:select';

export const MAX_CONVERSATION_INPUT_BYTES = 64 * 1024;
export const MAX_THREAD_SEARCH_BYTES = 256;

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

export type ConversationCommandExecutionResultOutcome =
  | Readonly<{ type: 'error'; kind: string }>
  | Readonly<{
      type: 'process';
      stdoutBytes: number;
      stderrBytes: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      encoding: 'utf8Lossy';
      durationMs: number;
      outcome:
        | Readonly<{ type: 'exitCode'; code: number }>
        | Readonly<{ type: 'signal'; signal: number }>
        | Readonly<{ type: 'timedOut' }>;
      sandboxPolicy: 'filesystemReadOnlyV1';
      networkPolicy: 'networkDeniedV1';
    }>;

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
  executionAttempt?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
  }>;
  executionResult?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationCommandExecutionResultOutcome;
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

export type ConversationThreadNavigatorSnapshot = Readonly<{
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  activeThreadIds: readonly string[];
  activeTruncated: boolean;
  search: Readonly<{
    query: string;
    status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
    threadIds: readonly string[];
    truncated: boolean;
    summary?: string;
  }>;
  pendingThreadId?: string;
  selectionNotice?: string;
}>;

export type ConversationStateSnapshot = Readonly<{
  revision: number;
  phase: ConversationPhase;
  threadId?: string;
  activeTurnId?: string;
  turns: readonly ConversationTurn[];
  navigator: ConversationThreadNavigatorSnapshot;
  notice?: ConversationNotice;
}>;

export type ConversationActionResult = Readonly<{
  accepted: boolean;
  reason:
    | 'accepted'
    | 'invalidInput'
    | 'invalidSearch'
    | 'unknownThread'
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
  searchConversationThreads: (
    query: string,
  ) => Promise<ConversationActionResult>;
  selectConversationThread: (
    threadId: string,
  ) => Promise<ConversationActionResult>;
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
  'invalidSearch',
  'unknownThread',
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

const isCommandExecutionResultOutcome = (
  value: unknown,
): value is ConversationCommandExecutionResultOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'error') {
    return (
      Object.keys(value).length === 2 &&
      typeof value.kind === 'string' &&
      value.kind.length > 0
    );
  }
  if (
    value.type !== 'process' ||
    Object.keys(value).length !== 10 ||
    typeof value.stdoutBytes !== 'number' ||
    !Number.isSafeInteger(value.stdoutBytes) ||
    value.stdoutBytes < 0 ||
    typeof value.stderrBytes !== 'number' ||
    !Number.isSafeInteger(value.stderrBytes) ||
    value.stderrBytes < 0 ||
    typeof value.stdoutTruncated !== 'boolean' ||
    typeof value.stderrTruncated !== 'boolean' ||
    value.encoding !== 'utf8Lossy' ||
    typeof value.durationMs !== 'number' ||
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs < 0 ||
    value.sandboxPolicy !== 'filesystemReadOnlyV1' ||
    value.networkPolicy !== 'networkDeniedV1' ||
    !isRecord(value.outcome)
  ) {
    return false;
  }
  if (value.outcome.type === 'timedOut') {
    return Object.keys(value.outcome).length === 1;
  }
  if (value.outcome.type === 'exitCode') {
    return (
      Object.keys(value.outcome).length === 2 &&
      typeof value.outcome.code === 'number' &&
      Number.isSafeInteger(value.outcome.code)
    );
  }
  return (
    value.outcome.type === 'signal' &&
    Object.keys(value.outcome).length === 2 &&
    typeof value.outcome.signal === 'number' &&
    Number.isSafeInteger(value.outcome.signal)
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
    return (
      !Object.hasOwn(value, 'executionAttempt') &&
      !Object.hasOwn(value, 'executionResult')
    );
  }
  if (!(
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
  )) {
    return false;
  }
  if (!Object.hasOwn(value, 'executionAttempt')) {
    return !Object.hasOwn(value, 'executionResult');
  }
  if (!(
    value.decision.value === 'approved' &&
    value.decision.status === 'completed' &&
    isRecord(value.executionAttempt) &&
    isId(value.executionAttempt.id) &&
    value.executionAttempt.id !== value.id &&
    value.executionAttempt.id !== value.callItemId &&
    value.executionAttempt.id !== value.decision.id &&
    typeof value.executionAttempt.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.executionAttempt.status as ConversationMessageStatus,
    )
  )) {
    return false;
  }
  if (!Object.hasOwn(value, 'executionResult')) {
    return true;
  }
  return (
    value.executionAttempt.status === 'completed' &&
    isRecord(value.executionResult) &&
    isId(value.executionResult.id) &&
    value.executionResult.id !== value.id &&
    value.executionResult.id !== value.callItemId &&
    value.executionResult.id !== value.decision.id &&
    value.executionResult.id !== value.executionAttempt.id &&
    typeof value.executionResult.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.executionResult.status as ConversationMessageStatus,
    ) &&
    isCommandExecutionResultOutcome(value.executionResult.outcome)
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
      (commandApproval.executionAttempt &&
        commandApproval.executionAttempt.status !== 'completed') ||
      (commandApproval.executionResult &&
        commandApproval.executionResult.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        (commandApproval.decision?.status !== 'completed' ||
          (commandApproval.executionAttempt &&
            commandApproval.executionResult?.status !== 'completed'))))
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

const isThreadNavigator = (
  value: unknown,
): value is ConversationThreadNavigatorSnapshot => {
  if (
    !isRecord(value) ||
    !['loading', 'ready', 'error', 'unavailable'].includes(
      value.status as string,
    ) ||
    !Array.isArray(value.activeThreadIds) ||
    !value.activeThreadIds.every(isId) ||
    new Set(value.activeThreadIds).size !== value.activeThreadIds.length ||
    typeof value.activeTruncated !== 'boolean' ||
    !isRecord(value.search) ||
    typeof value.search.query !== 'string' ||
    new TextEncoder().encode(value.search.query).byteLength >
      MAX_THREAD_SEARCH_BYTES ||
    !['idle', 'loading', 'ready', 'empty', 'error'].includes(
      value.search.status as string,
    ) ||
    !Array.isArray(value.search.threadIds) ||
    !value.search.threadIds.every(isId) ||
    new Set(value.search.threadIds).size !== value.search.threadIds.length ||
    typeof value.search.truncated !== 'boolean' ||
    (Object.hasOwn(value.search, 'summary') &&
      (typeof value.search.summary !== 'string' ||
        value.search.summary.length === 0)) ||
    (Object.hasOwn(value, 'pendingThreadId') &&
      !isId(value.pendingThreadId)) ||
    (Object.hasOwn(value, 'selectionNotice') &&
      (typeof value.selectionNotice !== 'string' ||
        value.selectionNotice.length === 0))
  ) {
    return false;
  }
  return (
    (value.search.status === 'idle'
      ? value.search.query.length === 0 &&
        value.search.threadIds.length === 0 &&
        !value.search.truncated
      : value.search.query.trim().length > 0) &&
    (value.search.status === 'empty'
      ? value.search.threadIds.length === 0
      : true)
  );
};

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
    !isThreadNavigator(value.navigator) ||
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

export const isValidThreadSearchInput = (
  value: unknown,
): value is string => {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > MAX_THREAD_SEARCH_BYTES ||
    Array.from(value).some((character) => /\p{Cc}/u.test(character))
  ) {
    return false;
  }
  const query = value.trim();
  return query.length === 0 || query.split(/\s+/u).length <= 16;
};
