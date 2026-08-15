export const PREVIEW_STATE_GET_CHANNEL = 'preview-state:get';
export const PREVIEW_STATE_CHANGED_CHANNEL = 'preview-state:changed';
export const PREVIEW_OPEN_CHANNEL = 'preview:open';
export const PREVIEW_EXTERNAL_OPEN_CHANNEL = 'preview:open-external';
export const PREVIEW_BOUNDS_SET_CHANNEL = 'preview-bounds:set';
export const PREVIEW_NAVIGATE_CHANNEL = 'preview:navigate';
export const PREVIEW_RELOAD_CHANNEL = 'preview:reload';
export const PREVIEW_GO_BACK_CHANNEL = 'preview:go-back';
export const PREVIEW_GO_FORWARD_CHANNEL = 'preview:go-forward';
export const PREVIEW_CLOSE_CHANNEL = 'preview:close';

export const PREVIEW_URL_MAX_BYTES = 2_048;

export type PreviewFailure =
  | 'loadFailed'
  | 'renderProcessGone'
  | 'policyUnavailable';

type PreviewSessionState = Readonly<{
  generation: number;
  sessionId: string;
  url: string;
  origin: string;
}>;

export type PreviewStateSnapshot =
  | Readonly<{
      revision: number;
      status: 'closed';
    }>
  | (PreviewSessionState &
      Readonly<{
        revision: number;
        status: 'opening';
        visible: false;
      }>)
  | (PreviewSessionState &
      Readonly<{
        revision: number;
        status: 'ready';
        visible: boolean;
        canGoBack: boolean;
        canGoForward: boolean;
      }>)
  | Readonly<{
      revision: number;
      status: 'failed';
      generation: number;
      url: string;
      origin: string;
      error: PreviewFailure;
    }>;

export type PreviewOpenRequest = Readonly<{
  generation: number;
  url: string;
}>;

export type PreviewSessionRequest = Readonly<{
  generation: number;
  sessionId: string;
}>;

export type PreviewBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PreviewBoundsRequest = PreviewSessionRequest &
  Readonly<{
    bounds: PreviewBounds | null;
  }>;

export type PreviewNavigateRequest = PreviewSessionRequest &
  Readonly<{
    url: string;
  }>;

export type PreviewActionReason =
  | 'accepted'
  | 'cancelled'
  | 'stale'
  | 'unavailable'
  | 'invalid'
  | 'busy'
  | 'failed';

export type PreviewActionResult = Readonly<{
  accepted: boolean;
  reason: PreviewActionReason;
}>;

export type PreviewApi = Readonly<{
  getPreviewState: () => Promise<PreviewStateSnapshot>;
  onPreviewStateChanged: (
    listener: (snapshot: PreviewStateSnapshot) => void,
  ) => () => void;
  openPreview: (
    request: PreviewOpenRequest,
  ) => Promise<PreviewActionResult>;
  openExternalPreview: (
    request: PreviewOpenRequest,
  ) => Promise<PreviewActionResult>;
  setPreviewBounds: (
    request: PreviewBoundsRequest,
  ) => Promise<PreviewActionResult>;
  navigatePreview: (
    request: PreviewNavigateRequest,
  ) => Promise<PreviewActionResult>;
  reloadPreview: (
    request: PreviewSessionRequest,
  ) => Promise<PreviewActionResult>;
  goBackPreview: (
    request: PreviewSessionRequest,
  ) => Promise<PreviewActionResult>;
  goForwardPreview: (
    request: PreviewSessionRequest,
  ) => Promise<PreviewActionResult>;
  closePreview: (
    request: PreviewSessionRequest,
  ) => Promise<PreviewActionResult>;
}>;

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
): boolean =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key));

const isGeneration = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isBoundedUrl = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  new TextEncoder().encode(value).byteLength <= PREVIEW_URL_MAX_BYTES;

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value);

const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export const isPreviewOpenRequest = (
  value: unknown,
): value is PreviewOpenRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'url']) &&
  isGeneration(value.generation) &&
  isBoundedUrl(value.url);

export const isPreviewSessionRequest = (
  value: unknown,
): value is PreviewSessionRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'sessionId']) &&
  isGeneration(value.generation) &&
  isSessionId(value.sessionId);

const isPreviewBounds = (value: unknown): value is PreviewBounds => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y', 'width', 'height'])) {
    return false;
  }
  const coordinatesValid = ['x', 'y', 'width', 'height'].every((key) => {
    const coordinate = value[key];
    return (
      Number.isSafeInteger(coordinate) &&
      (coordinate as number) >= 0 &&
      (coordinate as number) <= 16_384
    );
  });
  return (
    coordinatesValid &&
    (value.width as number) > 0 &&
    (value.height as number) > 0
  );
};

export const isPreviewBoundsRequest = (
  value: unknown,
): value is PreviewBoundsRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'sessionId', 'bounds']) &&
  isGeneration(value.generation) &&
  isSessionId(value.sessionId) &&
  (value.bounds === null || isPreviewBounds(value.bounds));

export const isPreviewNavigateRequest = (
  value: unknown,
): value is PreviewNavigateRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'sessionId', 'url']) &&
  isGeneration(value.generation) &&
  isSessionId(value.sessionId) &&
  isBoundedUrl(value.url);

export const isPreviewActionResult = (
  value: unknown,
): value is PreviewActionResult => {
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

const hasSessionState = (
  value: Record<string, unknown>,
): boolean =>
  isGeneration(value.generation) &&
  isSessionId(value.sessionId) &&
  isBoundedUrl(value.url) &&
  typeof value.origin === 'string' &&
  value.origin.length > 0 &&
  value.origin.length <= 128;

export const isPreviewStateSnapshot = (
  value: unknown,
): value is PreviewStateSnapshot => {
  if (
    !isRecord(value) ||
    !isRevision(value.revision) ||
    typeof value.status !== 'string'
  ) {
    return false;
  }
  if (value.status === 'closed') {
    return hasOnlyKeys(value, ['revision', 'status']);
  }
  if (value.status === 'opening') {
    return (
      hasOnlyKeys(value, [
        'revision',
        'status',
        'generation',
        'sessionId',
        'url',
        'origin',
        'visible',
      ]) &&
      hasSessionState(value) &&
      value.visible === false
    );
  }
  if (value.status === 'ready') {
    return (
      hasOnlyKeys(value, [
        'revision',
        'status',
        'generation',
        'sessionId',
        'url',
        'origin',
        'visible',
        'canGoBack',
        'canGoForward',
      ]) &&
      hasSessionState(value) &&
      typeof value.visible === 'boolean' &&
      typeof value.canGoBack === 'boolean' &&
      typeof value.canGoForward === 'boolean'
    );
  }
  return (
    value.status === 'failed' &&
    hasOnlyKeys(value, [
      'revision',
      'status',
      'generation',
      'url',
      'origin',
      'error',
    ]) &&
    isGeneration(value.generation) &&
    isBoundedUrl(value.url) &&
    typeof value.origin === 'string' &&
    value.origin.length > 0 &&
    ['loadFailed', 'renderProcessGone', 'policyUnavailable'].includes(
      value.error as string,
    )
  );
};
