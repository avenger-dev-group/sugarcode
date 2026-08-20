import { ipcMain } from 'electron';

import {
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_ATTACHMENT_PREVIEW_CHANNEL,
  CONVERSATION_REVISE_CHANNEL,
  CONVERSATION_QUEUE_UPDATE_CHANNEL,
  CONVERSATION_QUEUE_DELETE_CHANNEL,
  CONVERSATION_QUEUE_STEER_CHANNEL,
  CONVERSATION_QUEUE_RESUME_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
  CONVERSATION_USER_INPUT_RESPONSE_CHANNEL,
  CONVERSATION_THREAD_DELTA_CHANNEL,
  CONVERSATION_THREAD_DELETE_CHANNEL,
  CONVERSATION_THREAD_NEW_CHANNEL,
  CONVERSATION_THREAD_PROJECTION_CHANGED_CHANNEL,
  CONVERSATION_THREAD_PROJECTION_GET_CHANNEL,
  CONVERSATION_THREAD_SEARCH_CHANNEL,
  CONVERSATION_THREAD_SELECT_CHANNEL,
} from '@/shared/conversation';

import type {
  ConversationActionResult,
  ConversationAttachmentPreviewResult,
  ConversationStateListener,
  ConversationStateSnapshot,
  ConversationThreadDeltaListener,
  ConversationThreadProjectionListener,
  ConversationThreadProjectionSnapshot,
} from '@/shared/conversation';

type ConversationControllerBoundary = Readonly<{
  getSnapshot: () => ConversationStateSnapshot;
  subscribe: (listener: ConversationStateListener) => () => void;
  getThreadProjection: (
    threadId: unknown,
  ) => ConversationThreadProjectionSnapshot | null;
  subscribeThreadProjection: (
    listener: ConversationThreadProjectionListener,
  ) => () => void;
  subscribeThreadDelta: (
    listener: ConversationThreadDeltaListener,
  ) => () => void;
  getAttachmentPreview: (
    request: unknown,
  ) => Promise<ConversationAttachmentPreviewResult>;
  startTurn: (input: unknown) => Promise<ConversationActionResult>;
  reviseTurn: (input: unknown) => Promise<ConversationActionResult>;
  updateQueuedMessage: (input: unknown) => Promise<ConversationActionResult>;
  deleteQueuedMessage: (input: unknown) => Promise<ConversationActionResult>;
  steerQueuedMessage: (input: unknown) => Promise<ConversationActionResult>;
  resumeQueue: (threadId: unknown) => Promise<ConversationActionResult>;
  stopTurn: (threadId: unknown) => Promise<ConversationActionResult>;
  respondToUserInput: (input: unknown) => Promise<ConversationActionResult>;
  searchThreads: (query: unknown) => Promise<ConversationActionResult>;
  selectThread: (threadId: unknown) => Promise<ConversationActionResult>;
  startNewThread: () => ConversationActionResult;
  deleteThread: (threadId: unknown) => Promise<ConversationActionResult>;
}>;
import {
  isTrustedIpcSender,
  sendToTrustedMainWindow,
  type IpcSenderValidationOptions,
} from './trusted-sender';

type ConversationIpcOptions = IpcSenderValidationOptions &
  Readonly<{
    controller: ConversationControllerBoundary;
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
    CONVERSATION_THREAD_PROJECTION_GET_CHANNEL,
    (event, threadId: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error(
          'Thread projection request came from an untrusted frame.',
        );
      }
      const projection = options.controller.getThreadProjection(threadId);
      if (!projection) {
        throw new Error('The requested Thread projection is unavailable.');
      }
      return projection;
    },
  );

  ipcMain.handle(CONVERSATION_SEND_CHANNEL, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('Conversation send came from an untrusted frame.');
    }
    return options.controller.startTurn(input);
  });

  ipcMain.handle(
    CONVERSATION_ATTACHMENT_PREVIEW_CHANNEL,
    async (event, request: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error(
          'Attachment preview request came from an untrusted frame.',
        );
      }
      return options.controller.getAttachmentPreview(request);
    },
  );

  ipcMain.handle(CONVERSATION_REVISE_CHANNEL, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('Conversation revision came from an untrusted frame.');
    }
    return options.controller.reviseTurn(input);
  });

  ipcMain.handle(
    CONVERSATION_QUEUE_UPDATE_CHANNEL,
    async (event, input: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error('Queued message update came from an untrusted frame.');
      }
      return options.controller.updateQueuedMessage(input);
    },
  );
  ipcMain.handle(
    CONVERSATION_QUEUE_DELETE_CHANNEL,
    async (event, input: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error(
          'Queued message deletion came from an untrusted frame.',
        );
      }
      return options.controller.deleteQueuedMessage(input);
    },
  );
  ipcMain.handle(
    CONVERSATION_QUEUE_STEER_CHANNEL,
    async (event, input: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error(
          'Queued message steering came from an untrusted frame.',
        );
      }
      return options.controller.steerQueuedMessage(input);
    },
  );
  ipcMain.handle(
    CONVERSATION_QUEUE_RESUME_CHANNEL,
    async (event, threadId: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error('Queue resume came from an untrusted frame.');
      }
      return options.controller.resumeQueue(threadId);
    },
  );

  ipcMain.handle(
    CONVERSATION_STOP_CHANNEL,
    async (event, threadId: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error('Conversation stop came from an untrusted frame.');
      }
      return options.controller.stopTurn(threadId);
    },
  );

  ipcMain.handle(
    CONVERSATION_USER_INPUT_RESPONSE_CHANNEL,
    async (event, input: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error(
          'Conversation user input came from an untrusted frame.',
        );
      }
      return options.controller.respondToUserInput(input);
    },
  );

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

  ipcMain.handle(
    CONVERSATION_THREAD_DELETE_CHANNEL,
    async (event, threadId: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error('Thread deletion came from an untrusted frame.');
      }
      return options.controller.deleteThread(threadId);
    },
  );

  const unsubscribe = options.controller.subscribe((snapshot) => {
    sendToTrustedMainWindow(
      options,
      CONVERSATION_STATE_CHANGED_CHANNEL,
      snapshot,
    );
  });
  const unsubscribeThreadProjection =
    options.controller.subscribeThreadProjection((snapshot) => {
      sendToTrustedMainWindow(
        options,
        CONVERSATION_THREAD_PROJECTION_CHANGED_CHANNEL,
        snapshot,
      );
    });
  const unsubscribeThreadDelta = options.controller.subscribeThreadDelta(
    (delta) => {
      sendToTrustedMainWindow(
        options,
        CONVERSATION_THREAD_DELTA_CHANNEL,
        delta,
      );
    },
  );

  return () => {
    unsubscribe();
    unsubscribeThreadProjection();
    unsubscribeThreadDelta();
    ipcMain.removeHandler(CONVERSATION_STATE_GET_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_PROJECTION_GET_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_SEND_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_ATTACHMENT_PREVIEW_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_REVISE_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_QUEUE_UPDATE_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_QUEUE_DELETE_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_QUEUE_STEER_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_QUEUE_RESUME_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_STOP_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_USER_INPUT_RESPONSE_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_SEARCH_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_SELECT_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_NEW_CHANNEL);
    ipcMain.removeHandler(CONVERSATION_THREAD_DELETE_CHANNEL);
  };
};
