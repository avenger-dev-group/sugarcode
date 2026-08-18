import { ipcMain } from 'electron';

import type { RuntimeKnowledgeController } from '@/main/runtime/knowledge-controller';
import {
  KNOWLEDGE_ADD_FILES_CHANNEL,
  KNOWLEDGE_ADD_FOLDER_CHANNEL,
  KNOWLEDGE_TEXT_CREATE_CHANNEL,
  KNOWLEDGE_TEXT_READ_CHANNEL,
  KNOWLEDGE_TEXT_UPDATE_CHANNEL,
  KNOWLEDGE_CREATE_CHANNEL,
  KNOWLEDGE_UPDATE_CHANNEL,
  KNOWLEDGE_DELETE_CHANNEL,
  KNOWLEDGE_DETAIL_CHANNEL,
  KNOWLEDGE_DOCUMENT_OPEN_CHANNEL,
  KNOWLEDGE_DOCUMENT_REVEAL_CHANNEL,
  KNOWLEDGE_SOURCE_DELETE_CHANNEL,
  KNOWLEDGE_SOURCE_RESCAN_CHANNEL,
  KNOWLEDGE_INDEX_CANCEL_CHANNEL,
  KNOWLEDGE_GET_CHANNEL,
  KNOWLEDGE_MODEL_CANCEL_CHANNEL,
  KNOWLEDGE_MODEL_INSTALL_CHANNEL,
  KNOWLEDGE_MODEL_REMOVE_CHANNEL,
  KNOWLEDGE_RETRIEVAL_SELECT_CHANNEL,
  KNOWLEDGE_SEMANTIC_INDEX_PAUSE_CHANNEL,
  KNOWLEDGE_SEARCH_CHANNEL,
} from '@/shared/knowledge';

import { isTrustedIpcSender, type IpcSenderValidationOptions } from './trusted-sender';

type KnowledgeIpcOptions = IpcSenderValidationOptions &
  Readonly<{ controller: RuntimeKnowledgeController }>;

export const registerKnowledgeIpc = (options: KnowledgeIpcOptions): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('Knowledge request came from an untrusted frame.');
    }
  };
  ipcMain.handle(KNOWLEDGE_GET_CHANNEL, (event) => {
    trusted(event);
    return options.controller.inspect();
  });
  ipcMain.handle(KNOWLEDGE_CREATE_CHANNEL, (event, request: unknown) => {
    trusted(event);
    return options.controller.create(request);
  });
  ipcMain.handle(KNOWLEDGE_UPDATE_CHANNEL, (event, id: unknown, request: unknown) => {
    trusted(event);
    return options.controller.update(id, request);
  });
  ipcMain.handle(KNOWLEDGE_DELETE_CHANNEL, (event, id: unknown) => {
    trusted(event);
    return options.controller.delete(id);
  });
  ipcMain.handle(KNOWLEDGE_ADD_FILES_CHANNEL, (event, id: unknown) => {
    trusted(event);
    return options.controller.addFiles(id);
  });
  ipcMain.handle(KNOWLEDGE_ADD_FOLDER_CHANNEL, (event, id: unknown) => {
    trusted(event);
    return options.controller.addFolder(id);
  });
  ipcMain.handle(
    KNOWLEDGE_TEXT_CREATE_CHANNEL,
    (event, id: unknown, request: unknown) => {
      trusted(event);
      return options.controller.createTextDocument(id, request);
    },
  );
  ipcMain.handle(KNOWLEDGE_TEXT_READ_CHANNEL, (event, id: unknown) => {
    trusted(event);
    return options.controller.readTextDocument(id);
  });
  ipcMain.handle(
    KNOWLEDGE_TEXT_UPDATE_CHANNEL,
    (event, id: unknown, request: unknown) => {
      trusted(event);
      return options.controller.updateTextDocument(id, request);
    },
  );
  ipcMain.handle(KNOWLEDGE_SOURCE_DELETE_CHANNEL, (event, id: unknown) => {
    trusted(event);
    return options.controller.deleteSource(id);
  });
  ipcMain.handle(
    KNOWLEDGE_SOURCE_RESCAN_CHANNEL,
    (event, id: unknown, rebuild: unknown) => {
      trusted(event);
      return options.controller.rescanSource(id, rebuild);
    },
  );
  ipcMain.handle(KNOWLEDGE_INDEX_CANCEL_CHANNEL, (event, id: unknown) => {
    trusted(event);
    return options.controller.cancelIndexJob(id);
  });
  ipcMain.handle(KNOWLEDGE_DETAIL_CHANNEL, (event, id: unknown) => {
    trusted(event);
    return options.controller.detail(id);
  });
  ipcMain.handle(KNOWLEDGE_SEARCH_CHANNEL, (event, ids: unknown, query: unknown) => {
    trusted(event);
    return options.controller.search(ids, query);
  });
  ipcMain.handle(
    KNOWLEDGE_DOCUMENT_OPEN_CHANNEL,
    (event, knowledgeBaseId: unknown, documentId: unknown) => {
      trusted(event);
      return options.controller.openDocument(knowledgeBaseId, documentId);
    },
  );
  ipcMain.handle(
    KNOWLEDGE_DOCUMENT_REVEAL_CHANNEL,
    (event, knowledgeBaseId: unknown, documentId: unknown) => {
      trusted(event);
      return options.controller.revealDocument(knowledgeBaseId, documentId);
    },
  );
  ipcMain.handle(KNOWLEDGE_MODEL_INSTALL_CHANNEL, (event) => {
    trusted(event);
    return options.controller.installSemanticModel();
  });
  ipcMain.handle(KNOWLEDGE_MODEL_CANCEL_CHANNEL, (event) => {
    trusted(event);
    return options.controller.cancelSemanticModelDownload();
  });
  ipcMain.handle(KNOWLEDGE_MODEL_REMOVE_CHANNEL, (event) => {
    trusted(event);
    return options.controller.removeSemanticModel();
  });
  ipcMain.handle(KNOWLEDGE_RETRIEVAL_SELECT_CHANNEL, (event, planId: unknown) => {
    trusted(event);
    return options.controller.selectRetrievalPlan(planId);
  });
  ipcMain.handle(KNOWLEDGE_SEMANTIC_INDEX_PAUSE_CHANNEL, (event, paused: unknown) => {
    trusted(event);
    return options.controller.setSemanticIndexPaused(paused);
  });
  return () => {
    for (const channel of [
      KNOWLEDGE_GET_CHANNEL,
      KNOWLEDGE_CREATE_CHANNEL,
      KNOWLEDGE_UPDATE_CHANNEL,
      KNOWLEDGE_DELETE_CHANNEL,
      KNOWLEDGE_ADD_FILES_CHANNEL,
      KNOWLEDGE_ADD_FOLDER_CHANNEL,
      KNOWLEDGE_TEXT_CREATE_CHANNEL,
      KNOWLEDGE_TEXT_READ_CHANNEL,
      KNOWLEDGE_TEXT_UPDATE_CHANNEL,
      KNOWLEDGE_DETAIL_CHANNEL,
      KNOWLEDGE_SOURCE_DELETE_CHANNEL,
      KNOWLEDGE_SOURCE_RESCAN_CHANNEL,
      KNOWLEDGE_INDEX_CANCEL_CHANNEL,
      KNOWLEDGE_SEARCH_CHANNEL,
      KNOWLEDGE_DOCUMENT_OPEN_CHANNEL,
      KNOWLEDGE_DOCUMENT_REVEAL_CHANNEL,
      KNOWLEDGE_MODEL_INSTALL_CHANNEL,
      KNOWLEDGE_MODEL_CANCEL_CHANNEL,
      KNOWLEDGE_MODEL_REMOVE_CHANNEL,
      KNOWLEDGE_RETRIEVAL_SELECT_CHANNEL,
      KNOWLEDGE_SEMANTIC_INDEX_PAUSE_CHANNEL,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
};
