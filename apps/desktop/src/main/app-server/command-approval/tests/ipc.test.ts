import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import {
  COMMAND_APPROVAL_APPROVE_CHANNEL,
  COMMAND_APPROVAL_DENY_CHANNEL,
  COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
  COMMAND_APPROVAL_STATE_GET_CHANNEL,
} from '@/shared/command-approval';

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

import { registerCommandApprovalIpc } from '../ipc';
import type { CommandApprovalController } from '../controller';

describe('registerCommandApprovalIpc', () => {
  it('exposes only bounded approval handlers to the owned main frame', async () => {
    let stateListener:
      | ((snapshot: { revision: number; status: 'approved' }) => void)
      | null = null;
    const unsubscribe = vi.fn();
    const surfaceUnavailable = vi.fn();
    const controller = {
      approve: vi.fn(async () => ({
        accepted: true,
        reason: 'accepted',
      })),
      deny: vi.fn(async () => ({
        accepted: true,
        reason: 'accepted',
      })),
      markSurfaceReady: vi.fn(() => ({ revision: 0, status: 'idle' })),
      subscribe: vi.fn(
        (
          listener: (snapshot: {
            revision: number;
            status: 'approved';
          }) => void,
        ) => {
          stateListener = listener;
          return unsubscribe;
        },
      ),
      surfaceUnavailable,
    } as unknown as CommandApprovalController;
    const mainFrame = { url: 'http://localhost:5173/' };
    const webContents = {
      mainFrame,
      send: vi.fn(),
    };
    const window = {
      isDestroyed: () => false,
      webContents,
    } as unknown as BrowserWindow;
    const dispose = registerCommandApprovalIpc({
      controller,
      getMainWindow: () => window,
      isAllowedUrl: (url) => url === mainFrame.url,
    });
    const handlers = new Map(
      electron.handle.mock.calls.map(([channel, handler]) => [
        channel as string,
        handler as (
          event: IpcMainInvokeEvent,
          value?: unknown,
        ) => unknown,
      ]),
    );
    const trustedEvent = {
      sender: webContents,
      senderFrame: mainFrame,
    } as unknown as IpcMainInvokeEvent;

    expect(
      handlers.get(COMMAND_APPROVAL_STATE_GET_CHANNEL)?.(trustedEvent),
    ).toEqual({ revision: 0, status: 'idle' });
    await expect(
      handlers
        .get(COMMAND_APPROVAL_APPROVE_CHANNEL)
        ?.(trustedEvent, 'presentation/one'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(
      handlers
        .get(COMMAND_APPROVAL_DENY_CHANNEL)
        ?.(trustedEvent, 'presentation/one'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(controller.approve).toHaveBeenCalledWith('presentation/one');
    expect(controller.deny).toHaveBeenCalledWith('presentation/one');

    expect(() =>
      handlers.get(COMMAND_APPROVAL_STATE_GET_CHANNEL)?.({
        sender: webContents,
        senderFrame: { url: mainFrame.url },
      } as unknown as IpcMainInvokeEvent),
    ).toThrow('untrusted frame');

    stateListener?.({ revision: 1, status: 'approved' });
    expect(webContents.send).toHaveBeenCalledWith(
      COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
      { revision: 1, status: 'approved' },
    );

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(surfaceUnavailable).toHaveBeenCalledOnce();
    expect(electron.removeHandler).toHaveBeenCalledTimes(3);
  });
});
