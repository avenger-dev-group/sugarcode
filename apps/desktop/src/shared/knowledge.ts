export const KNOWLEDGE_GET_CHANNEL = 'knowledge:get';
export const KNOWLEDGE_CREATE_CHANNEL = 'knowledge:create';
export const KNOWLEDGE_UPDATE_CHANNEL = 'knowledge:update';
export const KNOWLEDGE_DELETE_CHANNEL = 'knowledge:delete';
export const KNOWLEDGE_ADD_FILES_CHANNEL = 'knowledge:add-files';
export const KNOWLEDGE_ADD_FOLDER_CHANNEL = 'knowledge:add-folder';
export const KNOWLEDGE_TEXT_CREATE_CHANNEL = 'knowledge:text-create';
export const KNOWLEDGE_TEXT_READ_CHANNEL = 'knowledge:text-read';
export const KNOWLEDGE_TEXT_UPDATE_CHANNEL = 'knowledge:text-update';
export const KNOWLEDGE_DETAIL_CHANNEL = 'knowledge:detail';
export const KNOWLEDGE_SOURCE_DELETE_CHANNEL = 'knowledge:source-delete';
export const KNOWLEDGE_SOURCE_RESCAN_CHANNEL = 'knowledge:source-rescan';
export const KNOWLEDGE_INDEX_CANCEL_CHANNEL = 'knowledge:index-cancel';
export const KNOWLEDGE_SEARCH_CHANNEL = 'knowledge:search';
export const KNOWLEDGE_DOCUMENT_OPEN_CHANNEL = 'knowledge:document-open';
export const KNOWLEDGE_DOCUMENT_REVEAL_CHANNEL = 'knowledge:document-reveal';
export const KNOWLEDGE_MODEL_INSTALL_CHANNEL = 'knowledge:model-install';
export const KNOWLEDGE_MODEL_CANCEL_CHANNEL = 'knowledge:model-cancel';
export const KNOWLEDGE_MODEL_REMOVE_CHANNEL = 'knowledge:model-remove';
export const KNOWLEDGE_RETRIEVAL_SELECT_CHANNEL = 'knowledge:retrieval-select';
export const KNOWLEDGE_SEMANTIC_INDEX_PAUSE_CHANNEL = 'knowledge:semantic-index-pause';

export type KnowledgeBaseSummary = Readonly<{
  id: string;
  name: string;
  description: string;
  scope: 'global' | 'project';
  workspaceIds: readonly string[];
  sourceCount: number;
  documentCount: number;
  chunkCount: number;
  errorCount: number;
  sizeBytes: number;
  status: 'ready' | 'indexing' | 'error';
  semanticEnabled?: boolean;
  updatedAt: number;
}>;

export type SemanticModelState = Readonly<{
  state: 'notInstalled' | 'downloading' | 'ready' | 'error';
  enabled: boolean;
  modelId: string;
  version: string;
  revision: string;
  dimensions: number;
  runtime: string;
  variant: string;
  downloadedBytes: number;
  totalBytes: number;
  installedBytes: number;
  error?: string;
  semanticIndex: Readonly<{
    state: 'notIndexed' | 'indexing' | 'paused' | 'ready' | 'error';
    indexedChunks: number;
    totalChunks: number;
    errorCount: number;
  }>;
  device: Readonly<{
    architecture: string;
    logicalCores: number;
    totalMemoryBytes: number;
    availableMemoryBytes: number;
    availableDiskBytes: number;
    requiredDiskBytes: number;
    supported: boolean;
    recommended: boolean;
    warnings: readonly string[];
  }>;
}>;

export type KnowledgeInspection = Readonly<{
  knowledgeBases: readonly KnowledgeBaseSummary[];
  semanticModel: SemanticModelState;
  retrievalPlans?: readonly RetrievalPlan[];
  retrievalSettings?: RetrievalSettings;
}>;

export type RetrievalPlan = Readonly<{
  id: string;
  name: string;
  description: string;
  language: string;
  downloadBytes: number;
  model?: Readonly<{
    id: string;
    name: string;
    description: string;
    language: string;
    version: string;
    revision: string;
    dimensions: number;
    minimumAppVersion: string;
  }>;
}>;

export type RetrievalSettings = Readonly<{
  strategy: 'fullText' | 'semantic';
  selectedPlanId: string;
  activeModelId?: string | null;
  activeModelVersion?: string | null;
  pendingModelId?: string | null;
  pendingModelVersion?: string | null;
  indexPaused?: boolean;
}>;

export type KnowledgeSource = Readonly<{
  id: string;
  knowledgeBaseId: string;
  kind: 'managedFile' | 'linkedFolder';
  path: string;
  displayName: string;
  documentCount: number;
  errorCount: number;
  status?: 'ready' | 'scanning' | 'disconnected' | 'error';
  lastError?: string;
  lastScannedAt?: number;
  updatedAt: number;
}>;

export type KnowledgeIndexJob = Readonly<{
  id: string;
  knowledgeBaseId: string;
  sourceId?: string;
  kind: 'initial' | 'incremental' | 'rescan' | 'rebuild';
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  discoveredFiles: number;
  processedFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  deletedFiles: number;
  errorCount: number;
  attemptCount: number;
  cancelRequested: boolean;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type KnowledgeDocument = Readonly<{
  id: string;
  knowledgeBaseId: string;
  sourceId: string;
  relativePath: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  modifiedAt: number;
  sha256: string;
  parseStatus: 'ready' | 'error';
  parseError?: string;
  chunkCount: number;
  updatedAt: number;
}>;

export type KnowledgeBaseDetail = Readonly<{
  sources: readonly KnowledgeSource[];
  documents: readonly KnowledgeDocument[];
  indexJobs?: readonly KnowledgeIndexJob[];
  ignoreRules?: readonly string[];
  semanticEnabled?: boolean;
}>;

export type KnowledgeSearchHit = Readonly<{
  citation: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  fileName: string;
  relativePath: string;
  heading?: string;
  pageNumber?: number;
  contentKind?: 'text' | 'code';
  language?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  score: number;
}>;

export type KnowledgeSearchResult = Readonly<{
  query: string;
  mode: 'fullText' | 'hybrid';
  hits: readonly KnowledgeSearchHit[];
}>;

export type KnowledgeEditableDocument = Readonly<{
  sourceId: string;
  knowledgeBaseId: string;
  fileName: string;
  format: 'text' | 'markdown';
  content: string;
  sha256: string;
  sizeBytes: number;
}>;

export type KnowledgeTextCreateRequest = Readonly<{
  fileName: string;
  content: string;
}>;

export type KnowledgeTextUpdateRequest = Readonly<{
  expectedSha256: string;
  content: string;
}>;

export type KnowledgeActionResult =
  | Readonly<{
      accepted: true;
      knowledgeBaseId?: string;
      indexed?: number;
      skipped?: number;
      errors?: number;
      deleted?: number;
      jobId?: string;
    }>
  | Readonly<{
      accepted: false;
      reason: 'cancelled' | 'invalid' | 'unavailable' | 'conflict';
      message?: string;
    }>;

export type KnowledgeCreateRequest = Readonly<{
  name: string;
  description: string;
  workspaceIds: readonly string[];
}>;

export type KnowledgeUpdateRequest = KnowledgeCreateRequest &
  Readonly<{ ignoreRules: readonly string[]; semanticEnabled?: boolean }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const safeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const validId = (value: unknown, prefix: string): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{32}$`, 'u').test(value);

export const isKnowledgeBaseSummary = (
  value: unknown,
): value is KnowledgeBaseSummary =>
  isRecord(value) &&
  validId(value.id, 'kb') &&
  typeof value.name === 'string' &&
  typeof value.description === 'string' &&
  (value.scope === 'global' || value.scope === 'project') &&
  Array.isArray(value.workspaceIds) &&
  value.workspaceIds.every((id) => typeof id === 'string') &&
  safeCount(value.sourceCount) &&
  safeCount(value.documentCount) &&
  safeCount(value.chunkCount) &&
  safeCount(value.errorCount) &&
  safeCount(value.sizeBytes) &&
  ['ready', 'indexing', 'error'].includes(String(value.status)) &&
  (value.semanticEnabled === undefined || typeof value.semanticEnabled === 'boolean') &&
  safeCount(value.updatedAt);

export const isKnowledgeInspection = (
  value: unknown,
): value is KnowledgeInspection =>
  isRecord(value) &&
  Array.isArray(value.knowledgeBases) &&
  value.knowledgeBases.every(isKnowledgeBaseSummary) &&
  isRecord(value.semanticModel) &&
  ['notInstalled', 'downloading', 'ready', 'error'].includes(
    String(value.semanticModel.state),
  ) &&
  typeof value.semanticModel.enabled === 'boolean' &&
  typeof value.semanticModel.modelId === 'string' &&
  typeof value.semanticModel.version === 'string' &&
  /^[0-9a-f]{40}$/u.test(String(value.semanticModel.revision)) &&
  safeCount(value.semanticModel.dimensions) &&
  value.semanticModel.dimensions > 0 &&
  typeof value.semanticModel.runtime === 'string' &&
  typeof value.semanticModel.variant === 'string' &&
  safeCount(value.semanticModel.downloadedBytes) &&
  safeCount(value.semanticModel.totalBytes) &&
  safeCount(value.semanticModel.installedBytes) &&
  (value.semanticModel.error === undefined ||
    typeof value.semanticModel.error === 'string') &&
  isRecord(value.semanticModel.semanticIndex) &&
  ['notIndexed', 'indexing', 'paused', 'ready', 'error'].includes(
    String(value.semanticModel.semanticIndex.state),
  ) &&
  safeCount(value.semanticModel.semanticIndex.indexedChunks) &&
  safeCount(value.semanticModel.semanticIndex.totalChunks) &&
  safeCount(value.semanticModel.semanticIndex.errorCount) &&
  isRecord(value.semanticModel.device) &&
  typeof value.semanticModel.device.architecture === 'string' &&
  safeCount(value.semanticModel.device.logicalCores) &&
  safeCount(value.semanticModel.device.totalMemoryBytes) &&
  safeCount(value.semanticModel.device.availableMemoryBytes) &&
  safeCount(value.semanticModel.device.availableDiskBytes) &&
  safeCount(value.semanticModel.device.requiredDiskBytes) &&
  typeof value.semanticModel.device.supported === 'boolean' &&
  typeof value.semanticModel.device.recommended === 'boolean' &&
  Array.isArray(value.semanticModel.device.warnings) &&
  value.semanticModel.device.warnings.every(
    (warning) => typeof warning === 'string',
  ) &&
  (value.retrievalPlans === undefined ||
    (Array.isArray(value.retrievalPlans) &&
      value.retrievalPlans.length === 4 &&
      value.retrievalPlans.every(
        (plan) =>
          isRecord(plan) &&
          typeof plan.id === 'string' &&
          typeof plan.name === 'string' &&
          typeof plan.description === 'string' &&
          typeof plan.language === 'string' &&
          safeCount(plan.downloadBytes) &&
          (plan.model === undefined ||
            (isRecord(plan.model) &&
              typeof plan.model.id === 'string' &&
              typeof plan.model.name === 'string' &&
              typeof plan.model.description === 'string' &&
              typeof plan.model.language === 'string' &&
              typeof plan.model.version === 'string' &&
              /^[0-9a-f]{40}$/u.test(String(plan.model.revision)) &&
              safeCount(plan.model.dimensions) &&
              plan.model.dimensions > 0 &&
              typeof plan.model.minimumAppVersion === 'string')),
      ))) &&
  (value.retrievalSettings === undefined ||
    (isRecord(value.retrievalSettings) &&
      (value.retrievalSettings.strategy === 'fullText' ||
        value.retrievalSettings.strategy === 'semantic') &&
      typeof value.retrievalSettings.selectedPlanId === 'string' &&
      (value.retrievalSettings.activeModelId === null ||
        value.retrievalSettings.activeModelId === undefined ||
        typeof value.retrievalSettings.activeModelId === 'string') &&
      (value.retrievalSettings.activeModelVersion === null ||
        value.retrievalSettings.activeModelVersion === undefined ||
        typeof value.retrievalSettings.activeModelVersion === 'string') &&
      (value.retrievalSettings.pendingModelId === null ||
        value.retrievalSettings.pendingModelId === undefined ||
        typeof value.retrievalSettings.pendingModelId === 'string') &&
      (value.retrievalSettings.pendingModelVersion === null ||
        value.retrievalSettings.pendingModelVersion === undefined ||
        typeof value.retrievalSettings.pendingModelVersion === 'string') &&
      (value.retrievalSettings.indexPaused === undefined ||
        typeof value.retrievalSettings.indexPaused === 'boolean')));

const isKnowledgeSource = (value: unknown): value is KnowledgeSource =>
  isRecord(value) &&
  validId(value.id, 'ks') &&
  validId(value.knowledgeBaseId, 'kb') &&
  (value.kind === 'managedFile' || value.kind === 'linkedFolder') &&
  typeof value.path === 'string' &&
  typeof value.displayName === 'string' &&
  safeCount(value.documentCount) &&
  safeCount(value.errorCount) &&
  (value.status === undefined ||
    ['ready', 'scanning', 'disconnected', 'error'].includes(String(value.status))) &&
  (value.lastError === null ||
    value.lastError === undefined ||
    typeof value.lastError === 'string') &&
  (value.lastScannedAt === null ||
    value.lastScannedAt === undefined ||
    safeCount(value.lastScannedAt)) &&
  safeCount(value.updatedAt);

const isKnowledgeIndexJob = (value: unknown): value is KnowledgeIndexJob =>
  isRecord(value) &&
  validId(value.id, 'kj') &&
  validId(value.knowledgeBaseId, 'kb') &&
  (value.sourceId === null || value.sourceId === undefined || validId(value.sourceId, 'ks')) &&
  ['initial', 'incremental', 'rescan', 'rebuild'].includes(String(value.kind)) &&
  ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(
    String(value.status),
  ) &&
  safeCount(value.discoveredFiles) &&
  safeCount(value.processedFiles) &&
  safeCount(value.indexedFiles) &&
  safeCount(value.skippedFiles) &&
  safeCount(value.deletedFiles) &&
  safeCount(value.errorCount) &&
  safeCount(value.attemptCount) &&
  typeof value.cancelRequested === 'boolean' &&
  (value.lastError === null || value.lastError === undefined || typeof value.lastError === 'string') &&
  safeCount(value.createdAt) &&
  safeCount(value.updatedAt);

const isKnowledgeDocument = (value: unknown): value is KnowledgeDocument =>
  isRecord(value) &&
  validId(value.id, 'kd') &&
  validId(value.knowledgeBaseId, 'kb') &&
  validId(value.sourceId, 'ks') &&
  typeof value.relativePath === 'string' &&
  typeof value.fileName === 'string' &&
  typeof value.mediaType === 'string' &&
  safeCount(value.sizeBytes) &&
  safeCount(value.modifiedAt) &&
  typeof value.sha256 === 'string' &&
  /^[0-9a-f]{64}$/u.test(value.sha256) &&
  (value.parseStatus === 'ready' || value.parseStatus === 'error') &&
  (value.parseError === null ||
    value.parseError === undefined ||
    typeof value.parseError === 'string') &&
  safeCount(value.chunkCount) &&
  safeCount(value.updatedAt);

export const isKnowledgeBaseDetail = (
  value: unknown,
): value is KnowledgeBaseDetail =>
  isRecord(value) &&
  Array.isArray(value.sources) &&
  value.sources.every(isKnowledgeSource) &&
  Array.isArray(value.documents) &&
  value.documents.every(isKnowledgeDocument) &&
  (value.indexJobs === undefined ||
    (Array.isArray(value.indexJobs) && value.indexJobs.every(isKnowledgeIndexJob))) &&
  (value.ignoreRules === undefined ||
    (Array.isArray(value.ignoreRules) &&
      value.ignoreRules.every((rule) => typeof rule === 'string'))) &&
  (value.semanticEnabled === undefined || typeof value.semanticEnabled === 'boolean');

const isKnowledgeSearchHit = (value: unknown): value is KnowledgeSearchHit =>
  isRecord(value) &&
  /^K[1-8]$/u.test(String(value.citation)) &&
  validId(value.knowledgeBaseId, 'kb') &&
  typeof value.knowledgeBaseName === 'string' &&
  validId(value.documentId, 'kd') &&
  typeof value.fileName === 'string' &&
  typeof value.relativePath === 'string' &&
  (value.heading === null ||
    value.heading === undefined ||
    typeof value.heading === 'string') &&
  (value.pageNumber === null ||
    value.pageNumber === undefined ||
    safeCount(value.pageNumber)) &&
  (value.contentKind === undefined ||
    value.contentKind === 'text' ||
    value.contentKind === 'code') &&
  (value.language === null || value.language === undefined || typeof value.language === 'string') &&
  (value.startLine === null || value.startLine === undefined || safeCount(value.startLine)) &&
  (value.endLine === null || value.endLine === undefined || safeCount(value.endLine)) &&
  typeof value.content === 'string' &&
  typeof value.score === 'number';

export const isKnowledgeSearchResult = (
  value: unknown,
): value is KnowledgeSearchResult =>
  isRecord(value) &&
  typeof value.query === 'string' &&
  (value.mode === 'fullText' || value.mode === 'hybrid') &&
  Array.isArray(value.hits) &&
  value.hits.length <= 8 &&
  value.hits.every(isKnowledgeSearchHit);

export const isKnowledgeActionResult = (
  value: unknown,
): value is KnowledgeActionResult => {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') return false;
  if (!value.accepted) {
    return (
      ['cancelled', 'invalid', 'unavailable', 'conflict'].includes(
        String(value.reason),
      ) &&
      (value.message === undefined || typeof value.message === 'string')
    );
  }
  return (
    (value.knowledgeBaseId === undefined || validId(value.knowledgeBaseId, 'kb')) &&
    (value.indexed === undefined || safeCount(value.indexed)) &&
    (value.skipped === undefined || safeCount(value.skipped)) &&
    (value.errors === undefined || safeCount(value.errors)) &&
    (value.deleted === undefined || safeCount(value.deleted)) &&
    (value.jobId === undefined || validId(value.jobId, 'kj'))
  );
};

export const isKnowledgeEditableDocument = (
  value: unknown,
): value is KnowledgeEditableDocument =>
  isRecord(value) &&
  validId(value.sourceId, 'ks') &&
  validId(value.knowledgeBaseId, 'kb') &&
  typeof value.fileName === 'string' &&
  value.fileName.length > 0 &&
  value.fileName.length <= 255 &&
  (value.format === 'text' || value.format === 'markdown') &&
  typeof value.content === 'string' &&
  value.content.length <= 2 * 1_024 * 1_024 &&
  typeof value.sha256 === 'string' &&
  /^[0-9a-f]{64}$/u.test(value.sha256) &&
  safeCount(value.sizeBytes) &&
  value.sizeBytes <= 2 * 1_024 * 1_024 &&
  new TextEncoder().encode(value.content).byteLength === value.sizeBytes;

export type KnowledgeApi = Readonly<{
  getKnowledge: () => Promise<KnowledgeInspection>;
  createKnowledgeBase: (
    request: KnowledgeCreateRequest,
  ) => Promise<KnowledgeActionResult>;
  updateKnowledgeBase: (
    id: string,
    request: KnowledgeUpdateRequest,
  ) => Promise<KnowledgeActionResult>;
  deleteKnowledgeBase: (id: string) => Promise<KnowledgeActionResult>;
  addKnowledgeFiles: (id: string) => Promise<KnowledgeActionResult>;
  addKnowledgeFolder: (id: string) => Promise<KnowledgeActionResult>;
  createKnowledgeTextDocument: (
    id: string,
    request: KnowledgeTextCreateRequest,
  ) => Promise<KnowledgeActionResult>;
  readKnowledgeTextDocument: (sourceId: string) => Promise<KnowledgeEditableDocument>;
  updateKnowledgeTextDocument: (
    sourceId: string,
    request: KnowledgeTextUpdateRequest,
  ) => Promise<KnowledgeActionResult>;
  deleteKnowledgeSource: (id: string) => Promise<KnowledgeActionResult>;
  rescanKnowledgeSource: (id: string, rebuild?: boolean) => Promise<KnowledgeActionResult>;
  cancelKnowledgeIndexJob: (id: string) => Promise<KnowledgeActionResult>;
  getKnowledgeBaseDetail: (id: string) => Promise<KnowledgeBaseDetail>;
  searchKnowledge: (
    ids: readonly string[],
    query: string,
  ) => Promise<KnowledgeSearchResult>;
  openKnowledgeDocument: (
    knowledgeBaseId: string,
    documentId: string,
  ) => Promise<KnowledgeActionResult>;
  revealKnowledgeDocument: (
    knowledgeBaseId: string,
    documentId: string,
  ) => Promise<KnowledgeActionResult>;
  installSemanticModel: () => Promise<KnowledgeActionResult>;
  cancelSemanticModelDownload: () => Promise<KnowledgeActionResult>;
  removeSemanticModel: () => Promise<KnowledgeActionResult>;
  selectKnowledgeRetrievalPlan: (planId: string) => Promise<KnowledgeActionResult>;
  setSemanticIndexPaused: (paused: boolean) => Promise<KnowledgeActionResult>;
}>;
