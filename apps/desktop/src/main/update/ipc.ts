import { ipcMain, type BrowserWindow } from 'electron';

import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_PAGE_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATE_CHANGED_CHANNEL,
  UPDATE_STATE_GET_CHANNEL,
} from '@/shared/update';

import {
  isTrustedIpcSender,
  sendToTrustedMainWindow,
} from '../ipc/trusted-sender';
import type { UpdateController } from './controller';

type UpdateIpcOptions = Readonly<{
  controller: UpdateController;
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

export const registerUpdateIpc = (
  options: UpdateIpcOptions,
): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
    isTrustedIpcSender(event, options);

  ipcMain.handle(UPDATE_STATE_GET_CHANNEL, (event) => {
    if (!trusted(event)) {
      throw new Error('Update state request came from an untrusted frame.');
    }
    return options.controller.getSnapshot();
  });
  ipcMain.handle(UPDATE_CHECK_CHANNEL, (event) => {
    if (!trusted(event)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.requestCheck();
  });
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, (event) => {
    if (!trusted(event)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.install();
  });
  ipcMain.handle(UPDATE_DOWNLOAD_PAGE_CHANNEL, (event) => {
    if (!trusted(event)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.openDownloadPage();
  });

  const unsubscribe = options.controller.subscribe((snapshot) => {
    sendToTrustedMainWindow(
      options,
      UPDATE_STATE_CHANGED_CHANNEL,
      snapshot,
    );
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(UPDATE_STATE_GET_CHANNEL);
    ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
    ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
    ipcMain.removeHandler(UPDATE_DOWNLOAD_PAGE_CHANNEL);
  };
};
