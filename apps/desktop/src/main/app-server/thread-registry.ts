import type { Thread } from '@sugarcode/app-server-protocol';

import type { ConversationTerminalTurnStatus } from '@/shared/conversation';

import { ThreadRuntime } from './conversation/controller/thread-runtime';

export type ThreadBindingSource = 'sessionCache' | 'protocol';

export type CachedThreadMetadata = Readonly<{
  threadId: string;
  ownerKey: string;
  workspaceId?: string;
  title?: string;
}>;

export type ThreadRegistryView = Readonly<{
  threadIds: readonly string[];
  threadTitles: Readonly<Record<string, string>>;
}>;

type WorkspaceOwnerBinding = Readonly<{
  ownerKey: string;
  source: ThreadBindingSource;
}>;

type OwnerWorkspaceBinding = Readonly<{
  workspaceId: string;
  source: ThreadBindingSource;
}>;

type ThreadRegistryEntry = {
  readonly threadId: string;
  source: ThreadBindingSource;
  ownerKey?: string;
  workspaceId?: string;
  title?: string;
  runtime?: ThreadRuntime;
  unreadStatus?: ConversationTerminalTurnStatus;
  reloadRequired: boolean;
};

type Listener = () => void;

export class ThreadRegistryProtocolError extends Error {}

export class ThreadRegistry {
  private readonly entries = new Map<string, ThreadRegistryEntry>();
  private readonly workspaceIndexes = new Map<string, string[]>();
  private readonly authoritativeWorkspaces = new Set<string>();
  private readonly cachedOwnerIndexes = new Map<string, string[]>();
  private readonly workspaceOwners = new Map<string, WorkspaceOwnerBinding>();
  private readonly ownerWorkspaces = new Map<string, OwnerWorkspaceBinding>();
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  hydrateSessionCache = (threads: readonly CachedThreadMetadata[]): void => {
    for (const thread of threads) {
      const existing = this.entries.get(thread.threadId);
      if (existing?.source === 'protocol') {
        continue;
      }
      const entry: ThreadRegistryEntry = existing ?? {
        threadId: thread.threadId,
        source: 'sessionCache',
        reloadRequired: false,
      };
      entry.source = 'sessionCache';
      entry.ownerKey = thread.ownerKey;
      entry.workspaceId = thread.workspaceId;
      if (thread.title) {
        entry.title = thread.title;
      }
      this.entries.set(thread.threadId, entry);
      this.appendCachedOwnerThread(thread.ownerKey, thread.threadId);
      if (thread.workspaceId) {
        this.appendWorkspaceThread(thread.workspaceId, thread.threadId);
      }
    }
    this.notify();
  };

  registerWorkspaceOwner = (
    workspaceId: string,
    ownerKey: string,
    source: ThreadBindingSource,
  ): void => {
    const currentOwner = this.workspaceOwners.get(workspaceId);
    const currentWorkspace = this.ownerWorkspaces.get(ownerKey);
    if (
      (currentOwner?.source === 'protocol' &&
        currentOwner.ownerKey !== ownerKey) ||
      (currentWorkspace?.source === 'protocol' &&
        currentWorkspace.workspaceId !== workspaceId)
    ) {
      throw new ThreadRegistryProtocolError(
        'Workspace owner binding changed after protocol confirmation.',
      );
    }

    if (currentOwner && currentOwner.ownerKey !== ownerKey) {
      this.ownerWorkspaces.delete(currentOwner.ownerKey);
    }
    if (currentWorkspace && currentWorkspace.workspaceId !== workspaceId) {
      this.workspaceOwners.delete(currentWorkspace.workspaceId);
    }
    this.workspaceOwners.set(workspaceId, { ownerKey, source });
    this.ownerWorkspaces.set(ownerKey, { workspaceId, source });

    const cachedIds = this.cachedOwnerIndexes.get(ownerKey) ?? [];
    if (!this.workspaceIndexes.has(workspaceId) && cachedIds.length > 0) {
      this.workspaceIndexes.set(workspaceId, [...cachedIds]);
    }
    const authoritativeIds = this.authoritativeWorkspaces.has(workspaceId)
      ? new Set(this.workspaceIndexes.get(workspaceId) ?? [])
      : null;
    for (const entry of this.entries.values()) {
      if (entry.ownerKey === ownerKey && entry.source === 'sessionCache') {
        if (authoritativeIds && !authoritativeIds.has(entry.threadId)) {
          this.removeFromCachedOwnerIndex(ownerKey, entry.threadId);
          this.entries.delete(entry.threadId);
          continue;
        }
        entry.workspaceId = workspaceId;
      } else if (entry.workspaceId === workspaceId) {
        entry.ownerKey = ownerKey;
      }
    }
    this.notify();
  };

  getWorkspaceIdForOwner = (ownerKey: string): string | null =>
    this.ownerWorkspaces.get(ownerKey)?.workspaceId ?? null;

  getOwnerKeyForWorkspace = (workspaceId: string): string | null =>
    this.workspaceOwners.get(workspaceId)?.ownerKey ?? null;

  getOwnerKey = (threadId: string): string | null =>
    this.entries.get(threadId)?.ownerKey ?? null;

  getBindingSource = (threadId: string): ThreadBindingSource | null =>
    this.entries.get(threadId)?.source ?? null;

  replaceWorkspaceIndex = (
    workspaceId: string,
    threads: readonly Thread[],
  ): void => {
    if (threads.some((thread) => thread.workspaceId !== workspaceId)) {
      throw new Error('Thread index crossed workspace ownership.');
    }
    const nextIds = threads.map((thread) => thread.id);
    const nextSet = new Set(nextIds);
    const previousIds = this.workspaceIndexes.get(workspaceId) ?? [];
    for (const threadId of previousIds) {
      if (!nextSet.has(threadId)) {
        this.removeFromWorkspaceIndex(workspaceId, threadId);
        const entry = this.entries.get(threadId);
        if (
          entry?.source === 'sessionCache' &&
          entry.workspaceId === workspaceId
        ) {
          if (entry.ownerKey) {
            this.removeFromCachedOwnerIndex(entry.ownerKey, threadId);
          }
          this.entries.delete(threadId);
        }
      }
    }
    for (const thread of threads) {
      this.bindProtocolThread(thread);
    }
    this.workspaceIndexes.set(workspaceId, nextIds);
    this.authoritativeWorkspaces.add(workspaceId);
    this.notify();
  };

  registerActiveThread = (thread: Thread): void => {
    this.bindProtocolThread(thread);
    const current = this.workspaceIndexes.get(thread.workspaceId) ?? [];
    this.workspaceIndexes.set(thread.workspaceId, [
      thread.id,
      ...current.filter((threadId) => threadId !== thread.id),
    ]);
    this.notify();
  };

  registerDiscoveredThread = (thread: Thread): void => {
    this.bindProtocolThread(thread);
    this.notify();
  };

  updateTitle = (workspaceId: string, threadId: string, title: string): void => {
    const entry = this.entries.get(threadId);
    if (
      !entry ||
      entry.source !== 'protocol' ||
      entry.workspaceId !== workspaceId
    ) {
      throw new Error('Thread title route is not bound to a protocol Thread.');
    }
    if (entry.title === title) {
      return;
    }
    entry.title = title;
    this.notify();
  };

  setRuntime = (threadId: string, runtime: ThreadRuntime): void => {
    const entry = this.entries.get(threadId);
    if (
      !entry ||
      entry.source !== 'protocol' ||
      entry.workspaceId !== runtime.workspaceId ||
      runtime.capture().threadId !== threadId
    ) {
      throw new Error('Thread Runtime binding is unavailable.');
    }
    entry.runtime = runtime;
  };

  getRuntime = (threadId: string): ThreadRuntime | null =>
    this.entries.get(threadId)?.runtime ?? null;

  runtimes = (): readonly ThreadRuntime[] =>
    [...this.entries.values()].flatMap((entry) =>
      entry.runtime ? [entry.runtime] : [],
    );

  runtimeEntries = (): readonly (readonly [string, ThreadRuntime])[] =>
    [...this.entries.values()].flatMap((entry) =>
      entry.runtime ? [[entry.threadId, entry.runtime] as const] : [],
    );

  deleteRuntime = (threadId: string): void => {
    const entry = this.entries.get(threadId);
    if (entry) {
      delete entry.runtime;
    }
  };

  markUnread = (
    threadId: string,
    status: ConversationTerminalTurnStatus,
  ): void => {
    const entry = this.requireEntry(threadId);
    entry.unreadStatus = status;
  };

  clearUnread = (threadId: string): void => {
    const entry = this.entries.get(threadId);
    if (entry) {
      delete entry.unreadStatus;
    }
  };

  markReloadRequired = (threadId: string): void => {
    const entry = this.requireEntry(threadId);
    entry.reloadRequired = true;
  };

  clearReloadRequired = (threadId: string): void => {
    const entry = this.entries.get(threadId);
    if (entry) {
      entry.reloadRequired = false;
    }
  };

  isReloadRequired = (threadId: string): boolean =>
    this.entries.get(threadId)?.reloadRequired ?? false;

  getWorkspaceId = (threadId: string): string | null =>
    this.entries.get(threadId)?.workspaceId ?? null;

  getTitle = (threadId: string): string | null =>
    this.entries.get(threadId)?.title ?? null;

  isActive = (threadId: string): boolean => {
    const workspaceId = this.entries.get(threadId)?.workspaceId;
    return workspaceId
      ? this.workspaceIndexes.get(workspaceId)?.includes(threadId) ?? false
      : [...this.cachedOwnerIndexes.values()].some((threadIds) =>
          threadIds.includes(threadId),
        );
  };

  getWorkspaceView = (workspaceId: string): ThreadRegistryView =>
    this.createView(this.workspaceIndexes.get(workspaceId) ?? []);

  getOwnerView = (ownerKey: string): ThreadRegistryView => {
    const workspaceId = this.ownerWorkspaces.get(ownerKey)?.workspaceId;
    return workspaceId
      ? this.getWorkspaceView(workspaceId)
      : this.createView(this.cachedOwnerIndexes.get(ownerKey) ?? []);
  };

  getRunningThreadIds = (): readonly string[] =>
    this.runtimeEntries()
      .filter(([, runtime]) => runtime.getActiveTurnId() !== null)
      .map(([threadId]) => threadId);

  getUnreadStatuses = (): Readonly<Record<string, ConversationTerminalTurnStatus>> =>
    Object.fromEntries(
      [...this.entries.values()].flatMap((entry) =>
        entry.unreadStatus
          ? [[entry.threadId, entry.unreadStatus] as const]
          : [],
      ),
    );

  getReloadRequiredThreadIds = (): readonly string[] =>
    [...this.entries.values()]
      .filter((entry) => entry.reloadRequired)
      .map((entry) => entry.threadId);

  removeThread = (threadId: string): void => {
    const entry = this.entries.get(threadId);
    if (!entry) {
      return;
    }
    for (const [workspaceId, threadIds] of this.workspaceIndexes) {
      if (threadIds.includes(threadId)) {
        this.workspaceIndexes.set(
          workspaceId,
          threadIds.filter((candidate) => candidate !== threadId),
        );
      }
    }
    for (const [ownerKey, threadIds] of this.cachedOwnerIndexes) {
      if (threadIds.includes(threadId)) {
        this.cachedOwnerIndexes.set(
          ownerKey,
          threadIds.filter((candidate) => candidate !== threadId),
        );
      }
    }
    this.entries.delete(threadId);
    this.notify();
  };

  private bindProtocolThread = (thread: Thread): void => {
    const existing = this.entries.get(thread.id);
    if (
      existing?.source === 'protocol' &&
      existing.workspaceId !== thread.workspaceId
    ) {
      throw new ThreadRegistryProtocolError(
        'Thread Workspace binding changed after confirmation.',
      );
    }
    const ownerKey = this.workspaceOwners.get(thread.workspaceId)?.ownerKey;
    const entry: ThreadRegistryEntry = existing ?? {
      threadId: thread.id,
      source: 'protocol',
      reloadRequired: false,
    };
    if (existing?.ownerKey) {
      this.removeFromCachedOwnerIndex(existing.ownerKey, thread.id);
    }
    if (existing?.workspaceId && existing.workspaceId !== thread.workspaceId) {
      this.removeFromWorkspaceIndex(existing.workspaceId, thread.id);
    }
    entry.source = 'protocol';
    entry.workspaceId = thread.workspaceId;
    entry.ownerKey = ownerKey;
    if (thread.title) {
      entry.title = thread.title;
    }
    this.entries.set(thread.id, entry);
  };

  private createView = (threadIds: readonly string[]): ThreadRegistryView => ({
    threadIds: [...threadIds],
    threadTitles: Object.fromEntries(
      threadIds.flatMap((threadId) => {
        const title = this.entries.get(threadId)?.title;
        return title ? [[threadId, title]] : [];
      }),
    ),
  });

  private requireEntry = (threadId: string): ThreadRegistryEntry => {
    const entry = this.entries.get(threadId);
    if (!entry) {
      throw new Error('Thread Registry entry is unavailable.');
    }
    return entry;
  };

  private appendCachedOwnerThread = (ownerKey: string, threadId: string): void => {
    const current = this.cachedOwnerIndexes.get(ownerKey) ?? [];
    if (!current.includes(threadId)) {
      this.cachedOwnerIndexes.set(ownerKey, [...current, threadId]);
    }
  };

  private appendWorkspaceThread = (workspaceId: string, threadId: string): void => {
    const current = this.workspaceIndexes.get(workspaceId) ?? [];
    if (!current.includes(threadId)) {
      this.workspaceIndexes.set(workspaceId, [...current, threadId]);
    }
  };

  private removeFromCachedOwnerIndex = (ownerKey: string, threadId: string): void => {
    const current = this.cachedOwnerIndexes.get(ownerKey);
    if (current?.includes(threadId)) {
      this.cachedOwnerIndexes.set(
        ownerKey,
        current.filter((candidate) => candidate !== threadId),
      );
    }
  };

  private removeFromWorkspaceIndex = (workspaceId: string, threadId: string): void => {
    const current = this.workspaceIndexes.get(workspaceId);
    if (current?.includes(threadId)) {
      this.workspaceIndexes.set(
        workspaceId,
        current.filter((candidate) => candidate !== threadId),
      );
    }
  };

  private notify = (): void => {
    for (const listener of this.listeners) {
      listener();
    }
  };
}
