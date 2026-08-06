export type ThreadBindingSource = 'sessionCache' | 'runtime';

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

export type RuntimeThreadBinding = Readonly<{
  id: string;
  workspaceId: string;
  title?: string;
}>;

type ThreadRegistryEntry = {
  readonly threadId: string;
  source: ThreadBindingSource;
  ownerKey?: string;
  workspaceId?: string;
  title?: string;
};

type OwnerBinding = Readonly<{
  value: string;
  source: ThreadBindingSource;
}>;

type Listener = () => void;

export class ThreadRegistry {
  private readonly entries = new Map<string, ThreadRegistryEntry>();
  private readonly workspaceIndexes = new Map<string, string[]>();
  private readonly authoritativeWorkspaces = new Set<string>();
  private readonly cachedOwnerIndexes = new Map<string, string[]>();
  private readonly workspaceOwners = new Map<string, OwnerBinding>();
  private readonly ownerWorkspaces = new Map<string, OwnerBinding>();
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  hydrateSessionCache = (threads: readonly CachedThreadMetadata[]): void => {
    for (const thread of threads) {
      const existing = this.entries.get(thread.threadId);
      if (existing?.source === 'runtime') {
        continue;
      }
      this.entries.set(thread.threadId, {
        threadId: thread.threadId,
        source: 'sessionCache',
        ownerKey: thread.ownerKey,
        ...(thread.workspaceId ? { workspaceId: thread.workspaceId } : {}),
        ...(thread.title ? { title: thread.title } : {}),
      });
      this.appendUnique(
        this.cachedOwnerIndexes,
        thread.ownerKey,
        thread.threadId,
      );
      if (thread.workspaceId) {
        this.appendUnique(
          this.workspaceIndexes,
          thread.workspaceId,
          thread.threadId,
        );
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
      (currentOwner?.source === 'runtime' && currentOwner.value !== ownerKey) ||
      (currentWorkspace?.source === 'runtime' &&
        currentWorkspace.value !== workspaceId)
    ) {
      throw new Error('Runtime Workspace owner binding changed after confirmation.');
    }
    if (currentOwner && currentOwner.value !== ownerKey) {
      this.ownerWorkspaces.delete(currentOwner.value);
    }
    if (currentWorkspace && currentWorkspace.value !== workspaceId) {
      this.workspaceOwners.delete(currentWorkspace.value);
    }
    this.workspaceOwners.set(workspaceId, { value: ownerKey, source });
    this.ownerWorkspaces.set(ownerKey, { value: workspaceId, source });

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
          this.removeFromIndex(
            this.cachedOwnerIndexes,
            ownerKey,
            entry.threadId,
          );
          this.entries.delete(entry.threadId);
        } else {
          entry.workspaceId = workspaceId;
        }
      } else if (entry.workspaceId === workspaceId) {
        entry.ownerKey = ownerKey;
      }
    }
    this.notify();
  };

  replaceRuntimeWorkspaceIndex = (
    workspaceId: string,
    threads: readonly RuntimeThreadBinding[],
  ): void => {
    if (threads.some((thread) => thread.workspaceId !== workspaceId)) {
      throw new Error('Runtime Thread index crossed Workspace ownership.');
    }
    const nextIds = threads.map((thread) => thread.id);
    const nextSet = new Set(nextIds);
    for (const threadId of this.workspaceIndexes.get(workspaceId) ?? []) {
      if (!nextSet.has(threadId)) {
        const entry = this.entries.get(threadId);
        if (entry?.ownerKey) {
          this.removeFromIndex(
            this.cachedOwnerIndexes,
            entry.ownerKey,
            threadId,
          );
        }
        if (entry?.workspaceId === workspaceId) {
          this.entries.delete(threadId);
        }
      }
    }

    const ownerKey = this.workspaceOwners.get(workspaceId)?.value;
    for (const thread of threads) {
      const existing = this.entries.get(thread.id);
      if (existing?.ownerKey) {
        this.removeFromIndex(
          this.cachedOwnerIndexes,
          existing.ownerKey,
          thread.id,
        );
      }
      this.entries.set(thread.id, {
        threadId: thread.id,
        source: 'runtime',
        workspaceId,
        ...(ownerKey ? { ownerKey } : {}),
        ...(thread.title
          ? { title: thread.title }
          : existing?.title
            ? { title: existing.title }
            : {}),
      });
    }
    this.workspaceIndexes.set(workspaceId, nextIds);
    this.authoritativeWorkspaces.add(workspaceId);
    this.notify();
  };

  getWorkspaceIdForOwner = (ownerKey: string): string | null =>
    this.ownerWorkspaces.get(ownerKey)?.value ?? null;

  getOwnerKey = (threadId: string): string | null =>
    this.entries.get(threadId)?.ownerKey ?? null;

  getBindingSource = (threadId: string): ThreadBindingSource | null =>
    this.entries.get(threadId)?.source ?? null;

  getWorkspaceId = (threadId: string): string | null =>
    this.entries.get(threadId)?.workspaceId ?? null;

  getTitle = (threadId: string): string | null =>
    this.entries.get(threadId)?.title ?? null;

  getOwnerView = (ownerKey: string): ThreadRegistryView => {
    const workspaceId = this.ownerWorkspaces.get(ownerKey)?.value;
    return this.createView(
      workspaceId
        ? this.workspaceIndexes.get(workspaceId) ?? []
        : this.cachedOwnerIndexes.get(ownerKey) ?? [],
    );
  };

  removeThread = (threadId: string): void => {
    const entry = this.entries.get(threadId);
    if (!entry) {
      return;
    }
    for (const workspaceId of this.workspaceIndexes.keys()) {
      this.removeFromIndex(this.workspaceIndexes, workspaceId, threadId);
    }
    for (const ownerKey of this.cachedOwnerIndexes.keys()) {
      this.removeFromIndex(this.cachedOwnerIndexes, ownerKey, threadId);
    }
    this.entries.delete(threadId);
    this.notify();
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

  private appendUnique = (
    index: Map<string, string[]>,
    key: string,
    threadId: string,
  ): void => {
    const values = index.get(key) ?? [];
    if (!values.includes(threadId)) {
      index.set(key, [...values, threadId]);
    }
  };

  private removeFromIndex = (
    index: Map<string, string[]>,
    key: string,
    threadId: string,
  ): void => {
    const values = index.get(key);
    if (!values?.includes(threadId)) {
      return;
    }
    const next = values.filter((candidate) => candidate !== threadId);
    if (next.length > 0) {
      index.set(key, next);
    } else {
      index.delete(key);
    }
  };

  private notify = (): void => {
    for (const listener of this.listeners) {
      listener();
    }
  };
}
