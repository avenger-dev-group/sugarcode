export const KNOWLEDGE_GET_CHANNEL = 'knowledge:get';
export const KNOWLEDGE_CREATE_CHANNEL = 'knowledge:create';
export const KNOWLEDGE_DELETE_CHANNEL = 'knowledge:delete';
export const KNOWLEDGE_ADD_FILES_CHANNEL = 'knowledge:add-files';
export const KNOWLEDGE_ADD_FOLDER_CHANNEL = 'knowledge:add-folder';
export const KNOWLEDGE_DETAIL_CHANNEL = 'knowledge:detail';
export const KNOWLEDGE_SEARCH_CHANNEL = 'knowledge:search';
export const KNOWLEDGE_MODEL_INSTALL_CHANNEL = 'knowledge:model-install';
export const KNOWLEDGE_MODEL_CANCEL_CHANNEL = 'knowledge:model-cancel';
export const KNOWLEDGE_MODEL_REMOVE_CHANNEL = 'knowledge:model-remove';

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
    state: 'notIndexed' | 'indexing' | 'ready' | 'error';
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
}>;

export type KnowledgeSource = Readonly<{
  id: string;
  knowledgeBaseId: string;
  kind: 'managedFile' | 'linkedFolder';
  path: string;
  displayName: string;
  documentCount: number;
  errorCount: number;
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
  content: string;
  score: number;
}>;

export type KnowledgeSearchResult = Readonly<{
  query: string;
  mode: 'fullText' | 'hybrid';
  hits: readonly KnowledgeSearchHit[];
}>;

export type KnowledgeActionResult =
  | Readonly<{
      accepted: true;
      knowledgeBaseId?: string;
      indexed?: number;
      skipped?: number;
      errors?: number;
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
  value.semanticModel.dimensions === 384 &&
  typeof value.semanticModel.runtime === 'string' &&
  typeof value.semanticModel.variant === 'string' &&
  safeCount(value.semanticModel.downloadedBytes) &&
  safeCount(value.semanticModel.totalBytes) &&
  safeCount(value.semanticModel.installedBytes) &&
  (value.semanticModel.error === undefined ||
    typeof value.semanticModel.error === 'string') &&
  isRecord(value.semanticModel.semanticIndex) &&
  ['notIndexed', 'indexing', 'ready', 'error'].includes(
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
  );

const isKnowledgeSource = (value: unknown): value is KnowledgeSource =>
  isRecord(value) &&
  validId(value.id, 'ks') &&
  validId(value.knowledgeBaseId, 'kb') &&
  (value.kind === 'managedFile' || value.kind === 'linkedFolder') &&
  typeof value.path === 'string' &&
  typeof value.displayName === 'string' &&
  safeCount(value.documentCount) &&
  safeCount(value.errorCount) &&
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
  value.documents.every(isKnowledgeDocument);

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
    (value.errors === undefined || safeCount(value.errors))
  );
};

export type KnowledgeApi = Readonly<{
  getKnowledge: () => Promise<KnowledgeInspection>;
  createKnowledgeBase: (
    request: KnowledgeCreateRequest,
  ) => Promise<KnowledgeActionResult>;
  deleteKnowledgeBase: (id: string) => Promise<KnowledgeActionResult>;
  addKnowledgeFiles: (id: string) => Promise<KnowledgeActionResult>;
  addKnowledgeFolder: (id: string) => Promise<KnowledgeActionResult>;
  getKnowledgeBaseDetail: (id: string) => Promise<KnowledgeBaseDetail>;
  searchKnowledge: (
    ids: readonly string[],
    query: string,
  ) => Promise<KnowledgeSearchResult>;
  installSemanticModel: () => Promise<KnowledgeActionResult>;
  cancelSemanticModelDownload: () => Promise<KnowledgeActionResult>;
  removeSemanticModel: () => Promise<KnowledgeActionResult>;
}>;
