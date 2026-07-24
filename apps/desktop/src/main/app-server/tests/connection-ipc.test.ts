import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import {
  CONNECTION_STATE_CHANGED_CHANNEL,
  CONNECTION_STATE_GET_CHANNEL,
} from '@/shared/connection';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

import { registerConnectionIpc } from '../connection-ipc';
import type { ConnectionSupervisor } from '../connection-supervisor';

describe('registerConnectionIpc', () => {
  it('accepts only the owned main frame and pushes bounded snapshots', () => {
    let stateListener:
      | ((snapshot: { revision: number; status: 'ready' }) => void)
      | null = null;
    const unsubscribe = vi.fn();
    const supervisor = {
      getSnapshot: vi.fn(() => ({ revision: 1, status: 'connecting' })),
      subscribe: vi.fn(
        (
          listener: (snapshot: { revision: number; status: 'ready' }) => void,
        ) => {
          stateListener = listener;
          return unsubscribe;
        },
      ),
    } as unknown as ConnectionSupervisor;
    const mainFrame = { url: 'http://localhost:5173/' };
    const webContents = {
      mainFrame,
      send: vi.fn(),
    };
    const window = {
      isDestroyed: () => false,
      webContents,
    } as unknown as BrowserWindow;
    const dispose = registerConnectionIpc({
      supervisor,
      getMainWindow: () => window,
      isAllowedUrl: (url) => url === mainFrame.url,
    });
    const handler = electron.handle.mock.calls.find(
      ([channel]) => channel === CONNECTION_STATE_GET_CHANNEL,
    )?.[1] as (event: IpcMainInvokeEvent) => unknown;

    expect(
      handler({
        sender: webContents,
        senderFrame: mainFrame,
      } as unknown as IpcMainInvokeEvent),
    ).toEqual({ revision: 1, status: 'connecting' });
    expect(() =>
      handler({
        sender: webContents,
        senderFrame: { url: mainFrame.url },
      } as unknown as IpcMainInvokeEvent),
    ).toThrow('untrusted frame');

    stateListener?.({ revision: 2, status: 'ready' });
    expect(webContents.send).toHaveBeenCalledWith(
      CONNECTION_STATE_CHANGED_CHANNEL,
      { revision: 2, status: 'ready' },
    );

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(electron.removeHandler).toHaveBeenCalledWith(
      CONNECTION_STATE_GET_CHANNEL,
    );
  });
});
