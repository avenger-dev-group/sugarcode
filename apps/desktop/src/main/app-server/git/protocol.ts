import type {
  WorkspaceGitCommitResponse,
  WorkspaceGitDiffResponse,
  WorkspaceGitErrorKind,
  WorkspaceGitMutationResponse,
  WorkspaceGitStatusResponse,
} from '@sugarcode/app-server-protocol';

const ERROR_KINDS = new Set<WorkspaceGitErrorKind>([
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
]);
const CHANGE_KINDS = new Set([
  'added',
  'modified',
  'deleted',
  'renamed',
  'typeChanged',
  'conflicted',
  'untracked',
]);
const REPOSITORY_STATES = new Set([
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
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

const isOid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);

const isSafePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= 1_024 &&
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.startsWith('\\') &&
  value.split(/[\\/]/u).length <= 64 &&
  !value
    .split(/[\\/]/u)
    .some(
      (component) =>
        component.length === 0 ||
        component === '.' ||
        component === '..',
    ) &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const isErrorResponse = (
  value: Record<string, unknown>,
): boolean =>
  hasOnlyKeys(value, ['status', 'kind']) &&
  value.status === 'error' &&
  ERROR_KINDS.has(value.kind as WorkspaceGitErrorKind);

export const parseWorkspaceGitStatusResponse = (
  value: unknown,
): WorkspaceGitStatusResponse => {
  if (!isRecord(value)) {
    throw new Error('Invalid workspace Git status response.');
  }
  if (isErrorResponse(value)) {
    return value as WorkspaceGitStatusResponse;
  }
  if (
    !hasOnlyKeys(
      value,
      [
        'status',
        'revision',
        'repositoryState',
        'mutationAllowed',
        'entries',
        'stagedCount',
        'unstagedCount',
        'unsupportedPaths',
      ],
      ['branch', 'head'],
    ) ||
    value.status !== 'ready' ||
    !isRevision(value.revision) ||
    (value.branch !== undefined &&
      (typeof value.branch !== 'string' ||
        value.branch.length === 0 ||
        Buffer.byteLength(value.branch, 'utf8') > 1_024)) ||
    (value.head !== undefined && !isOid(value.head)) ||
    !REPOSITORY_STATES.has(value.repositoryState as string) ||
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
    throw new Error('Invalid workspace Git status response.');
  }
  let totalPathBytes = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let previousPath: string | undefined;
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ['path', 'stageable'], ['index', 'worktree']) ||
      !isSafePath(entry.path) ||
      typeof entry.stageable !== 'boolean' ||
      (entry.index !== undefined &&
        !CHANGE_KINDS.has(entry.index as string)) ||
      (entry.worktree !== undefined &&
        !CHANGE_KINDS.has(entry.worktree as string)) ||
      (entry.index === undefined && entry.worktree === undefined) ||
      (previousPath !== undefined &&
        Buffer.compare(
          Buffer.from(previousPath),
          Buffer.from(entry.path as string),
        ) >= 0)
    ) {
      throw new Error('Invalid workspace Git status entry.');
    }
    previousPath = entry.path as string;
    stagedCount += entry.index === undefined ? 0 : 1;
    unstagedCount += entry.worktree === undefined ? 0 : 1;
    totalPathBytes += Buffer.byteLength(entry.path, 'utf8');
    if (totalPathBytes > 256 * 1_024) {
      throw new Error('Workspace Git status paths exceeded the limit.');
    }
  }
  if (
    value.stagedCount !== stagedCount ||
    value.unstagedCount !== unstagedCount
  ) {
    throw new Error('Workspace Git status counts are inconsistent.');
  }
  return value as WorkspaceGitStatusResponse;
};

export const parseWorkspaceGitDiffResponse = (
  value: unknown,
  expectedRevision: string,
  path: string,
  source: 'worktree' | 'index',
): WorkspaceGitDiffResponse => {
  if (!isRecord(value)) {
    throw new Error('Invalid workspace Git diff response.');
  }
  if (isErrorResponse(value)) {
    return value as WorkspaceGitDiffResponse;
  }
  if (
    !hasOnlyKeys(value, [
      'status',
      'revision',
      'path',
      'source',
      'content',
      'additions',
      'deletions',
    ]) ||
    value.status !== 'ready' ||
    value.revision !== expectedRevision ||
    value.path !== path ||
    value.source !== source ||
    typeof value.content !== 'string' ||
    Buffer.byteLength(value.content, 'utf8') > 512 * 1_024 ||
    !Number.isSafeInteger(value.additions) ||
    (value.additions as number) < 0 ||
    (value.additions as number) > 20_000 ||
    !Number.isSafeInteger(value.deletions) ||
    (value.deletions as number) < 0 ||
    (value.deletions as number) > 20_000 ||
    value.content.split('\n').length > 20_001
  ) {
    throw new Error('Invalid workspace Git diff response.');
  }
  return value as WorkspaceGitDiffResponse;
};

export const parseWorkspaceGitMutationResponse = (
  value: unknown,
  paths: readonly string[],
): WorkspaceGitMutationResponse => {
  if (!isRecord(value)) {
    throw new Error('Invalid workspace Git mutation response.');
  }
  if (isErrorResponse(value)) {
    return value as WorkspaceGitMutationResponse;
  }
  if (
    !hasOnlyKeys(value, ['status', 'revision', 'paths']) ||
    value.status !== 'applied' ||
    !isRevision(value.revision) ||
    !Array.isArray(value.paths) ||
    value.paths.length !== paths.length ||
    value.paths.some((path, index) => path !== paths[index])
  ) {
    throw new Error('Invalid workspace Git mutation response.');
  }
  return value as WorkspaceGitMutationResponse;
};

export const parseWorkspaceGitCommitResponse = (
  value: unknown,
): WorkspaceGitCommitResponse => {
  if (!isRecord(value)) {
    throw new Error('Invalid workspace Git commit response.');
  }
  if (isErrorResponse(value)) {
    return value as WorkspaceGitCommitResponse;
  }
  if (
    !hasOnlyKeys(value, [
      'status',
      'revision',
      'oldHead',
      'newHead',
    ]) ||
    value.status !== 'committed' ||
    !isRevision(value.revision) ||
    !isOid(value.oldHead) ||
    !isOid(value.newHead) ||
    value.oldHead === value.newHead
  ) {
    throw new Error('Invalid workspace Git commit response.');
  }
  return value as WorkspaceGitCommitResponse;
};
