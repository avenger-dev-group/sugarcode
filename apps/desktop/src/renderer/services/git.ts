import type {
  GitCommitRequest,
  GitCommitResult,
  GitDiffRequest,
  GitDiffResult,
  GitGenerationRequest,
  GitMutationRequest,
  GitMutationResult,
  GitRefreshResult,
  GitStateSnapshot,
} from '@/shared/git';

export const getGitState = (): Promise<GitStateSnapshot> =>
  window.sugarcode.getGitState();

export const onGitStateChanged = (
  listener: (snapshot: GitStateSnapshot) => void,
): (() => void) => window.sugarcode.onGitStateChanged(listener);

export const refreshGitStatus = (
  request: GitGenerationRequest,
): Promise<GitRefreshResult> =>
  window.sugarcode.refreshGitStatus(request);

export const loadGitDiff = (
  request: GitDiffRequest,
): Promise<GitDiffResult> =>
  window.sugarcode.loadGitDiff(request);

export const stageGitPaths = (
  request: GitMutationRequest,
): Promise<GitMutationResult> =>
  window.sugarcode.stageGitPaths(request);

export const unstageGitPaths = (
  request: GitMutationRequest,
): Promise<GitMutationResult> =>
  window.sugarcode.unstageGitPaths(request);

export const commitGitIndex = (
  request: GitCommitRequest,
): Promise<GitCommitResult> =>
  window.sugarcode.commitGitIndex(request);
