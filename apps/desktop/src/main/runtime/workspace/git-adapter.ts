import { randomUUID } from 'node:crypto';
import type {
  WorkspaceGitCommitResponse,
  WorkspaceGitDiffResponse,
  WorkspaceGitMutationResponse,
  WorkspaceGitStatusResponse,
} from '../../../shared/git.ts';

import type { RuntimeSupervisor } from '../connection/supervisor.ts';

type GitDiffParams = Readonly<{
  expectedRevision: string;
  path: string;
  source: 'worktree' | 'index';
}>;
type GitMutationParams = Readonly<{
  expectedRevision: string;
  paths: readonly string[];
}>;
type GitCommitParams = Readonly<{
  expectedRevision: string;
  message: string;
  authorName: string;
  authorEmail: string;
}>;

export class RuntimeGitAdapter {
  private readonly runtime: RuntimeSupervisor;
  private workspaceId: string | null = null;
  private threadId: string | null = null;
  private transactionWorkspaceId: string | null = null;
  private transactionThreadId: string | null = null;

  constructor(runtime: RuntimeSupervisor) {
    this.runtime = runtime;
  }

  openWorkspace = (workspaceId: string): void => {
    this.workspaceId = workspaceId;
    this.threadId = null;
  };

  selectThread = (workspaceId: string | undefined, threadId: string | undefined): void => {
    this.threadId = workspaceId === this.workspaceId ? threadId ?? null : null;
  };

  beginGitTransaction = (): { release: () => void } | 'busy' | 'unavailable' => {
    if (!this.workspaceId) {
      return 'unavailable';
    }
    if (this.transactionWorkspaceId) {
      return 'busy';
    }
    this.transactionWorkspaceId = this.workspaceId;
    this.transactionThreadId = this.threadId;
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.transactionWorkspaceId = null;
          this.transactionThreadId = null;
        }
      },
    };
  };

  gitStatus = async (): Promise<WorkspaceGitStatusResponse> =>
    this.request('status', {
      type: 'git.status',
      requestId: randomUUID(),
      workspaceId: this.requireWorkspace(),
      ...this.threadCoordinates(),
    }) as Promise<WorkspaceGitStatusResponse>;

  gitDiff = async (
    params: GitDiffParams,
  ): Promise<WorkspaceGitDiffResponse> =>
    this.request('diff', {
      type: 'git.diff',
      requestId: randomUUID(),
      workspaceId: this.requireWorkspace(),
      ...this.threadCoordinates(),
      expectedRevision: params.expectedRevision,
      path: params.path,
      source: params.source,
    }) as Promise<WorkspaceGitDiffResponse>;

  gitStage = async (
    params: GitMutationParams,
  ): Promise<WorkspaceGitMutationResponse> =>
    this.mutate('stage', params);

  gitUnstage = async (
    params: GitMutationParams,
  ): Promise<WorkspaceGitMutationResponse> =>
    this.mutate('unstage', params);

  gitCommit = async (
    params: GitCommitParams,
  ): Promise<WorkspaceGitCommitResponse> =>
    this.request('commit', {
      type: 'git.commit',
      requestId: randomUUID(),
      workspaceId: this.requireWorkspace(),
      ...this.threadCoordinates(),
      expectedRevision: params.expectedRevision,
      message: params.message,
      authorName: params.authorName,
      authorEmail: params.authorEmail,
    }) as Promise<WorkspaceGitCommitResponse>;

  private mutate = async (
    operation: 'stage' | 'unstage',
    params: GitMutationParams,
  ): Promise<WorkspaceGitMutationResponse> =>
    this.request(operation, {
      type: `git.${operation}`,
      requestId: randomUUID(),
      workspaceId: this.requireWorkspace(),
      ...this.threadCoordinates(),
      expectedRevision: params.expectedRevision,
      paths: params.paths,
    }) as Promise<WorkspaceGitMutationResponse>;

  private request = async (
    operation: 'status' | 'diff' | 'stage' | 'unstage' | 'commit',
    command: Parameters<RuntimeSupervisor['request']>[0],
  ): Promise<unknown> => {
    const event = await this.runtime.request(command, 'git.result');
    if (event.operation !== operation) {
      throw new Error(`Runtime returned ${event.operation} for Git ${operation}.`);
    }
    return event.result;
  };

  private requireWorkspace = (): string => {
    if (this.transactionWorkspaceId) {
      return this.transactionWorkspaceId;
    }
    if (!this.workspaceId) {
      throw new Error('No workspace is open for Git.');
    }
    return this.workspaceId;
  };

  private currentThreadId = (): string | null =>
    this.transactionWorkspaceId ? this.transactionThreadId : this.threadId;

  private threadCoordinates = (): Readonly<{ threadId?: string }> => {
    const threadId = this.currentThreadId();
    return threadId ? { threadId } : {};
  };
}
