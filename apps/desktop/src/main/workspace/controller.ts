import type {
  ConnectionStateListener,
} from '@/shared/connection';
import { isValidConversationTitle } from '@/shared/conversation';
import type {
  WorkspaceChatRequest,
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceKind,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspacePathSearchRequest,
  WorkspacePathSearchResult,
  WorkspaceResolveRequest,
  WorkspaceResolveResult,
  WorkspaceSelectResult,
  WorkspaceStateSnapshot,
  ForegroundCommit,
} from '@/shared/workspace';
import { isAbsoluteWorkspaceFileReference } from '@/shared/workspace-file-reference';
import type { BrowserWindow, Dialog, OpenDialogOptions } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { ThreadRegistry } from '../navigation/thread-registry';
import { resolveAbsoluteWorkspaceFileReference } from './file-reference';

export type WorkspaceRuntimeBoundary = Readonly<{
  subscribe: (listener: ConnectionStateListener) => () => void;
  getWorkspaceSwitchBlock: () => unknown | null;
  switchWorkspace: (
    workspacePath: string,
    kind: WorkspaceKind,
  ) => Promise<boolean>;
  getWorkspaceBindingId: () => string | null;
  deleteThread: (
    workspaceId: string,
    threadId: string,
  ) => Promise<'deleted' | 'missing'>;
  renameThread: (
    workspaceId: string,
    threadId: string,
    title: string,
  ) => Promise<void>;
  listWorkspace: (path: string) => Promise<{
    path: string;
    entries: readonly import('@/shared/workspace').WorkspaceEntry[];
  }>;
  searchWorkspacePaths: (query: string) => Promise<Readonly<{
    query: string;
    paths: readonly string[];
    truncated: boolean;
  }>>;
  inspectWorkspace: (
    path: string,
  ) => Promise<import('@/shared/workspace').WorkspaceInspectDocument>;
  resolveWorkspaceFile: (
    name: string,
  ) => Promise<Readonly<{
    name: string;
    status: 'resolved' | 'notFound' | 'ambiguous' | 'unavailable';
    path?: string;
  }>>;
  conversation: Readonly<{
    getSnapshot: () => import('@/shared/conversation').ConversationStateSnapshot;
    selectThread: (
      threadId: string,
    ) => Promise<import('@/shared/conversation').ConversationActionResult>;
    getThreadProjection: (
      threadId: unknown,
    ) => import('@/shared/conversation').ConversationThreadProjectionSnapshot | null;
  }>;
}>;

type DialogBoundary = Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>;

type WorkspaceControllerOptions = Readonly<{
  threadRegistry: ThreadRegistry;
  supervisor: WorkspaceRuntimeBoundary;
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
  workspaceId: string;
  path: string;
  name: string;
  threadId: string | null;
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
  threadTitles: Readonly<Record<string, string>>;
  lastOpenedAtMs: number;
  workspaceId?: string;
}>;

type StoredSession = Readonly<{
  schemaVersion: 1;
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

type ProjectRecord = Readonly<
  Pick<StoredProject, 'id' | 'path' | 'name' | 'lastOpenedAtMs'>
>;

type ChatOwnerRecord = Readonly<{
  ownerKey: string;
  directory?: string;
}>;

const projectOwnerKey = (projectId: string): string =>
  `project:${projectId}`;

const chatOwnerKey = (directory: string): string => `chat:${directory}`;

const legacyChatOwnerKey = (threadId: string): string =>
  `chat-cache:${threadId}`;

const isThreadId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );

export class WorkspaceController {
  private readonly options: WorkspaceControllerOptions;
  private readonly listeners = new Set<Listener>();
  private readonly chatOwners = new Map<string, ChatOwnerRecord>();
  private persistedActive: StoredSession['active'] | null = null;
  private revision = 0;
  private generation = 0;
  private foregroundGeneration = 0;
  private projectPath: string | null = null;
  private activeProjectId: string | null = null;
  private readonly projects = new Map<string, ProjectRecord>();
  private workspaceId: string | null = null;
  private workspacePath: string | null = null;
  private workspaceKind: WorkspaceKind | null = null;
  private activeChatThreadId: string | null = null;
  private workspaceSwitchActive = false;
  private snapshot: WorkspaceStateSnapshot = {
    revision: 0,
    generation: 0,
    status: 'unselected',
    chatThreadIds: [],
  };

  constructor(options: WorkspaceControllerOptions) {
    this.options = options;
    this.options.threadRegistry.subscribe(this.handleRegistryChange);
    this.options.supervisor.subscribe((connection) => {
      if (!this.workspacePath || this.snapshot.status === 'selecting') {
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
            'The local runtime stopped while opening this workspace.',
        );
      }
    });
  }

  getSnapshot = (): WorkspaceStateSnapshot => this.snapshot;

  getLaunchContext = (): WorkspaceLaunchContext | null =>
    this.workspaceId && this.workspacePath && this.snapshot.status === 'ready'
      ? {
          generation: this.generation,
          workspaceId: this.workspaceId,
          path: this.workspacePath,
          name:
            this.workspaceKind === 'chat'
              ? '聊天文件'
              : path.basename(this.workspacePath),
          threadId:
            this.options.supervisor.conversation.getSnapshot().threadId ?? null,
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
    this.persistedActive = stored.active;
    for (const project of stored.projects) {
      const canonicalPath = await validateDirectory(project.path);
      if (!canonicalPath) {
        continue;
      }
      this.projects.set(project.id, {
        id: project.id,
        path: canonicalPath,
        name: path.basename(canonicalPath),
        lastOpenedAtMs: project.lastOpenedAtMs,
      });
      const ownerKey = projectOwnerKey(project.id);
      if (project.workspaceId) {
        this.options.threadRegistry.registerWorkspaceOwner(
          project.workspaceId,
          ownerKey,
          'sessionCache',
        );
      }
      this.options.threadRegistry.hydrateSessionCache(
        project.threadIds.map((threadId) => ({
          threadId,
          ownerKey,
          ...(project.workspaceId
            ? { workspaceId: project.workspaceId }
            : {}),
          ...(project.threadTitles[threadId]
            ? { title: project.threadTitles[threadId] }
            : {}),
        })),
      );
    }
    for (const chat of stored.chats) {
      const directory = chat.directory
        ? await this.validateChatDirectory(chat.directory)
        : null;
      const ownerKey = directory
        ? chatOwnerKey(directory)
        : legacyChatOwnerKey(chat.threadId);
      this.chatOwners.set(ownerKey, {
        ownerKey,
        ...(directory ? { directory } : {}),
      });
      if (chat.workspaceId) {
        this.options.threadRegistry.registerWorkspaceOwner(
          chat.workspaceId,
          ownerKey,
          'sessionCache',
        );
      }
      this.options.threadRegistry.hydrateSessionCache([
        {
          threadId: chat.threadId,
          ownerKey,
          ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
          ...(chat.title ? { title: chat.title } : {}),
        },
      ]);
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
      this.workspaceKind === 'project' &&
      this.activeProjectId !== null &&
      this.projects.has(this.activeProjectId)
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
    preferredThreadId?: string,
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
      return this.selectActivatedThread(preferredThreadId);
    }
    const validated = await validateDirectory(project.path);
    if (!validated) {
      this.projects.delete(projectId);
      await this.persist().catch((): undefined => undefined);
      this.publish('failed', 'The saved project is no longer available.');
      return { accepted: false, reason: 'invalid' };
    }
    return this.activateProjectPath(
      validated,
      projectId,
      preferredThreadId,
    );
  };

  removeProject = async (
    projectId: string,
  ): Promise<WorkspaceSelectResult> => {
    const project = this.projects.get(projectId);
    if (!project) {
      return { accepted: false, reason: 'invalid' };
    }
    const ownerKey = projectOwnerKey(projectId);
    const projectThreadIds = this.options.threadRegistry.getOwnerView(
      ownerKey,
    ).threadIds;
    const runningThreadIds =
      this.options.supervisor.conversation.getSnapshot().navigator
        .runningThreadIds ?? [];
    if (projectThreadIds.some((threadId) => runningThreadIds.includes(threadId))) {
      return { accepted: false, reason: 'busy' };
    }

    this.projects.delete(projectId);
    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
      this.projectPath = null;
    }
    if (
      this.persistedActive?.kind === 'project' &&
      this.persistedActive.projectId === projectId
    ) {
      this.persistedActive = this.getFallbackPersistedActive();
    }
    this.options.threadRegistry.removeOwner(ownerKey);

    try {
      await this.persist();
    } catch {
      this.publish(
        this.workspacePath ? 'failed' : 'unselected',
        'The project was removed, but its navigation record could not be saved.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.publish(this.workspacePath ? 'ready' : 'unselected');
    return { accepted: true };
  };

  focusTask = async (threadId: string): Promise<WorkspaceSelectResult> => {
    const foregroundGeneration = ++this.foregroundGeneration;
    const ownerKey = this.options.threadRegistry.getOwnerKey(threadId);
    const project = ownerKey
      ? [...this.projects.values()].find(
          (candidate) => projectOwnerKey(candidate.id) === ownerKey,
        )
      : undefined;
    if (project !== undefined) {
      const activated = await this.activateProject(project.id, threadId);
      if (!activated.accepted) {
        return activated;
      }
      if (
        this.options.supervisor.conversation.getSnapshot().threadId ===
        threadId
      ) {
        return this.focusResult(threadId, foregroundGeneration);
      }
      const selected = await this.options.supervisor.conversation.selectThread(
        threadId,
      );
      return selected.accepted
        ? this.focusResult(threadId, foregroundGeneration)
        : {
            accepted: false,
            reason: selected.reason === 'turnActive' ? 'busy' : 'failed',
          };
    }
    if (ownerKey && this.chatOwners.has(ownerKey)) {
      const activated = await this.activateChat({ threadId });
      return activated.accepted
        ? this.focusResult(threadId, foregroundGeneration)
        : activated;
    }
    return { accepted: false, reason: 'invalid' };
  };

  private selectActivatedThread = async (
    threadId?: string,
  ): Promise<WorkspaceSelectResult> => {
    if (
      !threadId ||
      this.options.supervisor.conversation.getSnapshot().threadId === threadId
    ) {
      return { accepted: true };
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
  };

  private focusResult = (
    threadId: string,
    generation: number,
  ): WorkspaceSelectResult => {
    if (generation !== this.foregroundGeneration) {
      return { accepted: true };
    }
    const thread = this.options.supervisor.conversation.getThreadProjection(
      threadId,
    );
    if (!thread || thread.workspaceId !== this.workspaceId) {
      return { accepted: false, reason: 'failed' };
    }
    const commit: ForegroundCommit = {
      selection: {
        generation,
        workspaceId: thread.workspaceId,
        threadId,
      },
      workspace: this.snapshot,
      thread,
    };
    return { accepted: true, commit };
  };

  deleteTask = async (threadId: string): Promise<WorkspaceSelectResult> => {
    if (!isThreadId(threadId)) {
      return { accepted: false, reason: 'invalid' };
    }
    const ownerKey = this.options.threadRegistry.getOwnerKey(threadId);
    const projectOwner = ownerKey
      ? [...this.projects.values()].find(
          (project) => projectOwnerKey(project.id) === ownerKey,
        )
      : undefined;
    const chatOwner = ownerKey ? this.chatOwners.get(ownerKey) : undefined;
    const chatOwned = Boolean(chatOwner);
    if (!projectOwner && !chatOwned) {
      return { accepted: false, reason: 'invalid' };
    }
    if (
      this.options.supervisor.conversation
        .getSnapshot()
        .navigator.runningThreadIds?.includes(threadId)
    ) {
      return { accepted: false, reason: 'busy' };
    }

    const boundWorkspaceId = this.options.threadRegistry.getWorkspaceId(threadId);
    const workspaceIds = [boundWorkspaceId];
    if (
      this.options.threadRegistry.getBindingSource(threadId) === 'sessionCache'
    ) {
      workspaceIds.push(
        ...[...this.projects.values()].map((project) =>
          this.options.threadRegistry.getWorkspaceIdForOwner(
            projectOwnerKey(project.id),
          ),
        ),
      );
    }
    const resolvedWorkspaceIds = workspaceIds.filter(
      (workspaceId): workspaceId is string => Boolean(workspaceId),
    );
    const candidates = [...new Set(resolvedWorkspaceIds)];
    if (candidates.length === 0) {
      return { accepted: false, reason: 'failed' };
    }

    let deletionFailed = false;
    let deleted = false;
    for (const workspaceId of candidates) {
      try {
        if (
          (await this.options.supervisor.deleteThread(
            workspaceId,
            threadId,
          )) === 'deleted'
        ) {
          deleted = true;
          break;
        }
      } catch {
        deletionFailed = true;
      }
    }
    if (!deleted && deletionFailed) {
      return { accepted: false, reason: 'failed' };
    }

    const chatThreadIds = ownerKey
      ? this.options.threadRegistry.getOwnerView(ownerKey).threadIds
      : [];
    const removesChatDirectory = Boolean(
      chatOwner?.directory &&
      chatThreadIds.length === 1 &&
      chatThreadIds[0] === threadId,
    );
    const persistedActiveChatDirectory =
      removesChatDirectory && this.persistedActive?.kind === 'chat'
        ? await this.validateChatDirectory(this.persistedActive.directory)
        : null;
    const persistedActiveReferencesDeletedChat = Boolean(
      this.persistedActive?.kind === 'chat' &&
      (this.persistedActive.threadId === threadId ||
        (chatOwner?.directory &&
          persistedActiveChatDirectory === chatOwner.directory)),
    );
    const deletingActiveDirectory = Boolean(
      removesChatDirectory &&
      chatOwner?.directory &&
      this.workspaceKind === 'chat' &&
      this.workspacePath === chatOwner.directory,
    );
    if (removesChatDirectory && chatOwner?.directory) {
      if (deletingActiveDirectory) {
        const replacement = await this.activateChat({});
        if (!replacement.accepted) {
          this.publish(
            this.workspacePath ? 'failed' : 'unselected',
            'The conversation was deleted, but SugarCode could not leave its chat folder before removing local files.',
          );
          return { accepted: false, reason: 'failed' };
        }
      }
      if (!(await this.deleteManagedChatDirectory(chatOwner.directory))) {
        this.publish(
          this.workspacePath ? 'failed' : 'unselected',
          'The conversation was deleted, but its managed chat folder could not be removed.',
        );
        return { accepted: false, reason: 'failed' };
      }
    }

    if (chatOwned) {
      if (this.activeChatThreadId === threadId) {
        this.activeChatThreadId = null;
      }
      if (
        this.persistedActive?.kind === 'chat' &&
        this.persistedActive.threadId === threadId
      ) {
        this.persistedActive = {
          kind: 'chat',
          directory: this.persistedActive.directory,
        };
      }
    }

    this.options.threadRegistry.removeThread(threadId);
    if (
      chatOwned &&
      ownerKey &&
      this.options.threadRegistry.getOwnerView(ownerKey).threadIds.length === 0
    ) {
      this.chatOwners.delete(ownerKey);
      if (
        removesChatDirectory &&
        !deletingActiveDirectory &&
        persistedActiveReferencesDeletedChat
      ) {
        this.persistedActive = this.getFallbackPersistedActive();
      }
    }

    try {
      await this.persist();
    } catch {
      this.publish(
        this.workspacePath ? 'failed' : 'unselected',
        'The Thread was deleted, but its navigation record could not be saved.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.publish(this.workspacePath ? 'ready' : 'unselected');
    return { accepted: true };
  };

  renameTask = async (
    threadId: string,
    title: string,
  ): Promise<WorkspaceSelectResult> => {
    const normalizedTitle = title.trim();
    if (!isThreadId(threadId) || !isValidConversationTitle(normalizedTitle)) {
      return { accepted: false, reason: 'invalid' };
    }
    const ownerKey = this.options.threadRegistry.getOwnerKey(threadId);
    if (!ownerKey) {
      return { accepted: false, reason: 'invalid' };
    }
    const projectOwner = [...this.projects.values()].find(
      (project) => projectOwnerKey(project.id) === ownerKey,
    );
    const chatOwner = this.chatOwners.get(ownerKey);
    const ownerPath = projectOwner?.path ?? chatOwner?.directory;
    const boundWorkspaceId = this.options.threadRegistry.getWorkspaceId(threadId);
    const workspaceIds = [
      boundWorkspaceId,
      this.options.threadRegistry.getWorkspaceIdForOwner(ownerKey),
      ownerPath
        ? createHash('sha256').update(ownerPath).digest('hex')
        : null,
    ];
    if (
      this.options.threadRegistry.getBindingSource(threadId) === 'sessionCache'
    ) {
      workspaceIds.push(
        ...[...this.projects.values()].map((project) =>
          this.options.threadRegistry.getWorkspaceIdForOwner(
            projectOwnerKey(project.id),
          ),
        ),
      );
    }
    const candidates = [
      ...new Set(
        workspaceIds.filter(
          (workspaceId): workspaceId is string => Boolean(workspaceId),
        ),
      ),
    ];
    if (candidates.length === 0) {
      return { accepted: false, reason: 'failed' };
    }
    let renamed = false;
    for (const workspaceId of candidates) {
      try {
        await this.options.supervisor.renameThread(
          workspaceId,
          threadId,
          normalizedTitle,
        );
        renamed = true;
        break;
      } catch {
        continue;
      }
    }
    if (!renamed) {
      return { accepted: false, reason: 'failed' };
    }
    try {
      await this.persist();
    } catch {
      this.publish(
        this.workspacePath ? 'failed' : 'unselected',
        'The Thread was renamed, but its navigation record could not be saved.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.publish(this.workspacePath ? 'ready' : 'unselected');
    return { accepted: true };
  };

  activateChat = async (
    request: WorkspaceChatRequest,
  ): Promise<WorkspaceSelectResult> => {
    if (
      this.workspaceSwitchActive ||
      this.options.supervisor.getWorkspaceSwitchBlock()
    ) {
      return { accepted: false, reason: 'busy' };
    }
    this.workspaceSwitchActive = true;
    try {
      return await this.activateChatUnlocked(request);
    } finally {
      this.workspaceSwitchActive = false;
    }
  };

  private activateChatUnlocked = async (
    request: WorkspaceChatRequest,
  ): Promise<WorkspaceSelectResult> => {
    const threadId = request.threadId;
    if (
      threadId &&
      this.workspaceKind === 'chat' &&
      this.activeChatThreadId === threadId &&
      this.snapshot.status === 'ready'
    ) {
      return this.selectActivatedThread(threadId);
    }

    const existingOwnerKey = threadId
      ? this.options.threadRegistry.getOwnerKey(threadId)
      : null;
    const existingOwner = existingOwnerKey
      ? this.chatOwners.get(existingOwnerKey)
      : undefined;
    let directory = existingOwner?.directory ?? null;
    if (directory) {
      directory = await this.restoreManagedChatDirectory(directory);
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
    const previousWorkspaceId = this.workspaceId;
    const previousKind = this.workspaceKind;
    const previousThreadId = this.activeChatThreadId;
    await this.options.beforeWorkspaceSwitch?.();
    this.workspacePath = directory;
    this.workspaceKind = 'chat';
    this.activeChatThreadId = threadId ?? null;
    this.publish('selecting');
    if (
      !(await this.options.supervisor.switchWorkspace(directory, 'chat'))
    ) {
      this.workspacePath = previousPath;
      this.workspaceId = previousWorkspaceId;
      this.workspaceKind = previousKind;
      this.activeChatThreadId = previousThreadId;
      this.publish(
        previousPath ? 'ready' : 'failed',
        'The chat runtime could not be started.',
      );
      return { accepted: false, reason: 'failed' };
    }
    const workspaceId = this.options.supervisor.getWorkspaceBindingId();
    if (!workspaceId) {
      this.workspacePath = previousPath;
      this.workspaceId = previousWorkspaceId;
      this.workspaceKind = previousKind;
      this.activeChatThreadId = previousThreadId;
      this.publish(
        previousPath ? 'ready' : 'failed',
        'The chat runtime did not return a Workspace binding.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.workspaceId = workspaceId;
    const ownerKey = chatOwnerKey(directory);
    this.chatOwners.set(ownerKey, { ownerKey, directory });
    this.options.threadRegistry.registerWorkspaceOwner(
      workspaceId,
      ownerKey,
      'runtime',
    );
    const selected = await this.selectActivatedThread(threadId);
    if (!selected.accepted) {
      if (existingOwnerKey !== ownerKey) {
        this.chatOwners.delete(ownerKey);
        this.options.threadRegistry.removeOwner(ownerKey);
      }
      this.workspacePath = previousPath;
      this.workspaceId = previousWorkspaceId;
      this.workspaceKind = previousKind;
      this.activeChatThreadId = previousThreadId;
      this.publish(previousPath ? 'ready' : 'failed');
      return selected;
    }
    if (existingOwnerKey && existingOwnerKey !== ownerKey) {
      this.chatOwners.delete(existingOwnerKey);
    }
    this.generation += 1;
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
    return selected;
  };

  clear = (): Promise<WorkspaceSelectResult> =>
    this.activateChat({});

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

  searchPaths = async (
    request: WorkspacePathSearchRequest,
  ): Promise<WorkspacePathSearchResult> => {
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
      const response = await this.options.supervisor.searchWorkspacePaths(
        request.query,
      );
      if (request.generation !== this.generation) {
        return { accepted: false, reason: 'stale' };
      }
      return {
        accepted: true,
        generation: this.generation,
        query: response.query,
        paths: response.paths,
        truncated: response.truncated,
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

  resolve = async (
    request: WorkspaceResolveRequest,
  ): Promise<WorkspaceResolveResult> => {
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
    if (isAbsoluteWorkspaceFileReference(request.reference)) {
      if (!this.workspacePath) {
        return { accepted: false, reason: 'unavailable' };
      }
      const result = resolveAbsoluteWorkspaceFileReference(
        this.workspacePath,
        request.reference,
      );
      return {
        accepted: true,
        generation: this.generation,
        reference: request.reference,
        ...result,
      };
    }
    try {
      const result = await this.options.supervisor.resolveWorkspaceFile(
        request.reference,
      );
      if (request.generation !== this.generation) {
        return { accepted: false, reason: 'stale' };
      }
      return {
        accepted: true,
        generation: this.generation,
        reference: request.reference,
        status: result.status,
        ...(result.path ? { path: result.path } : {}),
      };
    } catch {
      return { accepted: false, reason: 'failed' };
    }
  };

  private activateProjectPath = async (
    selected: string,
    requestedProjectId?: string,
    preferredThreadId?: string,
  ): Promise<WorkspaceSelectResult> => {
    if (
      this.workspaceSwitchActive ||
      this.options.supervisor.getWorkspaceSwitchBlock()
    ) {
      return { accepted: false, reason: 'busy' };
    }
    this.workspaceSwitchActive = true;
    try {
      return await this.activateProjectPathUnlocked(
        selected,
        requestedProjectId,
        preferredThreadId,
      );
    } finally {
      this.workspaceSwitchActive = false;
    }
  };

  private activateProjectPathUnlocked = async (
    selected: string,
    requestedProjectId?: string,
    preferredThreadId?: string,
  ): Promise<WorkspaceSelectResult> => {
    const previousPath = this.workspacePath;
    const previousWorkspaceId = this.workspaceId;
    const previousKind = this.workspaceKind;
    const previousThreadId = this.activeChatThreadId;
    const previousProjectPath = this.projectPath;
    const previousProjectId = this.activeProjectId;
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
    this.publish('selecting');
    if (
      !(await this.options.supervisor.switchWorkspace(selected, 'project'))
    ) {
      this.workspacePath = previousPath;
      this.workspaceId = previousWorkspaceId;
      this.workspaceKind = previousKind;
      this.activeChatThreadId = previousThreadId;
      this.projectPath = previousProjectPath;
      this.activeProjectId = previousProjectId;
      this.publish(
        previousPath ? 'ready' : 'failed',
        'The local runtime could not bind the selected project.',
      );
      return { accepted: false, reason: 'failed' };
    }
    const workspaceId = this.options.supervisor.getWorkspaceBindingId();
    if (!workspaceId) {
      this.workspacePath = previousPath;
      this.workspaceId = previousWorkspaceId;
      this.workspaceKind = previousKind;
      this.activeChatThreadId = previousThreadId;
      this.projectPath = previousProjectPath;
      this.activeProjectId = previousProjectId;
      this.publish(
        previousPath ? 'ready' : 'failed',
        'The local runtime did not return a Workspace binding.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.workspaceId = workspaceId;
    this.options.threadRegistry.registerWorkspaceOwner(
      workspaceId,
      projectOwnerKey(projectId),
      'runtime',
    );
    this.projects.set(projectId, {
      id: projectId,
      path: selected,
      name: path.basename(selected),
      lastOpenedAtMs: existing?.lastOpenedAtMs ?? Date.now(),
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
    return this.selectActivatedThread(preferredThreadId);
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
      lastOpenedAtMs: current?.lastOpenedAtMs ?? Date.now(),
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

  /**
   * Chat Threads are durably bound to the hash of their original directory.
   * Recreate a missing managed directory in place instead of assigning the
   * Thread a fresh path (and therefore a different Workspace identity).
   */
  private restoreManagedChatDirectory = async (
    candidate: string,
  ): Promise<string | null> => {
    const existing = await this.validateChatDirectory(candidate);
    if (existing) {
      return existing;
    }
    try {
      await mkdir(this.options.chatRootPath, {
        recursive: true,
        mode: 0o700,
      });
      const root = await validateDirectory(this.options.chatRootPath);
      if (!root) {
        return null;
      }
      const requested = path.resolve(candidate);
      const relative = path.relative(root, requested);
      const segments = relative.split(path.sep);
      if (
        path.isAbsolute(relative) ||
        segments.length !== 2 ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(segments[0] ?? '') ||
        !segments[1] ||
        segments.some((segment) => segment === '..' || segment === '.')
      ) {
        return null;
      }
      const datePath = path.join(root, segments[0] as string);
      await mkdir(datePath, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException): undefined => {
          if (error.code !== 'EEXIST') throw error;
          return undefined;
        },
      );
      const validatedDate = await validateDirectory(datePath);
      if (!validatedDate || path.dirname(validatedDate) !== root) {
        return null;
      }
      await mkdir(requested, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException): undefined => {
          if (error.code !== 'EEXIST') throw error;
          return undefined;
        },
      );
      return this.validateChatDirectory(requested);
    } catch {
      return null;
    }
  };

  private deleteManagedChatDirectory = async (
    candidate: string,
  ): Promise<boolean> => {
    const directory = await this.validateChatDirectory(candidate);
    if (!directory) {
      try {
        await lstat(candidate);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    }
    try {
      await rm(directory, { recursive: true, force: false });
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  };

  private handleRegistryChange = (): void => {
    if (this.workspaceKind === 'chat') {
      const threadId = this.options.supervisor.conversation.getSnapshot().threadId;
      const workspaceId = this.options.supervisor.getWorkspaceBindingId();
      if (
        threadId &&
        workspaceId &&
        this.options.threadRegistry.getWorkspaceId(threadId) === workspaceId
      ) {
        this.activeChatThreadId = threadId;
      }
    }
    if (this.snapshot.status === 'ready') {
      void this.persist().catch((): undefined => undefined);
    }
    this.publish(this.snapshot.status);
  };

  private getChatThreads = (): readonly Readonly<{
    threadId: string;
    owner: ChatOwnerRecord;
  }>[] => {
    const seen = new Set<string>();
    return [...this.chatOwners.values()].flatMap((owner) =>
      this.options.threadRegistry
        .getOwnerView(owner.ownerKey)
        .threadIds.flatMap((threadId) => {
          if (seen.has(threadId)) {
            return [];
          }
          seen.add(threadId);
          return [{ threadId, owner }];
        }),
    );
  };

  private publish = (
    status: WorkspaceStateSnapshot['status'],
    error?: string,
  ): void => {
    const activeProjectView = this.activeProjectId
      ? this.options.threadRegistry.getOwnerView(
          projectOwnerKey(this.activeProjectId),
        )
      : { threadIds: [], threadTitles: {} };
    const chatThreads = this.getChatThreads();
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
      projectThreadIds: activeProjectView.threadIds,
      projects: [...this.projects.values()]
        .sort((left, right) => right.lastOpenedAtMs - left.lastOpenedAtMs)
        .map((project) => ({
          ...this.options.threadRegistry.getOwnerView(
            projectOwnerKey(project.id),
          ),
          id: project.id,
          name: project.name,
          lastOpenedAtMs: project.lastOpenedAtMs,
        })),
      ...(this.activeProjectId
        ? { activeProjectId: this.activeProjectId }
        : {}),
      chatThreadIds: chatThreads.map(({ threadId }) => threadId),
      chatTitles: Object.fromEntries(
        chatThreads.flatMap(({ threadId }) => {
          const title = this.options.threadRegistry.getTitle(threadId);
          return title ? [[threadId, title]] : [];
        }),
      ),
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
      return null;
    } catch {
      return null;
    }
  };

  private persist = async (): Promise<void> => {
    const active: StoredSession['active'] | null =
      this.workspaceKind === 'project' && this.activeProjectId
        ? {
            kind: 'project',
            projectId: this.activeProjectId,
          }
        : this.workspaceKind === 'chat' && this.workspacePath
          ? {
              kind: 'chat',
              directory: this.workspacePath,
              ...(this.activeChatThreadId
                ? { threadId: this.activeChatThreadId }
                : {}),
            }
          : this.persistedActive;
    if (!active) {
      await unlink(this.options.sessionPath).catch(
        (error: NodeJS.ErrnoException): undefined => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
          return undefined;
        },
      );
      return;
    }
    await mkdir(path.dirname(this.options.sessionPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.options.sessionPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    const chatThreads = this.getChatThreads();
    const stored: StoredSession = {
      schemaVersion: 1,
      projects: [...this.projects.values()].map((project) => {
        const view = this.options.threadRegistry.getOwnerView(
          projectOwnerKey(project.id),
        );
        const workspaceId = this.options.threadRegistry.getWorkspaceIdForOwner(
          projectOwnerKey(project.id),
        );
        return {
          ...project,
          threadIds: view.threadIds,
          threadTitles: view.threadTitles,
          ...(workspaceId ? { workspaceId } : {}),
        };
      }),
      active,
      chats: chatThreads.map(({ threadId, owner }) => {
        const title = this.options.threadRegistry.getTitle(threadId);
        const workspaceId = this.options.threadRegistry.getWorkspaceId(threadId);
        return {
          threadId,
          ...(title ? { title } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(owner.directory ? { directory: owner.directory } : {}),
        };
      }),
    };
    try {
      await handle.writeFile(
        `${JSON.stringify(stored)}\n`,
        'utf8',
      );
      await handle.sync();
      await handle.close();
      await rename(temporary, this.options.sessionPath);
      this.persistedActive = active;
    } catch (error) {
      await handle.close().catch((): undefined => undefined);
      await unlink(temporary).catch((): undefined => undefined);
      throw error;
    }
  };

  private getFallbackPersistedActive = (): StoredSession['active'] | null => {
    const project = [...this.projects.values()].sort(
      (left, right) => right.lastOpenedAtMs - left.lastOpenedAtMs,
    )[0];
    if (project) {
      return { kind: 'project', projectId: project.id };
    }
    const chat = [...this.chatOwners.values()].find(
      (owner) => owner.directory !== undefined,
    );
    return chat?.directory
      ? { kind: 'chat', directory: chat.directory }
      : null;
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
    record.schemaVersion !== 1 ||
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
  const projectThreadIdList = record.projects.flatMap(
    (project) => (project as StoredProject).threadIds,
  );
  const projectThreadIds = new Set(projectThreadIdList);
  const chatThreadIds = (record.chats as StoredChat[]).map(
    (chat) => chat.threadId,
  );
  if (
    !chatsValid ||
    projectThreadIds.size !== projectThreadIdList.length ||
    new Set(chatThreadIds).size !== chatThreadIds.length ||
    chatThreadIds.some((threadId) => projectThreadIds.has(threadId)) ||
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
        'threadTitles',
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
    typeof record.threadTitles === 'object' &&
    record.threadTitles !== null &&
    !Array.isArray(record.threadTitles) &&
    Object.entries(record.threadTitles).every(
      ([threadId, title]) =>
        (record.threadIds as unknown[]).includes(threadId) &&
        typeof title === 'string' &&
        title.length > 0 &&
        Buffer.byteLength(title, 'utf8') <= 256,
    ) &&
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
