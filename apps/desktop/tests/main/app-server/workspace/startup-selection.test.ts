import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow } from 'electron';

import type { ConnectionSupervisor } from '../../../../src/main/app-server/connection/supervisor.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(
          `../../../../src/${specifier.slice(2)}.ts`,
          import.meta.url,
        ).href,
      };
    }
    if (
      specifier.startsWith('.') &&
      !specifier.split('/').at(-1)?.includes('.') &&
      context.parentURL
    ) {
      return {
        shortCircuit: true,
        url: new URL(`${specifier}.ts`, context.parentURL).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { WorkspaceController } = await import(
  '../../../../src/main/app-server/workspace/controller.ts'
);

test('cold startup restores navigation without selecting or reordering projects', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sugarcode-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project-alpha');
  const newerProjectPath = path.join(root, 'project-beta');
  const importedProjectPath = path.join(root, 'project-gamma');
  const chatRootPath = path.join(root, 'chats');
  const chatDirectory = path.join(chatRootPath, '2026-08-03', 'chat-a');
  const sessionPath = path.join(root, 'workspace-session.json');
  await Promise.all([
    mkdir(projectPath, { recursive: true }),
    mkdir(newerProjectPath, { recursive: true }),
    mkdir(importedProjectPath, { recursive: true }),
    mkdir(chatDirectory, { recursive: true }),
  ]);
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      schemaVersion: 2,
      projects: [
        {
          id: 'project-alpha',
          path: projectPath,
          name: 'project-alpha',
          threadIds: ['thr_project'],
          lastOpenedAtMs: 1,
        },
        {
          id: 'project-beta',
          path: newerProjectPath,
          name: 'project-beta',
          threadIds: [],
          lastOpenedAtMs: 2,
        },
      ],
      active: { kind: 'project', projectId: 'project-beta' },
      chats: [
        {
          threadId: 'thr_chat',
          directory: chatDirectory,
          title: 'Saved chat',
        },
      ],
    })}\n`,
    'utf8',
  );

  let configuredWorkspace = false;
  const supervisor = {
    subscribe: (): (() => void) => () => undefined,
    configureInitialWorkspace: (): boolean => {
      configuredWorkspace = true;
      return true;
    },
    getWorkspaceSwitchBlock: (): null => null,
    switchWorkspace: async (): Promise<boolean> => true,
    getWorkspaceBindingId: (): null => null,
  } as unknown as ConnectionSupervisor;
  const controller = new WorkspaceController({
    supervisor,
    dialog: {
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: [importedProjectPath],
      }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    getMainWindow: () => ({}) as BrowserWindow,
    sessionPath,
    chatRootPath,
  });

  await controller.restore();

  const snapshot = controller.getSnapshot();
  assert.equal(configuredWorkspace, false);
  assert.equal(controller.getLaunchContext(), null);
  assert.equal(snapshot.status, 'unselected');
  assert.equal(snapshot.kind, undefined);
  assert.equal(snapshot.activeProjectId, undefined);
  assert.deepEqual(snapshot.projects, [
    {
      id: 'project-beta',
      name: 'project-beta',
      threadIds: [],
      lastOpenedAtMs: 2,
    },
    {
      id: 'project-alpha',
      name: 'project-alpha',
      threadIds: ['thr_project'],
      lastOpenedAtMs: 1,
    },
  ]);
  assert.deepEqual(snapshot.chatThreadIds, ['thr_chat']);
  assert.equal(snapshot.chatTitles?.thr_chat, 'Saved chat');

  assert.equal((await controller.activateProject('project-alpha')).accepted, true);
  assert.deepEqual(
    controller.getSnapshot().projects?.map((project) => project.id),
    ['project-beta', 'project-alpha'],
  );

  assert.equal((await controller.select()).accepted, true);
  assert.equal(controller.getSnapshot().projects?.[0]?.name, 'project-gamma');
});
