import type {
  BrowserWindow,
  Dialog,
  OpenDialogOptions,
  SaveDialogOptions,
} from 'electron';
import { randomUUID } from 'node:crypto';

import {
  isSkillId,
  type SkillContent,
  type SkillsActionResult,
  type SkillsInspection,
} from '../../shared/skills.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

type SkillsWorkspace = Readonly<{
  workspaceId: string;
}>;

type RuntimeSkillsControllerOptions = Readonly<{
  runtime: RuntimeSupervisor;
  dialog: Pick<Dialog, 'showOpenDialog'> &
    Partial<Pick<Dialog, 'showSaveDialog'>>;
  getMainWindow: () => BrowserWindow | null;
  getWorkspace: () => SkillsWorkspace | null;
}>;

const failed = (error: unknown): SkillsActionResult => ({
  accepted: false,
  reason:
    error instanceof Error &&
    /already exists|already contains/u.test(error.message)
      ? 'conflict'
      : 'unavailable',
  message: error instanceof Error ? error.message : 'Skills are unavailable.',
});

export class RuntimeSkillsController {
  private readonly options: RuntimeSkillsControllerOptions;

  constructor(options: RuntimeSkillsControllerOptions) {
    this.options = options;
  }

  private workspaceId = (): string | undefined =>
    this.options.getWorkspace()?.workspaceId;

  inspect = async (): Promise<SkillsInspection> => {
    const event = await this.options.runtime.request(
      {
        type: 'skills.inspect',
        requestId: randomUUID(),
        workspaceId: this.workspaceId(),
      },
      'skills.inspection',
    );
    return event.inspection;
  };

  content = async (
    skillId: unknown,
    expectedSha256: unknown,
  ): Promise<SkillContent> => {
    if (
      !isSkillId(skillId) ||
      typeof expectedSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(expectedSha256)
    ) {
      throw new Error('The Skill content request was invalid.');
    }
    const event = await this.options.runtime.request(
      {
        type: 'skills.content',
        requestId: randomUUID(),
        workspaceId: this.workspaceId(),
        skillId,
        expectedSha256,
      },
      'skills.content',
    );
    return event.content;
  };

  setEnabled = async (
    skillId: unknown,
    enabled: unknown,
  ): Promise<SkillsActionResult> => {
    if (!isSkillId(skillId) || typeof enabled !== 'boolean') {
      return { accepted: false, reason: 'invalid' };
    }
    try {
      const event = await this.options.runtime.request(
        {
          type: 'skills.setEnabled',
          requestId: randomUUID(),
          workspaceId: this.workspaceId(),
          skillId,
          enabled,
        },
        'skills.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  import = async (): Promise<SkillsActionResult> => {
    const selected = await this.pickDirectory({
      title: '选择包含 SKILL.md 的 Skill 目录',
      buttonLabel: '导入 Skill',
      properties: ['openDirectory'],
    });
    if (!selected) {
      return { accepted: false, reason: 'cancelled' };
    }
    try {
      const event = await this.options.runtime.request(
        {
          type: 'skills.import',
          requestId: randomUUID(),
          workspaceId: this.workspaceId(),
          sourcePath: selected,
        },
        'skills.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  export = async (skillId: unknown): Promise<SkillsActionResult> => {
    if (!isSkillId(skillId)) {
      return { accepted: false, reason: 'invalid' };
    }
    const selected = await this.pickDirectory({
      title: '选择 Skill 导出目录',
      buttonLabel: '导出 Skill',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!selected) {
      return { accepted: false, reason: 'cancelled' };
    }
    try {
      const event = await this.options.runtime.request(
        {
          type: 'skills.export',
          requestId: randomUUID(),
          workspaceId: this.workspaceId(),
          skillId,
          destinationPath: selected,
        },
        'skills.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  importZip = async (): Promise<SkillsActionResult> => {
    const selected = await this.pickDirectory({
      title: '选择 Skill ZIP',
      buttonLabel: '导入 Skill',
      properties: ['openFile'],
      filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
    });
    if (!selected) return { accepted: false, reason: 'cancelled' };
    try {
      const event = await this.options.runtime.request(
        {
          type: 'skills.importZip',
          requestId: randomUUID(),
          workspaceId: this.workspaceId(),
          archivePath: selected,
        },
        'skills.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  exportZip = async (skillId: unknown): Promise<SkillsActionResult> => {
    if (!isSkillId(skillId)) return { accepted: false, reason: 'invalid' };
    const inspection = await this.inspect();
    const skill = inspection.skills.find((candidate) => candidate.id === skillId);
    if (!skill) return { accepted: false, reason: 'invalid' };
    const destination = await this.pickSave({
      title: '导出 Skill ZIP',
      buttonLabel: '导出',
      defaultPath: `${skill.name}.zip`,
      filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
    });
    if (!destination) return { accepted: false, reason: 'cancelled' };
    try {
      const event = await this.options.runtime.request(
        {
          type: 'skills.exportZip',
          requestId: randomUUID(),
          workspaceId: this.workspaceId(),
          skillId,
          destinationPath: destination,
        },
        'skills.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  private pickDirectory = async (
    options: OpenDialogOptions,
  ): Promise<string | null> => {
    const window = this.options.getMainWindow();
    if (!window) {
      return null;
    }
    const result = await this.options.dialog.showOpenDialog(window, options);
    return result.canceled || result.filePaths.length !== 1
      ? null
      : result.filePaths[0];
  };

  private pickSave = async (options: SaveDialogOptions): Promise<string | null> => {
    const window = this.options.getMainWindow();
    if (!window || !this.options.dialog.showSaveDialog) return null;
    const result = await this.options.dialog.showSaveDialog(window, options);
    return result.canceled || !result.filePath ? null : result.filePath;
  };

}
