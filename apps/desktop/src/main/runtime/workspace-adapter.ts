import { createHash, randomUUID } from 'node:crypto';

import type { ConversationActionResult } from '../../shared/conversation.ts';
import type {
  WorkspaceEntry,
  WorkspaceInspectDocument,
  WorkspaceKind,
} from '../../shared/workspace.ts';
import type { WorkspaceRuntimeBoundary } from '../workspace/controller.ts';
import type { ThreadRegistry } from '../navigation/thread-registry.ts';
import type { RuntimeConnectionController } from './connection-controller.ts';
import type { RuntimeConversationController } from './conversation-controller.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

type RuntimeWorkspaceAdapterOptions = Readonly<{
  runtime: RuntimeSupervisor;
  connection: RuntimeConnectionController;
  conversation: RuntimeConversationController;
  threadRegistry: ThreadRegistry;
  getWorkspaceSwitchBlock: () => unknown | null;
  onWorkspaceOpened: (workspaceId: string, canonicalRoot: string) => void;
}>;

export class RuntimeWorkspaceAdapter implements WorkspaceRuntimeBoundary {
  readonly conversation: RuntimeConversationController;
  private readonly options: RuntimeWorkspaceAdapterOptions;
  private workspaceId: string | null = null;
  private canonicalRoot: string | null = null;
  private switchingRequestId: string | null = null;
  private recovering = false;

  constructor(options: RuntimeWorkspaceAdapterOptions) {
    this.options = options;
    this.conversation = options.conversation;
    options.conversation.subscribe((snapshot) => {
      const workspaceId = this.workspaceId;
      if (!workspaceId || snapshot.navigator.status !== 'ready') {
        return;
      }
      options.threadRegistry.replaceRuntimeWorkspaceIndex(
        workspaceId,
        snapshot.navigator.activeThreadIds.map((id) => ({
          id,
          workspaceId,
          ...(snapshot.navigator.activeThreadTitles[id]
            ? { title: snapshot.navigator.activeThreadTitles[id] }
            : {}),
        })),
      );
    });
    options.runtime.subscribe((event) => {
      if (
        event.type !== 'workspace.opened' ||
        event.workspaceId !== this.workspaceId ||
        event.requestId === this.switchingRequestId ||
        !this.canonicalRoot
      ) {
        return;
      }
      void this.restoreAfterRestart();
    });
  }

  subscribe = (
    listener: Parameters<RuntimeConnectionController['subscribe']>[0],
  ): (() => void) => this.options.connection.subscribe(listener);

  getWorkspaceSwitchBlock = (): unknown | null =>
    this.options.getWorkspaceSwitchBlock();

  getWorkspaceBindingId = (): string | null => this.workspaceId;

  switchWorkspace = async (
    workspacePath: string,
    _kind: WorkspaceKind,
    preferredThreadId?: string,
  ): Promise<boolean> => {
    const previousWorkspaceId = this.workspaceId;
    const previousRoot = this.canonicalRoot;
    const workspaceId = createHash('sha256').update(workspacePath).digest('hex');
    const requestId = randomUUID();
    this.workspaceId = workspaceId;
    this.canonicalRoot = workspacePath;
    this.switchingRequestId = requestId;
    try {
      const opened = await this.options.runtime.request(
        {
          type: 'workspace.open',
          requestId,
          workspaceId,
          canonicalRoot: workspacePath,
        },
        'workspace.opened',
      );
      if (
        opened.workspaceId !== workspaceId ||
        opened.canonicalRoot !== workspacePath
      ) {
        throw new Error('The runtime returned a mismatched Workspace binding.');
      }
      if (!(await this.conversation.switchWorkspace(workspaceId))) {
        throw new Error('Threads could not be restored for the workspace.');
      }
      if (preferredThreadId) {
        const selected = await this.conversation.selectThread(preferredThreadId);
        if (!selected.accepted) {
          throw new Error('The requested Thread could not be restored.');
        }
      }
      this.options.onWorkspaceOpened(workspaceId, workspacePath);
      return true;
    } catch {
      this.workspaceId = previousWorkspaceId;
      this.canonicalRoot = previousRoot;
      return false;
    } finally {
      if (this.switchingRequestId === requestId) {
        this.switchingRequestId = null;
      }
    }
  };

  deleteThread = async (
    workspaceId: string,
    threadId: string,
  ): Promise<'deleted' | 'missing'> => {
    let result: ConversationActionResult;
    if (workspaceId === this.workspaceId) {
      result = await this.conversation.deleteThread(threadId);
      if (result.accepted) {
        return 'deleted';
      }
      if (result.reason !== 'unknownThread') {
        throw new Error('The active Thread could not be deleted.');
      }
    }
    const event = await this.options.runtime.request(
      {
        type: 'thread.delete',
        requestId: randomUUID(),
        workspaceId,
        threadId,
      },
      'thread.mutated',
    );
    if (
      event.workspaceId !== workspaceId ||
      event.threadId !== threadId ||
      event.operation !== 'delete'
    ) {
      throw new Error('The runtime returned a mismatched Thread deletion.');
    }
    return event.deleted === false ? 'missing' : 'deleted';
  };

  listWorkspace = async (
    path: string,
  ): Promise<{ path: string; entries: readonly WorkspaceEntry[] }> => {
    if (!this.workspaceId) {
      throw new Error('Workspace unavailable.');
    }
    const event = await this.options.runtime.request(
      {
        type: 'workspace.list',
        requestId: randomUUID(),
        workspaceId: this.workspaceId,
        path,
      },
      'workspace.listResult',
    );
    if (event.workspaceId !== this.workspaceId || event.path !== path) {
      throw new Error('The runtime returned a mismatched Workspace listing.');
    }
    return { path: event.path, entries: event.entries };
  };

  inspectWorkspace = async (path: string): Promise<WorkspaceInspectDocument> => {
    if (!this.workspaceId) {
      throw new Error('Workspace unavailable.');
    }
    const event = await this.options.runtime.request(
      {
        type: 'workspace.inspect',
        requestId: randomUUID(),
        workspaceId: this.workspaceId,
        path,
      },
      'workspace.inspected',
    );
    if (
      event.workspaceId !== this.workspaceId ||
      event.document.path !== path
    ) {
      throw new Error('The runtime returned a mismatched Workspace document.');
    }
    return event.document;
  };

  private restoreAfterRestart = async (): Promise<void> => {
    if (this.recovering || !this.workspaceId || !this.canonicalRoot) {
      return;
    }
    this.recovering = true;
    try {
      await this.conversation.switchWorkspace(this.workspaceId);
      this.options.onWorkspaceOpened(this.workspaceId, this.canonicalRoot);
    } finally {
      this.recovering = false;
    }
  };
}
