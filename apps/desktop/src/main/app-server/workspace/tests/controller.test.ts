import type {
  ConnectionStateSnapshot,
} from '@/shared/connection';
import type {
  ConversationStateSnapshot,
} from '@/shared/conversation';
import type { BrowserWindow, Dialog } from 'electron';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionSupervisor } from '../../connection/supervisor';
import { WorkspaceController } from '../controller';

const temporaryRoots: string[] = [];

const createFixture = async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'sugarcode-workspace-controller-'),
  );
  temporaryRoots.push(temporaryRoot);
  const workspace = path.join(temporaryRoot, 'selected-workspace');
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const sessionPath = path.join(temporaryRoot, 'state', 'workspace.json');
  let connectionListener:
    | ((snapshot: ConnectionStateSnapshot) => void)
    | undefined;
  let conversationListener:
    | ((snapshot: ConversationStateSnapshot) => void)
    | undefined;
  const supervisor = {
    subscribe: vi.fn((listener) => {
      connectionListener = listener;
      return vi.fn();
    }),
    conversation: {
      subscribe: vi.fn((listener) => {
        conversationListener = listener;
        return vi.fn();
      }),
    },
    configureInitialWorkspace: vi.fn(() => true),
    getWorkspaceSwitchBlock: vi.fn(() => null),
    switchWorkspace: vi.fn(async () => true),
    listWorkspace: vi.fn(async (requestedPath: string) => ({
      path: requestedPath,
      entries: [],
    })),
    inspectWorkspace: vi.fn(async (requestedPath: string) => ({
      status: 'complete',
      path: requestedPath,
      content: 'fixture\n',
      bytes: 8,
      lines: 1,
      hasUtf8Bom: false,
    })),
  } as unknown as ConnectionSupervisor;
  const dialog = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: [workspace],
    })),
    showMessageBox: vi.fn(async () => ({
      response: 0,
      checkboxChecked: false,
    })),
  } as unknown as Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>;
  const beforeWorkspaceSwitch = vi.fn(async () => undefined);
  const controller = new WorkspaceController({
    supervisor,
    dialog,
    getMainWindow: () => ({}) as BrowserWindow,
    sessionPath,
    beforeWorkspaceSwitch,
  });
  return {
    beforeWorkspaceSwitch,
    connectionListener: () => connectionListener,
    canonicalWorkspace,
    controller,
    conversationListener: () => conversationListener,
    dialog,
    sessionPath,
    supervisor,
    temporaryRoot,
    workspace,
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

describe('WorkspaceController', () => {
  it('uses the native picker, persists the canonical root, and exposes only its name', async () => {
    const fixture = await createFixture();

    await expect(fixture.controller.select()).resolves.toEqual({
      accepted: true,
    });

    expect(fixture.supervisor.switchWorkspace).toHaveBeenCalledWith(
      fixture.canonicalWorkspace,
    );
    expect(fixture.beforeWorkspaceSwitch).toHaveBeenCalledOnce();
    expect(
      fixture.beforeWorkspaceSwitch.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(fixture.supervisor.switchWorkspace).mock
        .invocationCallOrder[0],
    );
    expect(fixture.controller.getSnapshot()).toMatchObject({
      generation: 1,
      name: 'selected-workspace',
      status: 'ready',
    });
    expect(fixture.controller.getSnapshot()).not.toHaveProperty('path');
    await expect(readFile(fixture.sessionPath, 'utf8')).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        path: fixture.canonicalWorkspace,
      })}\n`,
    );
  });

  it('restores the exact workspace and Thread before the sidecar starts', async () => {
    const fixture = await createFixture();
    const threadId = 'thr_0000000000000042';
    await mkdir(path.dirname(fixture.sessionPath), { recursive: true });
    await writeFile(
      fixture.sessionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        path: fixture.workspace,
        threadId,
      })}\n`,
      'utf8',
    );

    await fixture.controller.restore();

    expect(
      fixture.supervisor.configureInitialWorkspace,
    ).toHaveBeenCalledWith(fixture.canonicalWorkspace, threadId);
    expect(fixture.controller.getSnapshot()).toMatchObject({
      generation: 1,
      status: 'selecting',
    });
    fixture.connectionListener()?.({
      revision: 1,
      status: 'ready',
    });
    expect(fixture.controller.getSnapshot().status).toBe('ready');
  });

  it('rejects linked roots and stale browser requests without calling the sidecar', async () => {
    const fixture = await createFixture();
    const linkedWorkspace = path.join(fixture.temporaryRoot, 'linked-workspace');
    await symlink(fixture.workspace, linkedWorkspace, 'dir');
    vi.mocked(fixture.dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: [linkedWorkspace],
    });

    await expect(fixture.controller.select()).resolves.toEqual({
      accepted: false,
      reason: 'invalid',
    });
    await expect(
      fixture.controller.list({ generation: 99, path: '' }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'stale',
    });
    expect(fixture.supervisor.switchWorkspace).not.toHaveBeenCalled();
    expect(fixture.supervisor.listWorkspace).not.toHaveBeenCalled();
  });

  it('persists the active Thread and keeps browser responses generation-bound', async () => {
    const fixture = await createFixture();
    await fixture.controller.select();
    fixture.conversationListener()?.({
      revision: 1,
      phase: 'ready',
      threadId: 'thr_0000000000000064',
      turns: [],
      navigator: {
        status: 'ready',
        activeThreadIds: ['thr_0000000000000064'],
        activeTruncated: false,
        search: {
          query: '',
          status: 'idle',
          threadIds: [],
          truncated: false,
        },
      },
    });

    await vi.waitFor(async () => {
      const stored = await readFile(fixture.sessionPath, 'utf8');
      expect(stored).toContain('"threadId":"thr_0000000000000064"');
    });
    await expect(
      fixture.controller.inspect({
        generation: fixture.controller.getSnapshot().generation,
        path: 'notes.txt',
      }),
    ).resolves.toMatchObject({
      accepted: true,
      generation: 1,
      document: {
        status: 'complete',
        path: 'notes.txt',
      },
    });
  });
});
