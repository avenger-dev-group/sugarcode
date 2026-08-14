import type {
  CommandEnvironmentActionResult,
  CommandEnvironmentProfileRequest,
  CommandEnvironmentRefreshRequest,
  CommandEnvironmentStatus,
  CommandEnvironmentTarget,
} from '@/shared/command-environment';

const PROFILE_LOADING_STORAGE_KEY =
  'sugarcode.desktop.command-environment.profile-loading.v1';

export const getCommandEnvironment = (
  target: CommandEnvironmentTarget,
): Promise<CommandEnvironmentStatus> =>
  window.sugarcode.getCommandEnvironment(target);

export const refreshCommandEnvironment = (
  request: CommandEnvironmentRefreshRequest,
): Promise<CommandEnvironmentActionResult> =>
  window.sugarcode.refreshCommandEnvironment(request);

export const setCommandEnvironmentProfileLoading = async (
  request: CommandEnvironmentProfileRequest,
): Promise<CommandEnvironmentActionResult> => {
  const result = await window.sugarcode.setCommandEnvironmentProfileLoading(
    request,
  );
  if (result.accepted) {
    try {
      localStorage.setItem(
        PROFILE_LOADING_STORAGE_KEY,
        request.enabled ? 'enabled' : 'disabled',
      );
    } catch {
      // Preference persistence is best-effort and never blocks the workbench.
    }
  }
  return result;
};

export const initializeCommandEnvironmentPreference = async (): Promise<void> => {
  let disabled = false;
  try {
    disabled = localStorage.getItem(PROFILE_LOADING_STORAGE_KEY) === 'disabled';
  } catch {
    return;
  }
  if (disabled) {
    await window.sugarcode.setCommandEnvironmentProfileLoading({
      enabled: false,
    });
  }
};
