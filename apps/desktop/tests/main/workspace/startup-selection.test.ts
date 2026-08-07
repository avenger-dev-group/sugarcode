import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow } from 'electron';

import type { WorkspaceRuntimeBoundary } from '../../../src/main/workspace/controller.ts';
import type {
  ConversationStateSnapshot,
  ConversationThreadProjectionSnapshot,
} from '../../../src/shared/conversation.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(
          `../../../src/${specifier.slice(2)}.ts`,
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
  '../../../src/main/workspace/controller.ts'
);
const { ThreadRegistry } = await import(
  '../../../src/main/navigation/thread-registry.ts'
);

const PROJECT_THREAD_ID = '00000000-0000-7000-8000-000000000001';
const CHAT_THREAD_ID = '00000000-0000-7000-8000-000000000002';

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
      schemaVersion: 1,
      projects: [
        {
          id: 'project-alpha',
          path: projectPath,
          name: 'project-alpha',
          threadIds: [PROJECT_THREAD_ID],
          threadTitles: {
            [PROJECT_THREAD_ID]: 'Saved project task',
          },
          lastOpenedAtMs: 1,
        },
        {
          id: 'project-beta',
          path: newerProjectPath,
          name: 'project-beta',
          threadIds: [],
          threadTitles: {},
          lastOpenedAtMs: 2,
        },
      ],
      active: { kind: 'project', projectId: 'project-beta' },
      chats: [
        {
          threadId: CHAT_THREAD_ID,
          directory: chatDirectory,
          title: 'Saved chat',
        },
      ],
    })}\n`,
    'utf8',
  );

  let configuredWorkspace = false;
  let bindingId: string | null = null;
  let preferredThreadId: string | undefined;
  let selectedThreadId: string | null = null;
  const supervisor = {
    subscribe: (): (() => void) => () => undefined,
    configureInitialWorkspace: (): boolean => {
      configuredWorkspace = true;
      return true;
    },
    getWorkspaceSwitchBlock: (): null => null,
    switchWorkspace: async (
      workspacePath: string,
      _runtimeKind: 'project' | 'chat',
      requestedThreadId?: string,
    ): Promise<boolean> => {
      preferredThreadId = requestedThreadId;
      bindingId = path.basename(workspacePath) === 'project-alpha'
        ? 'a'.repeat(64)
        : 'c'.repeat(64);
      return true;
    },
    getWorkspaceBindingId: (): string | null => bindingId,
    conversation: {
      getSnapshot: (): ConversationStateSnapshot => ({
        revision: 0,
        ...(bindingId ? { workspaceId: bindingId } : {}),
        phase: selectedThreadId ? 'ready' : 'idle',
        ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
        turns: [],
        navigator: {
          status: 'ready',
          activeThreadIds: selectedThreadId ? [selectedThreadId] : [],
          activeThreadTitles: {},
          activeTruncated: false,
          search: {
            query: '',
            status: 'idle',
            threadIds: [],
            threadTitles: {},
            truncated: false,
          },
        },
      }),
      getThreadProjection: (
        threadId: string,
      ): ConversationThreadProjectionSnapshot | null =>
        bindingId && threadId === selectedThreadId
          ? {
              revision: 1,
              workspaceId: bindingId,
              threadId,
              phase: 'ready' as const,
              turns: [],
            }
          : null,
      selectThread: async (threadId: string) => {
        selectedThreadId = threadId;
        return { accepted: true, reason: 'accepted' as const };
      },
    },
  } as unknown as WorkspaceRuntimeBoundary;
  const controller = new WorkspaceController({
    threadRegistry: new ThreadRegistry(),
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
      threadTitles: {},
      lastOpenedAtMs: 2,
    },
    {
      id: 'project-alpha',
      name: 'project-alpha',
      threadIds: [PROJECT_THREAD_ID],
      threadTitles: {
        [PROJECT_THREAD_ID]: 'Saved project task',
      },
      lastOpenedAtMs: 1,
    },
  ]);
  assert.deepEqual(snapshot.chatThreadIds, [CHAT_THREAD_ID]);
  assert.equal(snapshot.chatTitles?.[CHAT_THREAD_ID], 'Saved chat');

  assert.equal((await controller.focusTask(PROJECT_THREAD_ID)).accepted, true);
  assert.equal(preferredThreadId, PROJECT_THREAD_ID);
  assert.equal(selectedThreadId, PROJECT_THREAD_ID);
  assert.deepEqual(controller.getLaunchContext(), {
    generation: 1,
    workspaceId: 'a'.repeat(64),
    path: await realpath(projectPath),
    name: 'project-alpha',
  });
  assert.deepEqual(
    controller.getSnapshot().projects?.map((project) => project.id),
    ['project-beta', 'project-alpha'],
  );

  assert.equal((await controller.select()).accepted, true);
  assert.equal(controller.getSnapshot().projects?.[0]?.name, 'project-gamma');
  const persisted = JSON.parse(await readFile(sessionPath, 'utf8')) as {
    schemaVersion?: unknown;
    projects?: readonly {
      id: string;
      threadIds: readonly string[];
      threadTitles: Readonly<Record<string, string>>;
      workspaceId?: string;
    }[];
  };
  assert.equal(persisted.schemaVersion, 1);
  assert.deepEqual(
    persisted.projects?.find((project) => project.id === 'project-alpha'),
    {
      id: 'project-alpha',
      path: await realpath(projectPath),
      name: 'project-alpha',
      threadIds: [PROJECT_THREAD_ID],
      threadTitles: { [PROJECT_THREAD_ID]: 'Saved project task' },
      lastOpenedAtMs: 1,
      workspaceId: 'a'.repeat(64),
    },
  );
});

test('chat activation creates a dated managed directory and one atomic launch binding', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sugarcode-chat-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chatRootPath = path.join(root, 'Documents', 'SugarCode');
  const sessionPath = path.join(root, 'workspace-session.json');
  const workspaceId = 'd'.repeat(64);
  let openedPath: string | null = null;
  let releaseSwitch: () => void = () => undefined;
  const switchGate = new Promise<void>((resolve) => {
    releaseSwitch = resolve;
  });
  const supervisor = {
    subscribe: (): (() => void) => () => undefined,
    getWorkspaceSwitchBlock: (): null => null,
    switchWorkspace: async (
      workspacePath: string,
      kind: 'project' | 'chat',
    ): Promise<boolean> => {
      assert.equal(kind, 'chat');
      openedPath = workspacePath;
      await switchGate;
      return true;
    },
    getWorkspaceBindingId: (): string => workspaceId,
    conversation: {
      getSnapshot: (): ConversationStateSnapshot => ({
        revision: 0,
        phase: 'idle' as const,
        turns: [],
        navigator: {
          status: 'ready' as const,
          activeThreadIds: [],
          activeThreadTitles: {},
          activeTruncated: false,
          runningThreadIds: [],
          search: {
            query: '',
            status: 'idle' as const,
            threadIds: [],
            threadTitles: {},
            truncated: false,
          },
        },
      }),
    },
  } as unknown as WorkspaceRuntimeBoundary;
  const controller = new WorkspaceController({
    threadRegistry: new ThreadRegistry(),
    supervisor,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    getMainWindow: () => ({}) as BrowserWindow,
    sessionPath,
    chatRootPath,
    now: () => new Date(2026, 7, 7, 9, 10, 11),
    randomId: () => 'fixture-id',
  });

  const activation = controller.activateChat({});
  assert.deepEqual(await controller.activateChat({}), {
    accepted: false,
    reason: 'busy',
  });
  releaseSwitch();
  assert.equal((await activation).accepted, true);
  const expectedPath = await realpath(
    path.join(chatRootPath, '2026-08-07', 'chat-091011-fixture-id'),
  );
  assert.equal(openedPath, expectedPath);
  assert.deepEqual(controller.getLaunchContext(), {
    generation: 1,
    workspaceId,
    path: expectedPath,
    name: '聊天文件',
  });
});
