import { dialog, ipcMain } from 'electron';
import { isSchedulesRequest, SCHEDULES_CHANNEL, SCHEDULES_CHANGED_CHANNEL, type SchedulesResult } from '../../shared/schedules.ts';
import type { WorkspaceController } from '../workspace/controller.ts';
import type { SchedulesController } from './controller.ts';
import { isTrustedIpcSender, sendToTrustedMainWindow, type IpcSenderValidationOptions } from '../ipc/trusted-sender.ts';

export const registerSchedulesIpc = (options: IpcSenderValidationOptions & {
  controller: SchedulesController;
  workspace: WorkspaceController;
}): (() => void) => {
  ipcMain.handle(SCHEDULES_CHANNEL, async (event, request: unknown): Promise<SchedulesResult> => {
    if (!isTrustedIpcSender(event, options) || !isSchedulesRequest(request)) return { accepted: false, error: '定时任务请求无效。' };
    const controller = options.controller;
    try {
      switch (request.action) {
        case 'get': break;
        case 'chooseDirectory': {
          const selection = await dialog.showOpenDialog({ title: '选择定时任务工作目录', properties: ['openDirectory', 'createDirectory'] });
          return { accepted: !selection.canceled, path: selection.filePaths[0] };
        }
        case 'save': await controller.save(request.input, request.id); break;
        case 'toggle': await controller.toggle(request.id, request.enabled); break;
        case 'remove': await controller.remove(request.id); break;
        case 'removeRun': await controller.removeRun(request.id); break;
        case 'run': await controller.runNow(request.id); break;
        case 'review': await controller.review(request.id); break;
        case 'stop': await controller.stop(request.id); break;
        case 'open': {
          const run = controller.getRun(request.id);
          if (!run?.threadId) return { accepted: false, error: '本次执行还没有可打开的对话。' };
          const navigation = await options.workspace.openScheduledTask(run.workspacePath, run.threadId, run.name);
          return { accepted: navigation.accepted, navigation, ...(navigation.accepted ? {} : { error: '无法打开执行结果，请检查工作目录是否仍然存在。' }) };
        }
      }
      return { accepted: true, snapshot: controller.getSnapshot() };
    } catch (error) {
      return { accepted: false, error: error instanceof Error ? error.message : '定时任务操作失败。' };
    }
  });
  const unsubscribe = options.controller.subscribe((snapshot) => sendToTrustedMainWindow(options, SCHEDULES_CHANGED_CHANNEL, snapshot));
  return () => { unsubscribe(); ipcMain.removeHandler(SCHEDULES_CHANNEL); };
};
