import { ipcMain } from 'electron';

import {
  SKILLS_CONTENT_CHANNEL,
  SKILLS_EXPORT_CHANNEL,
  SKILLS_GET_CHANNEL,
  SKILLS_IMPORT_CHANNEL,
  SKILLS_IMPORT_ZIP_CHANNEL,
  SKILLS_EXPORT_ZIP_CHANNEL,
  SKILLS_SET_ENABLED_CHANNEL,
} from '@/shared/skills';
import type { RuntimeSkillsController } from '@/main/runtime/skills-controller';
import { SKILLS_MARKET_INSTALL_CHANNEL } from '@/shared/skill-market';

import {
  isTrustedIpcSender,
  type IpcSenderValidationOptions,
} from './trusted-sender';

type SkillsIpcOptions = IpcSenderValidationOptions &
  Readonly<{ controller: RuntimeSkillsController }>;

export const registerSkillsIpc = (options: SkillsIpcOptions): (() => void) => {
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isTrustedIpcSender(event, options)) {
      throw new Error('Skills request came from an untrusted frame.');
    }
  };
  ipcMain.handle(SKILLS_GET_CHANNEL, (event) => {
    trusted(event);
    return options.controller.inspect();
  });
  ipcMain.handle(
    SKILLS_CONTENT_CHANNEL,
    (event, skillId: unknown, expectedSha256: unknown) => {
      trusted(event);
      return options.controller.content(skillId, expectedSha256);
    },
  );
  ipcMain.handle(
    SKILLS_SET_ENABLED_CHANNEL,
    (event, skillId: unknown, enabled: unknown) => {
      trusted(event);
      return options.controller.setEnabled(skillId, enabled);
    },
  );
  ipcMain.handle(SKILLS_IMPORT_CHANNEL, (event, scope: unknown) => {
    trusted(event);
    return options.controller.import(scope);
  });
  ipcMain.handle(SKILLS_EXPORT_CHANNEL, (event, skillId: unknown) => {
    trusted(event);
    return options.controller.export(skillId);
  });
  ipcMain.handle(SKILLS_IMPORT_ZIP_CHANNEL, (event, scope: unknown) => {
    trusted(event);
    return options.controller.importZip(scope);
  });
  ipcMain.handle(SKILLS_EXPORT_ZIP_CHANNEL, (event, skillId: unknown) => {
    trusted(event);
    return options.controller.exportZip(skillId);
  });
  ipcMain.handle(SKILLS_MARKET_INSTALL_CHANNEL, (event, catalogId: unknown) => {
    trusted(event);
    return options.controller.installCurated(catalogId);
  });
  return () => {
    for (const channel of [
      SKILLS_GET_CHANNEL,
      SKILLS_CONTENT_CHANNEL,
      SKILLS_SET_ENABLED_CHANNEL,
      SKILLS_IMPORT_CHANNEL,
      SKILLS_EXPORT_CHANNEL,
      SKILLS_IMPORT_ZIP_CHANNEL,
      SKILLS_EXPORT_ZIP_CHANNEL,
      SKILLS_MARKET_INSTALL_CHANNEL,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
};
