export const MODEL_CONFIG_GET_CHANNEL = 'model-config:get';
export const MODEL_CONFIG_SAVE_CHANNEL = 'model-config:save';
export const MODEL_CONFIG_DELETE_API_KEY_CHANNEL =
  'model-config:delete-api-key';

export type ModelApiKeyStatus =
  | 'notConfigured'
  | 'present';

export type ModelConfigValue = Readonly<{
  apiFormat: 'openai-chat-completions';
  endpoint: string;
  model: string;
}>;

export type ModelConfigInspection = Readonly<{
  contractVersion: 1;
  revision: string;
  config: ModelConfigValue | null;
  apiKeyStatus: ModelApiKeyStatus;
}>;

export type ModelConfigSaveRequest = Readonly<{
  expectedRevision: string;
  config: ModelConfigValue;
  apiKey?: string;
}>;

export type ModelConfigActionResult = Readonly<{
  accepted: boolean;
  state: 'saved' | 'blocked' | 'failed';
  inspection?: ModelConfigInspection;
  reason?:
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
  deleteModelApiKey: (
    expectedRevision: string,
  ) => Promise<ModelConfigActionResult>;
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
    !hasOnlyKeys(value, ['apiFormat', 'endpoint', 'model']) ||
    value.apiFormat !== 'openai-chat-completions' ||
    typeof value.endpoint !== 'string' ||
    byteLength(value.endpoint) > 16 * 1024 ||
    typeof value.model !== 'string' ||
    byteLength(value.model) > 256
  ) {
    return false;
  }
  return true;
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
      'apiKeyStatus',
    ]) ||
    value.contractVersion !== 1 ||
    !isRevision(value.revision) ||
    (value.config !== null && !isModelConfigValue(value.config)) ||
    !['notConfigured', 'present'].includes(value.apiKeyStatus as string)
  ) {
    return false;
  }
  return value.config !== null || value.apiKeyStatus === 'notConfigured';
};

export const isModelConfigSaveRequest = (
  value: unknown,
): value is ModelConfigSaveRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['expectedRevision', 'config'], ['apiKey']) &&
  isRevision(value.expectedRevision) &&
  isModelConfigValue(value.config) &&
  (value.apiKey === undefined ||
    (typeof value.apiKey === 'string' &&
      byteLength(value.apiKey) <= 2_048));

export const isModelConfigActionResult = (
  value: unknown,
): value is ModelConfigActionResult => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['accepted', 'state'], ['inspection', 'reason']) ||
    typeof value.accepted !== 'boolean' ||
    !['saved', 'blocked', 'failed'].includes(value.state as string) ||
    (value.inspection !== undefined &&
      !isModelConfigInspection(value.inspection)) ||
    (value.reason !== undefined &&
      ![
        'reconnectPending',
        'unavailable',
        'invalid',
        'stale',
      ].includes(value.reason as string))
  ) {
    return false;
  }
  return value.accepted === (value.state === 'saved');
};
