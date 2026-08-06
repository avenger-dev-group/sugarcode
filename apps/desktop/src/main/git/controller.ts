import type {
  GitActionFailureReason,
  GitCommitRequest,
  GitCommitResult,
  GitDiffRequest,
  GitDiffResult,
  GitGenerationRequest,
  GitMutationRequest,
  GitMutationResult,
  GitPendingOperation,
  GitRefreshResult,
  GitStateSnapshot,
  WorkspaceGitCommitResponse,
  WorkspaceGitDiffResponse,
  WorkspaceGitMutationResponse,
  WorkspaceGitStatusResponse,
} from '@/shared/git';

import type { WorkspaceController } from '../workspace/controller';

type GitRuntimeBoundary = Readonly<{
  gitStatus: () => Promise<WorkspaceGitStatusResponse>;
  gitDiff: (params: {
    expectedRevision: string;
    path: string;
    source: 'worktree' | 'index';
  }) => Promise<WorkspaceGitDiffResponse>;
  gitStage: (params: { expectedRevision: string; paths: string[] }) => Promise<WorkspaceGitMutationResponse>;
  gitUnstage: (params: { expectedRevision: string; paths: string[] }) => Promise<WorkspaceGitMutationResponse>;
  gitCommit: (params: {
    expectedRevision: string;
    message: string;
    authorName: string;
    authorEmail: string;
  }) => Promise<WorkspaceGitCommitResponse>;
  beginGitTransaction: () => { release: () => void } | 'busy' | 'unavailable';
}>;

type GitControllerOptions = Readonly<{
  supervisor: GitRuntimeBoundary;
  workspace: WorkspaceController;
}>;

type Listener = (snapshot: GitStateSnapshot) => void;
type Lease = Readonly<{ release: () => void }>;

export class GitController {
  private readonly listeners = new Set<Listener>();
  private revision = 0;
  private snapshot: GitStateSnapshot;

  constructor(private readonly options: GitControllerOptions) {
    const workspace = options.workspace.getSnapshot();
    this.snapshot = {
      revision: 0,
      generation: workspace.generation,
      status: workspace.status === 'ready' ? 'idle' : 'unavailable',
    };
    options.workspace.subscribe((next) => {
      if (
        next.generation === this.snapshot.generation &&
        ((next.status === 'ready') ===
          (this.snapshot.status !== 'unavailable'))
      ) {
        return;
      }
      this.publish({
        generation: next.generation,
        status: next.status === 'ready' ? 'idle' : 'unavailable',
      });
    });
  }

  getSnapshot = (): GitStateSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  refresh = async (
    request: GitGenerationRequest,
  ): Promise<GitRefreshResult> => {
    const invalid = this.validateGeneration(request.generation);
    if (invalid) {
      return { accepted: false, reason: invalid };
    }
    const lease = this.acquireLease();
    if (typeof lease === 'string') {
      return { accepted: false, reason: lease };
    }
    this.publish({
      generation: this.snapshot.generation,
      status: this.snapshot.repository ? 'ready' : 'idle',
      pending: 'refresh',
      repository: this.snapshot.repository,
      lastCommit: this.snapshot.lastCommit,
      error: undefined,
    });
    try {
      const repository = await this.options.supervisor.gitStatus();
      if (request.generation !== this.snapshot.generation) {
        return { accepted: false, reason: 'stale' };
      }
      this.publish({
        generation: request.generation,
        status: 'ready',
        repository,
        lastCommit: this.snapshot.lastCommit,
      });
      return { accepted: true, state: this.snapshot };
    } catch {
      if (request.generation !== this.snapshot.generation) {
        return { accepted: false, reason: 'stale' };
      }
      this.publish({
        generation: request.generation,
        status: 'failed',
        error: 'Git status could not be refreshed from the local runtime.',
      });
      return { accepted: false, reason: 'failed' };
    } finally {
      lease.release();
    }
  };

  diff = async (request: GitDiffRequest): Promise<GitDiffResult> => {
    const invalid = this.validateRepositoryRequest(
      request.generation,
      request.expectedRevision,
      [request.path],
      request.source,
    );
    if (invalid) {
      return { accepted: false, reason: invalid };
    }
    const lease = this.acquireLease();
    if (typeof lease === 'string') {
      return { accepted: false, reason: lease };
    }
    this.publishPending('diff');
    try {
      const diff = await this.options.supervisor.gitDiff({
        expectedRevision: request.expectedRevision,
        path: request.path,
        source: request.source,
      });
      if (request.generation !== this.snapshot.generation) {
        return { accepted: false, reason: 'stale' };
      }
      this.clearPending(
        diff.status === 'error'
          ? describeGitError(diff.kind)
          : undefined,
      );
      return {
        accepted: true,
        generation: request.generation,
        diff,
      };
    } catch {
      this.failRead('Git diff could not be loaded from the local runtime.');
      return { accepted: false, reason: 'failed' };
    } finally {
      lease.release();
    }
  };

  stage = (request: GitMutationRequest): Promise<GitMutationResult> =>
    this.mutate(request, 'stage');

  unstage = (request: GitMutationRequest): Promise<GitMutationResult> =>
    this.mutate(request, 'unstage');

  commit = async (request: GitCommitRequest): Promise<GitCommitResult> => {
    const invalid = this.validateRepositoryRequest(
      request.generation,
      request.expectedRevision,
      [],
    );
    if (
      invalid ||
      !this.readyRepository()?.mutationAllowed ||
      (this.readyRepository()?.stagedCount ?? 0) === 0
    ) {
      return {
        accepted: false,
        reason: invalid ?? 'invalid',
      };
    }
    const lease = this.acquireLease();
    if (typeof lease === 'string') {
      return { accepted: false, reason: lease };
    }
    this.publishPending('commit');
    try {
      const receipt = await this.options.supervisor.gitCommit({
        expectedRevision: request.expectedRevision,
        message: request.message,
        authorName: request.authorName,
        authorEmail: request.authorEmail,
      });
      if (request.generation !== this.snapshot.generation) {
        return { accepted: false, reason: 'stale' };
      }
      if (receipt.status === 'error') {
        this.clearPending(describeGitError(receipt.kind));
        return { accepted: true, state: this.snapshot, receipt };
      }
      const state = await this.reconcileMutation(
        request.generation,
        receipt.revision,
        receipt,
      );
      return { accepted: true, state, receipt };
    } catch {
      this.publish({
        generation: request.generation,
        status: 'failed',
        error:
          'Commit outcome is unknown. Refresh before attempting another Git action.',
      });
      return { accepted: false, reason: 'outcomeUnknown' };
    } finally {
      lease.release();
    }
  };

  private mutate = async (
    request: GitMutationRequest,
    operation: 'stage' | 'unstage',
  ): Promise<GitMutationResult> => {
    const invalid = this.validateRepositoryRequest(
      request.generation,
      request.expectedRevision,
      request.paths,
      operation === 'stage' ? 'worktree' : 'index',
    );
    if (invalid) {
      return { accepted: false, reason: invalid };
    }
    const lease = this.acquireLease();
    if (typeof lease === 'string') {
      return { accepted: false, reason: lease };
    }
    this.publishPending(operation);
    try {
      const params = {
        expectedRevision: request.expectedRevision,
        paths: [...request.paths],
      };
      const receipt =
        operation === 'stage'
          ? await this.options.supervisor.gitStage(params)
          : await this.options.supervisor.gitUnstage(params);
      if (request.generation !== this.snapshot.generation) {
        return { accepted: false, reason: 'stale' };
      }
      if (receipt.status === 'error') {
        this.clearPending(describeGitError(receipt.kind));
        return { accepted: true, state: this.snapshot, receipt };
      }
      const state = await this.reconcileMutation(
        request.generation,
        receipt.revision,
      );
      return { accepted: true, state, receipt };
    } catch {
      this.publish({
        generation: request.generation,
        status: 'failed',
        error:
          'Git mutation outcome is unknown. Refresh before attempting another action.',
      });
      return { accepted: false, reason: 'outcomeUnknown' };
    } finally {
      lease.release();
    }
  };

  private reconcileMutation = async (
    generation: number,
    expectedRevision: string,
    lastCommit?: Extract<
      WorkspaceGitCommitResponse,
      { status: 'committed' }
    >,
  ): Promise<GitStateSnapshot> => {
    const repository = await this.options.supervisor.gitStatus();
    if (
      generation !== this.snapshot.generation ||
      repository.status !== 'ready' ||
      repository.revision !== expectedRevision
    ) {
      throw new Error('Git mutation receipt did not reconcile.');
    }
    this.publish({
      generation,
      status: 'ready',
      repository,
      lastCommit: lastCommit ?? this.snapshot.lastCommit,
    });
    return this.snapshot;
  };

  private validateGeneration = (
    generation: number,
  ): GitActionFailureReason | null => {
    const workspace = this.options.workspace.getSnapshot();
    if (
      generation !== this.snapshot.generation ||
      generation !== workspace.generation
    ) {
      return 'stale';
    }
    if (workspace.status !== 'ready') {
      return 'unavailable';
    }
    return null;
  };

  private validateRepositoryRequest = (
    generation: number,
    expectedRevision: string,
    paths: readonly string[],
    source?: 'worktree' | 'index',
  ): GitActionFailureReason | null => {
    const generationError = this.validateGeneration(generation);
    if (generationError) {
      return generationError;
    }
    const repository = this.readyRepository();
    if (!repository || repository.revision !== expectedRevision) {
      return 'stale';
    }
    for (const path of paths) {
      const entry = repository.entries.find(
        (candidate) => candidate.path === path,
      );
      if (
        !entry ||
        (source === 'worktree' &&
          (!entry.worktree || !entry.stageable)) ||
        (source === 'index' && !entry.index)
      ) {
        return 'invalid';
      }
    }
    return null;
  };

  private readyRepository = (): Extract<
    WorkspaceGitStatusResponse,
    { status: 'ready' }
  > | null =>
    this.snapshot.repository?.status === 'ready'
      ? this.snapshot.repository
      : null;

  private acquireLease = (): Lease | GitActionFailureReason => {
    const lease = this.options.supervisor.beginGitTransaction();
    if (typeof lease !== 'string') {
      return lease;
    }
    return lease === 'unavailable' ? 'unavailable' : 'busy';
  };

  private publishPending = (pending: GitPendingOperation): void => {
    this.publish({
      generation: this.snapshot.generation,
      status: this.snapshot.status,
      pending,
      repository: this.snapshot.repository,
      lastCommit: this.snapshot.lastCommit,
      error: undefined,
    });
  };

  private clearPending = (error?: string): void => {
    this.publish({
      generation: this.snapshot.generation,
      status: this.snapshot.repository ? 'ready' : 'idle',
      repository: this.snapshot.repository,
      lastCommit: this.snapshot.lastCommit,
      error,
    });
  };

  private failRead = (message: string): void => {
    this.publish({
      generation: this.snapshot.generation,
      status: this.snapshot.repository ? 'ready' : 'failed',
      repository: this.snapshot.repository,
      lastCommit: this.snapshot.lastCommit,
      error: message,
    });
  };

  private publish = (
    next: Omit<GitStateSnapshot, 'revision'>,
  ): void => {
    this.revision += 1;
    this.snapshot = {
      ...next,
      revision: this.revision,
    };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };
}

const describeGitError = (
  kind:
    | Extract<WorkspaceGitMutationResponse, { status: 'error' }>['kind']
    | Extract<WorkspaceGitCommitResponse, { status: 'error' }>['kind'],
): string => {
  switch (kind) {
    case 'stale':
      return 'The repository changed. Refresh before retrying.';
    case 'indexLocked':
      return 'The Git index is locked by another process.';
    case 'tooLarge':
      return 'This Git operation exceeds the bounded workbench limits.';
    case 'unsupportedPath':
      return 'This path type cannot be changed safely in the workbench.';
    case 'repositoryState':
      return 'Finish the current merge, rebase, or recovery operation elsewhere.';
    case 'nothingToCommit':
      return 'The staged index does not contain a commit.';
    default:
      return `Git operation failed: ${kind}.`;
  }
};
