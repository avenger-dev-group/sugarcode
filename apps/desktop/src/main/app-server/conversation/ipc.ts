import { ipcMain } from 'electron';

import {
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
  CONVERSATION_THREAD_ARCHIVE_CHANNEL,
  CONVERSATION_THREAD_DELETE_CHANNEL,
  CONVERSATION_THREAD_FORK_CHANNEL,
  CONVERSATION_THREAD_NEW_CHANNEL,
  CONVERSATION_THREAD_SEARCH_CHANNEL,
  CONVERSATION_THREAD_SELECT_CHANNEL,
  CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
} from '@/shared/conversation';

import type { ConversationController } from './controller';
import {
  getTrustedMainWindow,
  isTrustedIpcSender,
  type IpcSenderValidationOptions,
} from '../ipc/trusted-sender';

type ConversationIpcOptions = IpcSenderValidationOptions &
  Readonly<{
    controller: ConversationController;
  }>;

export const registerConversationIpc = (
  options: ConversationIpcOptions,
): (() => void) => {
  ipcMain.handle(CONVERSATION_STATE_GET_CHANNEL, (event) => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error(
        'Conversation state request came from an untrusted frame.',
      );
    }
    return options.controller.getSnapshot();
  });

  ipcMain.handle(
    CONVERSATION_SEND_CHANNEL,
    async (event, input: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error('Conversation send came from an untrusted frame.');
      }
      return options.controller.startTurn(input);
    },
  );

  ipcMain.handle(CONVERSATION_STOP_CHANNEL, async (event, threadId: unknown) => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('Conversation stop came from an untrusted frame.');
    }
    return options.controller.stopTurn(threadId);
  });

  ipcMain.handle(
    CONVERSATION_THREAD_SEARCH_CHANNEL,
    async (event, query: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error('Thread search came from an untrusted frame.');
      }
      return options.controller.searchThreads(query);
    },
  );

  ipcMain.handle(
    CONVERSATION_THREAD_SELECT_CHANNEL,
    async (event, threadId: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error('Thread selection came from an untrusted frame.');
      }
      return options.controller.selectThread(threadId);
    },
  );

  ipcMain.handle(CONVERSATION_THREAD_NEW_CHANNEL, async (event) => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('New Thread request came from an untrusted frame.');
    }
    return options.controller.startNewThread();
  });

  for (const [channel, action] of [
    [CONVERSATION_THREAD_FORK_CHANNEL, options.controller.forkThread],
    [CONVERSATION_THREAD_ARCHIVE_CHANNEL, options.controller.archiveThread],
    [
      CONVERSATION_THREAD_UNARCHIVE_CHANNEL,
      options.controller.unarchiveThread,
    ],
    [CONVERSATION_THREAD_DELETE_CHANNEL, options.controller.deleteThread],
  ] as const) {
    ipcMain.handle(channel, async (event, threadId: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error('Thread mutation came from an untrusted frame.');
      }
      return action(threadId);
    });
  }

  const unsubscribe = options.controller.subscribe((snapshot) => {
    const window = getTrustedMainWindow(options);
    window?.webContents.send(CONVERSATION_STATE_CHANGED_CHANNEL, snapshot);
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(CONVERSATION_STATE_GET_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_SEND_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_STOP_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_SEARCH_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_SELECT_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_NEW_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_FORK_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_ARCHIVE_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_UNARCHIVE_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_DELETE_CHANNEL);
  };
};
