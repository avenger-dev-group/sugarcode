import { ipcMain, type BrowserWindow } from 'electron';

import {
  isWorkspaceInspectRequest,
  isWorkspaceChatRequest,
  isWorkspaceListRequest,
  isWorkspacePathSearchRequest,
  isWorkspaceResolveRequest,
  isWorkspaceTaskRenameRequest,
  WORKSPACE_CHAT_ACTIVATE_CHANNEL,
  WORKSPACE_CLEAR_CHANNEL,
  WORKSPACE_INSPECT_CHANNEL,
  WORKSPACE_LIST_CHANNEL,
  WORKSPACE_PATH_SEARCH_CHANNEL,
  WORKSPACE_RESOLVE_CHANNEL,
  WORKSPACE_PROJECT_RESUME_CHANNEL,
  WORKSPACE_PROJECT_ACTIVATE_CHANNEL,
  WORKSPACE_PROJECT_REMOVE_CHANNEL,
  WORKSPACE_SELECT_CHANNEL,
  WORKSPACE_STATE_CHANGED_CHANNEL,
  WORKSPACE_STATE_GET_CHANNEL,
  WORKSPACE_TASK_FOCUS_CHANNEL,
  WORKSPACE_TASK_DELETE_CHANNEL,
  WORKSPACE_TASK_RENAME_CHANNEL,
} from '@/shared/workspace';

import type { WorkspaceController } from '../workspace/controller';
import {
  getTrustedMainWindow,
  isTrustedIpcSender,
} from './trusted-sender';

type WorkspaceIpcOptions = Readonly<{
  controller: WorkspaceController;
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

export const registerWorkspaceIpc = (
  options: WorkspaceIpcOptions,
): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
    isTrustedIpcSender(event, options);

  ipcMain.handle(WORKSPACE_STATE_GET_CHANNEL, (event) => {
    if (!trusted(event)) {
      throw new Error('Workspace state request came from an untrusted frame.');
    }
    return options.controller.getSnapshot();
  });
  ipcMain.handle(WORKSPACE_SELECT_CHANNEL, (event) => {
    if (!trusted(event)) {
      throw new Error('Workspace selection came from an untrusted frame.');
    }
    return options.controller.select();
  });
  ipcMain.handle(WORKSPACE_PROJECT_RESUME_CHANNEL, (event) => {
    if (!trusted(event)) {
      throw new Error('Workspace resume came from an untrusted frame.');
    }
    return options.controller.resumeProject();
  });
  ipcMain.handle(
    WORKSPACE_PROJECT_ACTIVATE_CHANNEL,
    (event, projectId: unknown) => {
      if (
        !trusted(event) ||
        typeof projectId !== 'string' ||
        projectId.length === 0 ||
        projectId.length > 128
      ) {
        return { accepted: false, reason: 'invalid' };
      }
      return options.controller.activateProject(projectId);
    },
  );
  ipcMain.handle(
    WORKSPACE_PROJECT_REMOVE_CHANNEL,
    (event, projectId: unknown) => {
      if (
        !trusted(event) ||
        typeof projectId !== 'string' ||
        projectId.length === 0 ||
        projectId.length > 128
      ) {
        return { accepted: false, reason: 'invalid' };
      }
      return options.controller.removeProject(projectId);
    },
  );
  ipcMain.handle(
    WORKSPACE_TASK_FOCUS_CHANNEL,
    (event, threadId: unknown) => {
      if (
        !trusted(event) ||
        typeof threadId !== 'string' ||
        threadId.length === 0 ||
        threadId.length > 128
      ) {
        return { accepted: false, reason: 'invalid' };
      }
      return options.controller.focusTask(threadId);
    },
  );
  ipcMain.handle(
    WORKSPACE_TASK_DELETE_CHANNEL,
    (event, threadId: unknown) => {
      if (
        !trusted(event) ||
        typeof threadId !== 'string' ||
        threadId.length === 0 ||
        threadId.length > 128
      ) {
        return { accepted: false, reason: 'invalid' };
      }
      return options.controller.deleteTask(threadId);
    },
  );
  ipcMain.handle(
    WORKSPACE_TASK_RENAME_CHANNEL,
    (event, request: unknown) => {
      if (!trusted(event) || !isWorkspaceTaskRenameRequest(request)) {
        return { accepted: false, reason: 'invalid' };
      }
      return options.controller.renameTask(request.threadId, request.title);
    },
  );
  ipcMain.handle(
    WORKSPACE_CHAT_ACTIVATE_CHANNEL,
    (event, request: unknown) => {
      if (!trusted(event) || !isWorkspaceChatRequest(request)) {
        return { accepted: false, reason: 'invalid' };
      }
      return options.controller.activateChat(request);
    },
  );
  ipcMain.handle(WORKSPACE_CLEAR_CHANNEL, (event) => {
    if (!trusted(event)) {
      throw new Error('Workspace clear came from an untrusted frame.');
    }
    return options.controller.clear();
  });
  ipcMain.handle(WORKSPACE_LIST_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isWorkspaceListRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.list(request);
  });
  ipcMain.handle(WORKSPACE_PATH_SEARCH_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isWorkspacePathSearchRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.searchPaths(request);
  });
  ipcMain.handle(WORKSPACE_INSPECT_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isWorkspaceInspectRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.inspect(request);
  });
  ipcMain.handle(WORKSPACE_RESOLVE_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isWorkspaceResolveRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.resolve(request);
  });

  const unsubscribe = options.controller.subscribe((snapshot) => {
    getTrustedMainWindow(options)?.webContents.send(
      WORKSPACE_STATE_CHANGED_CHANNEL,
      snapshot,
    );
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(WORKSPACE_STATE_GET_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_SELECT_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_PROJECT_RESUME_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_PROJECT_ACTIVATE_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_PROJECT_REMOVE_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_TASK_FOCUS_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_TASK_DELETE_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_TASK_RENAME_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_CHAT_ACTIVATE_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_CLEAR_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_LIST_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_PATH_SEARCH_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_INSPECT_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_RESOLVE_CHANNEL);
  };
};
