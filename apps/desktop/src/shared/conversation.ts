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

const isTurn = (value: unknown): value is ConversationTurn => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.status !== 'string' ||
    !TURN_STATUSES.has(value.status as ConversationTurnStatus) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage)
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
