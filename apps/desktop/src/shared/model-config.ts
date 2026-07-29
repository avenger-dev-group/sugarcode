export const MODEL_CONFIG_GET_CHANNEL = 'model-config:get';
export const MODEL_CONFIG_SAVE_CHANNEL = 'model-config:save';
export const MODEL_CONFIG_DELETE_CREDENTIAL_CHANNEL =
  'model-config:delete-credential';
export const MODEL_CONFIG_RETRY_CONNECTION_CHANNEL =
  'model-config:retry-connection';

export type ModelCredentialStatus =
  | 'notConfigured'
  | 'present'
  | 'missing'
  | 'unavailable';

export type ModelConfigValue = Readonly<{
  apiFormat: 'openai-chat-completions';
  endpoint: string;
  model: string;
  credentialReference: string | null;
}>;

export type ModelConfigInspection = Readonly<{
  contractVersion: 1;
  revision: string;
  config: ModelConfigValue | null;
  credentialStatus: ModelCredentialStatus;
}>;

export type ModelConfigSaveRequest = Readonly<{
  expectedRevision: string;
  config: ModelConfigValue;
  credential?: string;
}>;

export type ModelConfigActionResult = Readonly<{
  accepted: boolean;
  state:
    | 'active'
    | 'savedNotActive'
    | 'credentialStoredConfigUnchanged'
    | 'blocked'
    | 'failed';
  inspection?: ModelConfigInspection;
  reason?:
    | 'turnActive'
    | 'approvalPending'
    | 'navigationPending'
    | 'reconnectPending'
    | 'unavailable'
    | 'invalid'
    | 'stale';
}>;

export type ModelConfigApi = Readonly<{
  getModelConfig: () => Promise<ModelConfigInspection>;
  saveModelConfig: (
    request: ModelConfigSaveRequest,
  ) => Promise<ModelConfigActionResult>;
  deleteModelCredential: (
    expectedRevision: string,
  ) => Promise<ModelConfigActionResult>;
  retryModelConnection: () => Promise<ModelConfigActionResult>;
}>;

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

const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const isModelConfigValue = (
  value: unknown,
): value is ModelConfigValue => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'apiFormat',
      'endpoint',
      'model',
      'credentialReference',
    ]) ||
    value.apiFormat !== 'openai-chat-completions' ||
    typeof value.endpoint !== 'string' ||
    byteLength(value.endpoint) > 16 * 1024 ||
    typeof value.model !== 'string' ||
    byteLength(value.model) > 256
  ) {
    return false;
  }
  const reference = value.credentialReference;
  return (
    reference === null ||
    (typeof reference === 'string' && byteLength(reference) <= 64)
  );
};

export const isModelConfigInspection = (
  value: unknown,
): value is ModelConfigInspection => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'contractVersion',
      'revision',
      'config',
      'credentialStatus',
    ]) ||
    value.contractVersion !== 1 ||
    !isRevision(value.revision) ||
    (value.config !== null && !isModelConfigValue(value.config)) ||
    ![
      'notConfigured',
      'present',
      'missing',
      'unavailable',
    ].includes(value.credentialStatus as string)
  ) {
    return false;
  }
  const config = value.config as ModelConfigValue | null;
  const hasReference =
    config !== null && config.credentialReference !== null;
  return hasReference
    ? value.credentialStatus !== 'notConfigured'
    : value.credentialStatus === 'notConfigured';
};

export const isModelConfigSaveRequest = (
  value: unknown,
): value is ModelConfigSaveRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['expectedRevision', 'config'], ['credential']) &&
  isRevision(value.expectedRevision) &&
  isModelConfigValue(value.config) &&
  (value.credential === undefined ||
    (typeof value.credential === 'string' &&
      byteLength(value.credential) <= 2_048));

export const isModelConfigActionResult = (
  value: unknown,
): value is ModelConfigActionResult => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['accepted', 'state'], ['inspection', 'reason']) ||
    typeof value.accepted !== 'boolean' ||
    ![
      'active',
      'savedNotActive',
      'credentialStoredConfigUnchanged',
      'blocked',
      'failed',
    ].includes(value.state as string) ||
    (value.inspection !== undefined &&
      !isModelConfigInspection(value.inspection)) ||
    (value.reason !== undefined &&
      ![
        'turnActive',
        'approvalPending',
        'navigationPending',
        'reconnectPending',
        'unavailable',
        'invalid',
        'stale',
      ].includes(value.reason as string))
  ) {
    return false;
  }
  return value.accepted === (value.state === 'active');
};
