import type { IpcRendererEvent } from 'electron';

import {
  CONNECTION_STATE_CHANGED_CHANNEL,
  CONNECTION_STATE_GET_CHANNEL,
  isConnectionStateSnapshot,
  type ConnectionStateSnapshot,
  type DesktopApi,
} from '@/shared/connection';

type StateChangedHandler = (
  event: IpcRendererEvent,
  snapshot: unknown,
) => void;

export type IpcRendererBoundary = Readonly<{
  invoke: (channel: string) => Promise<unknown>;
  on: (channel: string, listener: StateChangedHandler) => void;
  removeListener: (channel: string, listener: StateChangedHandler) => void;
}>;

export const createDesktopApi = (
  ipcRenderer: IpcRendererBoundary,
): DesktopApi => ({
  getConnectionState: async (): Promise<ConnectionStateSnapshot> => {
    const snapshot: unknown = await ipcRenderer.invoke(
      CONNECTION_STATE_GET_CHANNEL,
    );
    if (!isConnectionStateSnapshot(snapshot)) {
      throw new Error('Main returned an invalid connection state snapshot.');
    }
    return snapshot;
  },
  onConnectionStateChanged: (listener) => {
    const handleStateChanged = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isConnectionStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(CONNECTION_STATE_CHANGED_CHANNEL, handleStateChanged);
    return () => {
      ipcRenderer.removeListener(
        CONNECTION_STATE_CHANGED_CHANNEL,
        handleStateChanged,
      );
    };
  },
});
