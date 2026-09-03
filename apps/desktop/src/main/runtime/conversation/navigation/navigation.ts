import { randomUUID } from 'node:crypto';
import {
  isValidThreadSearchInput,
  type ConversationActionResult,
  type ConversationThreadNavigatorSnapshot,
} from '../../../../shared/conversation.ts';
import type { RuntimeThreadRecord } from '../../../../runtime/contracts/protocol.ts';
import { projectThread } from '../projection/project-thread.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';
import {
  accepted,
  rejected,
} from '../action-result.ts';
import {
  emptyNavigator,
  withoutNavigatorFields,
} from './state.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'publish'
  | 'runtime'
  | 'publishThreadProjection'
  | 'applyRuntimeQueue'
  | 'goals'
  | 'dispatchQueuedMessage'
  | 'projections'
>;

export class ConversationNavigation {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  switchWorkspace = async (workspaceId: string): Promise<boolean> => {
    const generation = ++this.state.workspaceGeneration;
    this.state.threadSelectionGeneration += 1;
    this.state.workspaceId = workspaceId;
    this.state.threadId = null;
    this.state.available = false;
    this.state.navigator = { ...emptyNavigator(), status: 'loading' };
    this.state.notice = undefined;
    this.refreshNavigator('loading');
    this.context.publish();
    try {
      const event = await this.context.runtime.request(
        { type: 'thread.list', requestId: randomUUID(), workspaceId },
        'thread.listResult',
      );
      if (
        this.state.workspaceGeneration !== generation ||
        this.state.workspaceId !== workspaceId
      ) {
        return true;
      }
      this.state.available = true;
      this.applyThreadList(workspaceId, event.threads);
      this.context.publish();
      return true;
    } catch {
      if (
        this.state.workspaceGeneration === generation &&
        this.state.workspaceId === workspaceId
      ) {
        this.state.navigator = { ...this.state.navigator, status: 'error' };
        this.state.notice = {
          kind: 'requestFailed',
          summary: 'Threads could not be loaded from local storage.',
        };
        this.context.publish();
      }
      return false;
    }
  };

  searchThreads = async (query: unknown): Promise<ConversationActionResult> => {
    if (!isValidThreadSearchInput(query)) {
      return rejected('invalidSearch');
    }
    if (!this.state.workspaceId) {
      return rejected('unavailable');
    }
    const workspaceId = this.state.workspaceId;
    const normalizedQuery = query.trim();
    this.state.navigator = {
      ...this.state.navigator,
      search: {
        ...this.state.navigator.search,
        query: normalizedQuery,
        status: 'loading',
      },
    };
    this.context.publish();
    try {
      const event = await this.context.runtime.request(
        {
          type: 'thread.list',
          requestId: randomUUID(),
          workspaceId,
          query: normalizedQuery,
        },
        'thread.listResult',
      );
      if (
        this.state.workspaceId !== workspaceId ||
        this.state.navigator.search.query !== normalizedQuery
      ) {
        return accepted();
      }
      const titles = Object.fromEntries(
        event.threads.flatMap((thread) =>
          thread.title ? [[thread.id, thread.title]] : [],
        ),
      );
      this.state.navigator = {
        ...this.state.navigator,
        search: {
          query: normalizedQuery,
          status: event.threads.length > 0 ? 'ready' : 'empty',
          threadIds: event.threads.map((thread) => thread.id),
          threadTitles: titles,
          truncated: event.threads.length === 200,
        },
      };
      this.context.publish();
      return accepted();
    } catch {
      if (
        this.state.workspaceId !== workspaceId ||
        this.state.navigator.search.query !== normalizedQuery
      ) {
        return accepted();
      }
      this.state.navigator = {
        ...this.state.navigator,
        search: { ...this.state.navigator.search, status: 'error' },
      };
      this.context.publish();
      return rejected('unavailable');
    }
  };

  selectThread = async (
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string') {
      return rejected('unknownThread');
    }
    const thread = this.state.threadRecords.get(threadId);
    if (!thread || thread.workspaceId !== this.state.workspaceId) {
      return rejected('unknownThread');
    }
    if (!this.state.workspaceId) {
      return rejected('unavailable');
    }
    const selectionGeneration = ++this.state.threadSelectionGeneration;
    const workspaceId = this.state.workspaceId;
    if (threadId === this.state.threadId) {
      this.state.unreadThreadStatuses.delete(threadId);
      this.refreshNavigator();
      this.state.navigator = withoutNavigatorFields(this.state.navigator, [
        'pendingThreadId',
        'selectionNotice',
      ]);
      this.context.publish();
      this.context.publishThreadProjection(threadId);
      return accepted();
    }
    if (
      this.state.workspaceId &&
      this.state.pendingTurnStartWorkspaces.has(this.state.workspaceId)
    ) {
      return rejected('turnActive');
    }
    if (
      this.state.activeTurnsByThread.has(threadId) &&
      this.state.turnsByThread.has(threadId)
    ) {
      this.state.threadId = threadId;
      this.state.unreadThreadStatuses.delete(threadId);
      this.refreshNavigator();
      this.state.navigator = withoutNavigatorFields(this.state.navigator, [
        'pendingThreadId',
        'selectionNotice',
      ]);
      this.context.publish();
      this.context.publishThreadProjection(threadId);
      return accepted();
    }
    this.state.navigator = {
      ...withoutNavigatorFields(this.state.navigator, ['selectionNotice']),
      pendingThreadId: threadId,
    };
    this.context.publish();
    try {
      const event = await this.context.runtime.request(
        { type: 'thread.load', requestId: randomUUID(), workspaceId, threadId },
        'thread.loaded',
      );
      if (
        event.workspaceId !== workspaceId ||
        event.snapshot.thread.workspaceId !== workspaceId
      ) {
        throw new Error('Thread crossed workspace ownership.');
      }
      if (
        this.state.workspaceId !== workspaceId ||
        this.state.threadSelectionGeneration !== selectionGeneration
      ) {
        return accepted();
      }
      this.state.threadId = threadId;
      this.state.turnsByThread.set(threadId, [...projectThread(event.snapshot)]);
      this.context.applyRuntimeQueue(threadId, event.snapshot.queue);
      this.context.goals.apply(threadId, event.snapshot.goal);
      this.state.unreadThreadStatuses.delete(threadId);
      this.refreshNavigator();
      this.state.navigator = withoutNavigatorFields(this.state.navigator, [
        'pendingThreadId',
        'selectionNotice',
      ]);
      this.context.publish();
      this.context.publishThreadProjection(threadId, true);
      void this.context.dispatchQueuedMessage(threadId);
      return accepted();
    } catch {
      if (
        this.state.workspaceId !== workspaceId ||
        this.state.threadSelectionGeneration !== selectionGeneration
      ) {
        return accepted();
      }
      this.state.navigator = {
        ...this.state.navigator,
        pendingThreadId: threadId,
        selectionNotice:
          'That Thread could not be restored safely. Select it to retry.',
      };
      this.context.publish();
      return rejected('unavailable');
    }
  };

  startNewThread = (): ConversationActionResult => {
    const pendingTurnStart = this.state.workspaceId
      ? this.state.pendingTurnStartWorkspaces.has(this.state.workspaceId)
      : false;
    if (!this.state.workspaceId || !this.state.available || pendingTurnStart) {
      return rejected(pendingTurnStart ? 'turnActive' : 'unavailable');
    }
    this.state.threadSelectionGeneration += 1;
    this.state.threadId = null;
    this.state.navigator = withoutNavigatorFields(this.state.navigator, [
      'pendingThreadId',
      'selectionNotice',
    ]);
    this.context.publish();
    return accepted();
  };

  private applyThreadList = (
    workspaceId: string,
    threads: readonly RuntimeThreadRecord[],
  ): void => {
    for (const [threadId, thread] of this.state.threadRecords) {
      if (
        thread.workspaceId === workspaceId &&
        !this.state.activeTurnsByThread.has(threadId)
      ) {
        this.state.threadRecords.delete(threadId);
        this.state.turnsByThread.delete(threadId);
        this.state.queuesByThread.delete(threadId);
        this.state.runtimeQueuesByThread.delete(threadId);
        this.context.goals.forget(threadId);
        this.context.projections.forgetThread(threadId);
      }
    }
    for (const thread of threads) {
      this.state.threadRecords.set(thread.id, thread);
    }
    this.refreshNavigator();
  };

  ensureSelectedThread = async (workspaceId: string): Promise<string> => {
    if (this.state.threadId) return this.state.threadId;
    const created = await this.context.runtime.request(
      {
        type: 'thread.create',
        requestId: randomUUID(),
        workspaceId,
      },
      'thread.mutated',
    );
    if (!created.snapshot) {
      throw new Error('The local runtime did not return the new Thread.');
    }
    this.state.threadRecords.set(created.threadId, created.snapshot.thread);
    this.state.turnsByThread.set(created.threadId, []);
    this.context.applyRuntimeQueue(created.threadId, created.snapshot.queue);
    this.context.goals.apply(created.threadId, created.snapshot.goal);
    if (this.state.workspaceId === workspaceId && !this.state.threadId) {
      this.state.threadSelectionGeneration += 1;
      this.state.threadId = created.threadId;
    }
    this.refreshNavigator();
    return created.threadId;
  };

  refreshNavigator = (
    status: ConversationThreadNavigatorSnapshot['status'] = this.state.available
      ? 'ready'
      : this.state.navigator.status,
  ): void => {
    const threads = [...this.state.threadRecords.values()]
      .filter((thread) => thread.workspaceId === this.state.workspaceId)
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
      );
    this.state.navigator = {
      ...withoutNavigatorFields(this.state.navigator, ['unreadThreadStatuses']),
      status,
      activeThreadIds: threads.map((thread) => thread.id),
      activeThreadTitles: Object.fromEntries(
        threads.flatMap((thread) =>
          thread.title ? [[thread.id, thread.title]] : [],
        ),
      ),
      activeTruncated: threads.length === 200,
      runningThreadIds: [...this.state.activeTurnsByThread.keys()],
      inputRequiredThreadIds: [...this.state.activeTurnsByThread.entries()].flatMap(
        ([threadId, activeTurn]) =>
          this.state.turnsByThread
            .get(threadId)
            ?.find((turn) => turn.id === activeTurn.turnId)?.userInputRequest
            ? [threadId]
            : [],
      ),
      ...(this.state.unreadThreadStatuses.size > 0
        ? {
            unreadThreadStatuses: Object.fromEntries(this.state.unreadThreadStatuses),
          }
        : {}),
    };
  };
}
