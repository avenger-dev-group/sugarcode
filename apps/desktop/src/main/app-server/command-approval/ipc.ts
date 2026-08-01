import { ipcMain } from 'electron';

import {
  COMMAND_APPROVAL_APPROVE_CHANNEL,
  COMMAND_APPROVAL_DENY_CHANNEL,
  COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
  COMMAND_APPROVAL_STATE_GET_CHANNEL,
  COMMAND_APPROVAL_MODE_SET_CHANNEL,
} from '@/shared/command-approval';

import type { CommandApprovalController } from './controller';
import {
  getTrustedMainWindow,
  isTrustedIpcSender,
  type IpcSenderValidationOptions,
} from '../ipc/trusted-sender';

type CommandApprovalIpcOptions = IpcSenderValidationOptions &
  Readonly<{
    controller: CommandApprovalController;
  }>;

export const registerCommandApprovalIpc = (
  options: CommandApprovalIpcOptions,
): (() => void) => {
  ipcMain.handle(COMMAND_APPROVAL_STATE_GET_CHANNEL, (event) => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error(
        'Command approval state request came from an untrusted frame.',
      );
    }
    return options.controller.markSurfaceReady();
  });

  ipcMain.handle(
    COMMAND_APPROVAL_APPROVE_CHANNEL,
    async (event, presentationId: unknown, mode: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error(
          'Command approval response came from an untrusted frame.',
        );
      }
      return options.controller.approve(presentationId, mode);
    },
  );

  ipcMain.handle(
    COMMAND_APPROVAL_MODE_SET_CHANNEL,
    (event, mode: unknown, threadId?: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error(
          'Command approval mode change came from an untrusted frame.',
        );
      }
      return options.controller.setMode(mode, threadId);
    },
  );

  ipcMain.handle(
    COMMAND_APPROVAL_DENY_CHANNEL,
    async (event, presentationId: unknown) => {
      if (!isTrustedIpcSender(event, options)) {
        throw new Error(
          'Command approval response came from an untrusted frame.',
        );
      }
      return options.controller.deny(presentationId);
    },
  );

  const unsubscribe = options.controller.subscribe((snapshot) => {
    const window = getTrustedMainWindow(options);
    window?.webContents.send(
      COMMAND_APPROVAL_STATE_CHANGED_CHANNEL,
      snapshot,
    );
  });

  return () => {
    unsubscribe();
    options.controller.surfaceUnavailable();
    ipcMain.removeHandler(COMMAND_APPROVAL_STATE_GET_CHANNEL);
    ipcMain.removeHandler(COMMAND_APPROVAL_APPROVE_CHANNEL);
    ipcMain.removeHandler(COMMAND_APPROVAL_DENY_CHANNEL);
    ipcMain.removeHandler(COMMAND_APPROVAL_MODE_SET_CHANNEL);
  };
};
