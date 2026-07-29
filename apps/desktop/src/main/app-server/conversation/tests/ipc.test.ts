import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import {
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
  CONVERSATION_THREAD_SEARCH_CHANNEL,
  CONVERSATION_THREAD_SELECT_CHANNEL,
  CONVERSATION_THREAD_ARCHIVE_CHANNEL,
  CONVERSATION_THREAD_DELETE_CHANNEL,
  CONVERSATION_THREAD_FORK_CHANNEL,
  CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
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

import type { ConversationController } from '../controller';
import { registerConversationIpc } from '../ipc';

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
      navigator: {
        status: 'ready',
        activeThreadIds: [],
        activeTruncated: false,
        search: {
          query: '',
          status: 'idle',
          threadIds: [],
          truncated: false,
        },
      },
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
      searchThreads: vi.fn(async () => ({
        accepted: true,
        reason: 'accepted',
      })),
      selectThread: vi.fn(async () => ({
        accepted: true,
        reason: 'accepted',
      })),
      forkThread: vi.fn(async () => ({
        accepted: true,
        reason: 'accepted',
      })),
      archiveThread: vi.fn(async () => ({
        accepted: true,
        reason: 'accepted',
      })),
      unarchiveThread: vi.fn(async () => ({
        accepted: true,
        reason: 'accepted',
      })),
      deleteThread: vi.fn(async () => ({
        accepted: true,
        reason: 'accepted',
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
    await expect(
      handler(CONVERSATION_THREAD_SEARCH_CHANNEL)(event, 'durable truth'),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(
      handler(CONVERSATION_THREAD_SELECT_CHANNEL)(
        event,
        'thr_0000000000000001',
      ),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    for (const channel of [
      CONVERSATION_THREAD_FORK_CHANNEL,
      CONVERSATION_THREAD_ARCHIVE_CHANNEL,
      CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
      CONVERSATION_THREAD_DELETE_CHANNEL,
    ]) {
      await expect(
        handler(channel)(event, 'thr_0000000000000001'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    }
    expect(controller.startTurn).toHaveBeenCalledWith('Exact input');

    listener?.({ ...snapshot, revision: 2, phase: 'ready' });
    expect(webContents.send).toHaveBeenCalledWith(
      CONVERSATION_STATE_CHANGED_CHANNEL,
      { ...snapshot, revision: 2, phase: 'ready' },
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
      CONVERSATION_THREAD_SEARCH_CHANNEL,
      CONVERSATION_THREAD_SELECT_CHANNEL,
      CONVERSATION_THREAD_FORK_CHANNEL,
      CONVERSATION_THREAD_ARCHIVE_CHANNEL,
      CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
      CONVERSATION_THREAD_DELETE_CHANNEL,
    ]) {
      expect(electron.removeHandler).toHaveBeenCalledWith(channel);
    }
  });
});
