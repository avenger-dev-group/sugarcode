import { ipcMain } from 'electron';
import { ARTIFACTS_CHANNEL, isArtifactRequest, type ArtifactResult } from '../../shared/artifacts.ts';
import type { ArtifactsController } from './controller.ts';
import { isTrustedIpcSender, type IpcSenderValidationOptions } from '../ipc/trusted-sender.ts';
export const registerArtifactsIpc = (options: IpcSenderValidationOptions & { controller: ArtifactsController }): (() => void) => {
  ipcMain.handle(ARTIFACTS_CHANNEL, async (event, request: unknown): Promise<ArtifactResult> => {
    if (!isTrustedIpcSender(event, options) || !isArtifactRequest(request)) return { accepted: false, error: '文件请求无效。' };
    try {
      switch (request.action) {
        case 'read': return { accepted: true, document: await options.controller.read(request.generation, request.path) };
        case 'save': return { accepted: true, document: await options.controller.save(request.generation, request.path, request.expectedRevision, request.edits) };
        case 'openExternal': await options.controller.openExternal(request.generation, request.path); break;
        case 'reveal': await options.controller.reveal(request.generation, request.path); break;
        case 'export': await options.controller.export(request.generation, request.path); break;
      }
      return { accepted: true };
    } catch (error) {
      return { accepted: false, error: error instanceof Error ? error.message : '文件操作失败。', conflict: (error as { code?: string }).code === 'CONFLICT' };
    }
  });
  return () => ipcMain.removeHandler(ARTIFACTS_CHANNEL);
};
