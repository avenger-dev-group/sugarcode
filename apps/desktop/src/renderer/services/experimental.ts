const GOAL_POWER_SAVE_STORAGE_KEY = 'sugarcode.experimental.goalPowerSave.v1';

export const storedGoalPowerSaveEnabled = (): boolean =>
  localStorage.getItem(GOAL_POWER_SAVE_STORAGE_KEY) === 'enabled';

export const setGoalPowerSaveEnabled = async (enabled: boolean): Promise<void> => {
  await window.sugarcode.setGoalPowerSaveEnabled(enabled);
  localStorage.setItem(
    GOAL_POWER_SAVE_STORAGE_KEY,
    enabled ? 'enabled' : 'disabled',
  );
};

export const initializeExperimentalPreferences = async (): Promise<void> => {
  await window.sugarcode.setGoalPowerSaveEnabled(storedGoalPowerSaveEnabled());
};
