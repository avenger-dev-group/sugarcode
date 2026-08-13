import type {
  UpdateActionResult,
  UpdateStateSnapshot,
} from '@/shared/update';

export const checkUpdate = (): Promise<UpdateActionResult> =>
  window.sugarcode.checkUpdate();

export const getUpdateState = (): Promise<UpdateStateSnapshot> =>
  window.sugarcode.getUpdateState();

export const onUpdateStateChanged = (
  listener: (snapshot: UpdateStateSnapshot) => void,
): (() => void) => window.sugarcode.onUpdateStateChanged(listener);

export const installUpdate = (): Promise<UpdateActionResult> =>
  window.sugarcode.installUpdate();

export const openUpdateDownloadPage = (): Promise<UpdateActionResult> =>
  window.sugarcode.openUpdateDownloadPage();
