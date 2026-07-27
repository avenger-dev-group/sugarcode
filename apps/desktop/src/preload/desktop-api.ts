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
});
