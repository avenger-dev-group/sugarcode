import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow } from 'electron';

import type { ConnectionSupervisor } from '../../../../src/main/app-server/connection/supervisor.ts';
import type { ConversationStateSnapshot } from '../../../../src/shared/conversation.ts';

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
const { ThreadRegistry } = await import(
  '../../../../src/main/app-server/thread-registry.ts'
);

const PROJECT_THREAD_ID = '00000000-0000-7000-8000-000000000001';
const CHAT_THREAD_ID = '00000000-0000-7000-8000-000000000002';
const ADMIN_THREAD_ID = '00000000-0000-7000-8000-000000000003';
const PROJECT_WORKSPACE_ID = 'a'.repeat(64);
const CHAT_WORKSPACE_ID = 'b'.repeat(64);
const ADMIN_WORKSPACE_ID = 'c'.repeat(64);

const conversationSnapshot = (
  threadIds: readonly string[],
  threadId?: string,
): ConversationStateSnapshot => ({
  revision: 1,
  phase: threadId ? 'ready' : 'idle',
  ...(threadId ? { threadId } : {}),
  turns: [],
  navigator: {
    status: 'ready',
    activeThreadIds: threadIds,
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
});

test('settling Threads keep their workspace owner during project and chat switches', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sugarcode-ownership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'admin');
  const chatRootPath = path.join(root, 'chats');
  const misplacedChatDirectory = path.join(
    chatRootPath,
    '2026-08-03',
    'misplaced-project-thread',
  );
  const sessionPath = path.join(root, 'workspace-session.json');
  await Promise.all([
    mkdir(projectPath, { recursive: true }),
    mkdir(chatRootPath, { recursive: true }),
    mkdir(misplacedChatDirectory, { recursive: true }),
  ]);
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          id: 'project-admin',
          path: projectPath,
          name: 'admin',
          threadIds: [],
          threadTitles: {},
          lastOpenedAtMs: 1,
          workspaceId: PROJECT_WORKSPACE_ID,
        },
      ],
      active: { kind: 'project', projectId: 'project-admin' },
      chats: [
        {
          threadId: PROJECT_THREAD_ID,
          directory: misplacedChatDirectory,
          workspaceId: PROJECT_WORKSPACE_ID,
        },
      ],
    })}\n`,
    'utf8',
  );

  const threadRegistry = new ThreadRegistry();
  let bindingId: string | null = null;
  let switchingFromProject = false;
  let switchingFromChat = false;
  const supervisor = {
    subscribe: (): (() => void) => () => undefined,
    getWorkspaceSwitchBlock: (): null => null,
    getWorkspaceBindingId: (): string | null => bindingId,
    switchWorkspace: async (
      _workspacePath: string,
      kind: 'project' | 'chat',
    ): Promise<boolean> => {
      if (kind === 'chat') {
        switchingFromProject = true;
        threadRegistry.replaceWorkspaceIndex(PROJECT_WORKSPACE_ID, [
          { id: PROJECT_THREAD_ID, workspaceId: PROJECT_WORKSPACE_ID },
        ]);
        bindingId = CHAT_WORKSPACE_ID;
        threadRegistry.replaceWorkspaceIndex(CHAT_WORKSPACE_ID, []);
      } else if (bindingId === CHAT_WORKSPACE_ID) {
        switchingFromChat = true;
        threadRegistry.replaceWorkspaceIndex(CHAT_WORKSPACE_ID, [
          { id: CHAT_THREAD_ID, workspaceId: CHAT_WORKSPACE_ID },
        ]);
        bindingId = PROJECT_WORKSPACE_ID;
        threadRegistry.replaceWorkspaceIndex(PROJECT_WORKSPACE_ID, [
          { id: PROJECT_THREAD_ID, workspaceId: PROJECT_WORKSPACE_ID },
        ]);
      } else {
        bindingId = PROJECT_WORKSPACE_ID;
        threadRegistry.replaceWorkspaceIndex(PROJECT_WORKSPACE_ID, [
          { id: PROJECT_THREAD_ID, workspaceId: PROJECT_WORKSPACE_ID },
        ]);
      }
      return true;
    },
    conversation: {
      getSnapshot: () => conversationSnapshot([]),
    },
  } as unknown as ConnectionSupervisor;

  const controller = new WorkspaceController({
    threadRegistry,
    supervisor,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    getMainWindow: () => ({}) as BrowserWindow,
    sessionPath,
    chatRootPath,
    now: () => new Date('2026-08-04T12:00:00Z'),
    randomId: () => 'ownership-test',
  });

  await controller.restore();
  assert.equal(
    (await controller.activateProject('project-admin')).accepted,
    true,
  );
  assert.equal((await controller.activateChat({})).accepted, true);
  assert.equal(switchingFromProject, true);
  assert.deepEqual(
    controller.getSnapshot().projects?.[0]?.threadIds,
    [PROJECT_THREAD_ID],
  );
  assert.deepEqual(controller.getSnapshot().chatThreadIds, []);

  assert.equal(
    (await controller.activateProject('project-admin')).accepted,
    true,
  );
  assert.equal(switchingFromChat, true);
  assert.deepEqual(
    controller.getSnapshot().projects?.[0]?.threadIds,
    [PROJECT_THREAD_ID],
  );
  assert.deepEqual(controller.getSnapshot().chatThreadIds, [CHAT_THREAD_ID]);
});

test('a settling web Thread cannot be copied into admin before a new admin Thread starts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sugarcode-project-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webPath = path.join(root, 'web');
  const adminPath = path.join(root, 'admin');
  const chatRootPath = path.join(root, 'chats');
  const sessionPath = path.join(root, 'workspace-session.json');
  await Promise.all([
    mkdir(webPath, { recursive: true }),
    mkdir(adminPath, { recursive: true }),
    mkdir(chatRootPath, { recursive: true }),
  ]);
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          id: 'project-web',
          path: webPath,
          name: 'web',
          threadIds: [],
          threadTitles: {},
          lastOpenedAtMs: 2,
          workspaceId: PROJECT_WORKSPACE_ID,
        },
        {
          id: 'project-admin',
          path: adminPath,
          name: 'admin',
          threadIds: [],
          threadTitles: {},
          lastOpenedAtMs: 1,
          workspaceId: ADMIN_WORKSPACE_ID,
        },
      ],
      active: { kind: 'project', projectId: 'project-web' },
      chats: [],
    })}\n`,
    'utf8',
  );

  const threadRegistry = new ThreadRegistry();
  let bindingId: string | null = null;
  const supervisor = {
    subscribe: (): (() => void) => () => undefined,
    getWorkspaceSwitchBlock: (): null => null,
    getWorkspaceBindingId: (): string | null => bindingId,
    switchWorkspace: async (workspacePath: string): Promise<boolean> => {
      if (path.basename(workspacePath) === 'web') {
        bindingId = PROJECT_WORKSPACE_ID;
        threadRegistry.replaceWorkspaceIndex(PROJECT_WORKSPACE_ID, []);
        return true;
      }

      assert.equal(path.basename(workspacePath), 'admin');
      threadRegistry.replaceWorkspaceIndex(PROJECT_WORKSPACE_ID, [
        { id: PROJECT_THREAD_ID, workspaceId: PROJECT_WORKSPACE_ID },
      ]);
      bindingId = ADMIN_WORKSPACE_ID;
      threadRegistry.replaceWorkspaceIndex(ADMIN_WORKSPACE_ID, []);
      return true;
    },
    conversation: {
      getSnapshot: () => conversationSnapshot([]),
    },
  } as unknown as ConnectionSupervisor;
  const controller = new WorkspaceController({
    threadRegistry,
    supervisor,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    getMainWindow: () => ({}) as BrowserWindow,
    sessionPath,
    chatRootPath,
  });

  await controller.restore();
  assert.equal(
    (await controller.activateProject('project-web')).accepted,
    true,
  );
  assert.equal(
    (await controller.activateProject('project-admin')).accepted,
    true,
  );
  threadRegistry.replaceWorkspaceIndex(ADMIN_WORKSPACE_ID, [
    { id: ADMIN_THREAD_ID, workspaceId: ADMIN_WORKSPACE_ID },
  ]);

  const projects = controller.getSnapshot().projects ?? [];
  assert.deepEqual(
    projects.find((project) => project.id === 'project-web')?.threadIds,
    [PROJECT_THREAD_ID],
  );
  assert.deepEqual(
    projects.find((project) => project.id === 'project-admin')?.threadIds,
    [ADMIN_THREAD_ID],
  );

  threadRegistry.updateTitle(
    PROJECT_WORKSPACE_ID,
    PROJECT_THREAD_ID,
    '确认当前项目',
  );
  const titledProjects = controller.getSnapshot().projects ?? [];
  assert.equal(
    titledProjects.find((project) => project.id === 'project-web')
      ?.threadTitles[PROJECT_THREAD_ID],
    '确认当前项目',
  );
  assert.equal(
    titledProjects.find((project) => project.id === 'project-admin')
      ?.threadTitles[PROJECT_THREAD_ID],
    undefined,
  );
});

test('an unavailable chat can be permanently deleted without activating it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sugarcode-delete-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'admin');
  const chatRootPath = path.join(root, 'chats');
  const chatDirectory = path.join(chatRootPath, '2026-08-04', 'broken-chat');
  const sessionPath = path.join(root, 'workspace-session.json');
  await Promise.all([
    mkdir(projectPath, { recursive: true }),
    mkdir(chatDirectory, { recursive: true }),
  ]);
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          id: 'project-admin',
          path: projectPath,
          name: 'admin',
          threadIds: [],
          threadTitles: {},
          lastOpenedAtMs: 1,
          workspaceId: PROJECT_WORKSPACE_ID,
        },
      ],
      active: {
        kind: 'chat',
        directory: chatDirectory,
        threadId: CHAT_THREAD_ID,
      },
      chats: [
        {
          threadId: CHAT_THREAD_ID,
          directory: chatDirectory,
          workspaceId: CHAT_WORKSPACE_ID,
        },
      ],
    })}\n`,
    'utf8',
  );

  const deletionAttempts: Array<
    Readonly<{ workspaceId: string; threadId: string }>
  > = [];
  const threadRegistry = new ThreadRegistry();
  const supervisor = {
    subscribe: (): (() => void) => () => undefined,
    getWorkspaceBindingId: (): null => null,
    conversation: {
      getSnapshot: () => conversationSnapshot([]),
      getThreadWorkspaceId: (): null => null,
    },
    deleteThread: async (
      workspaceId: string,
      threadId: string,
    ): Promise<'deleted' | 'missing'> => {
      deletionAttempts.push({ workspaceId, threadId });
      return workspaceId === PROJECT_WORKSPACE_ID
        ? 'deleted'
        : 'missing';
    },
  } as unknown as ConnectionSupervisor;
  const controller = new WorkspaceController({
    threadRegistry,
    supervisor,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    getMainWindow: () => ({}) as BrowserWindow,
    sessionPath,
    chatRootPath,
  });

  await controller.restore();
  assert.equal((await controller.deleteTask(CHAT_THREAD_ID)).accepted, true);
  assert.deepEqual(deletionAttempts, [
    { workspaceId: CHAT_WORKSPACE_ID, threadId: CHAT_THREAD_ID },
    { workspaceId: PROJECT_WORKSPACE_ID, threadId: CHAT_THREAD_ID },
  ]);
  assert.deepEqual(controller.getSnapshot().chatThreadIds, []);

  const persisted = JSON.parse(await readFile(sessionPath, 'utf8')) as {
    active: { kind: string; threadId?: string };
    chats: readonly { threadId: string }[];
  };
  assert.equal(persisted.active.kind, 'chat');
  assert.equal(persisted.active.threadId, undefined);
  assert.deepEqual(persisted.chats, []);
});
