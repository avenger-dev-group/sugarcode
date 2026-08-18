import type {
  BrowserWindow,
  Dialog,
  OpenDialogOptions,
  SaveDialogOptions,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  isSkillId,
  type SkillContent,
  type SkillsActionResult,
  type SkillsInspection,
} from '../../shared/skills.ts';
import type { WorkspaceStateSnapshot } from '../../shared/workspace.ts';
import { CURATED_SKILLS } from '../../shared/skill-market.ts';
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
  getWorkspaceState: () => WorkspaceStateSnapshot;
  tempDirectory?: string;
}>;

const execFileAsync = promisify(execFile);

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

  importZip = async (scope: unknown): Promise<SkillsActionResult> => {
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
          scope,
        },
        'skills.action',
      );
      return this.normalizeAction(event.action);
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

  installCurated = async (entryId: unknown): Promise<SkillsActionResult> => {
    if (typeof entryId !== 'string') return { accepted: false, reason: 'invalid' };
    const entry = CURATED_SKILLS.find((candidate) => candidate.id === entryId);
    if (!entry) return { accepted: false, reason: 'invalid' };
    if (!this.options.tempDirectory) {
      return { accepted: false, reason: 'unavailable', message: '临时目录不可用。' };
    }
    let stagingRoot: string | undefined;
    try {
      stagingRoot = await mkdtemp(path.join(this.options.tempDirectory, 'sugarcode-skill-'));
      await this.runGit(['init', '--quiet', stagingRoot]);
      await this.runGit(['-C', stagingRoot, 'remote', 'add', 'origin', entry.repository]);
      await this.runGit(['-C', stagingRoot, 'sparse-checkout', 'init', '--cone']);
      await this.runGit(['-C', stagingRoot, 'sparse-checkout', 'set', entry.path]);
      await this.runGit([
        '-C', stagingRoot, 'fetch', '--quiet', '--depth', '1', 'origin', entry.commit,
      ]);
      await this.runGit(['-C', stagingRoot, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
      const sourcePath = path.join(stagingRoot, ...entry.path.split('/'));
      const actualHash = await this.directorySha256(sourcePath);
      if (actualHash !== entry.directorySha256) {
        throw new Error('精选 Skill 的内容哈希与内置目录不一致，已停止安装。');
      }
      const event = await this.options.runtime.request(
        {
          type: 'skills.import',
          requestId: randomUUID(),
          workspaceId: this.workspaceId(),
          sourcePath,
          scope: 'user',
        },
        'skills.action',
      );
      return this.normalizeAction(event.action);
    } catch (error) {
      return failed(error);
    } finally {
      if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
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

  private runGit = async (argumentsValue: readonly string[]): Promise<void> => {
    await execFileAsync('git', [...argumentsValue], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  };

  private directorySha256 = async (root: string): Promise<string> => {
    const files: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) break;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        const metadata = await lstat(entryPath);
        if (metadata.isSymbolicLink()) {
          throw new Error('精选 Skill 包含符号链接，已停止安装。');
        }
        if (metadata.isDirectory()) pending.push(entryPath);
        else if (metadata.isFile()) files.push(entryPath);
        else throw new Error('精选 Skill 包含特殊文件，已停止安装。');
      }
    }
    if (files.length === 0 || files.length > 512) {
      throw new Error('精选 Skill 文件数量无效。');
    }
    const hash = createHash('sha256');
    for (const file of files.sort()) {
      hash.update(path.relative(root, file).split(path.sep).join('/'));
      hash.update('\0');
      hash.update(await readFile(file));
      hash.update('\0');
    }
    return hash.digest('hex');
  };
}
