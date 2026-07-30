export type GitChangeLabel =
  | 'Added'
  | 'Modified'
  | 'Deleted'
  | 'Renamed'
  | 'Type changed'
  | 'Conflicted'
  | 'Untracked';

export type GitChangeViewModel = Readonly<{
  path: string;
  index?: GitChangeLabel;
  worktree?: GitChangeLabel;
  stageable: boolean;
}>;

export type GitRepositoryViewModel =
  | Readonly<{
      status: 'ready';
      revision: string;
      branch: string;
      head?: string;
      state: string;
      mutationAllowed: boolean;
      stagedCount: number;
      unstagedCount: number;
      unsupportedPaths: number;
      changes: readonly GitChangeViewModel[];
    }>
  | Readonly<{
      status: 'error';
      message: string;
    }>;

export type GitDiffLine = Readonly<{
  kind: 'header' | 'hunk' | 'context' | 'addition' | 'deletion' | 'metadata';
  text: string;
}>;

export type GitDiffViewModel =
  | Readonly<{
      status: 'ready';
      path: string;
      source: 'worktree' | 'index';
      additions: number;
      deletions: number;
      lines: readonly GitDiffLine[];
    }>
  | Readonly<{
      status: 'error';
      message: string;
    }>;

export type GitWorkbenchStore = Readonly<{
  open: boolean;
  setOpen: (open: boolean) => void;
  generation: number;
  status: 'unavailable' | 'idle' | 'ready' | 'failed';
  pending?: 'refresh' | 'diff' | 'stage' | 'unstage' | 'commit';
  repository?: GitRepositoryViewModel;
  diff?: GitDiffViewModel;
  error?: string;
  selected: ReadonlySet<string>;
  selectedPath?: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  lastCommit?: Readonly<{ oid: string }>;
  setCommitMessage: (value: string) => void;
  setAuthorName: (value: string) => void;
  setAuthorEmail: (value: string) => void;
  toggleSelected: (path: string) => void;
  refresh: () => Promise<void>;
  inspect: (path: string, source: 'worktree' | 'index') => Promise<void>;
  stageSelected: () => Promise<void>;
  unstageSelected: () => Promise<void>;
  commit: () => Promise<void>;
}>;
