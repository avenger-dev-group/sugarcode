import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeSkillsController } from '../../../src/main/runtime/skills-controller.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/supervisor.ts';

const inspection = { skills: [], workspaceAvailable: true } as const;

const controllerFor = (
  onDialog: () => void = () => undefined,
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
  });

test('personal Skill import opens the picker without requiring a project scope', async () => {
  let dialogOpened = false;
  const controller = controllerFor(() => {
    dialogOpened = true;
  });
  assert.equal((await controller.inspect()).workspaceAvailable, true);
  assert.deepEqual(await controller.import(), {
    accepted: false,
    reason: 'cancelled',
  });
  assert.equal(dialogOpened, true);
});
