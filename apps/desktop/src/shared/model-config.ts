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
export type ModelReasoningEffort =
  | 'auto'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
export type ModelServiceTier = 'auto' | 'standard' | 'fast';
export type ModelRequestOptions = Readonly<{
  reasoningEffort?: ModelReasoningEffort;
  serviceTier?: ModelServiceTier;
}>;
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
  autoCompaction?: ModelCapabilityMode;
  compactThresholdTokens?: number;
  nativeCompaction?: ModelCapabilityMode;
  reasoningEffort?: ModelReasoningEffort;
  serviceTier?: ModelServiceTier;
  toolCalls: ModelCapabilityMode;
  strictTools: ModelCapabilityMode;
  parallelTools: ModelCapabilityMode;
  imageInput: ModelCapabilityMode;
  videoInput?: ModelCapabilityMode;
  audioInput?: ModelCapabilityMode;
  pdfInput: ModelCapabilityMode;
}>;

export type MediaModelRoutingValue = Readonly<{
  imageProfileId?: string;
  videoProfileId?: string;
  audioProfileId?: string;
}>;

export type ModelConfigValue = Readonly<{
  defaultProfileId: string;
  connections: readonly ModelConnectionValue[];
  profiles: readonly ModelProfileValue[];
  mediaRouting?: MediaModelRoutingValue;
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

export const MODEL_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const MODEL_SERVICE_TIERS: readonly ModelServiceTier[] = [
  'auto',
  'standard',
  'fast',
];

export const isModelRequestOptions = (
  value: unknown,
): value is ModelRequestOptions =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['reasoningEffort', 'serviceTier'].includes(key),
  ) &&
  (value.reasoningEffort === undefined ||
    MODEL_REASONING_EFFORTS.includes(
      value.reasoningEffort as ModelReasoningEffort,
    )) &&
  (value.serviceTier === undefined ||
    MODEL_SERVICE_TIERS.includes(value.serviceTier as ModelServiceTier));

const LEGACY_MEDIA_TRANSPORTS = [
  'auto',
  'inline',
  'dashscopeTemporaryUrl',
] as const;

const isConnection = (value: unknown): value is ModelConnectionValue =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    [
      'id',
      'providerFamily',
      'displayName',
      'baseUrl',
      'enabled',
      'wireApi',
      'continuationMode',
    ],
    ['mediaTransport'],
  ) &&
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
  ) &&
  (value.mediaTransport === undefined ||
    LEGACY_MEDIA_TRANSPORTS.includes(
      value.mediaTransport as (typeof LEGACY_MEDIA_TRANSPORTS)[number],
    ));

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
    [
      'contextWindowTokens',
      'autoCompaction',
      'compactThresholdTokens',
      'nativeCompaction',
      'reasoningEffort',
      'serviceTier',
      'videoInput',
      'audioInput',
    ],
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
  (value.autoCompaction === undefined ||
    CAPABILITY_MODES.includes(value.autoCompaction as ModelCapabilityMode)) &&
  (value.compactThresholdTokens === undefined ||
    (Number.isInteger(value.compactThresholdTokens) &&
      (value.compactThresholdTokens as number) >= 4_096 &&
      (value.compactThresholdTokens as number) <= 2_097_152)) &&
  (value.nativeCompaction === undefined ||
    CAPABILITY_MODES.includes(value.nativeCompaction as ModelCapabilityMode)) &&
  (value.reasoningEffort === undefined ||
    MODEL_REASONING_EFFORTS.includes(
      value.reasoningEffort as ModelReasoningEffort,
    )) &&
  (value.serviceTier === undefined ||
    MODEL_SERVICE_TIERS.includes(value.serviceTier as ModelServiceTier)) &&
  CAPABILITY_MODES.includes(value.toolCalls as ModelCapabilityMode) &&
  CAPABILITY_MODES.includes(value.strictTools as ModelCapabilityMode) &&
  CAPABILITY_MODES.includes(value.parallelTools as ModelCapabilityMode) &&
  CAPABILITY_MODES.includes(value.imageInput as ModelCapabilityMode) &&
  (value.videoInput === undefined ||
    CAPABILITY_MODES.includes(value.videoInput as ModelCapabilityMode)) &&
  (value.audioInput === undefined ||
    CAPABILITY_MODES.includes(value.audioInput as ModelCapabilityMode)) &&
  CAPABILITY_MODES.includes(value.pdfInput as ModelCapabilityMode);

const isMediaRouting = (value: unknown): value is MediaModelRoutingValue =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    [],
    ['imageProfileId', 'videoProfileId', 'audioProfileId'],
  ) &&
  (value.imageProfileId === undefined || isId(value.imageProfileId)) &&
  (value.videoProfileId === undefined || isId(value.videoProfileId)) &&
  (value.audioProfileId === undefined || isId(value.audioProfileId));

export const isModelConfigValue = (
  value: unknown,
): value is ModelConfigValue => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ['defaultProfileId', 'connections', 'profiles'],
      ['mediaRouting'],
    ) ||
    !isId(value.defaultProfileId) ||
    !Array.isArray(value.connections) ||
    value.connections.length < 1 ||
    value.connections.length > 16 ||
    !value.connections.every(isConnection) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length < 1 ||
    value.profiles.length > 128 ||
    !value.profiles.every(isProfile) ||
    (value.mediaRouting !== undefined &&
      !isMediaRouting(value.mediaRouting))
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
    ) ||
    profiles.some(
      (profile) =>
        profile.contextWindowTokens !== undefined &&
        profile.compactThresholdTokens !== undefined &&
        profile.compactThresholdTokens >= profile.contextWindowTokens,
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
  const imageProfileId = (
    value.mediaRouting as MediaModelRoutingValue | undefined
  )?.imageProfileId;
  const videoProfileId = (
    value.mediaRouting as MediaModelRoutingValue | undefined
  )?.videoProfileId;
  const audioProfileId = (
    value.mediaRouting as MediaModelRoutingValue | undefined
  )?.audioProfileId;
  const defaultConnection = connections.find(
    (connection) =>
      connection.id === defaultProfile?.connectionId,
  );
  return (
    wireApiMatches &&
    capabilitiesMatch &&
    (imageProfileId === undefined || profileIds.has(imageProfileId)) &&
    (videoProfileId === undefined || profileIds.has(videoProfileId)) &&
    (audioProfileId === undefined || profileIds.has(audioProfileId)) &&
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
