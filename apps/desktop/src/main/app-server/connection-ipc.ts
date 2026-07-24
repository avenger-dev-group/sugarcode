import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';

import {
  CONNECTION_STATE_CHANGED_CHANNEL,
  CONNECTION_STATE_GET_CHANNEL,
} from '@/shared/connection';

import type { ConnectionSupervisor } from './connection-supervisor';

type ConnectionIpcOptions = Readonly<{
  supervisor: ConnectionSupervisor;
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

const isTrustedSender = (
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  isAllowedUrl: (url: string) => boolean,
): boolean =>
  window !== null &&
  !window.isDestroyed() &&
  event.sender === window.webContents &&
  event.senderFrame === window.webContents.mainFrame &&
  isAllowedUrl(event.senderFrame.url);

export const registerConnectionIpc = (
  options: ConnectionIpcOptions,
): (() => void) => {
  ipcMain.handle(CONNECTION_STATE_GET_CHANNEL, (event) => {
    if (
      !isTrustedSender(
        event,
        options.getMainWindow(),
        options.isAllowedUrl,
      )
    ) {
      throw new Error('Connection state request came from an untrusted frame.');
    }
    return options.supervisor.getSnapshot();
  });

  const unsubscribe = options.supervisor.subscribe((snapshot) => {
    const window = options.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(CONNECTION_STATE_CHANGED_CHANNEL, snapshot);
    }
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(CONNECTION_STATE_GET_CHANNEL);
  };
};
