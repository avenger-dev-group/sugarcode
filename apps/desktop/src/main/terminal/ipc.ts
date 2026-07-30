import { ipcMain, type BrowserWindow } from 'electron';

import {
  isTerminalCreateRequest,
  isTerminalInputRequest,
  isTerminalResizeRequest,
  isTerminalSessionRequest,
  isTerminalSnapshotRequest,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_INPUT_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_STATE_CHANGED_CHANNEL,
  TERMINAL_STATE_GET_CHANNEL,
  TERMINAL_TERMINATE_CHANNEL,
} from '@/shared/terminal';

import {
  getTrustedMainWindow,
  isTrustedIpcSender,
} from '../app-server/ipc/trusted-sender';
import type { TerminalController } from './controller';

type TerminalIpcOptions = Readonly<{
  controller: TerminalController;
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

export const registerTerminalIpc = (
  options: TerminalIpcOptions,
): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
    isTrustedIpcSender(event, options);

  ipcMain.handle(TERMINAL_STATE_GET_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isTerminalSnapshotRequest(request)) {
      throw new Error('Terminal snapshot request was invalid.');
    }
    return options.controller.getSnapshot(request);
  });
  ipcMain.handle(TERMINAL_CREATE_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isTerminalCreateRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.create(request);
  });
  ipcMain.handle(TERMINAL_INPUT_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isTerminalInputRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.input(request);
  });
  ipcMain.handle(TERMINAL_RESIZE_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isTerminalResizeRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.resize(request);
  });
  ipcMain.handle(TERMINAL_TERMINATE_CHANNEL, (event, request: unknown) => {
    if (!trusted(event) || !isTerminalSessionRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    return options.controller.terminate(request);
  });

  const unsubscribe = options.controller.subscribe((signal) => {
    getTrustedMainWindow(options)?.webContents.send(
      TERMINAL_STATE_CHANGED_CHANNEL,
      signal,
    );
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(TERMINAL_STATE_GET_CHANNEL);
    ipcMain.removeHandler(TERMINAL_CREATE_CHANNEL);
    ipcMain.removeHandler(TERMINAL_INPUT_CHANNEL);
    ipcMain.removeHandler(TERMINAL_RESIZE_CHANNEL);
    ipcMain.removeHandler(TERMINAL_TERMINATE_CHANNEL);
  };
};
