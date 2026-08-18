import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeSkillsController } from '../../../src/main/runtime/skills-controller.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';
import type { WorkspaceStateSnapshot } from '../../../src/shared/workspace.ts';

const inspection = { skills: [], workspaceAvailable: true } as const;

const controllerFor = (
  workspace: WorkspaceStateSnapshot,
  onDialog: () => void = () => undefined,
  appVersion = '3.3.2',
): RuntimeSkillsController =>
  new RuntimeSkillsController({
    runtime: {
      request: async () => ({
        type: 'skills.inspection',
        sequence: 1,
        requestId: 'request-skills',
        inspection,
      }),
    } as unknown as RuntimeSupervisor,
    dialog: {
      showOpenDialog: async () => {
        onDialog();
        return { canceled: true, filePaths: [] };
      },
    },
    getMainWindow: () => ({}) as Electron.BrowserWindow,
    getWorkspace: () => ({ workspaceId: 'workspace-1' }),
    getWorkspaceState: () => workspace,
    getAppVersion: () => appVersion,
  });

test('Skills settings expose project import only for project workspaces', async () => {
  let dialogOpened = false;
  const chat = controllerFor(
    { revision: 1, generation: 1, status: 'ready', kind: 'chat' },
    () => {
      dialogOpened = true;
    },
  );
  assert.equal((await chat.inspect()).workspaceAvailable, false);
  assert.deepEqual(await chat.import('project'), {
    accepted: false,
    reason: 'unavailable',
    message: 'Open a project before importing a project Skill.',
  });
  assert.equal(dialogOpened, false);

  const project = controllerFor({
    revision: 2,
    generation: 2,
    status: 'ready',
    kind: 'project',
  });
  assert.equal((await project.inspect()).workspaceAvailable, true);
});

test('curated Skill installation rejects incompatible application versions before network access', async () => {
  const controller = controllerFor(
    { revision: 1, generation: 1, status: 'ready', kind: 'chat' },
    () => undefined,
    '3.3.1',
  );
  const result = await controller.installCurated('openai-test-driven-development');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'unavailable');
  assert.match(result.message ?? '', /3\.3\.2/u);
  assert.match(result.message ?? '', /3\.3\.1/u);
});
