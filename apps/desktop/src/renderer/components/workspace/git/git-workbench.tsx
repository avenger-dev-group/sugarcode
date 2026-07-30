import {
  CheckSquare2,
  FileDiff,
  GitBranch,
  RefreshCw,
  Square,
  X,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/renderer/components/ui/alert-dialog';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Textarea } from '@/renderer/components/ui/textarea';

import type { GitDiffLine } from './types';
import { useStore } from './use-store';

const diffLineClass = (line: GitDiffLine): string => {
  switch (line.kind) {
    case 'addition':
      return 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300';
    case 'deletion':
      return 'bg-destructive/10 text-destructive';
    case 'hunk':
      return 'bg-surface text-tertiary';
    case 'header':
      return 'bg-background text-primary';
    case 'context':
      return 'text-secondary';
    case 'metadata':
      return 'text-tertiary';
  }
};

export const GitWorkbench = () => {
  const store = useStore();
  const repository =
    store.repository?.status === 'ready' ? store.repository : undefined;
  const selectedChanges =
    repository?.changes.filter((change) =>
      store.selected.has(change.path),
    ) ?? [];
  const canStage =
    selectedChanges.length > 0 &&
    selectedChanges.every(
      (change) => change.worktree && change.stageable,
    );
  const canUnstage =
    selectedChanges.length > 0 &&
    selectedChanges.every((change) => change.index);
  const canCommit =
    Boolean(repository?.mutationAllowed) &&
    (repository?.stagedCount ?? 0) > 0 &&
    store.commitMessage.trim().length > 0 &&
    store.authorName.trim().length > 0 &&
    store.authorEmail.trim().length > 0 &&
    !store.pending;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => store.setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={store.open}
        title="Git changes"
      >
        <GitBranch aria-hidden="true" />
        <span className="hidden lg:inline">Changes</span>
        {repository && repository.changes.length > 0 ? (
          <span className="font-mono text-[10px] text-tertiary">
            {repository.changes.length}
          </span>
        ) : null}
      </Button>

      {store.open ? (
        <aside
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[58rem] flex-col border-l bg-background shadow-[-24px_0_70px_var(--shadow-soft)] sm:inset-y-3 sm:right-3 sm:rounded-2xl sm:border"
          role="dialog"
          aria-modal="false"
          aria-label="Git change workbench"
        >
          <header className="flex min-w-0 items-center gap-3 border-b px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-tertiary">
                Local repository
              </p>
              <div className="mt-0.5 flex min-w-0 items-center gap-2">
                <h2 className="truncate text-sm font-medium">
                  {repository?.branch ?? 'Git changes'}
                </h2>
                {repository ? (
                  <span className="font-mono text-[10px] text-tertiary">
                    {repository.stagedCount} staged ·{' '}
                    {repository.unstagedCount} working
                  </span>
                ) : null}
              </div>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={
                store.status === 'unavailable' || Boolean(store.pending)
              }
              onClick={() => void store.refresh()}
              aria-label="Refresh Git status"
            >
              <RefreshCw
                className={
                  store.pending === 'refresh'
                    ? 'animate-spin motion-reduce:animate-none'
                    : undefined
                }
                aria-hidden="true"
              />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => store.setOpen(false)}
              aria-label="Close Git workbench"
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          {store.status === 'unavailable' ? (
            <div className="flex flex-1 flex-col items-start justify-center px-8">
              <GitBranch className="size-8 text-tertiary" aria-hidden="true" />
              <h2 className="mt-4 text-2xl font-medium tracking-[-0.035em]">
                Bind a workspace first.
              </h2>
              <p className="mt-3 max-w-md text-sm leading-5.5 text-secondary">
                Git authority follows the active workspace root. No absolute
                path, shell command, hook, or network operation is exposed here.
              </p>
            </div>
          ) : store.repository?.status === 'error' ? (
            <div className="flex flex-1 flex-col items-start justify-center px-8">
              <FileDiff className="size-8 text-tertiary" aria-hidden="true" />
              <h2 className="mt-4 text-xl font-medium">
                Repository unavailable
              </h2>
              <p className="mt-3 max-w-md text-sm text-secondary">
                {store.repository.message}
              </p>
            </div>
          ) : !repository ? (
            <div className="flex flex-1 items-center justify-center px-8 text-sm text-secondary">
              {store.pending === 'refresh'
                ? 'Reading bounded repository status…'
                : 'Refresh to inspect this workspace repository.'}
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(12rem,1fr)_auto] lg:grid-cols-[minmax(18rem,38%)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]">
              <section
                className="min-h-0 overflow-auto border-b lg:border-r lg:border-b-0"
                aria-label="Repository changes"
              >
                {repository.changes.length === 0 ? (
                  <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center">
                    <CheckSquare2
                      className="size-7 text-emerald-700 dark:text-emerald-300"
                      aria-hidden="true"
                    />
                    <p className="mt-3 text-sm font-medium">
                      Working tree clean
                    </p>
                    <p className="mt-1 text-xs text-tertiary">
                      No staged or unstaged changes.
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y">
                    {repository.changes.map((change) => {
                      const isSelected = store.selected.has(change.path);
                      return (
                        <li
                          key={change.path}
                          className="min-w-0 px-3 py-2.5"
                        >
                          <div className="flex min-w-0 items-start gap-2">
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              aria-pressed={isSelected}
                              aria-label={`Select ${change.path}`}
                              disabled={Boolean(store.pending)}
                              onClick={() =>
                                store.toggleSelected(change.path)
                              }
                            >
                              {isSelected ? (
                                <CheckSquare2 aria-hidden="true" />
                              ) : (
                                <Square aria-hidden="true" />
                              )}
                            </Button>
                            <div className="min-w-0 flex-1">
                              <code
                                className="block truncate font-mono text-xs text-primary"
                                title={change.path}
                              >
                                {change.path}
                              </code>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {change.index ? (
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="secondary"
                                    disabled={Boolean(store.pending)}
                                    onClick={() =>
                                      void store.inspect(
                                        change.path,
                                        'index',
                                      )
                                    }
                                  >
                                    Index · {change.index}
                                  </Button>
                                ) : null}
                                {change.worktree ? (
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="outline"
                                    disabled={Boolean(store.pending)}
                                    onClick={() =>
                                      void store.inspect(
                                        change.path,
                                        'worktree',
                                      )
                                    }
                                  >
                                    Working · {change.worktree}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section
                className="min-h-0 overflow-auto border-b lg:border-b-0"
                aria-label="Git diff"
              >
                {!store.diff ? (
                  <div className="flex h-full min-h-48 items-center justify-center px-6 text-center text-sm text-secondary">
                    Choose an index or working-tree badge to review its diff.
                  </div>
                ) : store.diff.status === 'error' ? (
                  <p className="p-5 text-sm text-destructive" role="alert">
                    {store.diff.message}
                  </p>
                ) : (
                  <>
                    <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background px-3 py-2">
                      <code className="min-w-0 truncate font-mono text-xs">
                        {store.diff.path}
                      </code>
                      <span className="shrink-0 font-mono text-[10px] text-tertiary">
                        <span className="text-emerald-700 dark:text-emerald-300">
                          +{store.diff.additions}
                        </span>{' '}
                        <span className="text-destructive">
                          −{store.diff.deletions}
                        </span>
                      </span>
                    </div>
                    <div
                      className="min-w-max font-mono text-xs font-normal leading-5"
                      tabIndex={0}
                      role="region"
                      aria-label={`Git diff for ${store.diff.path}`}
                    >
                      {store.diff.lines.map((line, index) => (
                        <code
                          key={`${index}:${line.text}`}
                          className={`block whitespace-pre px-3 ${diffLineClass(
                            line,
                          )}`}
                        >
                          {line.text || ' '}
                        </code>
                      ))}
                    </div>
                  </>
                )}
              </section>

              <section className="border-t bg-surface px-4 py-3 lg:col-span-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canStage || Boolean(store.pending)}
                    onClick={() => void store.stageSelected()}
                  >
                    Stage selected
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canUnstage || Boolean(store.pending)}
                    onClick={() => void store.unstageSelected()}
                  >
                    Unstage selected
                  </Button>
                  <span className="font-mono text-[10px] text-tertiary">
                    {store.selected.size} selected
                  </span>
                  {store.error ? (
                    <span
                      className="min-w-0 flex-1 text-right text-xs text-destructive"
                      role="alert"
                    >
                      {store.error}
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(10rem,0.45fr)_minmax(12rem,0.55fr)_auto] lg:items-end">
                  <label className="min-w-0">
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
                      Commit message
                    </span>
                    <Textarea
                      className="mt-1 min-h-16 rounded-lg border bg-background"
                      value={store.commitMessage}
                      maxLength={65_536}
                      placeholder="Describe the staged change"
                      onChange={(event) =>
                        store.setCommitMessage(event.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
                      Author
                    </span>
                    <Input
                      className="mt-1"
                      value={store.authorName}
                      maxLength={256}
                      placeholder="Name"
                      onChange={(event) =>
                        store.setAuthorName(event.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-tertiary">
                      Email
                    </span>
                    <Input
                      className="mt-1"
                      type="email"
                      value={store.authorEmail}
                      maxLength={256}
                      placeholder="name@example.com"
                      onChange={(event) =>
                        store.setAuthorEmail(event.target.value)
                      }
                    />
                  </label>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" disabled={!canCommit}>
                        Commit staged index
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <div className="px-5 pt-5">
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Create this local commit?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {repository.branch} · {repository.stagedCount}{' '}
                            staged file
                            {repository.stagedCount === 1 ? '' : 's'}. The
                            working tree is not implicitly staged.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <div className="mt-4 rounded-lg border bg-surface p-3">
                          <p className="whitespace-pre-wrap text-sm text-primary">
                            {store.commitMessage}
                          </p>
                          <p className="mt-2 font-mono text-[10px] text-tertiary">
                            {store.authorName} &lt;{store.authorEmail}&gt;
                          </p>
                        </div>
                      </div>
                      <AlertDialogFooter className="mt-5 border-t px-5 py-4">
                        <AlertDialogCancel asChild>
                          <Button type="button" variant="outline">
                            Cancel
                          </Button>
                        </AlertDialogCancel>
                        <AlertDialogAction asChild>
                          <Button
                            type="button"
                            onClick={() => void store.commit()}
                          >
                            Create commit
                          </Button>
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                {store.lastCommit ? (
                  <p
                    className="mt-2 font-mono text-[10px] text-emerald-700 dark:text-emerald-300"
                    role="status"
                  >
                    Commit created · {store.lastCommit.oid}
                  </p>
                ) : null}
              </section>
            </div>
          )}
        </aside>
      ) : null}
    </>
  );
};
