import {
  ipcMain,
  type BrowserWindow,
} from 'electron';

import {
  CONNECTION_STATE_CHANGED_CHANNEL,
  CONNECTION_STATE_GET_CHANNEL,
} from '@/shared/connection';

import type { ConnectionSupervisor } from './connection-supervisor';
import {
  getTrustedMainWindow,
  isTrustedIpcSender,
} from './ipc-sender-validation';

type ConnectionIpcOptions = Readonly<{
  supervisor: ConnectionSupervisor;
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

export const registerConnectionIpc = (
  options: ConnectionIpcOptions,
): (() => void) => {
  ipcMain.handle(CONNECTION_STATE_GET_CHANNEL, (event) => {
    if (
      !isTrustedIpcSender(event, options)
    ) {
      throw new Error('Connection state request came from an untrusted frame.');
    }
    return options.supervisor.getSnapshot();
  });

  const unsubscribe = options.supervisor.subscribe((snapshot) => {
    const window = getTrustedMainWindow(options);
    window?.webContents.send(CONNECTION_STATE_CHANGED_CHANNEL, snapshot);
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(CONNECTION_STATE_GET_CHANNEL);
  };
};
