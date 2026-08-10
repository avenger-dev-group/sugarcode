import type { BrowserWindow, Dialog, OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  isSkillId,
  type SkillContent,
  type SkillsActionResult,
  type SkillsInspection,
} from '../../shared/skills.ts';
import type { WorkspaceStateSnapshot } from '../../shared/workspace.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

type SkillsWorkspace = Readonly<{
  workspaceId: string;
}>;

type RuntimeSkillsControllerOptions = Readonly<{
  runtime: RuntimeSupervisor;
  dialog: Pick<Dialog, 'showOpenDialog'>;
  getMainWindow: () => BrowserWindow | null;
  getWorkspace: () => SkillsWorkspace | null;
  getWorkspaceState: () => WorkspaceStateSnapshot;
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

const normalizeInspection = (
  inspection: SkillsInspection,
  workspaceAvailable: boolean,
): SkillsInspection => ({ ...inspection, workspaceAvailable });

export class RuntimeSkillsController {
  private readonly options: RuntimeSkillsControllerOptions;

  constructor(options: RuntimeSkillsControllerOptions) {
    this.options = options;
  }

  private workspaceId = (): string | undefined =>
    this.options.getWorkspace()?.workspaceId;

  private projectAvailable = (): boolean =>
    this.options.getWorkspaceState().kind === 'project' &&
    Boolean(this.workspaceId());

  private normalizeAction = (action: SkillsActionResult): SkillsActionResult =>
    action.accepted && action.inspection
      ? {
          ...action,
          inspection: normalizeInspection(
            action.inspection,
            this.projectAvailable(),
          ),
        }
      : action;

  inspect = async (): Promise<SkillsInspection> => {
    const event = await this.options.runtime.request(
      {
        type: 'skills.inspect',
        requestId: randomUUID(),
        workspaceId: this.workspaceId(),
      },
      'skills.inspection',
    );
    return normalizeInspection(event.inspection, this.projectAvailable());
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
      return this.normalizeAction(event.action);
    } catch (error) {
      return failed(error);
    }
  };

  import = async (scope: unknown): Promise<SkillsActionResult> => {
    if (scope !== 'user' && scope !== 'project') {
      return { accepted: false, reason: 'invalid' };
    }
    if (scope === 'project' && !this.projectAvailable()) {
      return {
        accepted: false,
        reason: 'unavailable',
        message: 'Open a project before importing a project Skill.',
      };
    }
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
          scope,
        },
        'skills.action',
      );
      return this.normalizeAction(event.action);
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
}
