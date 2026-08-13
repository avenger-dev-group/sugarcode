export const UPDATE_STATE_GET_CHANNEL = 'update-state:get';
export const UPDATE_STATE_CHANGED_CHANNEL = 'update-state:changed';
export const UPDATE_CHECK_CHANNEL = 'update:check';
export const UPDATE_INSTALL_CHANNEL = 'update:install';
export const UPDATE_DOWNLOAD_PAGE_CHANNEL = 'update:download-page';

export type UpdateStateSnapshot = Readonly<{
  revision: number;
  status:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'upToDate'
    | 'ready'
    | 'fallback';
  version?: string;
}>;

export type UpdateActionReason =
  | 'accepted'
  | 'busy'
  | 'unavailable'
  | 'invalid'
  | 'failed';

export type UpdateActionResult = Readonly<{
  accepted: boolean;
  reason: UpdateActionReason;
}>;

export type UpdateApi = Readonly<{
  getUpdateState: () => Promise<UpdateStateSnapshot>;
  onUpdateStateChanged: (
    listener: (snapshot: UpdateStateSnapshot) => void,
  ) => () => void;
  checkUpdate: () => Promise<UpdateActionResult>;
  installUpdate: () => Promise<UpdateActionResult>;
  openUpdateDownloadPage: () => Promise<UpdateActionResult>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const UPDATE_STATUSES = new Set<UpdateStateSnapshot['status']>([
  'idle',
  'checking',
  'downloading',
  'upToDate',
  'ready',
  'fallback',
]);

const UPDATE_ACTION_REASONS = new Set<UpdateActionReason>([
  'accepted',
  'busy',
  'unavailable',
  'invalid',
  'failed',
]);

export const isUpdateStateSnapshot = (
  value: unknown,
): value is UpdateStateSnapshot => {
  if (
    !isRecord(value) ||
    !isRevision(value.revision) ||
    typeof value.status !== 'string' ||
    !UPDATE_STATUSES.has(value.status as UpdateStateSnapshot['status']) ||
    (value.version !== undefined && typeof value.version !== 'string')
  ) {
    return false;
  }
  const allowedKeys = value.status === 'ready'
    ? ['revision', 'status', 'version']
    : ['revision', 'status'];
  return (
    (value.status !== 'ready' ||
      (typeof value.version === 'string' && value.version.length > 0)) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
};

export const isUpdateActionResult = (
  value: unknown,
): value is UpdateActionResult =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  UPDATE_ACTION_REASONS.has(value.reason as UpdateActionReason) &&
  value.accepted === (value.reason === 'accepted');
