import type {
  GitStateSnapshot,
  WorkspaceGitChangeKind,
  WorkspaceGitErrorKind,
  WorkspaceGitStatusResponse,
} from '@/shared/git';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  commitGitIndex,
  getGitState,
  loadGitDiff,
  onGitStateChanged,
  refreshGitStatus,
  stageGitPaths,
  unstageGitPaths,
} from '@/renderer/services/git';
import type {
  GitChangeLabel,
  GitDiffLine,
  GitDiffViewModel,
  GitRepositoryViewModel,
  GitWorkbenchStore,
} from './types';

const CHANGE_LABELS: Record<WorkspaceGitChangeKind, GitChangeLabel> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  typeChanged: 'Type changed',
  conflicted: 'Conflicted',
  untracked: 'Untracked',
};

const ERROR_COPY: Record<WorkspaceGitErrorKind, string> = {
  notRepository: 'The workspace root is not a Git repository.',
  unsupportedRepository:
    'This repository shape is outside the safe workbench boundary.',
  invalidPath: 'The requested repository path is invalid.',
  stale: 'The repository changed. Refresh before retrying.',
  nothingToCommit: 'The staged index does not contain a commit.',
  tooLarge: 'This repository view exceeds the bounded workbench limits.',
  unsupportedPath: 'This path cannot be changed safely in the workbench.',
  unborn: 'Create the initial commit outside this workbench.',
  detached: 'Detached HEAD is available for review but not mutation.',
  repositoryState:
    'Finish the current merge, rebase, or recovery operation elsewhere.',
  indexLocked: 'The Git index is locked by another process.',
  changed: 'A file changed while SugarCode was validating it.',
  unavailable: 'The local Git repository is unavailable.',
};

const mapRepository = (
  repository: WorkspaceGitStatusResponse,
): GitRepositoryViewModel =>
  repository.status === 'error'
    ? { status: 'error', message: ERROR_COPY[repository.kind] }
    : {
        status: 'ready',
        revision: repository.revision,
        branch: repository.branch ?? 'Detached HEAD',
        ...(repository.head ? { head: repository.head } : {}),
        state: repository.repositoryState,
        mutationAllowed: repository.mutationAllowed,
        stagedCount: repository.stagedCount,
        unstagedCount: repository.unstagedCount,
        unsupportedPaths: repository.unsupportedPaths,
        changes: repository.entries.map((entry) => ({
          path: entry.path,
          ...(entry.index
            ? { index: CHANGE_LABELS[entry.index] }
            : {}),
          ...(entry.worktree
            ? { worktree: CHANGE_LABELS[entry.worktree] }
            : {}),
          stageable: entry.stageable,
        })),
      };

const classifyDiffLine = (line: string): GitDiffLine => {
  if (line.startsWith('diff --git ')) {
    return { kind: 'header', text: line };
  }
  if (line.startsWith('@@ ')) {
    return { kind: 'hunk', text: line };
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return { kind: 'addition', text: line };
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return { kind: 'deletion', text: line };
  }
  if (line.startsWith(' ')) {
    return { kind: 'context', text: line };
  }
  return { kind: 'metadata', text: line };
};

const mapStateRepository = (
  state: GitStateSnapshot,
): GitRepositoryViewModel | undefined =>
  state.repository ? mapRepository(state.repository) : undefined;

export const useStore = (): GitWorkbenchStore => {
  const [open, setOpenState] = useState<boolean>(false);
  const [state, setState] = useState<GitStateSnapshot>({
    revision: 0,
    generation: 0,
    status: 'unavailable',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    undefined,
  );
  const [diff, setDiff] = useState<GitDiffViewModel | undefined>(
    undefined,
  );
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [authorName, setAuthorName] = useState<string>('');
  const [authorEmail, setAuthorEmail] = useState<string>('');
  const [localError, setLocalError] = useState<string | undefined>(
    undefined,
  );
  const generation = useRef<number>(0);
  const stateRevision = useRef<number>(-1);
  const repositoryRevision = useRef<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void getGitState().then((snapshot) => {
      if (active && snapshot.revision >= stateRevision.current) {
        stateRevision.current = snapshot.revision;
        generation.current = snapshot.generation;
        repositoryRevision.current =
          snapshot.repository?.status === 'ready'
            ? snapshot.repository.revision
            : undefined;
        setState(snapshot);
      }
    });
    const unsubscribe = onGitStateChanged((snapshot) => {
      if (snapshot.revision < stateRevision.current) {
        return;
      }
      stateRevision.current = snapshot.revision;
      const generationChanged =
        snapshot.generation !== generation.current;
      const nextRepositoryRevision =
        snapshot.repository?.status === 'ready'
          ? snapshot.repository.revision
          : undefined;
      const repositoryChanged =
        nextRepositoryRevision !== repositoryRevision.current;
      generation.current = snapshot.generation;
      repositoryRevision.current = nextRepositoryRevision;
      setState(snapshot);
      if (generationChanged || repositoryChanged) {
        setSelected(new Set());
        setSelectedPath(undefined);
        setDiff(undefined);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLocalError(undefined);
    setSelected(new Set());
    setDiff(undefined);
    const result = await refreshGitStatus({
      generation: state.generation,
    });
    if (result.accepted === false) {
      setLocalError(`Git refresh was not accepted: ${result.reason}.`);
    }
  }, [state.generation]);

  const setOpen = useCallback(
    (next: boolean): void => {
      setOpenState(next);
      if (
        next &&
        (state.status === 'idle' || state.status === 'failed') &&
        !state.pending
      ) {
        void refresh();
      }
    },
    [refresh, state.pending, state.status],
  );

  const inspect = useCallback(
    async (
      path: string,
      source: 'worktree' | 'index',
    ): Promise<void> => {
      const repository = state.repository;
      if (repository?.status !== 'ready') {
        return;
      }
      setSelectedPath(path);
      setDiff(undefined);
      setLocalError(undefined);
      const result = await loadGitDiff({
        generation: state.generation,
        expectedRevision: repository.revision,
        path,
        source,
      });
      if (result.accepted === false) {
        setLocalError(`Git diff was not accepted: ${result.reason}.`);
        return;
      }
      setDiff(
        result.diff.status === 'error'
          ? {
              status: 'error',
              message: ERROR_COPY[result.diff.kind],
            }
          : {
              status: 'ready',
              path: result.diff.path,
              source: result.diff.source,
              additions: result.diff.additions,
              deletions: result.diff.deletions,
              lines: result.diff.content
                .split('\n')
                .map(classifyDiffLine),
            },
      );
    },
    [state.generation, state.repository],
  );

  const toggleSelected = useCallback((path: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const mutate = useCallback(
    async (operation: 'stage' | 'unstage'): Promise<void> => {
      const repository = state.repository;
      if (
        repository?.status !== 'ready' ||
        selected.size === 0
      ) {
        return;
      }
      setLocalError(undefined);
      const request = {
        generation: state.generation,
        expectedRevision: repository.revision,
        paths: [...selected],
      };
      const result =
        operation === 'stage'
          ? await stageGitPaths(request)
          : await unstageGitPaths(request);
      if (result.accepted === false) {
        setLocalError(
          `Git ${operation} outcome requires attention: ${result.reason}.`,
        );
      } else if (result.receipt.status === 'error') {
        setLocalError(ERROR_COPY[result.receipt.kind]);
      }
      setSelected(new Set());
      setDiff(undefined);
    },
    [selected, state.generation, state.repository],
  );

  const commit = useCallback(async (): Promise<void> => {
    const repository = state.repository;
    if (
      repository?.status !== 'ready' ||
      !commitMessage.trim() ||
      !authorName.trim() ||
      !authorEmail.trim()
    ) {
      return;
    }
    setLocalError(undefined);
    const result = await commitGitIndex({
      generation: state.generation,
      expectedRevision: repository.revision,
      message: commitMessage,
      authorName,
      authorEmail,
    });
    if (result.accepted === false) {
      setLocalError(`Commit outcome requires attention: ${result.reason}.`);
    } else if (result.receipt.status === 'error') {
      setLocalError(ERROR_COPY[result.receipt.kind]);
    } else {
      setCommitMessage('');
      setSelected(new Set());
      setDiff(undefined);
    }
  }, [
    authorEmail,
    authorName,
    commitMessage,
    state.generation,
    state.repository,
  ]);

  const repository = useMemo(
    () => mapStateRepository(state),
    [state],
  );

  return {
    open,
    setOpen,
    generation: state.generation,
    status: state.status,
    ...(state.pending ? { pending: state.pending } : {}),
    ...(repository ? { repository } : {}),
    ...(diff ? { diff } : {}),
    ...(state.error || localError
      ? { error: localError ?? state.error }
      : {}),
    selected,
    ...(selectedPath ? { selectedPath } : {}),
    commitMessage,
    authorName,
    authorEmail,
    ...(state.lastCommit
      ? { lastCommit: { oid: state.lastCommit.newHead } }
      : {}),
    setCommitMessage,
    setAuthorName,
    setAuthorEmail,
    toggleSelected,
    refresh,
    inspect,
    stageSelected: () => mutate('stage'),
    unstageSelected: () => mutate('unstage'),
    commit,
  };
};
