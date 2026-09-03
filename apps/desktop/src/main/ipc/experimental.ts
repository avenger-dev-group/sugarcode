import { ipcMain } from 'electron';

import { EXPERIMENTAL_GOAL_POWER_SAVE_SET_CHANNEL } from '@/shared/experimental';
import type { GoalPowerSaveController } from '@/main/runtime/conversation/goals/power-save-controller';
import { isTrustedIpcSender, type IpcSenderValidationOptions } from './trusted-sender';

export const registerExperimentalIpc = (
  options: IpcSenderValidationOptions & Readonly<{ powerSave: GoalPowerSaveController }>,
): (() => void) => {
  ipcMain.handle(
    EXPERIMENTAL_GOAL_POWER_SAVE_SET_CHANNEL,
    (event, enabled: unknown) => {
      if (!isTrustedIpcSender(event, options) || typeof enabled !== 'boolean') {
        throw new Error('Invalid experimental preference update.');
      }
      options.powerSave.setEnabled(enabled);
      return enabled;
    },
  );
  return () => ipcMain.removeHandler(EXPERIMENTAL_GOAL_POWER_SAVE_SET_CHANNEL);
};
