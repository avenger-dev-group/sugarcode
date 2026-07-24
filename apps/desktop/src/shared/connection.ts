export const CONNECTION_STATE_GET_CHANNEL = 'connection-state:get';
export const CONNECTION_STATE_CHANGED_CHANNEL = 'connection-state:changed';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'failed'
  | 'closed';

export type ConnectionDiagnosticCode =
  | 'development-cli-missing'
  | 'development-cli-not-executable'
  | 'spawn-failed'
  | 'initialize-rejected'
  | 'protocol-invalid'
  | 'protocol-version-mismatch'
  | 'product-version-mismatch'
  | 'platform-mismatch'
  | 'write-failed'
  | 'server-closed'
  | 'server-crashed';

export type ConnectionDiagnostic = Readonly<{
  code: ConnectionDiagnosticCode;
  summary: string;
}>;

export type ConnectionStateSnapshot = Readonly<{
  revision: number;
  status: ConnectionStatus;
  diagnostic?: ConnectionDiagnostic;
}>;

export type ConnectionStateListener = (
  snapshot: ConnectionStateSnapshot,
) => void;

export type DesktopApi = Readonly<{
  getConnectionState: () => Promise<ConnectionStateSnapshot>;
  onConnectionStateChanged: (
    listener: ConnectionStateListener,
  ) => () => void;
}>;

const CONNECTION_STATUSES = new Set<ConnectionStatus>([
  'idle',
  'connecting',
  'ready',
  'failed',
  'closed',
]);

const CONNECTION_DIAGNOSTIC_CODES = new Set<ConnectionDiagnosticCode>([
  'development-cli-missing',
  'development-cli-not-executable',
  'spawn-failed',
  'initialize-rejected',
  'protocol-invalid',
  'protocol-version-mismatch',
  'product-version-mismatch',
  'platform-mismatch',
  'write-failed',
  'server-closed',
  'server-crashed',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isConnectionStateSnapshot = (
  value: unknown,
): value is ConnectionStateSnapshot => {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.status !== 'string' ||
    !CONNECTION_STATUSES.has(value.status as ConnectionStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'diagnostic')) {
    return true;
  }
  return (
    isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' &&
    CONNECTION_DIAGNOSTIC_CODES.has(
      value.diagnostic.code as ConnectionDiagnosticCode,
    ) &&
    typeof value.diagnostic.summary === 'string'
  );
};
