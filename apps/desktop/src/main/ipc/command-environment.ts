import { ipcMain } from 'electron';

import type { RuntimeCommandEnvironmentController } from '@/main/runtime/command-environment-controller';
import {
  COMMAND_ENVIRONMENT_GET_CHANNEL,
  COMMAND_ENVIRONMENT_PROFILE_CHANNEL,
  COMMAND_ENVIRONMENT_REFRESH_CHANNEL,
  TASK_WORKSPACE_GET_CHANNEL,
  TASK_WORKSPACE_SET_CHANNEL,
} from '@/shared/command-environment';
import {
  isTrustedIpcSender,
  type IpcSenderValidationOptions,
} from './trusted-sender';

type CommandEnvironmentIpcOptions = IpcSenderValidationOptions &
  Readonly<{ controller: RuntimeCommandEnvironmentController }>;

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

export const registerCommandEnvironmentIpc = (
  options: CommandEnvironmentIpcOptions,
): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('Command environment request came from an untrusted frame.');
    }
  };
  ipcMain.handle(COMMAND_ENVIRONMENT_GET_CHANNEL, (event, value: unknown) => {
    trusted(event);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('workspaceId' in value) ||
      !isIdentifier(value.workspaceId) ||
      ('threadId' in value &&
        value.threadId !== undefined &&
        !isIdentifier(value.threadId))
    ) {
      throw new Error('Command environment target was invalid.');
    }
    return options.controller.inspect({
      workspaceId: value.workspaceId,
      ...('threadId' in value && isIdentifier(value.threadId)
        ? { threadId: value.threadId }
        : {}),
    });
  });
  ipcMain.handle(COMMAND_ENVIRONMENT_REFRESH_CHANNEL, (event, value: unknown) => {
    trusted(event);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('workspaceId' in value) ||
      !('threadId' in value) ||
      !isIdentifier(value.workspaceId) ||
      !isIdentifier(value.threadId)
    ) {
      throw new Error('Command environment refresh request was invalid.');
    }
    return options.controller.refresh({
      workspaceId: value.workspaceId,
      threadId: value.threadId,
    });
  });
  ipcMain.handle(COMMAND_ENVIRONMENT_PROFILE_CHANNEL, (event, value: unknown) => {
    trusted(event);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('enabled' in value) ||
      typeof value.enabled !== 'boolean' ||
      ('workspaceId' in value &&
        value.workspaceId !== undefined &&
        !isIdentifier(value.workspaceId)) ||
      ('threadId' in value &&
        value.threadId !== undefined &&
        !isIdentifier(value.threadId))
    ) {
      throw new Error('Command environment profile request was invalid.');
    }
    return options.controller.setProfileLoading({
      enabled: value.enabled,
      ...('workspaceId' in value && isIdentifier(value.workspaceId)
        ? { workspaceId: value.workspaceId }
        : {}),
      ...('threadId' in value && isIdentifier(value.threadId)
        ? { threadId: value.threadId }
        : {}),
    });
  });
  ipcMain.handle(TASK_WORKSPACE_GET_CHANNEL, (event, value: unknown) => {
    trusted(event);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('workspaceId' in value) ||
      !('threadId' in value) ||
      !isIdentifier(value.workspaceId) ||
      !isIdentifier(value.threadId)
    ) {
      throw new Error('Task workspace request was invalid.');
    }
    return options.controller.inspectTaskWorkspace({
      workspaceId: value.workspaceId,
      threadId: value.threadId,
    });
  });
  ipcMain.handle(TASK_WORKSPACE_SET_CHANNEL, (event, value: unknown) => {
    trusted(event);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('workspaceId' in value) ||
      !('threadId' in value) ||
      !('mode' in value) ||
      !isIdentifier(value.workspaceId) ||
      !isIdentifier(value.threadId) ||
      (value.mode !== 'local' && value.mode !== 'worktree')
    ) {
      throw new Error('Task workspace mode request was invalid.');
    }
    return options.controller.setTaskWorkspace({
      workspaceId: value.workspaceId,
      threadId: value.threadId,
      mode: value.mode,
    });
  });
  return () => {
    ipcMain.removeHandler(COMMAND_ENVIRONMENT_GET_CHANNEL);
    ipcMain.removeHandler(COMMAND_ENVIRONMENT_REFRESH_CHANNEL);
    ipcMain.removeHandler(COMMAND_ENVIRONMENT_PROFILE_CHANNEL);
    ipcMain.removeHandler(TASK_WORKSPACE_GET_CHANNEL);
    ipcMain.removeHandler(TASK_WORKSPACE_SET_CHANNEL);
  };
};
