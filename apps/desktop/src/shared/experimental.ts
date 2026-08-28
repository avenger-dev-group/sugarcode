export const EXPERIMENTAL_GOAL_POWER_SAVE_SET_CHANNEL =
  'sugarcode:experimental-goal-power-save-set';

export type ExperimentalApi = Readonly<{
  setGoalPowerSaveEnabled: (enabled: boolean) => Promise<boolean>;
}>;
