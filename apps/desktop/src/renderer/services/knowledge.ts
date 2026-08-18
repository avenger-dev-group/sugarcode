import type {
  KnowledgeActionResult,
  KnowledgeBaseDetail,
  KnowledgeCreateRequest,
  KnowledgeInspection,
  KnowledgeSearchResult,
} from '@/shared/knowledge';

export const getKnowledge = (): Promise<KnowledgeInspection> =>
  window.sugarcode.getKnowledge();

export const createKnowledgeBase = (
  request: KnowledgeCreateRequest,
): Promise<KnowledgeActionResult> => window.sugarcode.createKnowledgeBase(request);

export const deleteKnowledgeBase = (id: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.deleteKnowledgeBase(id);

export const addKnowledgeFiles = (id: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.addKnowledgeFiles(id);

export const addKnowledgeFolder = (id: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.addKnowledgeFolder(id);

export const getKnowledgeBaseDetail = (id: string): Promise<KnowledgeBaseDetail> =>
  window.sugarcode.getKnowledgeBaseDetail(id);

export const searchKnowledge = (
  ids: readonly string[],
  query: string,
): Promise<KnowledgeSearchResult> => window.sugarcode.searchKnowledge(ids, query);

export const installSemanticModel = (): Promise<KnowledgeActionResult> =>
  window.sugarcode.installSemanticModel();

export const cancelSemanticModelDownload = (): Promise<KnowledgeActionResult> =>
  window.sugarcode.cancelSemanticModelDownload();

export const removeSemanticModel = (): Promise<KnowledgeActionResult> =>
  window.sugarcode.removeSemanticModel();
