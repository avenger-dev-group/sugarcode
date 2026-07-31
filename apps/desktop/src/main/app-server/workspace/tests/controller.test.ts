import type {
  ConnectionStateSnapshot,
} from '@/shared/connection';
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
  const chatRootPath = path.join(temporaryRoot, 'Documents', 'SugarCode');
  let connectionListener:
    | ((snapshot: ConnectionStateSnapshot) => void)
    | undefined;
  const supervisor = {
    subscribe: vi.fn((listener) => {
      connectionListener = listener;
      return vi.fn();
    }),
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
  let chatSequence = 0;
  const controller = new WorkspaceController({
    supervisor,
    dialog,
    getMainWindow: () => ({}) as BrowserWindow,
    sessionPath,
    chatRootPath,
    beforeWorkspaceSwitch,
    now: () => new Date(2026, 6, 31, 14, 5, 9),
    randomId: () =>
      `chatid${String(++chatSequence).padStart(6, '0')}`,
  });
  return {
    beforeWorkspaceSwitch,
    connectionListener: () => connectionListener,
    canonicalWorkspace,
    chatRootPath,
    controller,
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
      'project',
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
      kind: 'project',
      name: 'selected-workspace',
      projectName: 'selected-workspace',
      status: 'ready',
    });
    expect(fixture.controller.getSnapshot()).not.toHaveProperty('path');
    await expect(readFile(fixture.sessionPath, 'utf8')).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 2,
        projectPath: fixture.canonicalWorkspace,
        projectThreadIds: [],
        chatThreadIds: [],
        active: { kind: 'project' },
        chats: [],
      })}\n`,
    );
  });

  it('restores the workspace without selecting a legacy saved Thread', async () => {
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
    ).toHaveBeenCalledWith(fixture.canonicalWorkspace);
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

  it('does not persist a Thread selection and keeps browser responses generation-bound', async () => {
    const fixture = await createFixture();
    await fixture.controller.select();
    await expect(readFile(fixture.sessionPath, 'utf8')).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 2,
        projectPath: fixture.canonicalWorkspace,
        projectThreadIds: [],
        chatThreadIds: [],
        active: { kind: 'project' },
        chats: [],
      })}\n`,
    );
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

  it('opens an isolated chat folder without binding its Threads to the project', async () => {
    const fixture = await createFixture();
    await fixture.controller.select();

    await expect(fixture.controller.clear()).resolves.toEqual({
      accepted: true,
    });

    const chatDirectory = path.join(
      await realpath(fixture.chatRootPath),
      '2026-07-31',
      'chat-140509-chatid000001',
    );
    expect(fixture.supervisor.switchWorkspace).toHaveBeenLastCalledWith(
      chatDirectory,
      'chat',
      undefined,
    );
    expect(fixture.beforeWorkspaceSwitch).toHaveBeenCalledTimes(2);
    expect(fixture.controller.getSnapshot()).toMatchObject({
      revision: 4,
      generation: 2,
      status: 'ready',
      kind: 'chat',
      name: '聊天文件',
      projectName: 'selected-workspace',
      chatThreadIds: [],
    });
    await expect(realpath(chatDirectory)).resolves.toBe(chatDirectory);
    await expect(readFile(fixture.sessionPath, 'utf8')).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 2,
        projectPath: fixture.canonicalWorkspace,
        projectThreadIds: [],
        chatThreadIds: [],
        active: {
          kind: 'chat',
          directory: chatDirectory,
        },
        chats: [],
      })}\n`,
    );
  });

  it('associates a new durable chat with its prepared directory', async () => {
    const fixture = await createFixture();
    await fixture.controller.activateChat({});
    const threadId = 'thr_0000000000000042';

    fixture.controller.observeConversation({
      revision: 1,
      phase: 'ready',
      threadId,
      turns: [],
      navigator: {
        status: 'ready',
        activeThreadIds: [threadId],
        activeTruncated: false,
        search: {
          query: '',
          status: 'idle',
          threadIds: [],
          truncated: false,
        },
      },
    });

    expect(fixture.controller.getSnapshot()).toMatchObject({
      kind: 'chat',
      chatThreadIds: [threadId],
    });
    await vi.waitFor(async () => {
      expect(await readFile(fixture.sessionPath, 'utf8')).toContain(
        `"threadId":"${threadId}"`,
      );
    });

    fixture.controller.observeConversation({
      revision: 2,
      phase: 'idle',
      turns: [],
      navigator: {
        status: 'ready',
        activeThreadIds: [],
        activeTruncated: false,
        search: {
          query: '',
          status: 'idle',
          threadIds: [],
          truncated: false,
        },
      },
    });

    expect(fixture.controller.getSnapshot().chatThreadIds).toEqual([]);
    await vi.waitFor(async () => {
      const stored = JSON.parse(
        await readFile(fixture.sessionPath, 'utf8'),
      ) as {
        chatThreadIds: string[];
        chats: Array<{ threadId: string }>;
      };
      expect(stored.chatThreadIds).toEqual([]);
      expect(stored.chats).toContainEqual(
        expect.objectContaining({ threadId }),
      );
    });
  });

  it('returns from a chat to the remembered project without reopening the picker', async () => {
    const fixture = await createFixture();
    await fixture.controller.select();
    await fixture.controller.activateChat({});
    vi.mocked(fixture.dialog.showOpenDialog).mockClear();

    await expect(fixture.controller.resumeProject()).resolves.toEqual({
      accepted: true,
    });

    expect(fixture.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(fixture.supervisor.switchWorkspace).toHaveBeenLastCalledWith(
      fixture.canonicalWorkspace,
      'project',
    );
    expect(fixture.controller.getSnapshot()).toMatchObject({
      kind: 'project',
      name: 'selected-workspace',
      projectName: 'selected-workspace',
    });
  });
});
