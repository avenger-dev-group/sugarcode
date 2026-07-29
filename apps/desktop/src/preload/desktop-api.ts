import type { IpcRendererEvent } from 'electron';

import {
  COMMAND_APPROVAL_APPROVE_CHANNEL,
  COMMAND_APPROVAL_DENY_CHANNEL,
  COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
  COMMAND_APPROVAL_STATE_GET_CHANNEL,
  isCommandApprovalActionResult,
  isCommandApprovalStateSnapshot,
  type CommandApprovalActionResult,
  type CommandApprovalStateSnapshot,
} from '@/shared/command-approval';
import {
  CONNECTION_STATE_CHANGED_CHANNEL,
  CONNECTION_STATE_GET_CHANNEL,
  isConnectionStateSnapshot,
  type ConnectionStateSnapshot,
} from '@/shared/connection';
import type { DesktopApi } from '@/shared/desktop-api';
import {
  CONVERSATION_SEND_CHANNEL,
  CONVERSATION_STATE_CHANGED_CHANNEL,
  CONVERSATION_STATE_GET_CHANNEL,
  CONVERSATION_STOP_CHANNEL,
  CONVERSATION_THREAD_SEARCH_CHANNEL,
  CONVERSATION_THREAD_SELECT_CHANNEL,
  isConversationActionResult,
  isConversationStateSnapshot,
  type ConversationActionResult,
  type ConversationStateSnapshot,
} from '@/shared/conversation';

type StateChangedHandler = (
  event: IpcRendererEvent,
  snapshot: unknown,
) => void;

export type IpcRendererBoundary = Readonly<{
  invoke: (channel: string, ...args: readonly unknown[]) => Promise<unknown>;
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
  getCommandApprovalState:
    async (): Promise<CommandApprovalStateSnapshot> => {
      const snapshot: unknown = await ipcRenderer.invoke(
        COMMAND_APPROVAL_STATE_GET_CHANNEL,
      );
      if (!isCommandApprovalStateSnapshot(snapshot)) {
        throw new Error(
          'Main returned an invalid command approval state snapshot.',
        );
      }
      return snapshot;
    },
  onCommandApprovalStateChanged: (listener) => {
    const handleStateChanged = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isCommandApprovalStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(
      COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
      handleStateChanged,
    );
    return () => {
      ipcRenderer.removeListener(
        COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
        handleStateChanged,
      );
    };
  },
  approveCommand: async (
    presentationId: string,
  ): Promise<CommandApprovalActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      COMMAND_APPROVAL_APPROVE_CHANNEL,
      presentationId,
    );
    if (!isCommandApprovalActionResult(result)) {
      throw new Error('Main returned an invalid command approval result.');
    }
    return result;
  },
  denyCommand: async (
    presentationId: string,
  ): Promise<CommandApprovalActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      COMMAND_APPROVAL_DENY_CHANNEL,
      presentationId,
    );
    if (!isCommandApprovalActionResult(result)) {
      throw new Error('Main returned an invalid command approval result.');
    }
    return result;
  },
  getConversationState:
    async (): Promise<ConversationStateSnapshot> => {
      const snapshot: unknown = await ipcRenderer.invoke(
        CONVERSATION_STATE_GET_CHANNEL,
      );
      if (!isConversationStateSnapshot(snapshot)) {
        throw new Error(
          'Main returned an invalid conversation state snapshot.',
        );
      }
      return snapshot;
    },
  onConversationStateChanged: (listener) => {
    const handleStateChanged = (
      _event: IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isConversationStateSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(CONVERSATION_STATE_CHANGED_CHANNEL, handleStateChanged);
    return () => {
      ipcRenderer.removeListener(
        CONVERSATION_STATE_CHANGED_CHANNEL,
        handleStateChanged,
      );
    };
  },
  sendConversationMessage: async (
    input: string,
  ): Promise<ConversationActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      CONVERSATION_SEND_CHANNEL,
      input,
    );
    if (!isConversationActionResult(result)) {
      throw new Error('Main returned an invalid conversation send result.');
    }
    return result;
  },
  stopConversationTurn:
    async (): Promise<ConversationActionResult> => {
      const result: unknown = await ipcRenderer.invoke(
        CONVERSATION_STOP_CHANNEL,
      );
      if (!isConversationActionResult(result)) {
        throw new Error('Main returned an invalid conversation stop result.');
      }
      return result;
    },
  searchConversationThreads: async (
    query: string,
  ): Promise<ConversationActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      CONVERSATION_THREAD_SEARCH_CHANNEL,
      query,
    );
    if (!isConversationActionResult(result)) {
      throw new Error('Main returned an invalid Thread search result.');
    }
    return result;
  },
  selectConversationThread: async (
    threadId: string,
  ): Promise<ConversationActionResult> => {
    const result: unknown = await ipcRenderer.invoke(
      CONVERSATION_THREAD_SELECT_CHANNEL,
      threadId,
    );
    if (!isConversationActionResult(result)) {
      throw new Error('Main returned an invalid Thread selection result.');
    }
    return result;
  },
});
