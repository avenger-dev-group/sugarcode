export const MODEL_CONFIG_GET_CHANNEL = 'model-config:get';
export const MODEL_CONFIG_SAVE_CHANNEL = 'model-config:save';
export const MODEL_CONFIG_DELETE_API_KEY_CHANNEL =
  'model-config:delete-api-key';
export const MODEL_CONFIG_DISCOVER_CHANNEL = 'model-config:discover';

export type ModelProviderFamily = 'openai' | 'anthropic';

export type ModelWireApi =
  | 'openaiResponses'
  | 'openaiChatCompletions'
  | 'anthropicMessages';

export type ModelCapabilityMode = 'auto' | 'enabled' | 'disabled';
export type ModelContinuationMode = 'localReplay' | 'providerManaged';
export type ModelApiKeyStatus = 'notConfigured' | 'present';

export type ModelConnectionValue = Readonly<{
  id: string;
  providerFamily: ModelProviderFamily;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  wireApi: ModelWireApi;
  continuationMode: ModelContinuationMode;
}>;

export type ModelProfileValue = Readonly<{
  id: string;
  connectionId: string;
  displayName: string;
  modelId: string;
  contextWindowTokens?: number;
  toolCalls: ModelCapabilityMode;
  strictTools: ModelCapabilityMode;
  parallelTools: ModelCapabilityMode;
  imageInput: ModelCapabilityMode;
  pdfInput: ModelCapabilityMode;
}>;

export type ModelConfigValue = Readonly<{
  defaultProfileId: string;
  connections: readonly ModelConnectionValue[];
  profiles: readonly ModelProfileValue[];
}>;

export type ModelCredentialStatus = Readonly<{
  connectionId: string;
  status: ModelApiKeyStatus;
}>;

export type ModelConfigInspection = Readonly<{
  contractVersion: 1;
  revision: string;
  config: ModelConfigValue | null;
  credentialStatuses: readonly ModelCredentialStatus[];
}>;

export type ModelCredentialUpdate =
  | Readonly<{ action: 'preserve'; connectionId: string }>
  | Readonly<{ action: 'set'; connectionId: string; value: string }>
  | Readonly<{ action: 'delete'; connectionId: string }>;

export type ModelConfigSaveRequest = Readonly<{
  expectedRevision: string;
  config: ModelConfigValue;
  credentialUpdates: readonly ModelCredentialUpdate[];
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

export type DiscoveredModel = Readonly<{
  modelId: string;
  displayName: string;
  contextWindowTokens?: number;
}>;

export type ModelDiscoveryResult = Readonly<{
  connectionId: string;
  models: readonly DiscoveredModel[];
}>;

export type ModelConfigApi = Readonly<{
  getModelConfig: () => Promise<ModelConfigInspection>;
  saveModelConfig: (
    request: ModelConfigSaveRequest,
  ) => Promise<ModelConfigActionResult>;
  deleteModelApiKey: (
    connectionId: string,
    expectedRevision: string,
  ) => Promise<ModelConfigActionResult>;
  discoverModels: (connectionId: string) => Promise<ModelDiscoveryResult>;
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

const isId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,64}$/u.test(value);

const isDisplayName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  byteLength(value) <= 128;

const PROVIDER_FAMILIES: readonly ModelProviderFamily[] = [
  'openai',
  'anthropic',
];

const WIRE_APIS: readonly ModelWireApi[] = [
  'openaiResponses',
  'openaiChatCompletions',
  'anthropicMessages',
];

const CAPABILITY_MODES: readonly ModelCapabilityMode[] = [
  'auto',
  'enabled',
  'disabled',
];

const isConnection = (value: unknown): value is ModelConnectionValue =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    'id',
    'providerFamily',
    'displayName',
    'baseUrl',
    'enabled',
    'wireApi',
    'continuationMode',
  ]) &&
  isId(value.id) &&
  PROVIDER_FAMILIES.includes(
    value.providerFamily as ModelProviderFamily,
  ) &&
  isDisplayName(value.displayName) &&
  typeof value.baseUrl === 'string' &&
  byteLength(value.baseUrl) <= 16_384 &&
  typeof value.enabled === 'boolean' &&
  WIRE_APIS.includes(value.wireApi as ModelWireApi) &&
  ['localReplay', 'providerManaged'].includes(
    value.continuationMode as ModelContinuationMode,
  );

const isProfile = (value: unknown): value is ModelProfileValue =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    [
      'id',
      'connectionId',
      'displayName',
      'modelId',
      'toolCalls',
      'strictTools',
      'parallelTools',
      'imageInput',
      'pdfInput',
    ],
    ['contextWindowTokens'],
  ) &&
  isId(value.id) &&
  isId(value.connectionId) &&
  isDisplayName(value.displayName) &&
  typeof value.modelId === 'string' &&
  value.modelId.length > 0 &&
  byteLength(value.modelId) <= 256 &&
  (value.contextWindowTokens === undefined ||
    (Number.isInteger(value.contextWindowTokens) &&
      (value.contextWindowTokens as number) >= 4_096 &&
      (value.contextWindowTokens as number) <= 2_097_152)) &&
  CAPABILITY_MODES.includes(value.toolCalls as ModelCapabilityMode) &&
  CAPABILITY_MODES.includes(value.strictTools as ModelCapabilityMode) &&
  CAPABILITY_MODES.includes(value.parallelTools as ModelCapabilityMode) &&
  CAPABILITY_MODES.includes(value.imageInput as ModelCapabilityMode) &&
  CAPABILITY_MODES.includes(value.pdfInput as ModelCapabilityMode);

export const isModelConfigValue = (
  value: unknown,
): value is ModelConfigValue => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'defaultProfileId',
      'connections',
      'profiles',
    ]) ||
    !isId(value.defaultProfileId) ||
    !Array.isArray(value.connections) ||
    value.connections.length < 1 ||
    value.connections.length > 16 ||
    !value.connections.every(isConnection) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length < 1 ||
    value.profiles.length > 128 ||
    !value.profiles.every(isProfile)
  ) {
    return false;
  }
  const connections = value.connections as ModelConnectionValue[];
  const profiles = value.profiles as ModelProfileValue[];
  const connectionIds = new Set(
    connections.map((connection) => connection.id),
  );
  const profileIds = new Set(profiles.map((profile) => profile.id));
  if (
    connectionIds.size !== connections.length ||
    profileIds.size !== profiles.length ||
    profiles.some(
      (profile) => !connectionIds.has(profile.connectionId),
    )
  ) {
    return false;
  }
  const wireApiMatches = connections.every((connection) => {
    switch (connection.providerFamily) {
      case 'openai':
        return [
          'openaiResponses',
          'openaiChatCompletions',
        ].includes(connection.wireApi);
      case 'anthropic':
        return connection.wireApi === 'anthropicMessages';
    }
  });
  const capabilitiesMatch = profiles.every((profile) => {
    const connection = connections.find(
      (candidate) => candidate.id === profile.connectionId,
    );
    return !(
      connection?.wireApi === 'openaiChatCompletions' &&
      profile.pdfInput === 'enabled'
    );
  });
  const defaultProfile = profiles.find(
    (profile) => profile.id === value.defaultProfileId,
  );
  const defaultConnection = connections.find(
    (connection) =>
      connection.id === defaultProfile?.connectionId,
  );
  return (
    wireApiMatches &&
    capabilitiesMatch &&
    defaultConnection?.enabled === true
  );
};

const isCredentialStatus = (
  value: unknown,
): value is ModelCredentialStatus =>
  isRecord(value) &&
  hasOnlyKeys(value, ['connectionId', 'status']) &&
  isId(value.connectionId) &&
  ['notConfigured', 'present'].includes(value.status as string);

export const isModelConfigInspection = (
  value: unknown,
): value is ModelConfigInspection =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    'contractVersion',
    'revision',
    'config',
    'credentialStatuses',
  ]) &&
  value.contractVersion === 1 &&
  isRevision(value.revision) &&
  (value.config === null || isModelConfigValue(value.config)) &&
  Array.isArray(value.credentialStatuses) &&
  value.credentialStatuses.every(isCredentialStatus);

const isCredentialUpdate = (
  value: unknown,
): value is ModelCredentialUpdate => {
  if (!isRecord(value) || !isId(value.connectionId)) {
    return false;
  }
  if (value.action === 'set') {
    return (
      hasOnlyKeys(value, ['action', 'connectionId', 'value']) &&
      typeof value.value === 'string' &&
      value.value.length > 0 &&
      byteLength(value.value) <= 2_048
    );
  }
  return (
    ['preserve', 'delete'].includes(value.action as string) &&
    hasOnlyKeys(value, ['action', 'connectionId'])
  );
};

export const isModelConfigSaveRequest = (
  value: unknown,
): value is ModelConfigSaveRequest => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'expectedRevision',
      'config',
      'credentialUpdates',
    ]) ||
    !isRevision(value.expectedRevision) ||
    !isModelConfigValue(value.config) ||
    !Array.isArray(value.credentialUpdates) ||
    !value.credentialUpdates.every(isCredentialUpdate)
  ) {
    return false;
  }
  const connectionIds = new Set(
    value.config.connections.map((connection) => connection.id),
  );
  const credentialIds = new Set(
    value.credentialUpdates.map((update) => update.connectionId),
  );
  return (
    credentialIds.size === value.credentialUpdates.length &&
    credentialIds.size === connectionIds.size &&
    [...credentialIds].every((id) => connectionIds.has(id))
  );
};

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

export const isModelDiscoveryResult = (
  value: unknown,
): value is ModelDiscoveryResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ['connectionId', 'models']) &&
  isId(value.connectionId) &&
  Array.isArray(value.models) &&
  value.models.every(
    (model) =>
      isRecord(model) &&
      hasOnlyKeys(model, ['modelId', 'displayName'], [
        'contextWindowTokens',
      ]) &&
      typeof model.modelId === 'string' &&
      typeof model.displayName === 'string' &&
      (model.contextWindowTokens === undefined ||
        (Number.isInteger(model.contextWindowTokens) &&
          (model.contextWindowTokens as number) >= 4_096 &&
          (model.contextWindowTokens as number) <= 2_097_152)),
  );
