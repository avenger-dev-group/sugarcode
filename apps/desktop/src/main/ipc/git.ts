import { ipcMain, type BrowserWindow } from 'electron';

import {
  GIT_COMMIT_CHANNEL,
  GIT_DIFF_CHANNEL,
  GIT_REFRESH_CHANNEL,
  GIT_STAGE_CHANNEL,
  GIT_STATE_CHANGED_CHANNEL,
  GIT_STATE_GET_CHANNEL,
  GIT_UNSTAGE_CHANNEL,
  isGitCommitRequest,
  isGitDiffRequest,
  isGitGenerationRequest,
  isGitMutationRequest,
} from '@/shared/git';

import type { GitController } from '../git/controller';
import {
  isTrustedIpcSender,
  sendToTrustedMainWindow,
} from './trusted-sender';

type GitIpcOptions = Readonly<{
  controller: GitController;
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

export const registerGitIpc = (
  options: GitIpcOptions,
): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
    isTrustedIpcSender(event, options);
  const invalid = { accepted: false, reason: 'invalid' } as const;

  ipcMain.handle(GIT_STATE_GET_CHANNEL, (event) => {
    if (!trusted(event)) {
      throw new Error('Git state request came from an untrusted frame.');
    }
    return options.controller.getSnapshot();
  });
  ipcMain.handle(GIT_REFRESH_CHANNEL, (event, request: unknown) =>
    trusted(event) && isGitGenerationRequest(request)
      ? options.controller.refresh(request)
      : invalid,
  );
  ipcMain.handle(GIT_DIFF_CHANNEL, (event, request: unknown) =>
    trusted(event) && isGitDiffRequest(request)
      ? options.controller.diff(request)
      : invalid,
  );
  ipcMain.handle(GIT_STAGE_CHANNEL, (event, request: unknown) =>
    trusted(event) && isGitMutationRequest(request)
      ? options.controller.stage(request)
      : invalid,
  );
  ipcMain.handle(GIT_UNSTAGE_CHANNEL, (event, request: unknown) =>
    trusted(event) && isGitMutationRequest(request)
      ? options.controller.unstage(request)
      : invalid,
  );
  ipcMain.handle(GIT_COMMIT_CHANNEL, (event, request: unknown) =>
    trusted(event) && isGitCommitRequest(request)
      ? options.controller.commit(request)
      : invalid,
  );

  const unsubscribe = options.controller.subscribe((snapshot) => {
    sendToTrustedMainWindow(
      options,
      GIT_STATE_CHANGED_CHANNEL,
      snapshot,
    );
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(GIT_STATE_GET_CHANNEL);
    ipcMain.removeHandler(GIT_REFRESH_CHANNEL);
    ipcMain.removeHandler(GIT_DIFF_CHANNEL);
    ipcMain.removeHandler(GIT_STAGE_CHANNEL);
    ipcMain.removeHandler(GIT_UNSTAGE_CHANNEL);
    ipcMain.removeHandler(GIT_COMMIT_CHANNEL);
  };
};
