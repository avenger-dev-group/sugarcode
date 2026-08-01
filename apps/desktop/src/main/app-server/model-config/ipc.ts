import { ipcMain } from 'electron';

import {
  MODEL_CONFIG_DELETE_API_KEY_CHANNEL,
  MODEL_CONFIG_GET_CHANNEL,
  MODEL_CONFIG_DISCOVER_CHANNEL,
  MODEL_CONFIG_SAVE_CHANNEL,
} from '@/shared/model-config';

import type { ModelConfigController } from './controller';
import {
  isTrustedIpcSender,
  type IpcSenderValidationOptions,
} from '../ipc/trusted-sender';

type ModelConfigIpcOptions = IpcSenderValidationOptions &
  Readonly<{ controller: ModelConfigController }>;

export const registerModelConfigIpc = (
  options: ModelConfigIpcOptions,
): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error(
        'Model configuration request came from an untrusted frame.',
      );
    }
  };
  ipcMain.handle(MODEL_CONFIG_GET_CHANNEL, (event) => {
    trusted(event);
    return options.controller.inspect();
  });
  ipcMain.handle(MODEL_CONFIG_SAVE_CHANNEL, (event, request: unknown) => {
    trusted(event);
    return options.controller.save(request);
  });
  ipcMain.handle(
    MODEL_CONFIG_DISCOVER_CHANNEL,
    (event, connectionId: unknown) => {
      trusted(event);
      return options.controller.discover(connectionId);
    },
  );
  ipcMain.handle(
    MODEL_CONFIG_DELETE_API_KEY_CHANNEL,
    (
      event,
      connectionId: unknown,
      expectedRevision: unknown,
    ) => {
      trusted(event);
      return options.controller.deleteApiKey(
        connectionId,
        expectedRevision,
      );
    },
  );
  return () => {
    for (const channel of [
      MODEL_CONFIG_GET_CHANNEL,
      MODEL_CONFIG_SAVE_CHANNEL,
      MODEL_CONFIG_DISCOVER_CHANNEL,
      MODEL_CONFIG_DELETE_API_KEY_CHANNEL,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
};
