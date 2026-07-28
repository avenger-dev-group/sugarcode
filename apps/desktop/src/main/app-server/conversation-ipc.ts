import { ipcMain } from 'electron';

import {
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
} from '@/shared/conversation';

import type { ConversationController } from './conversation-controller';
import {
  getTrustedMainWindow,
  isTrustedIpcSender,
  type IpcSenderValidationOptions,
} from './ipc-sender-validation';

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

  ipcMain.handle(CONVERSATION_STOP_CHANNEL, async (event) => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('Conversation stop came from an untrusted frame.');
    }
    return options.controller.stopTurn();
  });

  const unsubscribe = options.controller.subscribe((snapshot) => {
    const window = getTrustedMainWindow(options);
    window?.webContents.send(CONVERSATION_STATE_CHANGED_CHANNEL, snapshot);
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(CONVERSATION_STATE_GET_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_SEND_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_STOP_CHANNEL);
  };
};
