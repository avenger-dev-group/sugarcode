export type WorkspaceGitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'typeChanged'
  | 'conflicted'
  | 'untracked';

export type WorkspaceGitRepositoryState =
  | 'clean'
  | 'merge'
  | 'revert'
  | 'revertSequence'
  | 'cherryPick'
  | 'cherryPickSequence'
  | 'bisect'
  | 'rebase'
  | 'rebaseInteractive'
  | 'rebaseMerge'
  | 'applyMailbox'
  | 'applyMailboxOrRebase';

export type WorkspaceGitErrorKind =
  | 'notRepository'
  | 'unsupportedRepository'
  | 'invalidPath'
  | 'stale'
  | 'nothingToCommit'
  | 'tooLarge'
  | 'unsupportedPath'
  | 'unborn'
  | 'detached'
  | 'repositoryState'
  | 'indexLocked'
  | 'changed'
  | 'unavailable';

export type WorkspaceGitStatusResponse =
  | Readonly<{
      status: 'ready';
      revision: string;
      branch?: string;
      head?: string;
      repositoryState: WorkspaceGitRepositoryState;
      mutationAllowed: boolean;
      entries: readonly Readonly<{
        path: string;
        index?: WorkspaceGitChangeKind;
        worktree?: WorkspaceGitChangeKind;
        stageable: boolean;
      }>[];
      stagedCount: number;
      unstagedCount: number;
      unsupportedPaths: number;
    }>
  | Readonly<{ status: 'error'; kind: WorkspaceGitErrorKind }>;

export type WorkspaceGitDiffResponse =
  | Readonly<{
      status: 'ready';
      revision: string;
      path: string;
      source: 'worktree' | 'index';
      content: string;
      additions: number;
      deletions: number;
    }>
  | Readonly<{ status: 'error'; kind: WorkspaceGitErrorKind }>;

export type WorkspaceGitMutationResponse =
  | Readonly<{ status: 'applied'; revision: string; paths: readonly string[] }>
  | Readonly<{ status: 'error'; kind: WorkspaceGitErrorKind }>;

export type WorkspaceGitCommitResponse =
  | Readonly<{
      status: 'committed';
      revision: string;
      oldHead: string;
      newHead: string;
    }>
  | Readonly<{ status: 'error'; kind: WorkspaceGitErrorKind }>;

export const GIT_STATE_GET_CHANNEL = 'git-state:get';
export const GIT_STATE_CHANGED_CHANNEL = 'git-state:changed';
export const GIT_REFRESH_CHANNEL = 'git:refresh';
export const GIT_DIFF_CHANNEL = 'git:diff';
export const GIT_STAGE_CHANNEL = 'git:stage';
export const GIT_UNSTAGE_CHANNEL = 'git:unstage';
export const GIT_COMMIT_CHANNEL = 'git:commit';

export type GitPendingOperation =
  | 'refresh'
  | 'diff'
  | 'stage'
  | 'unstage'
  | 'commit';

export type GitStateSnapshot = Readonly<{
  revision: number;
  generation: number;
  status: 'unavailable' | 'idle' | 'ready' | 'failed';
  pending?: GitPendingOperation;
  repository?: WorkspaceGitStatusResponse;
  error?: string;
  lastCommit?: Extract<WorkspaceGitCommitResponse, { status: 'committed' }>;
}>;

export type GitGenerationRequest = Readonly<{
  generation: number;
}>;

export type GitDiffRequest = Readonly<{
  generation: number;
  expectedRevision: string;
  path: string;
  source: 'worktree' | 'index';
}>;

export type GitMutationRequest = Readonly<{
  generation: number;
  expectedRevision: string;
  paths: readonly string[];
}>;

export type GitCommitRequest = Readonly<{
  generation: number;
  expectedRevision: string;
  message: string;
  authorName: string;
  authorEmail: string;
}>;

export type GitActionFailureReason =
  | 'stale'
  | 'busy'
  | 'unavailable'
  | 'invalid'
  | 'outcomeUnknown'
  | 'failed';

export type GitRefreshResult =
  | Readonly<{ accepted: true; state: GitStateSnapshot }>
  | Readonly<{ accepted: false; reason: GitActionFailureReason }>;

export type GitDiffResult =
  | Readonly<{
      accepted: true;
      generation: number;
      diff: WorkspaceGitDiffResponse;
    }>
  | Readonly<{ accepted: false; reason: GitActionFailureReason }>;

export type GitMutationResult =
  | Readonly<{
      accepted: true;
      state: GitStateSnapshot;
      receipt: WorkspaceGitMutationResponse;
    }>
  | Readonly<{ accepted: false; reason: GitActionFailureReason }>;

export type GitCommitResult =
  | Readonly<{
      accepted: true;
      state: GitStateSnapshot;
      receipt: WorkspaceGitCommitResponse;
    }>
  | Readonly<{ accepted: false; reason: GitActionFailureReason }>;

export type GitApi = Readonly<{
  getGitState: () => Promise<GitStateSnapshot>;
  onGitStateChanged: (
    listener: (snapshot: GitStateSnapshot) => void,
  ) => () => void;
  refreshGitStatus: (
    request: GitGenerationRequest,
  ) => Promise<GitRefreshResult>;
  loadGitDiff: (request: GitDiffRequest) => Promise<GitDiffResult>;
  stageGitPaths: (
    request: GitMutationRequest,
  ) => Promise<GitMutationResult>;
  unstageGitPaths: (
    request: GitMutationRequest,
  ) => Promise<GitMutationResult>;
  commitGitIndex: (
    request: GitCommitRequest,
  ) => Promise<GitCommitResult>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    }
  }
  return leftBytes.length - rightBytes.length;
};

const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

const isOid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);

const isSafePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  byteLength(value) <= 1_024 &&
  !value.startsWith('/') &&
  !value.startsWith('\\') &&
  value.split(/[\\/]/u).length <= 64 &&
  !value
    .split(/[\\/]/u)
    .some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..',
    ) &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const ERROR_KINDS = [
  'notRepository',
  'unsupportedRepository',
  'invalidPath',
  'stale',
  'nothingToCommit',
  'tooLarge',
  'unsupportedPath',
  'unborn',
  'detached',
  'repositoryState',
  'indexLocked',
  'changed',
  'unavailable',
];
const CHANGE_KINDS = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'typeChanged',
  'conflicted',
  'untracked',
];
const REPOSITORY_STATES = [
  'clean',
  'merge',
  'revert',
  'revertSequence',
  'cherryPick',
  'cherryPickSequence',
  'bisect',
  'rebase',
  'rebaseInteractive',
  'rebaseMerge',
  'applyMailbox',
  'applyMailboxOrRebase',
];

const isGitErrorResponse = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ['status', 'kind']) &&
  value.status === 'error' &&
  ERROR_KINDS.includes(value.kind as string);

export const isGitStatusResponse = (
  value: unknown,
): value is WorkspaceGitStatusResponse => {
  if (isGitErrorResponse(value)) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'status',
      'revision',
      'branch',
      'head',
      'repositoryState',
      'mutationAllowed',
      'entries',
      'stagedCount',
      'unstagedCount',
      'unsupportedPaths',
    ]) ||
    value.status !== 'ready' ||
    !isRevision(value.revision) ||
    (value.branch !== undefined &&
      (typeof value.branch !== 'string' ||
        value.branch.length === 0 ||
        byteLength(value.branch) > 1_024)) ||
    (value.head !== undefined && !isOid(value.head)) ||
    !REPOSITORY_STATES.includes(value.repositoryState as string) ||
    typeof value.mutationAllowed !== 'boolean' ||
    !Array.isArray(value.entries) ||
    value.entries.length > 1_000 ||
    !Number.isSafeInteger(value.stagedCount) ||
    (value.stagedCount as number) < 0 ||
    !Number.isSafeInteger(value.unstagedCount) ||
    (value.unstagedCount as number) < 0 ||
    !Number.isSafeInteger(value.unsupportedPaths) ||
    (value.unsupportedPaths as number) < 0 ||
    (value.unsupportedPaths as number) > 1_000 ||
    value.mutationAllowed !==
      (value.repositoryState === 'clean' &&
        value.unsupportedPaths === 0)
  ) {
    return false;
  }
  let totalPathBytes = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let previousPath: string | undefined;
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ['path', 'index', 'worktree', 'stageable']) ||
      !isSafePath(entry.path) ||
      typeof entry.stageable !== 'boolean' ||
      (entry.index !== undefined &&
        !CHANGE_KINDS.includes(entry.index as string)) ||
      (entry.worktree !== undefined &&
        !CHANGE_KINDS.includes(entry.worktree as string)) ||
      (entry.index === undefined && entry.worktree === undefined) ||
      (previousPath !== undefined &&
        compareUtf8(previousPath, entry.path) >= 0)
    ) {
      return false;
    }
    previousPath = entry.path;
    totalPathBytes += byteLength(entry.path);
    stagedCount += entry.index === undefined ? 0 : 1;
    unstagedCount += entry.worktree === undefined ? 0 : 1;
    if (totalPathBytes > 256 * 1_024) {
      return false;
    }
  }
  return (
    value.stagedCount === stagedCount &&
    value.unstagedCount === unstagedCount
  );
};

export const isGitDiffResponse = (
  value: unknown,
): value is WorkspaceGitDiffResponse =>
  isGitErrorResponse(value) ||
  (isRecord(value) &&
    hasOnlyKeys(value, [
      'status',
      'revision',
      'path',
      'source',
      'content',
      'additions',
      'deletions',
    ]) &&
    value.status === 'ready' &&
    isRevision(value.revision) &&
    isSafePath(value.path) &&
    ['worktree', 'index'].includes(value.source as string) &&
    typeof value.content === 'string' &&
    byteLength(value.content) <= 512 * 1_024 &&
    Number.isSafeInteger(value.additions) &&
    (value.additions as number) >= 0 &&
    (value.additions as number) <= 20_000 &&
    Number.isSafeInteger(value.deletions) &&
    (value.deletions as number) >= 0 &&
    (value.deletions as number) <= 20_000 &&
    value.content.split('\n').length <= 20_001);

export const isGitMutationResponse = (
  value: unknown,
): value is WorkspaceGitMutationResponse =>
  isGitErrorResponse(value) ||
  (isRecord(value) &&
    hasOnlyKeys(value, ['status', 'revision', 'paths']) &&
    value.status === 'applied' &&
    isRevision(value.revision) &&
    Array.isArray(value.paths) &&
    value.paths.length > 0 &&
    value.paths.length <= 100 &&
    value.paths.every(isSafePath));

export const isGitCommitResponse = (
  value: unknown,
): value is WorkspaceGitCommitResponse =>
  isGitErrorResponse(value) ||
  (isRecord(value) &&
    hasOnlyKeys(value, [
      'status',
      'revision',
      'oldHead',
      'newHead',
    ]) &&
    value.status === 'committed' &&
    isRevision(value.revision) &&
    isOid(value.oldHead) &&
    isOid(value.newHead) &&
    value.oldHead !== value.newHead);

export const isGitGenerationRequest = (
  value: unknown,
): value is GitGenerationRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation']) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0;

export const isGitDiffRequest = (
  value: unknown,
): value is GitDiffRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    'generation',
    'expectedRevision',
    'path',
    'source',
  ]) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  isRevision(value.expectedRevision) &&
  isSafePath(value.path) &&
  ['worktree', 'index'].includes(value.source as string);

export const isGitMutationRequest = (
  value: unknown,
): value is GitMutationRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'expectedRevision', 'paths']) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  isRevision(value.expectedRevision) &&
  Array.isArray(value.paths) &&
  value.paths.length > 0 &&
  value.paths.length <= 100 &&
  value.paths.every(isSafePath) &&
  new Set(value.paths).size === value.paths.length;

export const isGitCommitRequest = (
  value: unknown,
): value is GitCommitRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    'generation',
    'expectedRevision',
    'message',
    'authorName',
    'authorEmail',
  ]) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  isRevision(value.expectedRevision) &&
  typeof value.message === 'string' &&
  value.message.trim().length > 0 &&
  byteLength(value.message) <= 64 * 1_024 &&
  typeof value.authorName === 'string' &&
  value.authorName.length > 0 &&
  byteLength(value.authorName) <= 256 &&
  ![...value.authorName].some((character) =>
    character.charCodeAt(0) < 0x20,
  ) &&
  typeof value.authorEmail === 'string' &&
  value.authorEmail.length > 0 &&
  byteLength(value.authorEmail) <= 256 &&
  ![...value.authorEmail].some((character) =>
    character.charCodeAt(0) < 0x20,
  );

export const isGitStateSnapshot = (
  value: unknown,
): value is GitStateSnapshot =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    'revision',
    'generation',
    'status',
    'pending',
    'repository',
    'error',
    'lastCommit',
  ]) &&
  Number.isSafeInteger(value.revision) &&
  (value.revision as number) >= 0 &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  ['unavailable', 'idle', 'ready', 'failed'].includes(
    value.status as string,
  ) &&
  (value.pending === undefined ||
    ['refresh', 'diff', 'stage', 'unstage', 'commit'].includes(
      value.pending as string,
    )) &&
  (value.repository === undefined ||
    isGitStatusResponse(value.repository)) &&
  (value.error === undefined || typeof value.error === 'string') &&
  (value.lastCommit === undefined ||
    (isGitCommitResponse(value.lastCommit) &&
      value.lastCommit.status === 'committed'));

const FAILURE_REASONS = [
  'stale',
  'busy',
  'unavailable',
  'invalid',
  'outcomeUnknown',
  'failed',
];

const isFailure = (value: Record<string, unknown>): boolean =>
  hasOnlyKeys(value, ['accepted', 'reason']) &&
  value.accepted === false &&
  FAILURE_REASONS.includes(value.reason as string);

export const isGitRefreshResult = (
  value: unknown,
): value is GitRefreshResult =>
  isRecord(value) &&
  (isFailure(value) ||
    (hasOnlyKeys(value, ['accepted', 'state']) &&
      value.accepted === true &&
      isGitStateSnapshot(value.state)));

export const isGitDiffResult = (
  value: unknown,
): value is GitDiffResult =>
  isRecord(value) &&
  (isFailure(value) ||
    (hasOnlyKeys(value, ['accepted', 'generation', 'diff']) &&
      value.accepted === true &&
      Number.isSafeInteger(value.generation) &&
      isGitDiffResponse(value.diff)));

export const isGitMutationResult = (
  value: unknown,
): value is GitMutationResult =>
  isRecord(value) &&
  (isFailure(value) ||
    (hasOnlyKeys(value, ['accepted', 'state', 'receipt']) &&
      value.accepted === true &&
      isGitStateSnapshot(value.state) &&
      isGitMutationResponse(value.receipt)));

export const isGitCommitResult = (
  value: unknown,
): value is GitCommitResult =>
  isRecord(value) &&
  (isFailure(value) ||
    (hasOnlyKeys(value, ['accepted', 'state', 'receipt']) &&
      value.accepted === true &&
      isGitStateSnapshot(value.state) &&
      isGitCommitResponse(value.receipt)));
