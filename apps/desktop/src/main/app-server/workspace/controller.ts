import type {
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspaceSelectResult,
  WorkspaceStateSnapshot,
} from '@/shared/workspace';
import type { BrowserWindow, Dialog, OpenDialogOptions } from 'electron';
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
  beforeWorkspaceSwitch?: () => Promise<void>;
}>;

type Listener = (snapshot: WorkspaceStateSnapshot) => void;

export type WorkspaceLaunchContext = Readonly<{
  generation: number;
  path: string;
  name: string;
}>;

type StoredSession = Readonly<{
  schemaVersion: 1;
  path: string;
  threadId?: string;
}>;

export class WorkspaceController {
  private readonly listeners = new Set<Listener>();
  private revision = 0;
  private generation = 0;
  private workspacePath: string | null = null;
  private storedThreadId: string | undefined;
  private snapshot: WorkspaceStateSnapshot = {
    revision: 0,
    generation: 0,
    status: 'unselected',
  };

  constructor(private readonly options: WorkspaceControllerOptions) {
    this.options.supervisor.subscribe((connection) => {
      if (!this.workspacePath) {
        return;
      }
      if (connection.status === 'ready') {
        this.publish('ready');
      } else if (connection.status === 'failed') {
        this.publish('failed', 'The selected workspace could not be opened safely.');
      }
    });
    this.options.supervisor.conversation.subscribe((conversation) => {
      if (
        this.workspacePath &&
        conversation.threadId &&
        conversation.threadId !== this.storedThreadId
      ) {
        this.storedThreadId = conversation.threadId;
        void this.persist();
      }
    });
  }

  getSnapshot = (): WorkspaceStateSnapshot => this.snapshot;

  getLaunchContext = (): WorkspaceLaunchContext | null =>
    this.workspacePath && this.snapshot.status === 'ready'
      ? {
          generation: this.generation,
          path: this.workspacePath,
          name: path.basename(this.workspacePath),
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
    const validated = await validateDirectory(stored.path);
    if (!validated) {
      this.publish('failed', 'The saved workspace is missing or no longer allowed.');
      return;
    }
    this.workspacePath = validated;
    this.storedThreadId = stored.threadId;
    this.generation = 1;
    this.options.supervisor.configureInitialWorkspace(
      validated,
      stored.threadId,
    );
    this.publish('selecting');
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
      title: 'Choose a SugarCode workspace',
      buttonLabel: 'Use workspace',
      properties: ['openDirectory'],
    };
    const picked = await this.options.dialog.showOpenDialog(window, options);
    if (picked.canceled || picked.filePaths.length !== 1) {
      return { accepted: false, reason: 'cancelled' };
    }
    const selected = await validateDirectory(picked.filePaths[0]);
    if (!selected) {
      this.publish('failed', 'The selected directory is missing, linked, or inaccessible.');
      return { accepted: false, reason: 'invalid' };
    }
    if (selected === this.workspacePath) {
      this.publish('ready');
      return { accepted: true };
    }
    if (this.workspacePath) {
      const confirmation = await this.options.dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Switch workspace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Switch workspace?',
        message: 'Switching closes the current local runtime.',
        detail:
          'The current Thread is not rebound. SugarCode will start a new workspace session and MCP servers will remain disabled.',
      });
      if (confirmation.response !== 0) {
        return { accepted: false, reason: 'cancelled' };
      }
    }

    await this.options.beforeWorkspaceSwitch?.();
    this.publish('selecting');
    const hadWorkspace = this.workspacePath !== null;
    if (!(await this.options.supervisor.switchWorkspace(selected))) {
      this.publish(
        hadWorkspace ? 'ready' : 'failed',
        hadWorkspace
          ? 'The new workspace was rejected. The previous workspace was restored.'
          : 'The local runtime could not bind the selected workspace.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.workspacePath = selected;
    this.storedThreadId = undefined;
    this.generation += 1;
    try {
      await this.persist();
    } catch {
      this.publish(
        'failed',
        'The workspace opened, but its restart record could not be saved.',
      );
      return { accepted: false, reason: 'failed' };
    }
    this.publish('ready');
    return { accepted: true };
  };

  list = async (request: WorkspaceListRequest): Promise<WorkspaceListResult> => {
    if (
      request.generation !== this.generation ||
      this.snapshot.status !== 'ready'
    ) {
      return {
        accepted: false,
        reason:
          request.generation !== this.generation ? 'stale' : 'unavailable',
      };
    }
    try {
      const response = await this.options.supervisor.listWorkspace(request.path);
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
          request.generation !== this.generation ? 'stale' : 'unavailable',
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

  private publish = (
    status: WorkspaceStateSnapshot['status'],
    error?: string,
  ): void => {
    this.revision += 1;
    this.snapshot = {
      revision: this.revision,
      generation: this.generation,
      status,
      ...(this.workspacePath
        ? { name: path.basename(this.workspacePath) }
        : {}),
      ...(error ? { error } : {}),
    };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };

  private readStoredSession = async (): Promise<StoredSession | null> => {
    try {
      const metadata = await lstat(this.options.sessionPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        return null;
      }
      const value: unknown = JSON.parse(
        await readFile(this.options.sessionPath, 'utf8'),
      );
      if (
        !isStoredSession(value) ||
        Buffer.byteLength(value.path, 'utf8') > 4096
      ) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  };

  private persist = async (): Promise<void> => {
    if (!this.workspacePath) {
      return;
    }
    await mkdir(path.dirname(this.options.sessionPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.options.sessionPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({
          schemaVersion: 1,
          path: this.workspacePath,
          ...(this.storedThreadId
            ? { threadId: this.storedThreadId }
            : {}),
        })}\n`,
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

const isStoredSession = (value: unknown): value is StoredSession => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      ['schemaVersion', 'path', 'threadId'].includes(key)
    ) &&
    record.schemaVersion === 1 &&
    typeof record.path === 'string' &&
    path.isAbsolute(record.path) &&
    (record.threadId === undefined ||
      (typeof record.threadId === 'string' &&
        /^thr_(?:[0-9]{16}|[1-9][0-9]{16,19})$/u.test(record.threadId)))
  );
};

const validateDirectory = async (candidate: string): Promise<string | null> => {
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
