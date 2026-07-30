import { ipcMain, type BrowserWindow } from 'electron';

import {
  isPreviewOpenRequest,
  isPreviewSessionRequest,
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_GO_BACK_CHANNEL,
  PREVIEW_GO_FORWARD_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  PREVIEW_RELOAD_CHANNEL,
  PREVIEW_SHOW_CHANNEL,
  PREVIEW_STATE_CHANGED_CHANNEL,
  PREVIEW_STATE_GET_CHANNEL,
} from '@/shared/preview';

import type { PreviewController } from './controller';
import {
  getTrustedMainWindow,
  isTrustedIpcSender,
} from '../app-server/ipc/trusted-sender';

type PreviewIpcOptions = Readonly<{
  controller: PreviewController;
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

export const registerPreviewIpc = (
  options: PreviewIpcOptions,
): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
    isTrustedIpcSender(event, options);

  ipcMain.handle(PREVIEW_STATE_GET_CHANNEL, (event) => {
    if (!trusted(event)) {
      throw new Error('Preview state request came from an untrusted frame.');
    }
    return options.controller.getSnapshot();
  });
  ipcMain.handle(PREVIEW_OPEN_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isPreviewOpenRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.open(request);
  });
  ipcMain.handle(PREVIEW_SHOW_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isPreviewSessionRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.show(request);
  });
  ipcMain.handle(PREVIEW_RELOAD_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isPreviewSessionRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.reload(request);
  });
  ipcMain.handle(PREVIEW_GO_BACK_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isPreviewSessionRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.goBack(request);
  });
  ipcMain.handle(PREVIEW_GO_FORWARD_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isPreviewSessionRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.goForward(request);
  });
  ipcMain.handle(PREVIEW_CLOSE_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isPreviewSessionRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.close(request);
  });

  const unsubscribe = options.controller.subscribe((snapshot) => {
    getTrustedMainWindow(options)?.webContents.send(
      PREVIEW_STATE_CHANGED_CHANNEL,
      snapshot,
    );
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(PREVIEW_STATE_GET_CHANNEL);
    ipcMain.removeHandler(PREVIEW_OPEN_CHANNEL);
    ipcMain.removeHandler(PREVIEW_SHOW_CHANNEL);
    ipcMain.removeHandler(PREVIEW_RELOAD_CHANNEL);
    ipcMain.removeHandler(PREVIEW_GO_BACK_CHANNEL);
    ipcMain.removeHandler(PREVIEW_GO_FORWARD_CHANNEL);
    ipcMain.removeHandler(PREVIEW_CLOSE_CHANNEL);
  };
};
