import { ipcMain, type BrowserWindow } from 'electron';

import {
  isWorkspaceInspectRequest,
  isWorkspaceListRequest,
  WORKSPACE_INSPECT_CHANNEL,
  WORKSPACE_LIST_CHANNEL,
  WORKSPACE_SELECT_CHANNEL,
  WORKSPACE_STATE_CHANGED_CHANNEL,
  WORKSPACE_STATE_GET_CHANNEL,
} from '@/shared/workspace';

import type { WorkspaceController } from './controller';
import {
  getTrustedMainWindow,
  isTrustedIpcSender,
} from '../ipc/trusted-sender';

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
  ipcMain.handle(WORKSPACE_LIST_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isWorkspaceListRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.list(request);
  });
  ipcMain.handle(WORKSPACE_INSPECT_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isWorkspaceInspectRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.inspect(request);
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
    ipcMain.removeHandler(WORKSPACE_LIST_CHANNEL);
    ipcMain.removeHandler(WORKSPACE_INSPECT_CHANNEL);
  };
};
