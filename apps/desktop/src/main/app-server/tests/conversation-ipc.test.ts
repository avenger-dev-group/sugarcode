import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import {
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
  type ConversationStateSnapshot,
} from '@/shared/conversation';

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

import type { ConversationController } from '../conversation-controller';
import { registerConversationIpc } from '../conversation-ipc';

describe('registerConversationIpc', () => {
  it('keeps send, stop and snapshots on the trusted main frame', async () => {
    let listener:
      | ((snapshot: ConversationStateSnapshot) => void)
      | null = null;
    const unsubscribe = vi.fn();
    const snapshot: ConversationStateSnapshot = {
      revision: 1,
      phase: 'idle',
      turns: [],
    };
    const controller = {
      getSnapshot: vi.fn(() => snapshot),
      startTurn: vi.fn(async (input: unknown) => ({
        accepted: input === 'Exact input',
        reason: input === 'Exact input' ? 'accepted' : 'invalidInput',
      })),
      stopTurn: vi.fn(async () => ({
        accepted: false,
        reason: 'noActiveTurn',
      })),
      subscribe: vi.fn(
        (next: (value: ConversationStateSnapshot) => void) => {
          listener = next;
          return unsubscribe;
        },
      ),
    } as unknown as ConversationController;
    const mainFrame = { url: 'http://localhost:5173/' };
    const webContents = { mainFrame, send: vi.fn() };
    const window = {
      isDestroyed: () => false,
      webContents,
    } as unknown as BrowserWindow;
    const dispose = registerConversationIpc({
      controller,
      getMainWindow: () => window,
      isAllowedUrl: (url) => url === mainFrame.url,
    });
    const event = {
      sender: webContents,
      senderFrame: mainFrame,
    } as unknown as IpcMainInvokeEvent;
    const handler = (channel: string) =>
      electron.handle.mock.calls.find(([candidate]) => candidate === channel)
        ?.[1] as (
        event: IpcMainInvokeEvent,
        input?: unknown,
      ) => unknown;

    expect(handler(CONVERSATION_STATE_GET_CHANNEL)(event)).toEqual(snapshot);
    await expect(
      handler(CONVERSATION_SEND_CHANNEL)(event, 'Exact input'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(handler(CONVERSATION_STOP_CHANNEL)(event)).resolves.toEqual({
      accepted: false,
      reason: 'noActiveTurn',
    });
    expect(controller.startTurn).toHaveBeenCalledWith('Exact input');

    listener?.({ revision: 2, phase: 'ready', turns: [] });
    expect(webContents.send).toHaveBeenCalledWith(
      CONVERSATION_STATE_CHANGED_CHANNEL,
      { revision: 2, phase: 'ready', turns: [] },
    );

    expect(() =>
      handler(CONVERSATION_STATE_GET_CHANNEL)({
        sender: webContents,
        senderFrame: { url: mainFrame.url },
      } as unknown as IpcMainInvokeEvent),
    ).toThrow('untrusted frame');

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    for (const channel of [
      CONVERSATION_STATE_GET_CHANNEL,
      CONVERSATION_SEND_CHANNEL,
      CONVERSATION_STOP_CHANNEL,
    ]) {
      expect(electron.removeHandler).toHaveBeenCalledWith(channel);
    }
  });
});
