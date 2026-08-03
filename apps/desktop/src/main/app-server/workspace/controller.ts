import type {
  WorkspaceChatRequest,
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceKind,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspaceSelectResult,
  WorkspaceStateSnapshot,
} from '@/shared/workspace';
import type { ConversationStateSnapshot } from '@/shared/conversation';
import type { BrowserWindow, Dialog, OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import type { ConnectionSupervisor } from '../connection/supervisor';

type DialogBoundary = Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>;

type WorkspaceControllerOptions = Readonly<{
  supervisor: ConnectionSupervisor;
  dialog: DialogBoundary;
  getMainWindow: () => BrowserWindow | null;
  sessionPath: string;
  chatRootPath: string;
  beforeWorkspaceSwitch?: () => Promise<void>;
  now?: () => Date;
  randomId?: () => string;
}>;

type Listener = (snapshot: WorkspaceStateSnapshot) => void;

export type WorkspaceLaunchContext = Readonly<{
  generation: number;
  path: string;
  name: string;
}>;

type StoredChat = Readonly<{
  threadId: string;
  directory?: string;
  workspaceId?: string;
  title?: string;
}>;

type StoredProject = Readonly<{
  id: string;
  path: string;
  name: string;
  threadIds: readonly string[];
  lastOpenedAtMs: number;
  workspaceId?: string;
}>;

type LegacyStoredSession = Readonly<{
  schemaVersion: 1;
  projectPath?: string;
  projectThreadIds?: readonly string[];
  chatThreadIds?: readonly string[];
  active:
    | Readonly<{ kind: 'project' }>
    | Readonly<{
        kind: 'chat';
        directory: string;
        threadId?: string;
      }>;
  chats: readonly StoredChat[];
}>;

type StoredSession = Readonly<{
  schemaVersion: 2;
  projects: readonly StoredProject[];
  active:
    | Readonly<{ kind: 'project'; projectId: string }>
    | Readonly<{
        kind: 'chat';
        directory: string;
        threadId?: string;
      }>;
  chats: readonly StoredChat[];
}>;

const isThreadId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 128 &&
  /^thr_[A-Za-z0-9_-]+$/u.test(value);

const sameIds = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export class WorkspaceController {
  private readonly options: WorkspaceControllerOptions;
  private readonly listeners = new Set<Listener>();
  private readonly chatDirectories = new Map<string, string>();
  private readonly chatTitles = new Map<string, string>();
  private readonly chatWorkspaceIds = new Map<string, string>();
  private revision = 0;
  private generation = 0;
  private projectPath: string | null = null;
  private activeProjectId: string | null = null;
  private readonly projects = new Map<string, StoredProject>();
  private workspacePath: string | null = null;
  private workspaceKind: WorkspaceKind | null = null;
  private activeChatThreadId: string | null = null;
  private chatThreadIds: readonly string[] = [];
  private projectThreadIds: readonly string[] = [];
  private snapshot: WorkspaceStateSnapshot = {
    revision: 0,
    generation: 0,
    status: 'unselected',
    chatThreadIds: [],
  };

  constructor(options: WorkspaceControllerOptions) {
    this.options = options;
    this.options.supervisor.subscribe((connection) => {
      if (!this.workspacePath) {
        return;
      }
      if (connection.status === 'ready') {
        this.refreshActiveProjectRecord();
        void this.persist().catch((): undefined => undefined);
        this.publish('ready');
      } else if (connection.status === 'failed') {
        this.publish(
          'failed',
          connection.diagnostic?.summary ??
            'The local CLI stopped while opening this workspace.',
        );
      }
    });
  }

  getSnapshot = (): WorkspaceStateSnapshot => this.snapshot;

  getLaunchContext = (): WorkspaceLaunchContext | null =>
    this.workspacePath && this.snapshot.status === 'ready'
      ? {
          generation: this.generation,
          path: this.workspacePath,
          name:
            this.workspaceKind === 'chat'
              ? '聊天文件'
              : path.basename(this.workspacePath),
        }
      : null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  restore = async (): Promise<void> => {
    const stored = await this.readStoredSession();
    if (!stored) {
      return;
    }
    for (const project of stored.projects) {
      const canonicalPath = await validateDirectory(project.path);
      if (!canonicalPath) {
        continue;
      }
      this.projects.set(project.id, {
        ...project,
        path: canonicalPath,
        name: path.basename(canonicalPath),
      });
    }
    this.chatThreadIds = stored.chats.map((chat) => chat.threadId);
    for (const chat of stored.chats) {
      this.chatTitles.set(chat.threadId, chat.title ?? chat.threadId);
      if (chat.workspaceId) {
        this.chatWorkspaceIds.set(chat.threadId, chat.workspaceId);
      }
      if (!chat.directory) {
        continue;
      }
      const directory = await this.validateChatDirectory(chat.directory);
      if (directory) {
        this.chatDirectories.set(chat.threadId, directory);
      }
    }
    this.publish('unselected');
  };

  select = async (): Promise<WorkspaceSelectResult> => {
    if (this.options.supervisor.getWorkspaceSwitchBlock()) {
      return { accepted: false, reason: 'busy' };
    }
    const window = this.options.getMainWindow();
    if (!window) {
      return { accepted: false, reason: 'failed' };
    }
    const options: OpenDialogOptions = {
      title: '选择 SugarCode 项目',
      buttonLabel: '打开项目',
      properties: ['openDirectory'],
    };
    const picked = await this.options.dialog.showOpenDialog(window, options);
    if (picked.canceled || picked.filePaths.length !== 1) {
      return { accepted: false, reason: 'cancelled' };
    }
    const selected = await validateDirectory(picked.filePaths[0]);
    if (!selected) {
      this.publish(
        'failed',
        'The selected directory is missing, linked, or inaccessible.',
      );
      return { accepted: false, reason: 'invalid' };
    }
    if (
      selected === this.workspacePath &&
      this.workspaceKind === 'project'
    ) {
      this.publish('ready');
      return { accepted: true };
    }
    return this.activateProjectPath(selected);
  };

  resumeProject = async (): Promise<WorkspaceSelectResult> => {
    if (!this.projectPath) {
      return { accepted: false, reason: 'failed' };
    }
    if (
      this.workspaceKind === 'project' &&
      this.workspacePath === this.projectPath
    ) {
      this.publish('ready');
      return { accepted: true };
    }
    const validated = await validateDirectory(this.projectPath);
    if (!validated) {
      this.projectPath = null;
      this.publish('failed', 'The saved project is no longer available.');
      return { accepted: false, reason: 'invalid' };
    }
    return this.activateProjectPath(validated);
  };

  activateProject = async (
    projectId: string,
  ): Promise<WorkspaceSelectResult> => {
    const project = this.projects.get(projectId);
    if (!project) {
      return { accepted: false, reason: 'invalid' };
    }
    if (
      this.workspaceKind === 'project' &&
      this.activeProjectId === projectId &&
      this.snapshot.status === 'ready'
    ) {
      return { accepted: true };
    }
    const validated = await validateDirectory(project.path);
    if (!validated) {
      this.projects.delete(projectId);
      await this.persist().catch((): undefined => undefined);
      this.publish('failed', 'The saved project is no longer available.');
      return { accepted: false, reason: 'invalid' };
    }
    return this.activateProjectPath(validated, projectId);
  };

  focusTask = async (threadId: string): Promise<WorkspaceSelectResult> => {
    const project = [...this.projects.values()].find((candidate) =>
      candidate.threadIds.includes(threadId),
    );
    if (project) {
      const activated = await this.activateProject(project.id);
      if (!activated.accepted) {
        return activated;
      }
      const selected = await this.options.supervisor.conversation.selectThread(
        threadId,
      );
      return selected.accepted
        ? { accepted: true }
        : {
            accepted: false,
            reason: selected.reason === 'turnActive' ? 'busy' : 'failed',
          };
    }
    if (this.chatThreadIds.includes(threadId)) {
      return this.activateChat({ threadId });
    }
    return { accepted: false, reason: 'invalid' };
  };

  activateChat = async (
    request: WorkspaceChatRequest,
  ): Promise<WorkspaceSelectResult> => {
    if (this.options.supervisor.getWorkspaceSwitchBlock()) {
      return { accepted: false, reason: 'busy' };
    }
    const threadId = request.threadId;
    if (
      threadId &&
      this.workspaceKind === 'chat' &&
      this.activeChatThreadId === threadId &&
      this.snapshot.status === 'ready'
    ) {
      return { accepted: true };
    }

    let directory = threadId
      ? this.chatDirectories.get(threadId) ?? null
      : null;
    if (directory) {
      directory = await this.validateChatDirectory(directory);
    }
    try {
      directory ??= await this.createChatDirectory(threadId);
    } catch {
      this.publish(
        'failed',
        'SugarCode could not prepare the chat folder under Documents.',
      );
      return { accepted: false, reason: 'failed' };
    }

    const previousPath = this.workspacePath;
    const previousKind = this.workspaceKind;
    const previousThreadId = this.activeChatThreadId;
    await this.options.beforeWorkspaceSwitch?.();
    this.workspacePath = directory;
    this.workspaceKind = 'chat';
    this.activeChatThreadId = threadId ?? null;
    this.publish('selecting');
    if (
      !(await this.options.supervisor.switchWorkspace(
        directory,
        'chat',
        threadId,
      ))
    ) {
      this.workspacePath = previousPath;
      this.workspaceKind = previousKind;
      this.activeChatThreadId = previousThreadId;
      this.publish(
        previousPath ? 'ready' : 'failed',
        'The chat runtime could not be started.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.generation += 1;
    if (threadId) {
      this.chatDirectories.set(threadId, directory);
      this.chatThreadIds = [
        threadId,
        ...this.chatThreadIds.filter((id) => id !== threadId),
      ];
    }
    try {
      await this.persist();
    } catch {
      this.publish(
        'failed',
        'The chat opened, but its restart record could not be saved.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.publish('ready');
    return { accepted: true };
  };

  clear = (): Promise<WorkspaceSelectResult> =>
    this.activateChat({});

  observeConversation = (conversation: ConversationStateSnapshot): void => {
    if (
      conversation.phase === 'unavailable' ||
      conversation.navigator.status !== 'ready'
    ) {
      return;
    }
    const nextIds = conversation.navigator.activeThreadIds;
    if (this.workspaceKind === 'project') {
      if (!sameIds(this.projectThreadIds, nextIds)) {
        this.projectThreadIds = [...nextIds];
        this.refreshActiveProjectRecord();
        if (this.snapshot.status === 'ready') {
          void this.persist().catch((): undefined => undefined);
        }
        this.publish(this.snapshot.status);
      }
      return;
    }
    if (this.workspaceKind !== 'chat') {
      return;
    }

    let changed = !sameIds(this.chatThreadIds, nextIds);
    if (changed) {
      this.chatThreadIds = [...nextIds];
    }
    if (
      conversation.threadId &&
      this.workspacePath &&
      this.activeChatThreadId !== conversation.threadId
    ) {
      this.activeChatThreadId = conversation.threadId;
      this.chatDirectories.set(conversation.threadId, this.workspacePath);
      const title =
        conversation.navigator.activeThreadTitles[conversation.threadId];
      if (title) {
        this.chatTitles.set(conversation.threadId, title);
      }
      const workspaceId = this.options.supervisor.getWorkspaceBindingId();
      if (workspaceId) {
        this.chatWorkspaceIds.set(conversation.threadId, workspaceId);
      }
      if (!this.chatThreadIds.includes(conversation.threadId)) {
        this.chatThreadIds = [
          conversation.threadId,
          ...this.chatThreadIds,
        ];
      }
      changed = true;
    }
    if (changed) {
      if (this.snapshot.status === 'ready') {
        void this.persist().catch((): undefined => undefined);
      }
      this.publish(this.snapshot.status);
    }
  };

  list = async (
    request: WorkspaceListRequest,
  ): Promise<WorkspaceListResult> => {
    if (
      request.generation !== this.generation ||
      this.snapshot.status !== 'ready'
    ) {
      return {
        accepted: false,
        reason:
          request.generation !== this.generation
            ? 'stale'
            : 'unavailable',
      };
    }
    try {
      const response = await this.options.supervisor.listWorkspace(
        request.path,
      );
      if (request.generation !== this.generation) {
        return { accepted: false, reason: 'stale' };
      }
      return {
        accepted: true,
        generation: this.generation,
        path: response.path,
        entries: response.entries,
      };
    } catch {
      return { accepted: false, reason: 'failed' };
    }
  };

  inspect = async (
    request: WorkspaceInspectRequest,
  ): Promise<WorkspaceInspectResult> => {
    if (
      request.generation !== this.generation ||
      this.snapshot.status !== 'ready'
    ) {
      return {
        accepted: false,
        reason:
          request.generation !== this.generation
            ? 'stale'
            : 'unavailable',
      };
    }
    try {
      const document = await this.options.supervisor.inspectWorkspace(
        request.path,
      );
      if (request.generation !== this.generation) {
        return { accepted: false, reason: 'stale' };
      }
      return {
        accepted: true,
        generation: this.generation,
        document,
      };
    } catch {
      return { accepted: false, reason: 'failed' };
    }
  };

  private activateProjectPath = async (
    selected: string,
    requestedProjectId?: string,
  ): Promise<WorkspaceSelectResult> => {
    if (this.options.supervisor.getWorkspaceSwitchBlock()) {
      return { accepted: false, reason: 'busy' };
    }
    const previousPath = this.workspacePath;
    const previousKind = this.workspaceKind;
    const previousThreadId = this.activeChatThreadId;
    const previousProjectPath = this.projectPath;
    const previousProjectId = this.activeProjectId;
    const previousProjectThreadIds = this.projectThreadIds;
    const existing = requestedProjectId
      ? this.projects.get(requestedProjectId)
      : [...this.projects.values()].find(
          (project) => project.path === selected,
        );
    const projectId = existing?.id ?? randomUUID();
    await this.options.beforeWorkspaceSwitch?.();
    this.workspacePath = selected;
    this.workspaceKind = 'project';
    this.activeChatThreadId = null;
    this.projectPath = selected;
    this.activeProjectId = projectId;
    this.projectThreadIds = existing?.threadIds ?? [];
    this.publish('selecting');
    if (
      !(await this.options.supervisor.switchWorkspace(selected, 'project'))
    ) {
      this.workspacePath = previousPath;
      this.workspaceKind = previousKind;
      this.activeChatThreadId = previousThreadId;
      this.projectPath = previousProjectPath;
      this.activeProjectId = previousProjectId;
      this.projectThreadIds = previousProjectThreadIds;
      this.publish(
        previousPath ? 'ready' : 'failed',
        'The local runtime could not bind the selected project.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.projects.set(projectId, {
      id: projectId,
      path: selected,
      name: path.basename(selected),
      threadIds: this.projectThreadIds,
      lastOpenedAtMs: existing?.lastOpenedAtMs ?? Date.now(),
      ...(this.options.supervisor.getWorkspaceBindingId()
        ? { workspaceId: this.options.supervisor.getWorkspaceBindingId() as string }
        : {}),
    });
    this.generation += 1;
    try {
      await this.persist();
    } catch {
      this.publish(
        'failed',
        'The project opened, but its restart record could not be saved.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.publish('ready');
    return { accepted: true };
  };

  private refreshActiveProjectRecord = (): void => {
    if (
      this.workspaceKind !== 'project' ||
      !this.activeProjectId ||
      !this.projectPath
    ) {
      return;
    }
    const current = this.projects.get(this.activeProjectId);
    this.projects.set(this.activeProjectId, {
      id: this.activeProjectId,
      path: this.projectPath,
      name: path.basename(this.projectPath),
      threadIds: this.projectThreadIds,
      lastOpenedAtMs: current?.lastOpenedAtMs ?? Date.now(),
      ...(this.options.supervisor.getWorkspaceBindingId()
        ? { workspaceId: this.options.supervisor.getWorkspaceBindingId() as string }
        : current?.workspaceId
          ? { workspaceId: current.workspaceId }
          : {}),
    });
  };

  private createChatDirectory = async (
    threadId?: string,
  ): Promise<string> => {
    await mkdir(this.options.chatRootPath, {
      recursive: true,
      mode: 0o700,
    });
    const chatRoot = await validateDirectory(this.options.chatRootPath);
    if (!chatRoot) {
      throw new Error('Chat root is not a stable directory.');
    }
    const now = (this.options.now ?? ((): Date => new Date()))();
    const dateName = [
      String(now.getFullYear()).padStart(4, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    const datePath = path.join(chatRoot, dateName);
    await mkdir(datePath, { recursive: true, mode: 0o700 });
    const validatedDate = await validateDirectory(datePath);
    if (
      !validatedDate ||
      path.dirname(validatedDate) !== chatRoot
    ) {
      throw new Error('Chat date directory is not contained by its root.');
    }
    const randomId = (this.options.randomId ?? randomUUID)()
      .replace(/[^A-Za-z0-9_-]/gu, '')
      .slice(0, 12);
    const timeName = [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    const folderName = threadId ?? `chat-${timeName}-${randomId}`;
    const directory = path.join(validatedDate, folderName);
    await mkdir(directory, { mode: 0o700 });
    const validated = await this.validateChatDirectory(directory);
    if (!validated) {
      throw new Error('Chat directory is not contained by its root.');
    }
    return validated;
  };

  private validateChatDirectory = async (
    candidate: string,
  ): Promise<string | null> => {
    const [root, directory] = await Promise.all([
      validateDirectory(this.options.chatRootPath),
      validateDirectory(candidate),
    ]);
    if (!root || !directory) {
      return null;
    }
    const relative = path.relative(root, directory);
    return relative.length > 0 &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative)
      ? directory
      : null;
  };

  private publish = (
    status: WorkspaceStateSnapshot['status'],
    error?: string,
  ): void => {
    this.revision += 1;
    this.snapshot = {
      revision: this.revision,
      generation: this.generation,
      status,
      ...(this.workspaceKind ? { kind: this.workspaceKind } : {}),
      ...(this.workspacePath
        ? {
            name:
              this.workspaceKind === 'chat'
                ? '聊天文件'
                : path.basename(this.workspacePath),
          }
        : {}),
      ...(this.projectPath
        ? { projectName: path.basename(this.projectPath) }
        : {}),
      projectThreadIds: this.projectThreadIds,
      projects: [...this.projects.values()]
        .sort((left, right) => right.lastOpenedAtMs - left.lastOpenedAtMs)
        .map((project) => ({
          id: project.id,
          name: project.name,
          threadIds: project.threadIds,
          lastOpenedAtMs: project.lastOpenedAtMs,
        })),
      ...(this.activeProjectId
        ? { activeProjectId: this.activeProjectId }
        : {}),
      chatThreadIds: this.chatThreadIds,
      chatTitles: Object.fromEntries(this.chatTitles),
      ...(error ? { error } : {}),
    };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };

  private readStoredSession = async (): Promise<
    StoredSession | null
  > => {
    try {
      const metadata = await lstat(this.options.sessionPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return null;
      }
      const value: unknown = JSON.parse(
        await readFile(this.options.sessionPath, 'utf8'),
      );
      if (isStoredSession(value)) {
        return value;
      }
      return isLegacyStoredSession(value)
        ? migrateLegacySession(value)
        : null;
    } catch {
      return null;
    }
  };

  private persist = async (): Promise<void> => {
    if (!this.workspacePath || !this.workspaceKind) {
      return;
    }
    await mkdir(path.dirname(this.options.sessionPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.options.sessionPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    const chatIds = new Set([
      ...this.chatThreadIds,
      ...this.chatDirectories.keys(),
    ]);
    const stored: StoredSession = {
      schemaVersion: 2,
      projects: [...this.projects.values()],
      active:
        this.workspaceKind === 'project'
          ? {
              kind: 'project',
              projectId: this.activeProjectId as string,
            }
          : {
              kind: 'chat',
              directory: this.workspacePath,
              ...(this.activeChatThreadId
                ? { threadId: this.activeChatThreadId }
                : {}),
            },
      chats: [...chatIds].map((threadId) => ({
        threadId,
        title: this.chatTitles.get(threadId) ?? threadId,
        ...(this.chatWorkspaceIds.get(threadId)
          ? { workspaceId: this.chatWorkspaceIds.get(threadId) }
          : {}),
        ...(this.chatDirectories.get(threadId)
          ? { directory: this.chatDirectories.get(threadId) }
          : {}),
      })),
    };
    try {
      await handle.writeFile(
        `${JSON.stringify(stored)}\n`,
        'utf8',
      );
      await handle.sync();
      await handle.close();
      await rename(temporary, this.options.sessionPath);
    } catch (error) {
      await handle.close().catch((): undefined => undefined);
      await unlink(temporary).catch((): undefined => undefined);
      throw error;
    }
  };
}

const isStoredSession = (
  value: unknown,
): value is StoredSession => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 2 ||
    !Object.keys(record).every((key) =>
      ['schemaVersion', 'projects', 'active', 'chats'].includes(key)
    ) ||
    !Array.isArray(record.projects) ||
    record.projects.length > 100 ||
    !record.projects.every(isStoredProject) ||
    !Array.isArray(record.chats) ||
    record.chats.length > 1_000
  ) {
    return false;
  }
  const chatsValid = record.chats.every(isStoredChat);
  if (
    !chatsValid ||
    typeof record.active !== 'object' ||
    record.active === null ||
    Array.isArray(record.active)
  ) {
    return false;
  }
  const active = record.active as Record<string, unknown>;
  if (active.kind === 'project') {
    return (
      Object.keys(active).every((key) =>
        ['kind', 'projectId'].includes(key)
      ) &&
      typeof active.projectId === 'string' &&
      record.projects.some(
        (project) =>
          (project as StoredProject).id === active.projectId,
      )
    );
  }
  return (
    active.kind === 'chat' &&
    Object.keys(active).every((key) =>
      ['kind', 'directory', 'threadId'].includes(key)
    ) &&
    typeof active.directory === 'string' &&
    path.isAbsolute(active.directory) &&
    Buffer.byteLength(active.directory, 'utf8') <= 4096 &&
    (active.threadId === undefined || isThreadId(active.threadId))
  );
};

const isStoredProject = (value: unknown): value is StoredProject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      [
        'id',
        'path',
        'name',
        'threadIds',
        'lastOpenedAtMs',
        'workspaceId',
      ].includes(key)
    ) &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    record.id.length <= 128 &&
    typeof record.path === 'string' &&
    path.isAbsolute(record.path) &&
    Buffer.byteLength(record.path, 'utf8') <= 4096 &&
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    Array.isArray(record.threadIds) &&
    record.threadIds.length <= 1_000 &&
    record.threadIds.every(isThreadId) &&
    Number.isSafeInteger(record.lastOpenedAtMs) &&
    (record.lastOpenedAtMs as number) >= 0 &&
    (record.workspaceId === undefined ||
      (typeof record.workspaceId === 'string' &&
        /^[0-9a-f]{64}$/u.test(record.workspaceId)))
  );
};

const isStoredChat = (value: unknown): value is StoredChat => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      ['threadId', 'directory', 'workspaceId', 'title'].includes(key)
    ) &&
    isThreadId(record.threadId) &&
    (record.directory === undefined ||
      (typeof record.directory === 'string' &&
        path.isAbsolute(record.directory) &&
        Buffer.byteLength(record.directory, 'utf8') <= 4096)) &&
    (record.workspaceId === undefined ||
      (typeof record.workspaceId === 'string' &&
        /^[0-9a-f]{64}$/u.test(record.workspaceId))) &&
    (record.title === undefined ||
      (typeof record.title === 'string' && record.title.length > 0))
  );
};

const isLegacyStoredSession = (
  value: unknown,
): value is LegacyStoredSession => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !Array.isArray(record.chats) ||
    !record.chats.every(isStoredChat) ||
    (record.projectPath !== undefined &&
      (typeof record.projectPath !== 'string' ||
        !path.isAbsolute(record.projectPath))) ||
    (record.projectThreadIds !== undefined &&
      (!Array.isArray(record.projectThreadIds) ||
        !record.projectThreadIds.every(isThreadId))) ||
    (record.chatThreadIds !== undefined &&
      (!Array.isArray(record.chatThreadIds) ||
        !record.chatThreadIds.every(isThreadId))) ||
    typeof record.active !== 'object' ||
    record.active === null
  ) {
    return false;
  }
  const active = record.active as Record<string, unknown>;
  return active.kind === 'project'
    ? typeof record.projectPath === 'string'
    : active.kind === 'chat' &&
        typeof active.directory === 'string' &&
        path.isAbsolute(active.directory) &&
        (active.threadId === undefined || isThreadId(active.threadId));
};

const migrateLegacySession = (
  legacy: LegacyStoredSession,
): StoredSession => {
  const projectId = randomUUID();
  const projects: StoredProject[] = legacy.projectPath
    ? [
        {
          id: projectId,
          path: legacy.projectPath,
          name: path.basename(legacy.projectPath),
          threadIds: legacy.projectThreadIds ?? [],
          lastOpenedAtMs: Date.now(),
        },
      ]
    : [];
  return {
    schemaVersion: 2,
    projects,
    active:
      legacy.active.kind === 'project'
        ? { kind: 'project', projectId }
        : legacy.active,
    chats: legacy.chats.map((chat) => ({
      ...chat,
      title: chat.title ?? chat.threadId,
    })),
  };
};

const validateDirectory = async (
  candidate: string,
): Promise<string | null> => {
  if (
    !path.isAbsolute(candidate) ||
    candidate.includes('\u0000') ||
    candidate.startsWith('\\\\')
  ) {
    return null;
  }
  try {
    const original = await lstat(candidate);
    if (!original.isDirectory() || original.isSymbolicLink()) {
      return null;
    }
    const resolved = await realpath(candidate);
    const canonical = await lstat(resolved);
    return canonical.isDirectory() && !canonical.isSymbolicLink()
      ? resolved
      : null;
  } catch {
    return null;
  }
};
