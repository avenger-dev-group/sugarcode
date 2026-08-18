import type {
  KnowledgeActionResult,
  KnowledgeBaseDetail,
  KnowledgeCreateRequest,
  KnowledgeEditableDocument,
  KnowledgeInspection,
  KnowledgeSearchResult,
  KnowledgeTextCreateRequest,
  KnowledgeTextUpdateRequest,
  KnowledgeUpdateRequest,
} from '@/shared/knowledge';

export const getKnowledge = (): Promise<KnowledgeInspection> =>
  window.sugarcode.getKnowledge();

export const createKnowledgeBase = (
  request: KnowledgeCreateRequest,
): Promise<KnowledgeActionResult> => window.sugarcode.createKnowledgeBase(request);

export const updateKnowledgeBase = (
  id: string,
  request: KnowledgeUpdateRequest,
): Promise<KnowledgeActionResult> => window.sugarcode.updateKnowledgeBase(id, request);

export const deleteKnowledgeBase = (id: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.deleteKnowledgeBase(id);

export const addKnowledgeFiles = (id: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.addKnowledgeFiles(id);

export const addKnowledgeFolder = (id: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.addKnowledgeFolder(id);

export const createKnowledgeTextDocument = (
  id: string,
  request: KnowledgeTextCreateRequest,
): Promise<KnowledgeActionResult> =>
  window.sugarcode.createKnowledgeTextDocument(id, request);

export const readKnowledgeTextDocument = (
  sourceId: string,
): Promise<KnowledgeEditableDocument> =>
  window.sugarcode.readKnowledgeTextDocument(sourceId);

export const updateKnowledgeTextDocument = (
  sourceId: string,
  request: KnowledgeTextUpdateRequest,
): Promise<KnowledgeActionResult> =>
  window.sugarcode.updateKnowledgeTextDocument(sourceId, request);

export const deleteKnowledgeSource = (id: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.deleteKnowledgeSource(id);

export const rescanKnowledgeSource = (
  id: string,
  rebuild?: boolean,
): Promise<KnowledgeActionResult> => window.sugarcode.rescanKnowledgeSource(id, rebuild);

export const cancelKnowledgeIndexJob = (id: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.cancelKnowledgeIndexJob(id);

export const getKnowledgeBaseDetail = (id: string): Promise<KnowledgeBaseDetail> =>
  window.sugarcode.getKnowledgeBaseDetail(id);

export const searchKnowledge = (
  ids: readonly string[],
  query: string,
): Promise<KnowledgeSearchResult> => window.sugarcode.searchKnowledge(ids, query);

export const openKnowledgeDocument = (
  knowledgeBaseId: string,
  documentId: string,
): Promise<KnowledgeActionResult> =>
  window.sugarcode.openKnowledgeDocument(knowledgeBaseId, documentId);

export const revealKnowledgeDocument = (
  knowledgeBaseId: string,
  documentId: string,
): Promise<KnowledgeActionResult> =>
  window.sugarcode.revealKnowledgeDocument(knowledgeBaseId, documentId);

export const installSemanticModel = (): Promise<KnowledgeActionResult> =>
  window.sugarcode.installSemanticModel();

export const cancelSemanticModelDownload = (): Promise<KnowledgeActionResult> =>
  window.sugarcode.cancelSemanticModelDownload();

export const removeSemanticModel = (): Promise<KnowledgeActionResult> =>
  window.sugarcode.removeSemanticModel();
export const selectKnowledgeRetrievalPlan = (planId: string): Promise<KnowledgeActionResult> =>
  window.sugarcode.selectKnowledgeRetrievalPlan(planId);
export const setSemanticIndexPaused = (paused: boolean): Promise<KnowledgeActionResult> =>
  window.sugarcode.setSemanticIndexPaused(paused);
