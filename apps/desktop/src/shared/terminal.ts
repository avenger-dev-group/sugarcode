export const TERMINAL_STATE_GET_CHANNEL = 'terminal-state:get';
export const TERMINAL_STATE_CHANGED_CHANNEL = 'terminal-state:changed';
export const TERMINAL_CREATE_CHANNEL = 'terminal:create';
export const TERMINAL_INPUT_CHANNEL = 'terminal:input';
export const TERMINAL_RESIZE_CHANNEL = 'terminal:resize';
export const TERMINAL_TERMINATE_CHANNEL = 'terminal:terminate';

export const TERMINAL_INPUT_MAX_BYTES = 65_536;
export const TERMINAL_OUTPUT_CHUNK_MAX_BYTES = 32_768;
export const TERMINAL_MIN_COLUMNS = 2;
export const TERMINAL_MAX_COLUMNS = 500;
export const TERMINAL_MIN_ROWS = 2;
export const TERMINAL_MAX_ROWS = 300;

export type TerminalFailure =
  | 'spawnFailed'
  | 'protocolInvalid'
  | 'bridgeCrashed'
  | 'outputOverload';

export type TerminalExitReason =
  | 'natural'
  | 'requested'
  | 'ownerLost'
  | 'protocolError'
  | 'ioError';

export type TerminalOutputChunk = Readonly<{
  sequence: number;
  data: string;
}>;

type TerminalSessionState = Readonly<{
  generation: number;
  sessionId: string;
  workspaceName: string;
  shell?: string;
  acknowledgedThrough: number;
  output: readonly TerminalOutputChunk[];
}>;

export type TerminalStateSnapshot =
  | Readonly<{
      revision: number;
      generation: number;
      status: 'closed';
      acknowledgedThrough: number;
      output: readonly [];
    }>
  | (TerminalSessionState &
      Readonly<{
        revision: number;
        status: 'starting';
      }>)
  | (TerminalSessionState &
      Readonly<{
        revision: number;
        status: 'running' | 'paused';
      }>)
  | (TerminalSessionState &
      Readonly<{
        revision: number;
        status: 'exited';
        exitCode: number;
        signal?: string;
        reason: TerminalExitReason;
      }>)
  | (TerminalSessionState &
      Readonly<{
        revision: number;
        status: 'failed';
        error: TerminalFailure;
      }>);

export type TerminalStateSignal = Readonly<{
  revision: number;
  generation: number;
  status: TerminalStateSnapshot['status'];
  sessionId?: string;
}>;

export type TerminalCreateRequest = Readonly<{
  generation: number;
  columns: number;
  rows: number;
}>;

export type TerminalSessionRequest = Readonly<{
  generation: number;
  sessionId: string;
}>;

export type TerminalInputRequest = TerminalSessionRequest &
  Readonly<{ data: string }>;

export type TerminalResizeRequest = TerminalSessionRequest &
  Readonly<{
    columns: number;
    rows: number;
  }>;

export type TerminalSnapshotRequest = Readonly<{
  generation: number;
  sessionId?: string;
  acknowledgeThrough: number;
}>;

export type TerminalActionReason =
  | 'accepted'
  | 'cancelled'
  | 'stale'
  | 'unavailable'
  | 'invalid'
  | 'busy'
  | 'failed';

export type TerminalActionResult = Readonly<{
  accepted: boolean;
  reason: TerminalActionReason;
}>;

export type TerminalApi = Readonly<{
  getTerminalSnapshot: (
    request: TerminalSnapshotRequest,
  ) => Promise<TerminalStateSnapshot>;
  onTerminalStateChanged: (
    listener: (signal: TerminalStateSignal) => void,
  ) => () => void;
  createTerminal: (
    request: TerminalCreateRequest,
  ) => Promise<TerminalActionResult>;
  writeTerminalInput: (
    request: TerminalInputRequest,
  ) => Promise<TerminalActionResult>;
  resizeTerminal: (
    request: TerminalResizeRequest,
  ) => Promise<TerminalActionResult>;
  terminateTerminal: (
    request: TerminalSessionRequest,
  ) => Promise<TerminalActionResult>;
}>;

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isGeneration = isCount;

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value);

const isDimensions = (
  columns: unknown,
  rows: unknown,
): columns is number =>
  Number.isSafeInteger(columns) &&
  Number.isSafeInteger(rows) &&
  (columns as number) >= TERMINAL_MIN_COLUMNS &&
  (columns as number) <= TERMINAL_MAX_COLUMNS &&
  (rows as number) >= TERMINAL_MIN_ROWS &&
  (rows as number) <= TERMINAL_MAX_ROWS;

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const isTerminalCreateRequest = (
  value: unknown,
): value is TerminalCreateRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'columns', 'rows']) &&
  isGeneration(value.generation) &&
  isDimensions(value.columns, value.rows);

export const isTerminalSessionRequest = (
  value: unknown,
): value is TerminalSessionRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'sessionId']) &&
  isGeneration(value.generation) &&
  isSessionId(value.sessionId);

export const isTerminalInputRequest = (
  value: unknown,
): value is TerminalInputRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'sessionId', 'data']) &&
  isGeneration(value.generation) &&
  isSessionId(value.sessionId) &&
  typeof value.data === 'string' &&
  value.data.length > 0 &&
  byteLength(value.data) <= TERMINAL_INPUT_MAX_BYTES;

export const isTerminalResizeRequest = (
  value: unknown,
): value is TerminalResizeRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'sessionId', 'columns', 'rows']) &&
  isGeneration(value.generation) &&
  isSessionId(value.sessionId) &&
  isDimensions(value.columns, value.rows);

export const isTerminalSnapshotRequest = (
  value: unknown,
): value is TerminalSnapshotRequest =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    ['generation', 'acknowledgeThrough'],
    ['sessionId'],
  ) &&
  isGeneration(value.generation) &&
  (value.sessionId === undefined || isSessionId(value.sessionId)) &&
  isCount(value.acknowledgeThrough);

export const isTerminalActionResult = (
  value: unknown,
): value is TerminalActionResult => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['accepted', 'reason']) ||
    typeof value.accepted !== 'boolean' ||
    ![
      'accepted',
      'cancelled',
      'stale',
      'unavailable',
      'invalid',
      'busy',
      'failed',
    ].includes(value.reason as string)
  ) {
    return false;
  }
  return value.accepted === (value.reason === 'accepted');
};

const isTerminalOutput = (value: unknown): value is TerminalOutputChunk =>
  isRecord(value) &&
  hasOnlyKeys(value, ['sequence', 'data']) &&
  isCount(value.sequence) &&
  (value.sequence as number) > 0 &&
  typeof value.data === 'string' &&
  byteLength(value.data) <= TERMINAL_OUTPUT_CHUNK_MAX_BYTES;

const hasSessionState = (value: Record<string, unknown>): boolean =>
  isGeneration(value.generation) &&
  isSessionId(value.sessionId) &&
  typeof value.workspaceName === 'string' &&
  value.workspaceName.length > 0 &&
  value.workspaceName.length <= 512 &&
  (value.shell === undefined ||
    (typeof value.shell === 'string' &&
      value.shell.length > 0 &&
      value.shell.length <= 1_024)) &&
  isCount(value.acknowledgedThrough) &&
  Array.isArray(value.output) &&
  value.output.length <= 128 &&
  value.output.every(isTerminalOutput);

const sessionKeys = [
  'revision',
  'generation',
  'status',
  'sessionId',
  'workspaceName',
  'acknowledgedThrough',
  'output',
] as const;

export const isTerminalStateSnapshot = (
  value: unknown,
): value is TerminalStateSnapshot => {
  if (
    !isRecord(value) ||
    !isCount(value.revision) ||
    !isGeneration(value.generation) ||
    typeof value.status !== 'string'
  ) {
    return false;
  }
  if (value.status === 'closed') {
    return (
      hasOnlyKeys(value, [
        'revision',
        'generation',
        'status',
        'acknowledgedThrough',
        'output',
      ]) &&
      value.acknowledgedThrough === 0 &&
      Array.isArray(value.output) &&
      value.output.length === 0
    );
  }
  if (!hasSessionState(value)) {
    return false;
  }
  if (value.status === 'starting') {
    return hasOnlyKeys(value, sessionKeys, ['shell']);
  }
  if (value.status === 'running' || value.status === 'paused') {
    return hasOnlyKeys(value, sessionKeys, ['shell']);
  }
  if (value.status === 'exited') {
    return (
      hasOnlyKeys(
        value,
        [...sessionKeys, 'exitCode', 'reason'],
        ['shell', 'signal'],
      ) &&
      isCount(value.exitCode) &&
      (value.signal === undefined ||
        (typeof value.signal === 'string' && value.signal.length <= 128)) &&
      ['natural', 'requested', 'ownerLost', 'protocolError', 'ioError'].includes(
        value.reason as string,
      )
    );
  }
  return (
    value.status === 'failed' &&
    hasOnlyKeys(value, [...sessionKeys, 'error'], ['shell']) &&
    [
      'spawnFailed',
      'protocolInvalid',
      'bridgeCrashed',
      'outputOverload',
    ].includes(value.error as string)
  );
};

export const isTerminalStateSignal = (
  value: unknown,
): value is TerminalStateSignal =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    ['revision', 'generation', 'status'],
    ['sessionId'],
  ) &&
  isCount(value.revision) &&
  isGeneration(value.generation) &&
  ['closed', 'starting', 'running', 'paused', 'exited', 'failed'].includes(
    value.status as string,
  ) &&
  (value.sessionId === undefined || isSessionId(value.sessionId));
